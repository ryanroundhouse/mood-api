const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRequireWebRefreshAuth,
} = require('../middleware/requireWebRefreshAuth');

function makeFakeDb() {
  const refreshTokens = new Map();

  function seedRefreshToken(row) {
    refreshTokens.set(row.token, row);
  }

  function get(sql, params, cb) {
    try {
      if (sql.includes('FROM refresh_tokens WHERE token')) {
        const row = refreshTokens.get(params[0]);
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

async function invokeProtectedPage(requireWebRefreshAuth, path, cookieValue) {
  const req = {
    path,
    originalUrl: path,
    cookies: cookieValue ? { refreshToken: cookieValue } : {},
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
      set(field, value) {
        this.headers[field.toLowerCase()] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      send(payload) {
        resolve({ statusCode: this.statusCode, headers: this.headers, body: payload });
        return this;
      },
      redirect(codeOrLocation, maybeLocation) {
        this.statusCode = typeof maybeLocation === 'string' ? codeOrLocation : 302;
        this.headers.location = typeof maybeLocation === 'string' ? maybeLocation : codeOrLocation;
        resolve({ statusCode: this.statusCode, headers: this.headers, body: undefined });
        return this;
      },
    };

    requireWebRefreshAuth(req, res, () => {
      res.set('Cache-Control', 'no-store');
      res.status(200).send(path.toUpperCase());
    });
  });
}

test('authenticated HTML routes redirect to /login.html when cookie missing', async () => {
  const middleware = createRequireWebRefreshAuth({ db: makeFakeDb() });
  const res = await invokeProtectedPage(middleware, '/dashboard.html');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login.html');
});

test('authenticated HTML routes redirect to /login.html when cookie invalid/expired', async () => {
  const middleware = createRequireWebRefreshAuth({ db: makeFakeDb() });
  const res = await invokeProtectedPage(middleware, '/weekly-summary.html', 'not-a-real-token');
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login.html');
});

test('authenticated HTML routes return 200 with valid refresh cookie and set Cache-Control: no-store', async () => {
  const fakeDb = makeFakeDb();
  fakeDb.seedRefreshToken({
    userId: 123,
    token: 'valid-token',
    expiresAt: Date.now() + 60_000,
  });

  const middleware = createRequireWebRefreshAuth({ db: fakeDb });
  const res = await invokeProtectedPage(middleware, '/account-settings.html', 'valid-token');
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, '/ACCOUNT-SETTINGS.HTML');
  assert.equal(res.headers['cache-control'], 'no-store');
});
