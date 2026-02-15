const test = require('node:test');
const assert = require('node:assert/strict');

const { __test__ } = require('../middleware/rateLimiter');

test('rate limiter key prefers cf-connecting-ip', () => {
  const req = {
    ip: '::ffff:127.0.0.1',
    get: (name) => {
      if (name.toLowerCase() === 'cf-connecting-ip') return '74.15.37.224';
      return undefined;
    },
  };

  assert.equal(__test__.getRateLimitKey(req), '74.15.37.224');
});

test('rate limiter key falls back to x-forwarded-for (first hop)', () => {
  const req = {
    ip: '::ffff:127.0.0.1',
    get: (name) => {
      if (name.toLowerCase() === 'cf-connecting-ip') return undefined;
      if (name.toLowerCase() === 'x-forwarded-for')
        return '203.0.113.10, 108.162.242.37';
      return undefined;
    },
  };

  assert.equal(__test__.getRateLimitKey(req), '203.0.113.10');
});

test('rate limiter key falls back to req.ip', () => {
  const req = {
    ip: '::ffff:127.0.0.1',
    get: () => undefined,
  };

  assert.equal(__test__.getRateLimitKey(req), '::ffff:127.0.0.1');
});

