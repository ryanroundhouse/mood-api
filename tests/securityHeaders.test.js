const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSecurityHeadersMiddleware,
} = require('../middleware/securityHeaders');

async function invokeSecurityHeaders({ isDevelopment, forwardedProto }) {
  const middleware = createSecurityHeadersMiddleware({ isDevelopment });
  const req = {
    headers: forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {},
    get(header) {
      return this.headers[header.toLowerCase()];
    },
    secure: forwardedProto === 'https',
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      getHeader(name) {
        return this.headers[name.toLowerCase()];
      },
      removeHeader(name) {
        delete this.headers[name.toLowerCase()];
      },
      end(payload) {
        resolve({ statusCode: this.statusCode, headers: this.headers, body: payload });
      },
    };

    middleware(req, res, (err) => {
      if (err) {
        reject(err);
        return;
      }
      res.end('OK');
    });
  });
}

test('security headers are present; HSTS only on secure requests (prod mode)', async () => {
  const resInsecure = await invokeSecurityHeaders({ isDevelopment: false });
  assert.equal(resInsecure.statusCode, 200);
  assert.match(resInsecure.headers['content-security-policy'], /script-src-attr\s+'unsafe-inline'/);
  assert.equal(resInsecure.headers['x-content-type-options'], 'nosniff');
  assert.equal(resInsecure.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(resInsecure.headers['x-frame-options'], 'DENY');
  assert.equal(
    resInsecure.headers['permissions-policy'],
    'geolocation=(), microphone=(), camera=()'
  );
  assert.equal(resInsecure.headers['strict-transport-security'], undefined);

  const resSecure = await invokeSecurityHeaders({
    isDevelopment: false,
    forwardedProto: 'https',
  });
  assert.equal(
    resSecure.headers['strict-transport-security'],
    'max-age=31536000; includeSubDomains'
  );
});

test('HSTS is not set in development mode (even if request is secure)', async () => {
  const res = await invokeSecurityHeaders({
    isDevelopment: true,
    forwardedProto: 'https',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['strict-transport-security'], undefined);
});
