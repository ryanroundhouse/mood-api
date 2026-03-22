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

async function createBreathingDb() {
  const db = new sqlite3.Database(':memory:');

  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          accountLevel TEXT DEFAULT 'basic',
          manualProExpiresAt TEXT
        )`
      );
      db.run(
        `INSERT INTO users (id, accountLevel, manualProExpiresAt) VALUES (1, 'basic', NULL)`
      );
      db.run(
        `CREATE TABLE breathing_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          userId INTEGER NOT NULL,
          routineType TEXT NOT NULL,
          cycleMode TEXT NOT NULL,
          targetCycles INTEGER,
          completedCycles INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          startedAt TEXT NOT NULL,
          endedAt TEXT NOT NULL,
          durationSeconds INTEGER NOT NULL DEFAULT 0,
          calendarDate TEXT NOT NULL,
          timezone TEXT,
          triggerContext TEXT,
          audioEnabled INTEGER,
          countdownCompleted INTEGER,
          exitReason TEXT,
          createdAt TEXT,
          updatedAt TEXT
        )`,
        (err) => (err ? reject(err) : resolve())
      );
    });
  });

  return db;
}

function loadBreathingRouter(db) {
  installLoggerMock();
  installDatabaseMock(db);
  clearModule('../routes/breathing');
  clearModule('../middleware/auth');
  return require('../routes/breathing');
}

function getRouteLayer(router, method, path) {
  return router.stack.find(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method]
  );
}

async function invokeRoute(router, method, path, { headers = {}, body = {}, query = {} } = {}) {
  const layer = getRouteLayer(router, method, path);
  assert.ok(layer, `Expected ${method.toUpperCase()} ${path} route`);

  const req = {
    method: method.toUpperCase(),
    url: path,
    path,
    headers,
    body,
    query,
    params: {},
  };

  return await new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
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
      set(field, value) {
        this.headers[field.toLowerCase()] = value;
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

function makeToken(userId = 1) {
  return jwt.sign({ id: userId, accountLevel: 'basic' }, process.env.JWT_SECRET, {
    expiresIn: '10m',
  });
}

test('POST /sessions creates a breathing session with derived fields', async () => {
  process.env.JWT_SECRET = 'breathing_route_test_secret';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const db = await createBreathingDb();
  const router = loadBreathingRouter(db);
  const token = makeToken();

  try {
    const res = await invokeRoute(router, 'post', '/sessions', {
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: {
        routineType: 'box_breathing',
        cycleMode: '5_cycles',
        completedCycles: 5,
        status: 'completed',
        startedAt: '2026-03-21T02:30:00Z',
        endedAt: '2026-03-21T02:35:00Z',
        timezone: 'America/Toronto',
        triggerContext: 'home_panel',
        audioEnabled: true,
        countdownCompleted: true,
      },
    });

    assert.equal(res.statusCode, 201);
    assert.equal(res.body.targetCycles, 5);
    assert.equal(res.body.durationSeconds, 300);
    assert.equal(res.body.calendarDate, '2026-03-20');
    assert.equal(res.body.audioEnabled, true);
    assert.equal(res.body.countdownCompleted, true);
  } finally {
    await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }
});

test('GET /sessions and /stats return filtered breathing data', async () => {
  process.env.JWT_SECRET = 'breathing_route_test_secret';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const db = await createBreathingDb();
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `INSERT INTO breathing_sessions (
          userId, routineType, cycleMode, targetCycles, completedCycles, status,
          startedAt, endedAt, durationSeconds, calendarDate, timezone,
          triggerContext, audioEnabled, countdownCompleted, exitReason, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          1,
          'box_breathing',
          '3_cycles',
          3,
          3,
          'completed',
          '2026-03-18T08:00:00Z',
          '2026-03-18T08:02:00Z',
          120,
          '2026-03-18',
          'UTC',
          'home_panel',
          1,
          1,
          null,
          '2026-03-18T08:02:00Z',
          '2026-03-18T08:02:00Z',
        ]
      );
      db.run(
        `INSERT INTO breathing_sessions (
          userId, routineType, cycleMode, targetCycles, completedCycles, status,
          startedAt, endedAt, durationSeconds, calendarDate, timezone,
          triggerContext, audioEnabled, countdownCompleted, exitReason, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          1,
          'four_seven_eight',
          'infinite',
          null,
          7,
          'exited_early',
          '2026-03-19T08:00:00Z',
          '2026-03-19T08:06:00Z',
          360,
          '2026-03-19',
          'UTC',
          'drawer_menu',
          0,
          1,
          'user_backed_out',
          '2026-03-19T08:06:00Z',
          '2026-03-19T08:06:00Z',
        ],
        (err) => (err ? reject(err) : resolve())
      );
    });
  });

  const router = loadBreathingRouter(db);
  const token = makeToken();

  try {
    const sessionsRes = await invokeRoute(router, 'get', '/sessions', {
      headers: { authorization: `Bearer ${token}` },
      query: {
        startDate: '2026-03-19',
        routineType: 'four_seven_eight',
      },
    });

    assert.equal(sessionsRes.statusCode, 200);
    assert.equal(sessionsRes.body.length, 1);
    assert.equal(sessionsRes.body[0].status, 'exited_early');

    const statsRes = await invokeRoute(router, 'get', '/stats', {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(statsRes.statusCode, 200);
    assert.equal(statsRes.body.totalSessions, 2);
    assert.equal(statsRes.body.completedSessions, 1);
    assert.equal(statsRes.body.partialSessions, 1);
    assert.equal(statsRes.body.totalCompletedCycles, 10);
    assert.equal(statsRes.body.totalDurationSeconds, 480);
    assert.equal(statsRes.body.sessionsByRoutine.box_breathing, 1);
    assert.equal(statsRes.body.sessionsByRoutine.four_seven_eight, 1);
    assert.equal(statsRes.body.mostUsedRoutine, 'box_breathing');
  } finally {
    await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }
});

test('POST /sessions rejects endedAt earlier than startedAt', async () => {
  process.env.JWT_SECRET = 'breathing_route_test_secret';
  process.env.ENCRYPTION_KEY = '0000000000000000000000000000000000000000000000000000000000000000';

  const db = await createBreathingDb();
  const router = loadBreathingRouter(db);
  const token = makeToken();

  try {
    const res = await invokeRoute(router, 'post', '/sessions', {
      headers: {
        authorization: `Bearer ${token}`,
      },
      body: {
        routineType: 'box_breathing',
        cycleMode: '3_cycles',
        completedCycles: 0,
        status: 'interrupted',
        startedAt: '2026-03-21T02:30:00Z',
        endedAt: '2026-03-21T02:20:00Z',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'endedAt must be on or after startedAt');
  } finally {
    await new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
  }
});
