const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

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
        const email = params[0];
        return cb(null, usersByEmail.get(email));
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

function clearModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // ignore
  }
}

async function startTestServer() {
  const app = express();
  app.use(express.json());

  const authRoutes = require('../routes/auth');
  app.use('/api/auth', authRoutes);

  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('forgot-password sends branded HTML + text reset email', async () => {
  process.env.JWT_SECRET = 'test_jwt_secret';
  process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
  process.env.NODE_ENV = 'test';
  process.env.MAILGUN_API_KEY = 'test_key';
  process.env.EMAIL_DOMAIN = 'example.com';
  process.env.NOREPLY_EMAIL = 'noreply@moodful.ca';
  // Use localhost to simulate dev/test sending; logo must still be public https.
  process.env.MOOD_SITE_URL = 'http://localhost:3000';

  const fakeDb = makeFakeDb();
  fakeDb.seedUser({ id: 1, email: 'ryan@example.com', name: 'Ryan' });
  installDatabaseMock(fakeDb);

  const sent = [];
  installMailerMock({
    sendMail: (msg) => {
      sent.push(msg);
      return true;
    },
  });

  clearModule('../routes/auth');

  const server = await startTestServer();
  try {
    const res = await fetch(`${server.baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ryan@example.com' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message, 'Password reset email sent');

    assert.equal(sent.length, 1);
    const msg = sent[0];

    const { token } = fakeDb._getLastReset();
    assert.ok(token, 'expected reset token to be stored');
    const resetLink = `http://localhost:3000/reset.html?token=${token}`;

    assert.equal(msg.subject, '🔑 Reset your Moodful password');
    assert.equal(msg.to, 'ryan@example.com');
    assert.equal(msg.from, 'noreply@moodful.ca');

    assert.ok(typeof msg.text === 'string' && msg.text.length > 0);
    assert.ok(msg.text.includes(resetLink));
    assert.ok(msg.text.toLowerCase().includes('expires in 60 minutes'));
    assert.ok(msg.text.toLowerCase().includes("didn't request"));

    assert.ok(typeof msg.html === 'string' && msg.html.length > 0);
    assert.ok(msg.html.includes('class="cta-button"'));
    assert.ok(msg.html.includes('Reset password'));
    assert.ok(msg.html.includes(resetLink));
    assert.ok(msg.html.includes('https://moodful.ca/img/logo.png'));
    assert.ok(msg.html.toLowerCase().includes("didn't request"));
  } finally {
    await server.close();
  }
});

