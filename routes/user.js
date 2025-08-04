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

// Get user daily summaries data
router.get('/daily-summaries', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all(
    `SELECT calendarDate, steps, distanceInMeters, activeTimeInHours, 
     floorsClimbed, averageStressLevel, maxStressLevel, stressDurationInMinutes
     FROM daily_summaries 
     WHERE userId = ? 
     ORDER BY calendarDate DESC`,
    [userId],
    (err, rows) => {
      if (err) {
        logger.error('Error fetching user daily summaries data:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      const dailySummariesData = rows.map(row => ({
        date: row.calendarDate,
        steps: row.steps || 0,
        distanceInMeters: row.distanceInMeters || 0,
        activeTimeInHours: row.activeTimeInHours || 0,
        floorsClimbed: row.floorsClimbed || 0,
        averageStressLevel: row.averageStressLevel,
        maxStressLevel: row.maxStressLevel,
        stressDurationInMinutes: row.stressDurationInMinutes || 0
      }));

      logger.info(`Fetched ${dailySummariesData.length} daily summary entries for user: ${userId}`);
      res.json(dailySummariesData);
    }
  );
});

// Delete user account and all associated data
router.delete('/account', authenticateToken, (req, res) => {
  const userId = req.user.id;
  
  logger.info(`Account deletion requested for user: ${userId}`);
  
  // Begin transaction to ensure all deletions succeed or fail together
  db.serialize(() => {
    db.run('BEGIN TRANSACTION');
    
    let completedOperations = 0;
    let errors = [];
    const totalOperations = 10;
    
    function checkCompletion() {
      completedOperations++;
      if (completedOperations === totalOperations) {
        if (errors.length > 0) {
          logger.error(`Error during account deletion for user ${userId}:`, errors);
          db.run('ROLLBACK');
          return res.status(500).json({ 
            error: 'Failed to delete account. Please try again later.',
            details: errors
          });
        } else {
          db.run('COMMIT', (commitErr) => {
            if (commitErr) {
              logger.error(`Error committing account deletion for user ${userId}:`, commitErr);
              return res.status(500).json({ error: 'Failed to complete account deletion' });
            }
            
            logger.info(`Account successfully deleted for user: ${userId}`);
            res.json({ message: 'Account deleted successfully' });
          });
        }
      }
    }
    
    // Delete from custom_activities
    db.run('DELETE FROM custom_activities WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`custom_activities: ${err.message}`);
      } else {
        logger.info(`Deleted custom activities for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from moods
    db.run('DELETE FROM moods WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`moods: ${err.message}`);
      } else {
        logger.info(`Deleted moods for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from user_settings
    db.run('DELETE FROM user_settings WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`user_settings: ${err.message}`);
      } else {
        logger.info(`Deleted user settings for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from daily_summaries
    db.run('DELETE FROM daily_summaries WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`daily_summaries: ${err.message}`);
      } else {
        logger.info(`Deleted daily summaries for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from refresh_tokens
    db.run('DELETE FROM refresh_tokens WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`refresh_tokens: ${err.message}`);
      } else {
        logger.info(`Deleted refresh tokens for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from garmin_request_tokens
    db.run('DELETE FROM garmin_request_tokens WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`garmin_request_tokens: ${err.message}`);
      } else {
        logger.info(`Deleted Garmin request tokens for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from sleep_summaries
    db.run('DELETE FROM sleep_summaries WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`sleep_summaries: ${err.message}`);
      } else {
        logger.info(`Deleted sleep summaries for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from mood_auth_codes
    db.run('DELETE FROM mood_auth_codes WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`mood_auth_codes: ${err.message}`);
      } else {
        logger.info(`Deleted mood auth codes for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from summaries
    db.run('DELETE FROM summaries WHERE userId = ?', [userId], (err) => {
      if (err) {
        errors.push(`summaries: ${err.message}`);
      } else {
        logger.info(`Deleted summaries for user: ${userId}`);
      }
      checkCompletion();
    });
    
    // Delete from users (this should be last)
    db.run('DELETE FROM users WHERE id = ?', [userId], (err) => {
      if (err) {
        errors.push(`users: ${err.message}`);
      } else {
        logger.info(`Deleted user record for user: ${userId}`);
      }
      checkCompletion();
    });
  });
});

module.exports = router;
