const test = require('node:test');
const assert = require('node:assert/strict');

function makeFakeDb() {
  const usersByEmail = new Map();
  let lastResetToken = null;
  let lastResetExpires = null;

  function seedUser(user) {
    usersByEmail.set(user.email, user);
  }

  function get(sql, params, cb) {
    try {
      if (sql.includes('FROM users WHERE email')) {
        return cb(null, usersByEmail.get(params[0]));
      }
      return cb(new Error(`Unhandled db.get SQL: ${sql}`));
    } catch (err) {
      return cb(err);
    }
  }

  function run(sql, params, cb) {
    try {
      if (sql.includes('UPDATE users SET resetPasswordToken')) {
        const [token, expiresAt] = params;
        lastResetToken = token;
        lastResetExpires = expiresAt;
        if (cb) cb(null);
        return;
      }
      if (cb) cb(new Error(`Unhandled db.run SQL: ${sql}`));
    } catch (err) {
      if (cb) return cb(err);
      throw err;
    }
  }

  return {
    seedUser,
    get,
    run,
    _getLastReset: () => ({ token: lastResetToken, expiresAt: lastResetExpires }),
  };
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

function installMailerMock({ sendMail }) {
  const mailerPath = require.resolve('../utils/mailer');
  require.cache[mailerPath] = {
    id: mailerPath,
    filename: mailerPath,
    loaded: true,
    exports: { sendMail },
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

function getRouteLayer(router, method, path) {
  return router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method]
  );
}

async function invokeRoute(router, method, path, body) {
  const layer = getRouteLayer(router, method, path);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);

  const req = {
    method: method.toUpperCase(),
    url: path,
    path,
    baseUrl: '/api/auth',
    body,
    query: {},
    params: {},
    headers: {},
    ip: '127.0.0.1',
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
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
        return this;
      },
    };

    const handlers = layer.route.stack.map((routeLayer) => routeLayer.handle);
    let index = 0;

    function next(err) {
      if (err) {
        reject(err);
        return;
      }

      const handler = handlers[index++];
      if (!handler) {
        resolve({ statusCode: res.statusCode, body: undefined });
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

test('forgot-password sends branded HTML + text reset email', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.NOREPLY_EMAIL = 'noreply@moodful.ca';
  process.env.MOOD_SITE_URL = 'http://localhost:3000';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const fakeDb = makeFakeDb();
  fakeDb.seedUser({ id: 1, email: 'ryan@example.com', name: 'Ryan' });
  installLoggerMock();
  installDatabaseMock(fakeDb);

  const sent = [];
  installMailerMock({
    sendMail: (msg) => {
      sent.push(msg);
      return true;
    },
  });

  clearModule('../routes/auth');
  const authRoutes = require('../routes/auth');

  const res = await invokeRoute(authRoutes, 'post', '/forgot-password', {
    email: 'ryan@example.com',
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.message, 'Password reset email sent');
  assert.equal(sent.length, 1);

  const msg = sent[0];
  const { token } = fakeDb._getLastReset();
  assert.ok(token, 'expected reset token to be stored');
  const resetLink = `http://localhost:3000/reset.html?token=${token}`;

  assert.equal(msg.subject, '🔑 Reset your Moodful password');
  assert.equal(msg.to, 'ryan@example.com');
  assert.equal(msg.from, 'noreply@moodful.ca');
  assert.ok(msg.text.includes(resetLink));
  assert.ok(msg.text.toLowerCase().includes('expires in 60 minutes'));
  assert.ok(msg.text.toLowerCase().includes("didn't request"));
  assert.ok(msg.html.includes('class="cta-button"'));
  assert.ok(msg.html.includes('Reset password'));
  assert.ok(msg.html.includes(resetLink));
  assert.ok(msg.html.includes('https://moodful.ca/img/logo.png'));
  assert.ok(msg.html.toLowerCase().includes("didn't request"));
});
