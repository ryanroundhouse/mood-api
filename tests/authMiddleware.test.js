const test = require('node:test');
const assert = require('node:assert/strict');

function installDatabaseMock(db) {
  const databasePath = require.resolve('../database');
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { db, initializeDatabase: () => {} },
  };
}

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // ignore
  }
}

function makeRes() {
  return {
    statusCode: undefined,
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

test('authenticateToken returns 401 when Authorization header missing', async () => {
  process.env.JWT_SECRET = 'test_secret';
  installDatabaseMock({ get() {} });
  clearModule('../middleware/auth');
  const { authenticateToken } = require('../middleware/auth');

  const req = { headers: {} };
  const res = makeRes();
  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('authenticateToken returns 401 when token invalid', async () => {
  process.env.JWT_SECRET = 'test_secret';
  installDatabaseMock({ get() {} });
  clearModule('../middleware/auth');
  const { authenticateToken } = require('../middleware/auth');

  const req = { headers: { authorization: 'Bearer not-a-real-token' } };
  const res = makeRes();
  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
});

test('authenticateToken sets req.user and calls next for valid token', async () => {
  process.env.JWT_SECRET = 'test_secret';
  const jwt = require('jsonwebtoken');
  const fakeDb = {
    get(sql, params, cb) {
      cb(null, {
        id: params[0],
        accountLevel: 'basic',
        manualProExpiresAt: '2999-01-01T00:00:00.000Z',
      });
    },
  };

  const token = jwt.sign({ id: 123, accountLevel: 'pro' }, process.env.JWT_SECRET, {
    expiresIn: '5m',
  });

  installDatabaseMock(fakeDb);
  clearModule('../middleware/auth');
  const { authenticateToken } = require('../middleware/auth');

  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  let nextCalled = false;

  authenticateToken(req, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, undefined);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 123, accountLevel: 'pro' });
});

test('authenticateToken downgrades expired manual grants based on database state', async () => {
  process.env.JWT_SECRET = 'test_secret';
  const jwt = require('jsonwebtoken');
  const fakeDb = {
    get(sql, params, cb) {
      cb(null, {
        id: params[0],
        accountLevel: 'basic',
        manualProExpiresAt: '2000-01-01T00:00:00.000Z',
      });
    },
  };

  const token = jwt.sign({ id: 123, accountLevel: 'pro' }, process.env.JWT_SECRET, {
    expiresIn: '5m',
  });

  installDatabaseMock(fakeDb);
  clearModule('../middleware/auth');
  const { authenticateToken } = require('../middleware/auth');

  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = makeRes();
  let nextCalled = false;

  await new Promise((resolve) => {
    authenticateToken(req, res, () => {
      nextCalled = true;
      resolve();
    });
  });

  assert.equal(res.statusCode, undefined);
  assert.equal(nextCalled, true);
  assert.deepEqual(req.user, { id: 123, accountLevel: 'basic' });
});
