const express = require('express');
const { body, query, validationResult } = require('express-validator');
const { DateTime } = require('luxon');
const { authenticateToken } = require('../middleware/auth');
const { db } = require('../database');
const logger = require('../utils/logger');

const router = express.Router();

const ROUTINE_TYPES = ['box_breathing', 'four_seven_eight'];
const CYCLE_MODES = ['3_cycles', '5_cycles', '10_cycles', 'infinite'];
const SESSION_STATUSES = ['completed', 'exited_early', 'interrupted'];
const CYCLE_MODE_TARGETS = {
  '3_cycles': 3,
  '5_cycles': 5,
  '10_cycles': 10,
  infinite: null,
};

function toNullableBooleanInt(value) {
  if (value === undefined || value === null) {
    return null;
  }
  return value ? 1 : 0;
}

function formatSession(row) {
  return {
    id: row.id,
    userId: row.userId,
    routineType: row.routineType,
    cycleMode: row.cycleMode,
    targetCycles: row.targetCycles,
    completedCycles: row.completedCycles,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationSeconds: row.durationSeconds,
    calendarDate: row.calendarDate,
    timezone: row.timezone,
    triggerContext: row.triggerContext,
    audioEnabled: row.audioEnabled === null || row.audioEnabled === undefined ? null : Boolean(row.audioEnabled),
    countdownCompleted:
      row.countdownCompleted === null || row.countdownCompleted === undefined
        ? null
        : Boolean(row.countdownCompleted),
    exitReason: row.exitReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function deriveCalendarDate(startedAt, timezone) {
  const parsedStartedAt = DateTime.fromISO(startedAt, { setZone: true });
  if (!parsedStartedAt.isValid) {
    return { error: 'startedAt must be a valid ISO-8601 timestamp' };
  }

  if (timezone) {
    const zoned = parsedStartedAt.setZone(timezone);
    if (!zoned.isValid) {
      return { error: 'timezone must be a valid IANA time zone' };
    }
    return { value: zoned.toISODate() };
  }

  return { value: parsedStartedAt.toISODate() };
}

router.post(
  '/sessions',
  authenticateToken,
  [
    body('routineType').isString().isIn(ROUTINE_TYPES),
    body('cycleMode').isString().isIn(CYCLE_MODES),
    body('completedCycles').isInt({ min: 0 }),
    body('status').isString().isIn(SESSION_STATUSES),
    body('startedAt').isISO8601(),
    body('endedAt').isISO8601(),
    body('triggerContext').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
    body('audioEnabled').optional({ nullable: true }).isBoolean(),
    body('countdownCompleted').optional({ nullable: true }).isBoolean(),
    body('exitReason').optional({ nullable: true }).isString().trim().isLength({ max: 64 }),
    body('timezone').optional({ nullable: true }).isString().trim().isLength({ max: 100 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      routineType,
      cycleMode,
      completedCycles,
      status,
      startedAt,
      endedAt,
      triggerContext = null,
      audioEnabled = null,
      countdownCompleted = null,
      exitReason = null,
      timezone = null,
    } = req.body;
    const userId = req.user.id;

    const startedAtDate = DateTime.fromISO(startedAt, { setZone: true });
    const endedAtDate = DateTime.fromISO(endedAt, { setZone: true });

    if (!startedAtDate.isValid || !endedAtDate.isValid) {
      return res.status(400).json({ error: 'startedAt and endedAt must be valid ISO-8601 timestamps' });
    }

    if (endedAtDate < startedAtDate) {
      return res.status(400).json({ error: 'endedAt must be on or after startedAt' });
    }

    const calendarDateResult = deriveCalendarDate(startedAt, timezone);
    if (calendarDateResult.error) {
      return res.status(400).json({ error: calendarDateResult.error });
    }

    const durationSeconds = Math.max(0, Math.round(endedAtDate.diff(startedAtDate, 'seconds').seconds));
    const targetCycles = CYCLE_MODE_TARGETS[cycleMode];
    const now = new Date().toISOString();

    db.run(
      `INSERT INTO breathing_sessions (
        userId, routineType, cycleMode, targetCycles, completedCycles, status,
        startedAt, endedAt, durationSeconds, calendarDate, timezone,
        triggerContext, audioEnabled, countdownCompleted, exitReason,
        createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        routineType,
        cycleMode,
        targetCycles,
        completedCycles,
        status,
        startedAt,
        endedAt,
        durationSeconds,
        calendarDateResult.value,
        timezone,
        triggerContext,
        toNullableBooleanInt(audioEnabled),
        toNullableBooleanInt(countdownCompleted),
        exitReason,
        now,
        now,
      ],
      function insertSession(err) {
        if (err) {
          logger.error('Error creating breathing session:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        db.get(
          'SELECT * FROM breathing_sessions WHERE id = ?',
          [this.lastID],
          (fetchErr, row) => {
            if (fetchErr) {
              logger.error('Error fetching created breathing session:', fetchErr);
              return res.status(500).json({ error: 'Internal server error' });
            }

            logger.info(`Breathing session created for user: ${userId}`);
            return res.status(201).json(formatSession(row));
          }
        );
      }
    );
  }
);

router.get(
  '/sessions',
  authenticateToken,
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
    query('status').optional().isString().isIn(SESSION_STATUSES),
    query('routineType').optional().isString().isIn(ROUTINE_TYPES),
    query('limit').optional().isInt({ min: 1, max: 200 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const {
      startDate,
      endDate,
      status,
      routineType,
      limit = '100',
      offset = '0',
    } = req.query;

    const clauses = ['userId = ?'];
    const params = [userId];

    if (startDate) {
      clauses.push('calendarDate >= ?');
      params.push(startDate.slice(0, 10));
    }

    if (endDate) {
      clauses.push('calendarDate <= ?');
      params.push(endDate.slice(0, 10));
    }

    if (status) {
      clauses.push('status = ?');
      params.push(status);
    }

    if (routineType) {
      clauses.push('routineType = ?');
      params.push(routineType);
    }

    params.push(Number.parseInt(limit, 10));
    params.push(Number.parseInt(offset, 10));

    db.all(
      `SELECT * FROM breathing_sessions
       WHERE ${clauses.join(' AND ')}
       ORDER BY startedAt DESC, id DESC
       LIMIT ? OFFSET ?`,
      params,
      (err, rows) => {
        if (err) {
          logger.error('Error fetching breathing sessions:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        return res.json(rows.map(formatSession));
      }
    );
  }
);

router.get(
  '/stats',
  authenticateToken,
  [
    query('startDate').optional().isISO8601(),
    query('endDate').optional().isISO8601(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { startDate, endDate } = req.query;
    const clauses = ['userId = ?'];
    const params = [userId];

    if (startDate) {
      clauses.push('calendarDate >= ?');
      params.push(startDate.slice(0, 10));
    }

    if (endDate) {
      clauses.push('calendarDate <= ?');
      params.push(endDate.slice(0, 10));
    }

    db.all(
      `SELECT routineType, completedCycles, status, durationSeconds, calendarDate
       FROM breathing_sessions
       WHERE ${clauses.join(' AND ')}`,
      params,
      (err, rows) => {
        if (err) {
          logger.error('Error fetching breathing stats:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        const sessionsByRoutine = {};
        let completedSessions = 0;
        let partialSessions = 0;
        let totalCompletedCycles = 0;
        let totalDurationSeconds = 0;

        for (const row of rows) {
          sessionsByRoutine[row.routineType] = (sessionsByRoutine[row.routineType] || 0) + 1;
          totalCompletedCycles += row.completedCycles || 0;
          totalDurationSeconds += row.durationSeconds || 0;

          if (row.status === 'completed') {
            completedSessions += 1;
          } else {
            partialSessions += 1;
          }
        }

        const mostUsedRoutine = Object.entries(sessionsByRoutine).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

        return res.json({
          totalSessions: rows.length,
          completedSessions,
          partialSessions,
          sessionsByRoutine,
          totalCompletedCycles,
          totalDurationSeconds,
          mostUsedRoutine,
        });
      }
    );
  }
);

module.exports = router;
module.exports.ROUTINE_TYPES = ROUTINE_TYPES;
module.exports.CYCLE_MODES = CYCLE_MODES;
module.exports.SESSION_STATUSES = SESSION_STATUSES;
