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
        googlePlaySubscriptionId TEXT
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS moods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        datetime TEXT NOT NULL,
        rating INTEGER NOT NULL,
        comment TEXT,
        activities TEXT,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL UNIQUE,
        emailDailyNotifications INTEGER DEFAULT 1,
        emailWeeklySummary INTEGER DEFAULT 1,
        appDailyNotifications INTEGER DEFAULT 1,
        appWeeklySummary INTEGER DEFAULT 1,
        FOREIGN KEY (userId) REFERENCES users(id)
      )
    `);

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
