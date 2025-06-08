const sqlite3 = require('sqlite3').verbose();
const logger = require('./utils/logger');

const db = new sqlite3.Database('database.sqlite');

function initializeDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT,
        password TEXT NOT NULL,
        isVerified INTEGER DEFAULT 0,
        verificationToken TEXT,
        resetPasswordToken TEXT,
        resetPasswordExpires INTEGER,
        accountLevel TEXT DEFAULT 'basic' CHECK(accountLevel IN ('basic', 'pro', 'enterprise')),
        stripeCustomerId TEXT,
        stripeSubscriptionId TEXT,
        stripeSubscriptionStatus TEXT DEFAULT 'none',
        googlePlaySubscriptionId TEXT
      )
    `);

    // Migration: add stripeSubscriptionStatus and Garmin columns if they don't exist
    db.all("PRAGMA table_info(users)", (err, columns) => {
      if (err) {
        logger.error('Error checking users table columns:', err);
        return;
      }
      
      // Check if the columns exist in the returned array
      let hasSubscriptionStatus = false;
      let hasGarminAccessToken = false;
      let hasGarminTokenSecret = false;
      let hasGarminUserId = false;
      let hasGarminConnected = false;
      
      if (Array.isArray(columns)) {
        for (const col of columns) {
          if (col.name === 'stripeSubscriptionStatus') {
            hasSubscriptionStatus = true;
          } else if (col.name === 'garminAccessToken') {
            hasGarminAccessToken = true;
          } else if (col.name === 'garminTokenSecret') {
            hasGarminTokenSecret = true;
          } else if (col.name === 'garminUserId') {
            hasGarminUserId = true;
          } else if (col.name === 'garminConnected') {
            hasGarminConnected = true;
          }
        }
      }
      
      // Add missing columns
      if (!hasSubscriptionStatus) {
        db.run("ALTER TABLE users ADD COLUMN stripeSubscriptionStatus TEXT DEFAULT 'none'", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add stripeSubscriptionStatus column:', alterErr);
          } else {
            logger.info('stripeSubscriptionStatus column added to users table');
          }
        });
      }
      
      if (!hasGarminAccessToken) {
        db.run("ALTER TABLE users ADD COLUMN garminAccessToken TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add garminAccessToken column:', alterErr);
          } else {
            logger.info('garminAccessToken column added to users table');
          }
        });
      }
      
      if (!hasGarminTokenSecret) {
        db.run("ALTER TABLE users ADD COLUMN garminTokenSecret TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add garminTokenSecret column:', alterErr);
          } else {
            logger.info('garminTokenSecret column added to users table');
          }
        });
      }
      
      if (!hasGarminUserId) {
        db.run("ALTER TABLE users ADD COLUMN garminUserId TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add garminUserId column:', alterErr);
          } else {
            logger.info('garminUserId column added to users table');
          }
        });
      }
      
      if (!hasGarminConnected) {
        db.run("ALTER TABLE users ADD COLUMN garminConnected INTEGER DEFAULT 0", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add garminConnected column:', alterErr);
          } else {
            logger.info('garminConnected column added to users table');
          }
        });
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS moods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        datetime TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        activities TEXT,
        timezone TEXT,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    // Migration: add timezone column if it doesn't exist
    db.all("PRAGMA table_info(moods)", (err, columns) => {
      if (err) {
        logger.error('Error checking moods table columns:', err);
        return;
      }
      let hasTimezone = false;
      if (Array.isArray(columns)) {
        for (const col of columns) {
          if (col.name === 'timezone') {
            hasTimezone = true;
            break;
          }
        }
      }
      if (!hasTimezone) {
        db.run("ALTER TABLE moods ADD COLUMN timezone TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add timezone column:', alterErr);
          } else {
            logger.info('timezone column added to moods table');
          }
        });
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL UNIQUE,
        emailDailyNotifications INTEGER DEFAULT 1,
        emailWeeklySummary INTEGER DEFAULT 1,
        appDailyNotifications INTEGER DEFAULT 1,
        appWeeklySummary INTEGER DEFAULT 1,
        moodEmojis TEXT,
        unsubscribeToken TEXT,
        ai_insights INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    // Migration: add unsubscribeToken column if it doesn't exist
    db.all("PRAGMA table_info(user_settings)", (err, columns) => {
      if (err) {
        logger.error('Error checking user_settings columns:', err);
        return;
      }
      
      // Check if the columns exist in the returned array
      let hasUnsubscribeToken = false;
      let hasAiInsights = false;
      if (Array.isArray(columns)) {
        for (const col of columns) {
          if (col.name === 'unsubscribeToken') {
            hasUnsubscribeToken = true;
          }
          if (col.name === 'ai_insights') {
            hasAiInsights = true;
          }
        }
      }
      
      // If the unsubscribeToken column doesn't exist, add it
      if (!hasUnsubscribeToken) {
        db.run("ALTER TABLE user_settings ADD COLUMN unsubscribeToken TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add unsubscribeToken column:', alterErr);
          } else {
            logger.info('unsubscribeToken column added to user_settings table');
          }
        });
      }

      // If the ai_insights column doesn't exist, add it
      if (!hasAiInsights) {
        db.run("ALTER TABLE user_settings ADD COLUMN ai_insights INTEGER NOT NULL DEFAULT 0", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add ai_insights column:', alterErr);
          } else {
            logger.info('ai_insights column added to user_settings table');
            
            // Update existing Pro and Enterprise users to have AI insights enabled
            db.run(`
              UPDATE user_settings 
              SET ai_insights = 1 
              WHERE userId IN (
                SELECT id FROM users 
                WHERE accountLevel IN ('pro', 'enterprise') AND isVerified = 1
              )
            `, (updateErr) => {
              if (updateErr) {
                logger.error('Failed to enable ai_insights for existing Pro/Enterprise users:', updateErr);
              } else {
                db.get("SELECT COUNT(*) as count FROM user_settings WHERE ai_insights = 1", (countErr, row) => {
                  if (!countErr && row) {
                    logger.info(`ai_insights enabled for ${row.count} existing Pro/Enterprise users`);
                  }
                });
              }
            });
          }
        });
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS mood_auth_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        authCode TEXT NOT NULL,
        expiresAt INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS custom_activities (
        userId INTEGER PRIMARY KEY,
        activities TEXT,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        date TEXT NOT NULL,
        basic TEXT,
        advanced TEXT,
        appDailyNotificationTime TEXT DEFAULT '20:00',
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expiresAt INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS garmin_request_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        requestToken TEXT NOT NULL,
        requestTokenSecret TEXT NOT NULL,
        callbackUrl TEXT,
        expiresAt INTEGER NOT NULL,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    // Migration: add callbackUrl column to garmin_request_tokens if it doesn't exist
    db.all("PRAGMA table_info(garmin_request_tokens)", (err, columns) => {
      if (err) {
        logger.error('Error checking garmin_request_tokens columns:', err);
        return;
      }
      
      let hasCallbackUrl = false;
      if (Array.isArray(columns)) {
        for (const col of columns) {
          if (col.name === 'callbackUrl') {
            hasCallbackUrl = true;
            break;
          }
        }
      }
      
      if (!hasCallbackUrl) {
        db.run("ALTER TABLE garmin_request_tokens ADD COLUMN callbackUrl TEXT", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add callbackUrl column to garmin_request_tokens:', alterErr);
          } else {
            logger.info('callbackUrl column added to garmin_request_tokens table');
          }
        });
      }
    });

    db.run(`
      CREATE TABLE IF NOT EXISTS sleep_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        garminUserId TEXT NOT NULL,
        summaryId TEXT NOT NULL,
        calendarDate TEXT NOT NULL,
        startTimeInSeconds INTEGER NOT NULL,
        startTimeOffsetInSeconds INTEGER,
        durationInHours REAL NOT NULL,
        deepSleepDurationInHours REAL DEFAULT 0,
        lightSleepDurationInHours REAL DEFAULT 0,
        remSleepInHours REAL DEFAULT 0,
        awakeDurationInHours REAL DEFAULT 0,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (userId) REFERENCES users(id),
        UNIQUE(userId, calendarDate)
      )
    `);

    // Create index for efficient querying
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_sleep_summaries_user_date 
      ON sleep_summaries(userId, calendarDate)
    `);

    db.run(`
      CREATE INDEX IF NOT EXISTS idx_sleep_summaries_garmin_user 
      ON sleep_summaries(garminUserId)
    `);

    logger.info('Database tables initialized successfully');
  });
}

module.exports = {
  db: db,
  initializeDatabase,
};
