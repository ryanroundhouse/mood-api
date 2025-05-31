const sqlite3 = require('sqlite3').verbose();
const logger = require('./utils/logger');

const analyticsDb = new sqlite3.Database('analytics.sqlite');

function initializeAnalyticsDatabase() {
  analyticsDb.serialize(() => {
    // Check if table exists and get its schema
    analyticsDb.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='mood_submissions'", (err, row) => {
      if (err) {
        logger.error('Error checking mood_submissions table:', err);
        return;
      }

      if (row) {
        // Table exists, check if it needs updating
        const currentSchema = row.sql;
        if (currentSchema.includes("CHECK(source IN ('dashboard', 'email', 'app'))")) {
          logger.info('Updating mood_submissions table to support android/ios sources...');
          
          // Create new table with updated schema
          analyticsDb.run(`
            CREATE TABLE mood_submissions_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              submission_datetime TEXT NOT NULL,
              source TEXT NOT NULL CHECK(source IN ('dashboard', 'email', 'android', 'ios')),
              comment_length INTEGER NOT NULL DEFAULT 0,
              total_tags INTEGER NOT NULL DEFAULT 0,
              custom_tags_count INTEGER NOT NULL DEFAULT 0,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
          `, (createErr) => {
            if (createErr) {
              logger.error('Error creating new mood_submissions table:', createErr);
              return;
            }

            // Copy existing data
            analyticsDb.run(`
              INSERT INTO mood_submissions_new 
              SELECT * FROM mood_submissions
            `, (copyErr) => {
              if (copyErr) {
                logger.error('Error copying data to new table:', copyErr);
                return;
              }

              // Drop old table and rename new one
              analyticsDb.run(`DROP TABLE mood_submissions`, (dropErr) => {
                if (dropErr) {
                  logger.error('Error dropping old table:', dropErr);
                  return;
                }

                analyticsDb.run(`ALTER TABLE mood_submissions_new RENAME TO mood_submissions`, (renameErr) => {
                  if (renameErr) {
                    logger.error('Error renaming table:', renameErr);
                    return;
                  }
                  logger.info('mood_submissions table updated successfully to support android/ios sources');
                });
              });
            });
          });
        } else {
          logger.info('mood_submissions table already supports android/ios sources');
        }
      } else {
        // Table doesn't exist, create it with the new schema
        analyticsDb.run(`
          CREATE TABLE IF NOT EXISTS mood_submissions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            submission_datetime TEXT NOT NULL,
            source TEXT NOT NULL CHECK(source IN ('dashboard', 'email', 'android', 'ios')),
            comment_length INTEGER NOT NULL DEFAULT 0,
            total_tags INTEGER NOT NULL DEFAULT 0,
            custom_tags_count INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `, (createErr) => {
          if (createErr) {
            logger.error('Error creating mood_submissions table:', createErr);
          } else {
            logger.info('mood_submissions table created successfully with android/ios support');
          }
        });
      }
    });

    logger.info('Analytics database initialized successfully');
  });
}

// Standard/default activities that come pre-configured
const DEFAULT_ACTIVITIES = [
  'good sleep', 'worked out', 'sports', 'social', 'rested',
  'energized', 'active', 'connected', 'productive', 'relaxed'
];

function trackMoodSubmission(data) {
  return new Promise((resolve, reject) => {
    const {
      userId,
      submissionDatetime,
      source,
      comment,
      activities = []
    } = data;

    // Calculate metrics
    const commentLength = comment ? comment.length : 0;
    const totalTags = activities.length;
    
    // Count custom tags (activities not in the default list)
    const customTagsCount = activities.filter(activity => 
      !DEFAULT_ACTIVITIES.includes(activity.toLowerCase())
    ).length;

    analyticsDb.run(
      `INSERT INTO mood_submissions 
       (user_id, submission_datetime, source, comment_length, total_tags, custom_tags_count) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [userId, submissionDatetime, source, commentLength, totalTags, customTagsCount],
      function (err) {
        if (err) {
          logger.error('Error tracking mood submission:', err);
          reject(err);
        } else {
          logger.info(`Tracked mood submission analytics for user ${userId}: source=${source}, tags=${totalTags}, custom=${customTagsCount}`);
          resolve(this.lastID);
        }
      }
    );
  });
}

module.exports = {
  analyticsDb,
  initializeAnalyticsDatabase,
  trackMoodSubmission,
  DEFAULT_ACTIVITIES
}; 