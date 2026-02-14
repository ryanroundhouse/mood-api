const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

const {
  createRequireWebRefreshAuth,
} = require('../middleware/requireWebRefreshAuth');

function makeFakeDb() {
  const refreshTokens = new Map(); // token -> { userId, token, expiresAt }

  function seedRefreshToken(row) {
    refreshTokens.set(row.token, row);
  }

  function get(sql, params, cb) {
    try {
      if (sql.includes('FROM refresh_tokens WHERE token')) {
        const token = params[0];
        const row = refreshTokens.get(token);
        // SQL checks expiresAt > now; emulate that behavior
        if (!row || row.expiresAt <= params[1]) return cb(null, undefined);
        return cb(null, { userId: row.userId });
      }
      return cb(new Error(`Unhandled db.get SQL: ${sql}`));
    } catch (err) {
      return cb(err);
    }
  }

  return { seedRefreshToken, get };
}

async function startTestServer({ fakeDb }) {
  const app = express();
  app.use(cookieParser());

  const requireWebRefreshAuth = createRequireWebRefreshAuth({ db: fakeDb });

  // Serve simple placeholders; we only care about auth gating behavior.
  app.get('/dashboard.html', requireWebRefreshAuth, (req, res) => {
    res.status(200).send('DASHBOARD_OK');
  });
  app.get('/weekly-summary.html', requireWebRefreshAuth, (req, res) => {
    res.status(200).send('WEEKLY_SUMMARY_OK');
  });
  app.get('/account-settings.html', requireWebRefreshAuth, (req, res) => {
    res.status(200).send('ACCOUNT_SETTINGS_OK');
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('authenticated HTML routes redirect to /login.html when cookie missing', async () => {
  const fakeDb = makeFakeDb();
  const server = await startTestServer({ fakeDb });
  try {
    const res = await fetch(`${server.baseUrl}/dashboard.html`, {
      redirect: 'manual',
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html');
  } finally {
    await server.close();
  }
});

test('authenticated HTML routes redirect to /login.html when cookie invalid/expired', async () => {
  const fakeDb = makeFakeDb();
  const server = await startTestServer({ fakeDb });
  try {
    const res = await fetch(`${server.baseUrl}/weekly-summary.html`, {
      redirect: 'manual',
      headers: { Cookie: 'refreshToken=not-a-real-token' },
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login.html');
  } finally {
    await server.close();
  }
});

test('authenticated HTML routes return 200 with valid refresh cookie and set Cache-Control: no-store', async () => {
  const fakeDb = makeFakeDb();
  fakeDb.seedRefreshToken({
    userId: 123,
    token: 'valid-token',
    expiresAt: Date.now() + 60_000,
  });

  const server = await startTestServer({ fakeDb });
  try {
    const res = await fetch(`${server.baseUrl}/account-settings.html`, {
      redirect: 'manual',
      headers: { Cookie: 'refreshToken=valid-token' },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ACCOUNT_SETTINGS_OK');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  } finally {
    await server.close();
  }
});

