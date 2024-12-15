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
const db = new sqlite3.Database(
  path.join(__dirname, '../database.sqlite'),
  (err) => {
    if (err) {
      logger.error('Error connecting to database:', err);
      process.exit(1);
    }
    logger.info('Connected to database');
  }
);

// Check if column exists first
db.get(
  `
  SELECT COUNT(*) as count 
  FROM pragma_table_info('user_settings') 
  WHERE name='moodEmojis'
  `,
  (err, row) => {
    if (err) {
      logger.error('Error checking for column:', err);
      closeAndExit(1);
      return;
    }

    if (row.count > 0) {
      logger.info('Column moodEmojis already exists');
      closeAndExit(0);
      return;
    }

    // Add the new column if it doesn't exist
    db.run(
      `
      ALTER TABLE user_settings 
      ADD COLUMN moodEmojis TEXT
    `,
      (err) => {
        if (err) {
          logger.error('Error adding column:', err);
          closeAndExit(1);
          return;
        }
        logger.info('Successfully added moodEmojis column');
        closeAndExit(0);
      }
    );
  }
);

function closeAndExit(code) {
  db.close((err) => {
    if (err) {
      logger.error('Error closing database:', err);
      process.exit(1);
    }
    logger.info('Database connection closed');
    process.exit(code);
  });
}