const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const {
  createLegacyApiAuthDeprecationMiddleware,
} = require('../middleware/legacyAuthDeprecation');

function makeFakeDb() {
  const usersByEmail = new Map();
  const usersById = new Map();
  const refreshTokens = new Map(); // token -> { userId, token, expiresAt }

  function seedUser(user) {
    usersByEmail.set(user.email, user);
    usersById.set(user.id, user);
  }

  function get(sql, params, cb) {
    try {
      if (sql.includes('FROM users WHERE email')) {
        const email = params[0];
        return cb(null, usersByEmail.get(email));
      }
      if (sql.includes('FROM refresh_tokens WHERE token')) {
        const token = params[0];
        const row = refreshTokens.get(token);
        // Endpoint already checks expiresAt > now in SQL; emulate that behavior
        if (!row || row.expiresAt <= params[1]) return cb(null, undefined);
        return cb(null, row);
      }
      if (sql.includes('FROM users WHERE id')) {
        const id = params[0];
        return cb(null, usersById.get(id));
      }
      return cb(new Error(`Unhandled db.get SQL: ${sql}`));
    } catch (err) {
      return cb(err);
    }
  }

  function run(sql, params, cb) {
    try {
      if (sql.includes('INSERT INTO refresh_tokens')) {
        const [userId, token, expiresAt] = params;
        refreshTokens.set(token, { userId, token, expiresAt });
        if (cb) cb(null);
        return;
      }
      if (sql.includes('DELETE FROM refresh_tokens WHERE token')) {
        const [token] = params;
        refreshTokens.delete(token);
        if (cb) cb(null);
        return;
      }
      if (cb) cb(new Error(`Unhandled db.run SQL: ${sql}`));
    } catch (err) {
      if (cb) return cb(err);
      throw err;
    }
  }

  return { seedUser, get, run, _refreshTokens: refreshTokens };
}

function installDatabaseMock(fakeDb) {
  const databasePath = require.resolve('../database');
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { db: fakeDb, initializeDatabase: () => {} },
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // ignore
  }
}

async function startTestServer() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());

  const authRoutes = require('../routes/auth');
  const legacyApiAuthDeprecation = createLegacyApiAuthDeprecationMiddleware({
    logger: { warn: () => {} },
    sunset: '2099-01-01T00:00:00Z',
  });
  app.use('/api', legacyApiAuthDeprecation, authRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/web-auth', authRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function extractCookieValue(setCookieHeader, cookieName) {
  // "refreshToken=abc; Path=/; HttpOnly; ..."
  const match = setCookieHeader.match(new RegExp(`(?:^|,\\s*)${cookieName}=([^;]*)`));
  return match ? match[1] : null;
}

test('web mode (/api/web-auth/*) sets HttpOnly refresh cookie and does not return refreshToken', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/web-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(typeof data.accessToken === 'string' && data.accessToken.length > 10);
    assert.equal('refreshToken' in data, false);

    const setCookie = res.headers.get('set-cookie');
    assert.ok(setCookie, 'expected Set-Cookie header');
    assert.ok(setCookie.includes('HttpOnly'), 'expected HttpOnly cookie');
    assert.ok(
      setCookie.includes('Path=/'),
      'expected cookie Path=/'
    );

    const refreshToken = extractCookieValue(setCookie, 'refreshToken');
    assert.ok(refreshToken, 'expected refreshToken cookie value');
  } finally {
    await server.close();
  }
});

test('legacy mode (/api/*) preserves JSON refreshToken contract', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('deprecation'), 'true');
    assert.ok(res.headers.get('sunset'));
    assert.ok(res.headers.get('link'));

    const data = await res.json();
    assert.ok(typeof data.accessToken === 'string' && data.accessToken.length > 10);
    assert.ok(typeof data.refreshToken === 'string' && data.refreshToken.length > 10);

    const setCookie = res.headers.get('set-cookie');
    assert.equal(setCookie, null);
  } finally {
    await server.close();
  }
});

test('canonical JSON mode (/api/auth/*) preserves JSON refreshToken contract', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
    });
    assert.equal(res.status, 200);

    const data = await res.json();
    assert.ok(typeof data.accessToken === 'string' && data.accessToken.length > 10);
    assert.ok(typeof data.refreshToken === 'string' && data.refreshToken.length > 10);

    const setCookie = res.headers.get('set-cookie');
    assert.equal(setCookie, null);
  } finally {
    await server.close();
  }
});

test('legacy verify (/api/verify/:token) redirects to /api/auth/verify/:token', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';

  const fakeDb = makeFakeDb();
  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/verify/abc123`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/api/auth/verify/abc123');
  } finally {
    await server.close();
  }
});

test('web refresh-token + logout work via cookie (no body refreshToken)', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    // Login to receive cookie
    const loginRes = await fetch(`${server.baseUrl}/api/web-auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user@example.com', password: 'pw' }),
    });
    assert.equal(loginRes.status, 200);

    const setCookie = loginRes.headers.get('set-cookie');
    const refreshToken = extractCookieValue(setCookie, 'refreshToken');
    assert.ok(refreshToken);

    const cookieHeader = `refreshToken=${refreshToken}`;

    // Refresh token with cookie
    const refreshRes = await fetch(
      `${server.baseUrl}/api/web-auth/refresh-token`,
      {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      }
    );
    assert.equal(refreshRes.status, 200);
    const refreshData = await refreshRes.json();
    assert.ok(typeof refreshData.accessToken === 'string' && refreshData.accessToken.length > 10);

    // Logout clears cookie and deletes token
    const logoutRes = await fetch(`${server.baseUrl}/api/web-auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
    });
    assert.equal(logoutRes.status, 200);

    const logoutSetCookie = logoutRes.headers.get('set-cookie');
    assert.ok(logoutSetCookie, 'expected Set-Cookie on logout to clear cookie');
    assert.ok(logoutSetCookie.includes('Path=/'));
    assert.ok(logoutSetCookie.startsWith('refreshToken='));

    assert.equal(fakeDb._refreshTokens.has(refreshToken), false);
  } finally {
    await server.close();
  }
});

