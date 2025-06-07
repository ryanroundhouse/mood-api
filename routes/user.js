const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { generalLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { decrypt } = require('../utils/encryption');

// Get user settings
router.get('/settings', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT users.name, users.email, users.accountLevel,
     users.garminConnected, users.garminUserId,
     user_settings.emailDailyNotifications, user_settings.emailWeeklySummary,
     user_settings.appDailyNotifications, user_settings.appWeeklySummary,
     user_settings.appDailyNotificationTime, user_settings.moodEmojis,
     user_settings.ai_insights
     FROM users 
     LEFT JOIN user_settings ON users.id = user_settings.userId 
     WHERE users.id = ?`,
    [userId],
    (err, row) => {
      if (err) {
        logger.error('Error fetching user settings:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'User not found' });
      }

      const userSettings = {
        name: row.name,
        email: row.email,
        accountLevel: row.accountLevel,
        garminConnected: row.garminConnected === 1,
        garminUserId: row.garminUserId,
        emailDailyNotifications: row.emailDailyNotifications === 1,
        emailWeeklySummary: row.emailWeeklySummary === 1,
        appDailyNotifications: row.appDailyNotifications === 1,
        appWeeklySummary: row.appWeeklySummary === 1,
        appDailyNotificationTime: row.appDailyNotificationTime || '20:00',
        moodEmojis: row.moodEmojis ? JSON.parse(row.moodEmojis) : null,
        aiInsights: row.ai_insights === 1,
      };

      res.json(userSettings);
    }
  );
});

// Update user settings
router.put(
  '/settings',
  authenticateToken,
  [
    body('name').optional().trim().isLength({ min: 1 }),
    body('emailDailyNotifications').optional().isBoolean(),
    body('emailWeeklySummary').optional().isBoolean(),
    body('appDailyNotifications').optional().isBoolean(),
    body('appWeeklySummary').optional().isBoolean(),
    body('appDailyNotificationTime')
      .optional()
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/), // HH:mm format
    body('moodEmojis').optional().isArray(),
    body('aiInsights').optional().isBoolean(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const {
      name,
      emailDailyNotifications,
      emailWeeklySummary,
      appDailyNotifications,
      appWeeklySummary,
      appDailyNotificationTime,
      moodEmojis,
      aiInsights,
    } = req.body;

    db.serialize(() => {
      if (name !== undefined) {
        db.run(
          'UPDATE users SET name = ? WHERE id = ?',
          [name, userId],
          (err) => {
            if (err) {
              logger.error('Error updating user name:', err);
              return res.status(500).json({ error: 'Internal server error' });
            }
          }
        );
      }

      const updates = [];
      const values = [];

      if (emailDailyNotifications !== undefined) {
        updates.push('emailDailyNotifications = ?');
        values.push(emailDailyNotifications ? 1 : 0);
      }

      if (emailWeeklySummary !== undefined) {
        updates.push('emailWeeklySummary = ?');
        values.push(emailWeeklySummary ? 1 : 0);
      }

      if (appDailyNotifications !== undefined) {
        updates.push('appDailyNotifications = ?');
        values.push(appDailyNotifications ? 1 : 0);
      }

      if (appWeeklySummary !== undefined) {
        updates.push('appWeeklySummary = ?');
        values.push(appWeeklySummary ? 1 : 0);
      }

      if (appDailyNotificationTime !== undefined) {
        updates.push('appDailyNotificationTime = ?');
        values.push(appDailyNotificationTime);
      }

      if (moodEmojis !== undefined) {
        // Check if the moodEmojis array matches the default set
        const isDefaultEmojis = JSON.stringify(moodEmojis) === JSON.stringify(["😢","😕","😐","🙂","😄"]);
        
        if (isDefaultEmojis) {
          // If it's the default set, set the database value to null
          updates.push('moodEmojis = ?');
          values.push(null);
        } else {
          // If it's a custom set, store it as JSON
          updates.push('moodEmojis = ?');
          values.push(JSON.stringify(moodEmojis));
        }
      }

      if (aiInsights !== undefined) {
        updates.push('ai_insights = ?');
        values.push(aiInsights ? 1 : 0);
      }

      if (updates.length > 0) {
        values.push(userId);

        db.run(
          `UPDATE user_settings SET ${updates.join(', ')} WHERE userId = ?`,
          values,
          (err) => {
            if (err) {
              logger.error('Error updating notification settings:', err);
              return res.status(500).json({ error: 'Internal server error' });
            }
          }
        );
      }

      logger.info(`User settings updated for user: ${userId}`);
      res.json({ message: 'Settings updated successfully' });
    });
  }
);

// Get user activities
router.get('/activities', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    'SELECT activities FROM custom_activities WHERE userId = ?',
    [userId],
    (err, row) => {
      if (err) {
        logger.error('Error fetching user activities:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      let activities;
      if (row && row.activities && row.activities !== '[]') {
        activities = JSON.parse(row.activities);
      } else {
        activities = [
          'energized',
          'active',
          'connected',
          'productive',
          'relaxed',
        ];
      }

      res.json({ activities });
    }
  );
});

// Update user activities
router.post(
  '/activities',
  authenticateToken,
  [
    body('activities').isArray(),
    body('activities.*').isString().trim().isLength({ min: 1, max: 100 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const accountLevel = req.user.accountLevel;
    let { activities } = req.body;

    const maxActivities =
      accountLevel === 'pro' || accountLevel === 'enterprise' ? 20 : 5;

    if (activities.length > maxActivities) {
      return res.status(400).json({
        error: `You can only save up to ${maxActivities} activities with your current account level.`,
      });
    }

    if (activities.length === 0) {
      db.run(
        'DELETE FROM custom_activities WHERE userId = ?',
        [userId],
        (err) => {
          if (err) {
            logger.error('Error removing user activities:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          logger.info(`User activities removed for user: ${userId}`);
          res.json({
            message: 'Activities removed successfully',
            activities: [],
            maxActivities,
          });
        }
      );
    } else {
      const activitiesJson = JSON.stringify(activities);

      db.run(
        'INSERT OR REPLACE INTO custom_activities (userId, activities) VALUES (?, ?)',
        [userId, activitiesJson],
        (err) => {
          if (err) {
            logger.error('Error updating user activities:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          logger.info(`User activities updated for user: ${userId}`);
          res.json({
            message: 'Activities updated successfully',
            activities,
            maxActivities,
          });
        }
      );
    }
  }
);

// Get user summary
router.get('/summary', authenticateToken, generalLimiter, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT basic, advanced FROM summaries WHERE userId = ? ORDER BY date DESC LIMIT 1`,
    [userId],
    (err, row) => {
      if (err) {
        logger.error('Error fetching user summary:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!row) {
        return res.status(404).json({ error: 'Summary not found' });
      }

      let basicInsights, aiInsights;

      try {
        const decryptedBasic = row.basic ? decrypt(row.basic) : null;
        basicInsights = decryptedBasic ? JSON.parse(decryptedBasic) : [];
      } catch (error) {
        logger.error('Error parsing/decrypting basic insights:', error);
        basicInsights = [];
      }

      try {
        const decryptedAdvanced = row.advanced ? decrypt(row.advanced) : null;
        aiInsights = decryptedAdvanced ? JSON.parse(decryptedAdvanced) : [];
      } catch (error) {
        logger.error('Error parsing/decrypting AI insights:', error);
        aiInsights = [];
      }

      logger.info(`Summary fetched and decrypted for user: ${userId}`);
      res.json({
        basicInsights: basicInsights,
        aiInsights: aiInsights,
      });
    }
  );
});

// Get all user summaries
router.get('/summaries', authenticateToken, generalLimiter, (req, res) => {
  const userId = req.user.id;

  db.all(
    `SELECT date, basic, advanced FROM summaries WHERE userId = ? ORDER BY date DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        logger.error('Error fetching user summaries:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: 'No summaries found' });
      }

      logger.debug('Raw database rows:', rows);
      const summaries = rows.map(row => {
        logger.debug('Processing row:', { 
          rowId: row.id,
          hasEncryptedField: Boolean(row.yourEncryptedField),
          rowData: row 
        });
        let basicInsights, aiInsights;

        try {
          const decryptedBasic = row.basic ? decrypt(row.basic) : null;
          basicInsights = decryptedBasic ? JSON.parse(decryptedBasic) : [];
        } catch (error) {
          logger.error('Error parsing/decrypting basic insights:', error);
          basicInsights = [];
        }

        try {
          const decryptedAdvanced = row.advanced ? decrypt(row.advanced) : null;
          aiInsights = decryptedAdvanced ? JSON.parse(decryptedAdvanced) : [];
        } catch (error) {
          logger.error('Error parsing/decrypting AI insights:', error);
          aiInsights = [];
        }

        return {
          date: row.date,
          basicInsights,
          aiInsights,
        };
      });

      logger.info(
        `${summaries.length} summaries fetched and decrypted for user: ${userId}`
      );
      res.json(summaries);
    }
  );
});

// Unsubscribe from email notifications (no login required)
router.get('/unsubscribe', (req, res) => {
  const { token, type = 'daily' } = req.query;
  if (!token) return res.status(400).send('Invalid unsubscribe link.');

  db.get('SELECT userId FROM user_settings WHERE unsubscribeToken = ?', [token], (err, row) => {
    if (err || !row) return res.status(400).send('Invalid or expired unsubscribe link.');

    let updateSql;
    let responseMessage;

    // Determine which settings to update based on the type parameter
    switch (type) {
      case 'daily':
        updateSql = 'UPDATE user_settings SET emailDailyNotifications = 0 WHERE userId = ?';
        responseMessage = 'You have been unsubscribed from daily mood emails.';
        break;
      case 'weekly':
        updateSql = 'UPDATE user_settings SET emailWeeklySummary = 0 WHERE userId = ?';
        responseMessage = 'You have been unsubscribed from weekly mood summary emails.';
        break;
      case 'all':
        updateSql = 'UPDATE user_settings SET emailDailyNotifications = 0, emailWeeklySummary = 0 WHERE userId = ?';
        responseMessage = 'You have been unsubscribed from all mood emails.';
        break;
      default:
        updateSql = 'UPDATE user_settings SET emailDailyNotifications = 0 WHERE userId = ?';
        responseMessage = 'You have been unsubscribed from daily mood emails.';
    }

    db.run(updateSql, [row.userId], (err) => {
      if (err) {
        logger.error('Error unsubscribing user:', err);
        return res.status(500).send('Could not unsubscribe.');
      }
      
      logger.info(`User ${row.userId} unsubscribed from ${type} emails`);
      res.send(responseMessage);
    });
  });
});

// Get user sleep data
router.get('/sleep', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all(
    `SELECT calendarDate, durationInHours, deepSleepDurationInHours, 
     lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
     startTimeInSeconds, startTimeOffsetInSeconds
     FROM sleep_summaries 
     WHERE userId = ? 
     ORDER BY calendarDate DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        logger.error('Error fetching user sleep data:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const sleepData = rows.map(row => ({
        date: row.calendarDate,
        totalHours: row.durationInHours || 0,
        deepHours: row.deepSleepDurationInHours || 0,
        lightHours: row.lightSleepDurationInHours || 0,
        remHours: row.remSleepInHours || 0,
        awakeHours: row.awakeDurationInHours || 0,
        startTimeSeconds: row.startTimeInSeconds,
        startTimeOffsetSeconds: row.startTimeOffsetInSeconds
      }));

      logger.info(`Fetched ${sleepData.length} sleep entries for user: ${userId}`);
      res.json(sleepData);
    }
  );
});

module.exports = router;
