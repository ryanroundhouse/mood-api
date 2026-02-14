const test = require('node:test');
const assert = require('node:assert/strict');

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
  delete require.cache[require.resolve('../middleware/auth')];
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
  delete require.cache[require.resolve('../middleware/auth')];
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

  const token = jwt.sign({ id: 123, accountLevel: 'pro' }, process.env.JWT_SECRET, {
    expiresIn: '5m',
  });

  delete require.cache[require.resolve('../middleware/auth')];
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

