const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const {
  createSecurityHeadersMiddleware,
} = require('../middleware/securityHeaders');

async function startTestServer({ isDevelopment }) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createSecurityHeadersMiddleware({ isDevelopment }));

  app.get('/', (req, res) => {
    res.status(200).send('OK');
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

test('security headers are present; HSTS only on secure requests (prod mode)', async () => {
  const server = await startTestServer({ isDevelopment: false });
  try {
    const resInsecure = await fetch(`${server.baseUrl}/`, {
      redirect: 'manual',
    });
    assert.equal(resInsecure.status, 200);

    const csp = resInsecure.headers.get('content-security-policy');
    assert.ok(csp);
    assert.match(csp, /script-src-attr\s+'unsafe-inline'/);
    assert.equal(resInsecure.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(
      resInsecure.headers.get('referrer-policy'),
      'strict-origin-when-cross-origin'
    );
    assert.equal(resInsecure.headers.get('x-frame-options'), 'DENY');
    assert.equal(
      resInsecure.headers.get('permissions-policy'),
      'geolocation=(), microphone=(), camera=()'
    );
    assert.equal(resInsecure.headers.get('strict-transport-security'), null);

    const resSecure = await fetch(`${server.baseUrl}/`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(resSecure.status, 200);
    assert.equal(
      resSecure.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains'
    );
  } finally {
    await server.close();
  }
});

test('HSTS is not set in development mode (even if request is secure)', async () => {
  const server = await startTestServer({ isDevelopment: true });
  try {
    const res = await fetch(`${server.baseUrl}/`, {
      redirect: 'manual',
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('strict-transport-security'), null);
  } finally {
    await server.close();
  }
});

