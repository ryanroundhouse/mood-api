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
    body('timezone').optional().isString(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let { datetime, rating, comment, activities, timezone } = req.body;
    const userId = req.user.id;

    // Store datetime as provided (local time with offset), do not convert
    // If datetime is not provided, use current local time with offset (from server)
    if (!datetime) {
      datetime = new Date().toISOString();
    }
    // timezone can be null if not provided

    // Encrypt the comment if it exists
    const encryptedComment = comment ? encrypt(comment) : null;

    // Convert activities array to JSON string
    const activitiesJson = activities ? JSON.stringify(activities) : null;

    // Get the local date part (YYYY-MM-DD) from the datetime string
    const localDay = datetime.split('T')[0];

    logger.info(
      `Searching for existing mood on local day: ${localDay}`
    );
    db.get(
      `SELECT * FROM moods WHERE userId = ? AND DATE(datetime) = ?`,
      [userId, localDay],
      (err, mood) => {
        if (err) {
          logger.error('Error creating/updating mood:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (mood) {
          db.run(
            `UPDATE moods SET datetime = ?, rating = ?, comment = ?, activities = ?, timezone = ? WHERE id = ?`,
            [datetime, rating, encryptedComment, activitiesJson, timezone, mood.id],
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
                timezone,
              });
            }
          );
        } else {
          db.run(
            `INSERT INTO moods (userId, datetime, rating, comment, activities, timezone) VALUES (?, ?, ?, ?, ?, ?)`,
            [userId, datetime, rating, encryptedComment, activitiesJson, timezone],
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
                timezone,
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
    body('timezone').optional().isString(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { authCode } = req.params;
    const { rating, comment, activities, timezone } = req.body;
    // Store datetime as provided (local time, no offset)
    let datetime = req.body.datetime || new Date().toISOString().slice(0, 19);
    const localDay = datetime.split('T')[0];

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

        // Check if a mood already exists for this user on this local day
        db.get(
          `SELECT id FROM moods WHERE userId = ? AND DATE(datetime) = ?`,
          [userId, localDay],
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
                `UPDATE moods SET rating = ?, comment = ?, datetime = ?, activities = ?, timezone = ? WHERE id = ?`,
                [rating, encryptedComment, datetime, activitiesJson, timezone, row.id],
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
                `INSERT INTO moods (userId, datetime, rating, comment, activities, timezone) VALUES (?, ?, ?, ?, ?, ?)`,
                [userId, datetime, rating, encryptedComment, activitiesJson, timezone],
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
