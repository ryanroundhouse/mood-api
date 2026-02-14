const test = require('node:test');
const assert = require('node:assert/strict');

const { convertToEST, getCurrentESTDateTime } = require('../utils/datetime');

test('getCurrentESTDateTime returns an ISO string', async () => {
  const value = getCurrentESTDateTime();
  assert.equal(typeof value, 'string');
  assert.ok(value.includes('T'));
});

test('convertToEST returns an ISO string for an ISO input', async () => {
  const utc = '2024-01-01T12:00:00.000Z';
  const est = convertToEST(utc);
  assert.equal(typeof est, 'string');
  assert.ok(est.includes('T'));
});

