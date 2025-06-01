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

    // Migration: add stripeSubscriptionStatus column if it doesn't exist
    db.all("PRAGMA table_info(users)", (err, columns) => {
      if (err) {
        logger.error('Error checking users table columns:', err);
        return;
      }
      
      // Check if the column exists in the returned array
      let hasSubscriptionStatus = false;
      if (Array.isArray(columns)) {
        for (const col of columns) {
          if (col.name === 'stripeSubscriptionStatus') {
            hasSubscriptionStatus = true;
            break;
          }
        }
      }
      
      // If the column doesn't exist, add it
      if (!hasSubscriptionStatus) {
        db.run("ALTER TABLE users ADD COLUMN stripeSubscriptionStatus TEXT DEFAULT 'none'", (alterErr) => {
          if (alterErr) {
            logger.error('Failed to add stripeSubscriptionStatus column:', alterErr);
          } else {
            logger.info('stripeSubscriptionStatus column added to users table');
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

    logger.info('Database tables initialized successfully');
  });
}

module.exports = {
  db: db,
  initializeDatabase,
};
