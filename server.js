const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const app = express();
const port = 3000;
const winston = require('winston');
const fs = require('fs');
const mg = require('nodemailer-mailgun-transport');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios'); // Make sure to install axios: npm install axios
const rateLimit = require('express-rate-limit');
const { DateTime } = require('luxon'); // Make sure to install luxon: npm install luxon
const cors = require('cors'); // Make sure to install cors: npm install cors
const { v4: uuidv4 } = require('uuid'); // Make sure to install uuid: npm install uuid

// Add this near the top of your file, after other imports
const isDevelopment = process.env.NODE_ENV === 'development';

// Configure winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'app.log' }),
  ],
});

// SQLite database connection
const db = new sqlite3.Database('database.sqlite');

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
      accountLevel TEXT DEFAULT 'basic' CHECK(accountLevel IN ('basic', 'pro', 'enterprise'))
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
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL UNIQUE,
      dailyNotifications INTEGER DEFAULT 1,
      weeklySummary INTEGER DEFAULT 1,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);

  // Populate notifications table for existing users
  db.run(`
    INSERT OR IGNORE INTO notifications (userId)
    SELECT id FROM users
  `);
  // Create mood_auth_codes table if it doesn't exist
  db.run(`
  CREATE TABLE IF NOT EXISTS mood_auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    authCode TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    FOREIGN KEY (userId) REFERENCES users(id)
  )
  `);

  // Add accountLevel column to existing users table if it doesn't exist
  db.all(`PRAGMA table_info(users)`, (err, rows) => {
    if (err) {
      logger.error('Error checking users table schema:', err);
    } else if (rows && Array.isArray(rows)) {
      const accountLevelExists = rows.some(
        (row) => row.name === 'accountLevel'
      );
      if (!accountLevelExists) {
        db.run(
          `
          ALTER TABLE users
          ADD COLUMN accountLevel TEXT DEFAULT 'basic' CHECK(accountLevel IN ('basic', 'pro', 'enterprise'))
        `,
          (alterErr) => {
            if (alterErr) {
              logger.error('Error adding accountLevel column:', alterErr);
            } else {
              logger.info('accountLevel column added to users table');
            }
          }
        );
      }
    } else {
      logger.error('Unexpected result from PRAGMA table_info(users)');
    }
  });

  // Add activities column to moods table if it doesn't exist
  db.run(
    `
    ALTER TABLE moods ADD COLUMN activities TEXT
  `,
    (err) => {
      if (err && !err.message.includes('duplicate column name')) {
        logger.error('Error adding activities column to moods table:', err);
      } else {
        logger.info('Activities column added to moods table or already exists');
      }
    }
  );

  // Create custom_activities table
  db.run(`
    CREATE TABLE IF NOT EXISTS custom_activities (
      userId INTEGER PRIMARY KEY,
      activities TEXT,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY,
      basic TEXT,
      advanced TEXT,
      FOREIGN KEY (id) REFERENCES users(id)
    )
  `);

  // Add columns to users table if they don't exist
  db.all(`PRAGMA table_info(users)`, (err, rows) => {
    if (err) {
      logger.error('Error checking users table schema:', err);
    } else if (rows && Array.isArray(rows)) {
      const columnsToAdd = [
        { name: 'stripeCustomerId', type: 'TEXT' },
        { name: 'stripeSubscriptionId', type: 'TEXT' },
      ];

      columnsToAdd.forEach((column) => {
        const columnExists = rows.some((row) => row.name === column.name);
        if (!columnExists) {
          db.run(
            `ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`,
            (alterErr) => {
              if (alterErr) {
                logger.error(`Error adding ${column.name} column:`, alterErr);
              } else {
                logger.info(`${column.name} column added to users table`);
              }
            }
          );
        }
      });
    } else {
      logger.error('Unexpected result from PRAGMA table_info(users)');
    }
  });

  // Modify mood datetime values to add '-04:00' if not present
  db.all(`SELECT id, datetime FROM moods`, [], (err, rows) => {
    if (err) {
      logger.error('Error fetching moods for datetime update:', err);
      return;
    }

    rows.forEach((row) => {
      let updatedDatetime = row.datetime;
      if (
        !updatedDatetime.endsWith('Z') &&
        !updatedDatetime.match(/[+-]\d{2}:\d{2}$/)
      ) {
        updatedDatetime += '-04:00';
        db.run(
          `UPDATE moods SET datetime = ? WHERE id = ?`,
          [updatedDatetime, row.id],
          (updateErr) => {
            if (updateErr) {
              logger.error(
                `Error updating datetime for mood ${row.id}:`,
                updateErr
              );
            } else {
              logger.info(
                `Updated datetime for mood ${row.id}: ${updatedDatetime}`
              );
            }
          }
        );
      }
    });
  });

  db.run(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expiresAt INTEGER NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
});

// Set the base URL from environment variable or default to localhost
const BASE_URL = process.env.MOOD_SITE_URL || 'http://localhost:3000';
// JWT
const JWT_SECRET = process.env.JWT_SECRET;
// email credentials
const MAILGUN_API_KEY = process.env.MAILGUN_API_KEY;
const EMAIL_DOMAIN = process.env.EMAIL_DOMAIN;
const NOREPLY_EMAIL = process.env.NOREPLY_EMAIL;
const MY_EMAIL = process.env.EMAIL_ADDRESS;

app.use(express.json());
// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});
// Add this near the other middleware
app.use(express.urlencoded({ extended: true }));

// Nodemailer transporter setup
const auth = {
  auth: {
    api_key: MAILGUN_API_KEY, // Replace with your Mailgun API key
    domain: EMAIL_DOMAIN, // Replace with your Mailgun domain
  },
};

const transporter = nodemailer.createTransport(mg(auth));

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = { id: user.id, accountLevel: user.accountLevel };
    next();
  });
};

// Middleware to check if user has pro or enterprise account
const checkProOrEnterprise = (req, res, next) => {
  if (
    req.user.accountLevel === 'pro' ||
    req.user.accountLevel === 'enterprise'
  ) {
    next();
  } else {
    res
      .status(403)
      .json({ error: 'Access denied. Pro or Enterprise account required.' });
  }
};

// Define a general rate limiter with debugging
const generalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply the general rate limiter to all routes
app.use(generalLimiter);

// Define a stricter rate limiter for sensitive routes
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 5 requests per windowMs
  message:
    'Too many requests for this sensitive operation, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply the strict rate limiter to sensitive routes
app.use('/api/register', strictLimiter);
app.use('/api/login', strictLimiter);
app.use('/api/forgot-password', strictLimiter);
app.use('/api/reset-password', strictLimiter);
app.use('/api/upgrade', strictLimiter);
app.use('/api/downgrade', strictLimiter);

// Helper function to get current EST datetime
function getCurrentESTDateTime() {
  return DateTime.now().setZone('America/New_York').toISO();
}

// Helper function to convert UTC to EST
function convertToEST(utcDateString) {
  return DateTime.fromISO(utcDateString).setZone('America/New_York').toISO();
}

// Add this middleware before your routes
if (isDevelopment) {
  app.use(cors());
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, DELETE, OPTIONS'
    );
    res.header(
      'Access-Control-Allow-Headers',
      'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );
    next();
  });
}

// Endpoint to get user settings
app.get('/api/user/settings', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT users.name, users.email, users.accountLevel, notifications.dailyNotifications, notifications.weeklySummary 
     FROM users 
     LEFT JOIN notifications ON users.id = notifications.userId 
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
        dailyNotifications: row.dailyNotifications === 1,
        weeklySummary: row.weeklySummary === 1,
      };

      logger.info(`User settings fetched for user: ${userId}`);
      res.json(userSettings);
    }
  );
});

// Endpoint to update user settings
app.put(
  '/api/user/settings',
  authenticateToken,
  [
    body('name').optional().trim().isLength({ min: 1 }),
    body('dailyNotifications').optional().isBoolean(),
    body('weeklySummary').optional().isBoolean(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = req.user.id;
    const { name, dailyNotifications, weeklySummary } = req.body;

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

      if (dailyNotifications !== undefined || weeklySummary !== undefined) {
        const updates = [];
        const values = [];

        if (dailyNotifications !== undefined) {
          updates.push('dailyNotifications = ?');
          values.push(dailyNotifications ? 1 : 0);
        }

        if (weeklySummary !== undefined) {
          updates.push('weeklySummary = ?');
          values.push(weeklySummary ? 1 : 0);
        }

        values.push(userId);

        db.run(
          `UPDATE notifications SET ${updates.join(', ')} WHERE userId = ?`,
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

// mood by auth code
app.post(
  '/api/mood/:authCode',
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
                [rating, comment, datetime, activitiesJson, row.id],
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
                [userId, datetime, rating, comment, activitiesJson],
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

// register
app.post(
  '/api/register',
  strictLimiter,
  [
    body('email').isEmail(),
    body('name').optional().trim().escape(),
    body('password').isLength({ min: 6 }),
    body('paymentMethodId').optional().isString(), // Make payment method ID optional
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, name, password, paymentMethodId } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);
      const verificationToken = crypto.randomBytes(20).toString('hex');

      let stripeCustomerId = null;
      let stripeSubscriptionId = null;
      let accountLevel = 'basic';

      if (paymentMethodId) {
        // Create Stripe customer
        const customer = await stripe.customers.create({
          email,
          name,
          metadata: { verificationToken },
        });

        // Attach payment method to customer
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: customer.id,
        });

        // Set the default payment method for the customer
        await stripe.customers.update(customer.id, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });

        // Create subscription
        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: process.env.STRIPE_PRICE_ID }],
          expand: ['latest_invoice.payment_intent'],
        });

        stripeCustomerId = customer.id;
        stripeSubscriptionId = subscription.id;

        // Update account level based on payment status
        if (subscription.latest_invoice.payment_intent.status === 'succeeded') {
          accountLevel = 'pro';
        }
      }

      db.run(
        `INSERT INTO users (email, name, password, verificationToken, stripeCustomerId, stripeSubscriptionId, accountLevel) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          email,
          name,
          hashedPassword,
          verificationToken,
          stripeCustomerId,
          stripeSubscriptionId,
          accountLevel,
        ],
        function (err) {
          if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
              return res.status(400).json({ error: 'Email already exists' });
            }
            return res.status(500).json({ error: 'Error registering user' });
          }

          // Insert default notification settings for the new user
          db.run(
            `INSERT INTO notifications (userId) VALUES (?)`,
            [this.lastID],
            (notificationErr) => {
              if (notificationErr) {
                logger.error(
                  'Error inserting default notification settings:',
                  notificationErr
                );
              }
            }
          );

          // Send verification email
          const verificationLink = `${BASE_URL}/api/verify/${verificationToken}`;
          transporter.sendMail({
            from: NOREPLY_EMAIL,
            to: email,
            subject: 'Verify your email',
            html: `Please click this link to verify your email: <a href="${verificationLink}">${verificationLink}</a>`,
          });

          logger.info(`User registered successfully: ${email}`);
          res.status(201).json({
            message:
              'User created successfully. Please check your email to verify your account.',
          });
        }
      );
    } catch (error) {
      logger.error('Error during registration:', error);
      res.status(500).json({ error: 'Error registering user' });
    }
  }
);

// verify email
app.get('/api/verify/:token', (req, res) => {
  const { token } = req.params;

  db.get(
    `SELECT * FROM users WHERE verificationToken = ?`,
    [token],
    (err, user) => {
      if (err) {
        logger.error('Error verifying email:', err);
        return res.status(500).json({ error: 'Error verifying email' });
      }

      if (!user) {
        return res.status(400).json({ error: 'Invalid verification token' });
      }

      db.run(
        `UPDATE users SET isVerified = 1, verificationToken = NULL WHERE id = ?`,
        [user.id],
        (err) => {
          if (err) {
            logger.error('Error verifying email:', err);
            return res.status(500).json({ error: 'Error verifying email' });
          }

          logger.info(`Email verified successfully for user: ${user.email}`);
          // Redirect to login page with verified=true parameter
          res.redirect('/login.html?verified=true');
        }
      );
    }
  );
});

// login
app.post('/api/login', strictLimiter, async (req, res) => {
  const { email, password } = req.body;

  db.get(`SELECT * FROM users WHERE email = ?`, [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Error logging in' });
    }

    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    if (!user.isVerified) {
      return res
        .status(400)
        .json({ error: 'Please verify your email before logging in' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    const accessToken = jwt.sign(
      { id: user.id, accountLevel: user.accountLevel },
      JWT_SECRET,
      { expiresIn: '15m' }
    );

    const refreshToken = uuidv4();
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days from now

    db.run(
      `INSERT INTO refresh_tokens (userId, token, expiresAt) VALUES (?, ?, ?)`,
      [user.id, refreshToken, expiresAt],
      (err) => {
        if (err) {
          logger.error('Error storing refresh token:', err);
          return res.status(500).json({ error: 'Error logging in' });
        }

        logger.info(`User logged in successfully: ${email}`);
        res.json({ accessToken, refreshToken });
      }
    );
  });
});

// mood when authenticated
app.post(
  '/api/mood',
  authenticateToken,
  [
    body('datetime').optional().isISO8601().toDate(),
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

    // If no datetime is supplied, use current EST datetime
    if (!datetime) {
      datetime = getCurrentESTDateTime();
    } else {
      // Convert provided datetime to EST
      datetime = convertToEST(datetime);
    }

    // Convert activities array to JSON string
    const activitiesJson = activities ? JSON.stringify(activities) : null;

    // Get the start and end of the day for the given datetime
    const startOfDay = new Date(datetime);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(datetime);
    endOfDay.setHours(23, 59, 59, 999);

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
            [datetime, rating, comment, activitiesJson, mood.id],
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
                comment,
                activities,
              });
            }
          );
        } else {
          db.run(
            `INSERT INTO moods (userId, datetime, rating, comment, activities) VALUES (?, ?, ?, ?, ?)`,
            [userId, datetime, rating, comment, activitiesJson],
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
                comment,
                activities,
              });
            }
          );
        }
      }
    );
  }
);

// get moods
app.get('/api/moods', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.all(
    `SELECT * FROM moods WHERE userId = ? ORDER BY datetime DESC`,
    [userId],
    (err, moods) => {
      if (err) {
        logger.error('Error fetching moods:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      logger.info(`Fetched all moods for user: ${userId}`);
      res.json(moods);
    }
  );
});

// New route for forgot password
app.post('/api/forgot-password', strictLimiter, (req, res) => {
  const { email } = req.body;

  db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
    if (err) {
      logger.error('Error in forgot password:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');
    const resetPasswordExpires = DateTime.now()
      .setZone('America/New_York')
      .plus({ hours: 1 })
      .toMillis();

    db.run(
      `UPDATE users SET resetPasswordToken = ?, resetPasswordExpires = ? WHERE id = ?`,
      [resetToken, resetPasswordExpires, user.id],
      (err) => {
        if (err) {
          logger.error('Error in forgot password:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        const resetLink = `${BASE_URL}/reset-password.html?token=${resetToken}`;
        transporter.sendMail({
          from: NOREPLY_EMAIL,
          to: email,
          subject: 'Password Reset',
          html: `Please click this link to reset your password: <a href="${resetLink}">${resetLink}</a>`,
        });

        logger.info(`Password reset email sent to: ${email}`);
        res.json({ message: 'Password reset email sent' });
      }
    );
  });
});

// New route for password reset
app.post('/api/reset-password/:token', strictLimiter, (req, res) => {
  const { token } = req.params;
  const { password } = req.body;

  db.get(
    `SELECT * FROM users WHERE resetPasswordToken = ? AND resetPasswordExpires > ?`,
    [token, Date.now()],
    async (err, user) => {
      if (err) {
        logger.error('Error in password reset:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!user) {
        return res
          .status(400)
          .json({ error: 'Invalid or expired reset token' });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      db.run(
        `UPDATE users SET password = ?, resetPasswordToken = NULL, resetPasswordExpires = NULL WHERE id = ?`,
        [hashedPassword, user.id],
        (err) => {
          if (err) {
            logger.error('Error in password reset:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          logger.info(`Password reset successfully for user: ${user.email}`);
          res.json({ message: 'Password reset successful' });
        }
      );
    }
  );
});

// GET endpoint for user activities
app.get(
  '/api/user/activities',
  authenticateToken,
  checkProOrEnterprise,
  (req, res) => {
    const userId = req.user.id;

    db.get(
      'SELECT activities FROM custom_activities WHERE userId = ?',
      [userId],
      (err, row) => {
        if (err) {
          logger.error('Error fetching user activities:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        const activities = row ? JSON.parse(row.activities) : [];
        res.json({ activities });
      }
    );
  }
);

// POST endpoint for user activities
app.post(
  '/api/user/activities',
  authenticateToken,
  checkProOrEnterprise,
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
    const { activities } = req.body;
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
        res.json({ message: 'Activities updated successfully', activities });
      }
    );
  }
);

// GET endpoint for user activities using auth code
app.get('/api/user/activities/:authCode', (req, res) => {
  const { authCode } = req.params;

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
        logger.warn(`Expired auth code used: ${authCode}`);
        return res.status(401).json({ error: 'Auth code has expired' });
      }

      const userId = row.userId;

      // Check if the user has a pro or enterprise account
      db.get(
        'SELECT accountLevel FROM users WHERE id = ?',
        [userId],
        (err, userRow) => {
          if (err) {
            logger.error('Error fetching user account level:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (
            !userRow ||
            (userRow.accountLevel !== 'pro' &&
              userRow.accountLevel !== 'enterprise')
          ) {
            return res.status(403).json({
              error: 'Access denied. Pro or Enterprise account required.',
            });
          }

          // Fetch custom activities
          db.get(
            'SELECT activities FROM custom_activities WHERE userId = ?',
            [userId],
            (err, activitiesRow) => {
              if (err) {
                logger.error('Error fetching user activities:', err);
                return res.status(500).json({ error: 'Internal server error' });
              }

              const activities = activitiesRow
                ? JSON.parse(activitiesRow.activities)
                : [];
              logger.info(`Custom activities fetched for user: ${userId}`);
              res.json({ activities });
            }
          );
        }
      );
    }
  );
});

// Contact form submission endpoint
app.post(
  '/api/contact',
  [
    body('name').trim().isLength({ min: 1, max: 100 }).escape(),
    body('email').isEmail().normalizeEmail(),
    body('subject').trim().isLength({ min: 1, max: 200 }).escape(),
    body('message').trim().isLength({ min: 1, max: 1000 }).escape(),
    body('recaptchaToken').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, subject, message, recaptchaToken } = req.body;

    // Verify reCAPTCHA token
    try {
      const recaptchaResponse = await axios.post(
        `https://www.google.com/recaptcha/api/siteverify?secret=${process.env.RECAPTCHA_SECRET_KEY}&response=${recaptchaToken}`
      );

      if (
        !recaptchaResponse.data.success ||
        recaptchaResponse.data.score < 0.5
      ) {
        logger.warn(`reCAPTCHA verification failed for ${email}`);
        return res.status(400).json({ error: 'reCAPTCHA verification failed' });
      }
    } catch (error) {
      logger.error('Error verifying reCAPTCHA:', error);
      return res.status(500).json({ error: 'Error verifying reCAPTCHA' });
    }

    // Send email
    transporter.sendMail(
      {
        from: NOREPLY_EMAIL,
        to: MY_EMAIL,
        subject: `New Contact Form Submission: ${subject}`,
        html: `
          <h3>New contact form submission</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> ${email}</p>
          <p><strong>Subject:</strong> ${subject}</p>
          <p><strong>Message:</strong></p>
          <p>${message}</p>
        `,
      },
      (error, info) => {
        if (error) {
          logger.error('Error sending contact form email:', error);
          return res.status(500).json({ error: 'Error sending message' });
        }

        logger.info(`Contact form submission from ${email}`);
        res.status(200).json({ message: 'Message sent successfully' });
      }
    );
  }
);

// Endpoint to handle Stripe webhook events
app.post(
  '/api/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error('Webhook signature verification failed:', err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        logger.info(
          `PaymentIntent for ${paymentIntent.amount} was successful!`
        );
        // Handle successful payment here
        break;
      // Add more event types as needed
      default:
        logger.warn(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Endpoint to handle account upgrade
app.post('/api/upgrade', authenticateToken, strictLimiter, async (req, res) => {
  const { paymentMethodId } = req.body;
  const userId = req.user.id;

  try {
    // Fetch user details from the database
    db.get(
      `SELECT email, name, stripeCustomerId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        let stripeCustomerId = user.stripeCustomerId;

        if (!stripeCustomerId) {
          // Create Stripe customer if not already created
          const customer = await stripe.customers.create({
            email: user.email,
            name: user.name,
          });

          stripeCustomerId = customer.id;

          // Update user with the new Stripe customer ID
          db.run(
            `UPDATE users SET stripeCustomerId = ? WHERE id = ?`,
            [stripeCustomerId, userId],
            (updateErr) => {
              if (updateErr) {
                logger.error('Error updating Stripe customer ID:', updateErr);
                return res.status(500).json({ error: 'Internal server error' });
              }
            }
          );
        }

        // Attach payment method to customer
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: stripeCustomerId,
        });

        // Set the default payment method for the customer
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });

        // Create subscription
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: process.env.STRIPE_PRICE_ID }],
          expand: ['latest_invoice.payment_intent'],
        });

        // Update user with the new subscription ID and account level
        db.run(
          `UPDATE users SET stripeSubscriptionId = ?, accountLevel = 'pro' WHERE id = ?`,
          [subscription.id, userId],
          (updateErr) => {
            if (updateErr) {
              logger.error(
                'Error updating subscription ID and account level:',
                updateErr
              );
              return res.status(500).json({ error: 'Internal server error' });
            }

            logger.info(`User upgraded to Pro: ${user.email}`);
            res.json({ message: 'Your account has been upgraded to Pro!' });
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error during upgrade:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Endpoint to handle account downgrade
app.post(
  '/api/downgrade',
  authenticateToken,
  strictLimiter,
  async (req, res) => {
    const userId = req.user.id;

    try {
      // Fetch user details from the database
      db.get(
        `SELECT stripeSubscriptionId FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err) {
            logger.error('Error fetching user details:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user || !user.stripeSubscriptionId) {
            return res.status(404).json({ error: 'Subscription not found' });
          }

          // Cancel the Stripe subscription
          await stripe.subscriptions.cancel(user.stripeSubscriptionId);

          // Update user account level to 'basic' and remove subscription ID
          db.run(
            `UPDATE users SET stripeSubscriptionId = NULL, accountLevel = 'basic' WHERE id = ?`,
            [userId],
            (updateErr) => {
              if (updateErr) {
                logger.error('Error updating account level:', updateErr);
                return res.status(500).json({ error: 'Internal server error' });
              }

              logger.info(`User downgraded to Basic: ${userId}`);
              res.json({
                message: 'Your account has been downgraded to Basic.',
              });
            }
          );
        }
      );
    } catch (error) {
      logger.error('Error during downgrade:', error);
      res.status(500).json({ error: 'An error occurred. Please try again.' });
    }
  }
);

// New endpoint to get user's summary
app.get('/api/user/summary', authenticateToken, generalLimiter, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT basic, advanced FROM summaries WHERE id = ?`,
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
        basicInsights = JSON.parse(row.basic);
      } catch (error) {
        logger.error('Error parsing basic insights:', error);
        basicInsights = [];
      }

      try {
        aiInsights = JSON.parse(row.advanced);
      } catch (error) {
        logger.error('Error parsing AI insights:', error);
        aiInsights = [];
      }

      logger.info(`Summary fetched for user: ${userId}`);
      res.json({
        basicInsights: basicInsights,
        aiInsights: aiInsights,
      });
    }
  );
});

// Add a new endpoint for refreshing tokens
app.post('/api/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  db.get(
    `SELECT * FROM refresh_tokens WHERE token = ? AND expiresAt > ?`,
    [refreshToken, Date.now()],
    async (err, tokenData) => {
      if (err) {
        logger.error('Error verifying refresh token:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      if (!tokenData) {
        return res
          .status(401)
          .json({ error: 'Invalid or expired refresh token' });
      }

      db.get(
        `SELECT * FROM users WHERE id = ?`,
        [tokenData.userId],
        (err, user) => {
          if (err) {
            logger.error('Error fetching user for refresh token:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user) {
            return res.status(401).json({ error: 'User not found' });
          }

          const newAccessToken = jwt.sign(
            { id: user.id, accountLevel: user.accountLevel },
            JWT_SECRET,
            { expiresIn: '15m' }
          );

          logger.info(`Access token refreshed for user: ${user.id}`);
          res.json({ accessToken: newAccessToken });
        }
      );
    }
  );
});

// Add a new endpoint for logging out
app.post('/api/logout', authenticateToken, (req, res) => {
  const refreshToken = req.body.refreshToken;

  if (!refreshToken) {
    return res.status(400).json({ error: 'Refresh token is required' });
  }

  db.run(
    `DELETE FROM refresh_tokens WHERE token = ?`,
    [refreshToken],
    (err) => {
      if (err) {
        logger.error('Error deleting refresh token:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      logger.info(`User logged out successfully: ${req.user.id}`);
      res.json({ message: 'Logged out successfully' });
    }
  );
});

// Serve static files from the 'app' directory
app.use(express.static(path.join(__dirname, 'app')));

app.listen(port, () => {
  logger.info(`API listening at http://localhost:${port}`);
});
