const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const winston = require('winston');

// Configure winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'migration.log' }),
  ],
});

// Connect to the database
const db = new sqlite3.Database(path.join(__dirname, '../database.sqlite'), (err) => {
  if (err) {
    logger.error('Error connecting to database:', err);
    process.exit(1);
  }
  logger.info('Connected to database');
});

// Add the new column
db.run(`
  ALTER TABLE user_settings 
  ADD COLUMN appDailyNotificationTime TEXT DEFAULT '09:00'
`, (err) => {
  if (err) {
    // Column might already exist
    if (err.message.includes('duplicate column name')) {
      logger.info('Column appDailyNotificationTime already exists');
    } else {
      logger.error('Error adding column:', err);
      process.exit(1);
    }
  } else {
    logger.info('Successfully added appDailyNotificationTime column');
  }

  // Close the database connection
  db.close((err) => {
    if (err) {
      logger.error('Error closing database:', err);
      process.exit(1);
    }
    logger.info('Database connection closed');
    process.exit(0);
  });
});