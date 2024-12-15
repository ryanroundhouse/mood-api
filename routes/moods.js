const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/encryption');
const { getCurrentESTDateTime, convertToEST } = require('../utils/datetime');
const logger = require('../utils/logger');
const { db } = require('../database');

// POST mood when authenticated
router.post(
  '/',
  authenticateToken,
  [
    body('datetime').optional().isISO8601(),
    body('rating').isInt({ min: 0, max: 5 }),
    body('comment').optional().isString().trim().isLength({ max: 500 }),
    body('activities').optional().isArray(),
    body('activities.*').optional().isString().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let { datetime, rating, comment, activities } = req.body;
    const userId = req.user.id;

    // If datetime is not provided, use current EST datetime
    if (!datetime) {
      datetime = getCurrentESTDateTime();
    } else {
      // If datetime is provided, parse it and convert to EST
      datetime = convertToEST(new Date(datetime).toISOString());
    }

    // Encrypt the comment if it exists
    const encryptedComment = comment ? encrypt(comment) : null;

    // Convert activities array to JSON string
    const activitiesJson = activities ? JSON.stringify(activities) : null;

    // Get the start and end of the day for the given datetime
    const startOfDay = new Date(datetime);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(datetime);
    endOfDay.setHours(23, 59, 59, 999);

    logger.info(
      `Searching by date: ${startOfDay.toISOString()} to ${endOfDay.toISOString()}`
    );
    db.get(
      `SELECT * FROM moods WHERE userId = ? AND datetime >= ? AND datetime <= ?`,
      [userId, startOfDay.toISOString(), endOfDay.toISOString()],
      (err, mood) => {
        if (err) {
          logger.error('Error creating/updating mood:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (mood) {
          db.run(
            `UPDATE moods SET datetime = ?, rating = ?, comment = ?, activities = ? WHERE id = ?`,
            [datetime, rating, encryptedComment, activitiesJson, mood.id],
            function (err) {
              if (err) {
                logger.error('Error creating/updating mood:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              logger.info(`Mood updated successfully for user: ${userId}`);
              res.status(201).json({
                id: mood.id,
                userId,
                datetime,
                rating,
                comment, // Return the unencrypted comment to the client
                activities,
              });
            }
          );
        } else {
          db.run(
            `INSERT INTO moods (userId, datetime, rating, comment, activities) VALUES (?, ?, ?, ?, ?)`,
            [userId, datetime, rating, encryptedComment, activitiesJson],
            function (err) {
              if (err) {
                logger.error('Error creating/updating mood:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              logger.info(`Mood created successfully for user: ${userId}`);
              res.status(201).json({
                id: this.lastID,
                userId,
                datetime,
                rating,
                comment, // Return the unencrypted comment to the client
                activities,
              });
            }
          );
        }
      }
    );
  }
);

// POST mood by auth code
router.post(
  '/:authCode',
  [
    body('rating').isInt({ min: 0, max: 5 }),
    body('comment').optional().isString().trim().isLength({ max: 500 }),
    body('activities').optional().isArray(),
    body('activities.*').optional().isString().trim(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { authCode } = req.params;
    const { rating, comment, activities } = req.body;
    const datetime = getCurrentESTDateTime();

    // Encrypt the comment if it exists
    const encryptedComment = comment ? encrypt(comment) : null;

    logger.info(`Attempting to post mood with auth code: ${authCode}`);

    // Convert activities array to JSON string
    const activitiesJson = activities ? JSON.stringify(activities) : null;

    db.get(
      `SELECT userId, expiresAt FROM mood_auth_codes WHERE authCode = ?`,
      [authCode],
      (err, row) => {
        if (err) {
          logger.error('Error verifying mood auth code:', err);
          return res.status(500).json({ error: 'Error verifying auth code' });
        }

        if (!row) {
          logger.warn(`Invalid auth code used: ${authCode}`);
          return res.status(401).json({ error: 'Invalid auth code' });
        }

        if (Date.now() > row.expiresAt) {
          const now = Date.now();
          logger.warn(
            `Expired auth code used: ${authCode}. Current time: ${now}, Expiration time: ${row.expiresAt}`
          );
          return res.status(401).json({ error: 'Auth code has expired' });
        }

        const userId = row.userId;

        logger.info(`Posting mood for user ${userId} at ${datetime}`);

        // Check if a mood already exists for this user on this day
        const today = new Date(datetime).toISOString().split('T')[0];
        db.get(
          `SELECT id FROM moods WHERE userId = ? AND DATE(datetime) = DATE(?)`,
          [userId, today],
          (err, row) => {
            if (err) {
              logger.error('Error checking existing mood:', err);
              return res
                .status(500)
                .json({ error: 'Error checking existing mood' });
            }

            if (row) {
              // Update existing mood
              db.run(
                `UPDATE moods SET rating = ?, comment = ?, datetime = ?, activities = ? WHERE id = ?`,
                [rating, encryptedComment, datetime, activitiesJson, row.id],
                (updateErr) => {
                  if (updateErr) {
                    logger.error('Error updating mood:', updateErr);
                    return res
                      .status(500)
                      .json({ error: 'Error updating mood' });
                  }
                  logger.info(`Mood updated successfully for user ${userId}`);
                  deleteAuthCodeAndRespond('Mood updated successfully');
                }
              );
            } else {
              // Insert new mood
              db.run(
                `INSERT INTO moods (userId, datetime, rating, comment, activities) VALUES (?, ?, ?, ?, ?)`,
                [userId, datetime, rating, encryptedComment, activitiesJson],
                (insertErr) => {
                  if (insertErr) {
                    logger.error('Error posting mood:', insertErr);
                    return res
                      .status(500)
                      .json({ error: 'Error posting mood' });
                  }
                  logger.info(`Mood posted successfully for user ${userId}`);
                  deleteAuthCodeAndRespond('Mood posted successfully');
                }
              );
            }
          }
        );

        function deleteAuthCodeAndRespond(message) {
          // Delete the used auth code
          db.run(
            `DELETE FROM mood_auth_codes WHERE authCode = ?`,
            [authCode],
            (deleteErr) => {
              if (deleteErr) {
                logger.error('Error deleting used auth code:', deleteErr);
              } else {
                logger.info(
                  `Auth code ${authCode} deleted after successful use`
                );
              }
            }
          );

          res.status(201).json({ message: message });
        }
      }
    );
  }
);

// GET moods
router.get('/', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all(
    `SELECT * FROM moods WHERE userId = ? ORDER BY datetime DESC`,
    [userId],
    (err, moods) => {
      if (err) {
        logger.error('Error fetching moods:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      // Decrypt comments for each mood but leave activities as a string
      const decryptedMoods = moods.map((mood) => ({
        ...mood,
        comment: mood.comment ? 
          (() => {
            try {
              return decrypt(mood.comment);
            } catch (error) {
              logger.warn(`Failed to decrypt comment for mood ${mood.id}: ${error.message}`);
              return mood.comment; // Return the original comment if decryption fails
            }
          })() 
          : null
      }));

      logger.info(
        `Fetched and decrypted ${decryptedMoods.length} moods for user: ${userId}`
      );
      res.json(decryptedMoods);
    }
  );
});

module.exports = router;
