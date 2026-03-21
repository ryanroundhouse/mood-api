const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const {
  createLegacyApiAuthDeprecationMiddleware,
} = require('../middleware/legacyAuthDeprecation');

function makeFakeDb() {
  const usersByEmail = new Map();
  const usersById = new Map();
  const refreshTokens = new Map();

  function seedUser(user) {
    usersByEmail.set(user.email, user);
    usersById.set(user.id, user);
  }

  function get(sql, params, cb) {
    try {
      if (sql.includes('FROM users WHERE email')) {
        return cb(null, usersByEmail.get(params[0]));
      }
      if (sql.includes('FROM refresh_tokens WHERE token')) {
        const row = refreshTokens.get(params[0]);
        if (!row || row.expiresAt <= params[1]) return cb(null, undefined);
        return cb(null, row);
      }
      if (sql.includes('FROM users WHERE id')) {
        return cb(null, usersById.get(params[0]));
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
        refreshTokens.delete(params[0]);
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

function installLoggerMock() {
  const loggerPath = require.resolve('../utils/logger');
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // ignore
  }
}

function loadAuthRouter(fakeDb) {
  installLoggerMock();
  installDatabaseMock(fakeDb);
  clearModule('../routes/auth');
  return require('../routes/auth');
}

function getRouteLayer(router, method, path) {
  return router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method]
  );
}

async function invokeAuthRoute(
  router,
  method,
  path,
  { body = {}, baseUrl = '/api/auth', cookies = {}, useLegacyDeprecation = false, params = {} } = {}
) {
  const layer = getRouteLayer(router, method, path);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);

  const req = {
    method: method.toUpperCase(),
    url: path,
    path,
    body,
    params,
    query: {},
    headers: {},
    cookies,
    ip: '127.0.0.1',
    baseUrl,
    secure: false,
    protocol: 'http',
    get(header) {
      return this.headers[header.toLowerCase()];
    },
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(field, value) {
        this.headers[field.toLowerCase()] = value;
      },
      getHeader(field) {
        return this.headers[field.toLowerCase()];
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      set(field, value) {
        this.headers[field.toLowerCase()] = value;
        return this;
      },
      cookie(name, value, options = {}) {
        const attributes = [`${name}=${value}`, `Path=${options.path || '/'}`];
        if (options.httpOnly) attributes.push('HttpOnly');
        this.headers['set-cookie'] = attributes.join('; ');
        return this;
      },
      clearCookie(name, options = {}) {
        this.headers['set-cookie'] = `${name}=; Path=${options.path || '/'}; Max-Age=0`;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload, headers: this.headers });
        return this;
      },
      redirect(codeOrUrl, maybeUrl) {
        const statusCode = typeof maybeUrl === 'string' ? codeOrUrl : 302;
        const location = typeof maybeUrl === 'string' ? maybeUrl : codeOrUrl;
        this.statusCode = statusCode;
        this.headers.location = location;
        resolve({ statusCode: this.statusCode, body: undefined, headers: this.headers });
        return this;
      },
    };

    const handlers = [];
    if (useLegacyDeprecation) {
      handlers.push(
        createLegacyApiAuthDeprecationMiddleware({
          logger: { warn: () => {} },
          sunset: '2099-01-01T00:00:00Z',
        })
      );
    }
    handlers.push(...layer.route.stack.map((routeLayer) => routeLayer.handle));

    let index = 0;

    function next(err) {
      if (err) {
        reject(err);
        return;
      }

      const handler = handlers[index++];
      if (!handler) {
        resolve({ statusCode: res.statusCode, body: undefined, headers: res.headers });
        return;
      }

      try {
        handler(req, res, next);
      } catch (handlerErr) {
        reject(handlerErr);
      }
    }

    next();
  });
}

test('web mode (/api/web-auth/*) sets HttpOnly refresh cookie and does not return refreshToken', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  const authRoutes = loadAuthRouter(fakeDb);
  const res = await invokeAuthRoute(authRoutes, 'post', '/login', {
    baseUrl: '/api/web-auth',
    body: { email: 'user@example.com', password: 'pw' },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.body.accessToken === 'string' && res.body.accessToken.length > 10);
  assert.equal('refreshToken' in res.body, false);
  assert.ok(res.headers['set-cookie'].includes('HttpOnly'));
  assert.ok(res.headers['set-cookie'].includes('Path=/'));
});

test('legacy mode (/api/*) preserves JSON refreshToken contract and deprecation headers', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  const authRoutes = loadAuthRouter(fakeDb);
  const res = await invokeAuthRoute(authRoutes, 'post', '/login', {
    baseUrl: '/api',
    body: { email: 'user@example.com', password: 'pw' },
    useLegacyDeprecation: true,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers.deprecation, 'true');
  assert.ok(res.headers.sunset);
  assert.ok(res.headers.link);
  assert.ok(typeof res.body.refreshToken === 'string' && res.body.refreshToken.length > 10);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('canonical JSON mode (/api/auth/*) preserves JSON refreshToken contract', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  const authRoutes = loadAuthRouter(fakeDb);
  const res = await invokeAuthRoute(authRoutes, 'post', '/login', {
    baseUrl: '/api/auth',
    body: { email: 'user@example.com', password: 'pw' },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(typeof res.body.refreshToken === 'string' && res.body.refreshToken.length > 10);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('legacy verify (/api/verify/:token) redirects to /api/auth/verify/:token', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const authRoutes = loadAuthRouter(makeFakeDb());
  const res = await invokeAuthRoute(authRoutes, 'get', '/verify/:token', {
    baseUrl: '/api',
    params: { token: 'abc123' },
  });

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/api/auth/verify/abc123');
});

test('web refresh-token + logout work via cookie (no body refreshToken)', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const fakeDb = makeFakeDb();
  const hashed = await bcrypt.hash('pw', 10);
  fakeDb.seedUser({
    id: 1,
    email: 'user@example.com',
    password: hashed,
    isVerified: 1,
    accountLevel: 'basic',
  });

  const authRoutes = loadAuthRouter(fakeDb);

  const loginRes = await invokeAuthRoute(authRoutes, 'post', '/login', {
    baseUrl: '/api/web-auth',
    body: { email: 'user@example.com', password: 'pw' },
  });
  const refreshToken = loginRes.headers['set-cookie'].split(';')[0].split('=')[1];
  assert.ok(refreshToken);

  const refreshRes = await invokeAuthRoute(authRoutes, 'post', '/refresh-token', {
    baseUrl: '/api/web-auth',
    cookies: { refreshToken },
  });
  assert.equal(refreshRes.statusCode, 200);
  assert.ok(typeof refreshRes.body.accessToken === 'string' && refreshRes.body.accessToken.length > 10);

  const logoutRes = await invokeAuthRoute(authRoutes, 'post', '/logout', {
    baseUrl: '/api/web-auth',
    cookies: { refreshToken },
  });
  assert.equal(logoutRes.statusCode, 200);
  assert.ok(logoutRes.headers['set-cookie'].startsWith('refreshToken='));
  assert.equal(fakeDb._refreshTokens.has(refreshToken), false);
});
