const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3').verbose();

function installDatabaseMock(db) {
  const databasePath = require.resolve('../database');
  require.cache[databasePath] = {
    id: databasePath,
    filename: databasePath,
    loaded: true,
    exports: { db, initializeDatabase: () => {} },
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

async function createUserDeletionDb() {
  const db = new sqlite3.Database(':memory:');
  const statements = [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT)',
    'CREATE TABLE custom_activities (userId INTEGER)',
    'CREATE TABLE moods (userId INTEGER)',
    'CREATE TABLE breathing_sessions (userId INTEGER)',
    'CREATE TABLE user_settings (userId INTEGER)',
    'CREATE TABLE daily_summaries (userId INTEGER)',
    'CREATE TABLE refresh_tokens (userId INTEGER)',
    'CREATE TABLE garmin_request_tokens (userId INTEGER)',
    'CREATE TABLE sleep_summaries (userId INTEGER)',
    'CREATE TABLE mood_auth_codes (userId INTEGER)',
    'CREATE TABLE summaries (userId INTEGER)',
  ];

  await new Promise((resolve, reject) => {
    db.serialize(() => {
      for (const statement of statements) {
        db.run(statement);
      }
      db.run('INSERT INTO users (id, email) VALUES (?, ?)', [1, 'user@example.com']);
      db.run('INSERT INTO moods (userId) VALUES (?)', [1]);
      db.run('INSERT INTO breathing_sessions (userId) VALUES (?)', [1]);
      db.run('INSERT INTO user_settings (userId) VALUES (?)', [1], (err) =>
        err ? reject(err) : resolve()
      );
    });
  });

  return db;
}

function loadUserRouter(db) {
  installLoggerMock();
  installDatabaseMock(db);
  clearModule('../routes/user');
  clearModule('../middleware/auth');
  return require('../routes/user');
}

function getRouteLayer(router, method, path) {
  return router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method]
  );
}

async function invokeRoute(router, method, path, { headers = {} } = {}) {
  const layer = getRouteLayer(router, method, path);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);

  const req = {
    method: method.toUpperCase(),
    url: path,
    path,
    headers,
    body: {},
    query: {},
    params: {},
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        resolve({ statusCode: this.statusCode, body: payload });
        return this;
      },
      sendStatus(code) {
        this.statusCode = code;
        resolve({ statusCode: this.statusCode, body: undefined });
        return this;
      },
      send(payload) {
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

test('DELETE /account removes breathing sessions alongside other user data', async () => {
  process.env.JWT_SECRET = 'user_delete_test_secret';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const db = await createUserDeletionDb();
  const router = loadUserRouter(db);
  const token = jwt.sign({ id: 1, accountLevel: 'basic' }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });

  try {
    const res = await invokeRoute(router, 'delete', '/account', {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    assert.equal(res.statusCode, 200);

    const remainingUsers = await new Promise((resolve, reject) => {
      db.get('SELECT COUNT(*) AS count FROM users', (err, row) => (err ? reject(err) : resolve(row.count)));
    });
    const remainingBreathingSessions = await new Promise((resolve, reject) => {
      db.get(
        'SELECT COUNT(*) AS count FROM breathing_sessions',
        (err, row) => (err ? reject(err) : resolve(row.count))
      );
    });

    assert.equal(remainingUsers, 0);
    assert.equal(remainingBreathingSessions, 0);
  } finally {
    await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }
});
