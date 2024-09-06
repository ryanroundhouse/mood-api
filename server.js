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
      resetPasswordExpires INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS moods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      datetime TEXT NOT NULL,
      rating INTEGER NOT NULL,
      comment TEXT,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);
});

// Gmail credentials
const GMAIL_USERNAME = process.env.GMAIL_USERNAME;
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD;
const MY_EMAIL = process.env.EMAIL_ADDRESS;
// JWT
const JWT_SECRET = process.env.JWT_SECRET;

app.use(express.json());

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Nodemailer transporter setup
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USERNAME,
    pass: GMAIL_PASSWORD,
  },
});

// Endpoint to post mood using one-time auth code
app.post('/mood/:authCode', (req, res) => {
  const { authCode } = req.params;
  const { rating, comment } = req.body;

  logger.info(`Attempting to post mood with auth code: ${authCode}`);

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
      const datetime = new Date().toISOString();

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
              `UPDATE moods SET rating = ?, comment = ?, datetime = ? WHERE id = ?`,
              [rating, comment, datetime, row.id],
              (updateErr) => {
                if (updateErr) {
                  logger.error('Error updating mood:', updateErr);
                  return res.status(500).json({ error: 'Error updating mood' });
                }
                logger.info(`Mood updated successfully for user ${userId}`);
                deleteAuthCodeAndRespond('Mood updated successfully');
              }
            );
          } else {
            // Insert new mood
            db.run(
              `INSERT INTO moods (userId, datetime, rating, comment) VALUES (?, ?, ?, ?)`,
              [userId, datetime, rating, comment],
              (insertErr) => {
                if (insertErr) {
                  logger.error('Error posting mood:', insertErr);
                  return res.status(500).json({ error: 'Error posting mood' });
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
              logger.info(`Auth code ${authCode} deleted after successful use`);
            }
          }
        );

        res.status(201).json({ message: message });
      }
    }
  );
});

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

// Updated User registration
app.post(
  '/register',
  [
    body('email').isEmail(),
    body('name').optional().trim().escape(),
    body('password').isLength({ min: 6 }),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, name, password } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);
      const verificationToken = crypto.randomBytes(20).toString('hex');

      db.run(
        `INSERT INTO users (email, name, password, verificationToken) VALUES (?, ?, ?, ?)`,
        [email, name, hashedPassword, verificationToken],
        function (err) {
          if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
              return res.status(400).json({ error: 'Email already exists' });
            }
            return res.status(500).json({ error: 'Error registering user' });
          }

          // Send verification email
          const verificationLink = `http://localhost:${port}/verify/${verificationToken}`;
          transporter.sendMail({
            from: 'moodmailer@gmail.com',
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

// New route for email verification
app.get('/verify/:token', (req, res) => {
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
          res.json({
            message: 'Email verified successfully. You can now log in.',
          });
        }
      );
    }
  );
});

// Updated User login
app.post('/login', (req, res) => {
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

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' });
    logger.info(`User logged in successfully: ${email}`);
    res.json({ token });
  });
});

// Enhanced mood creation route (now includes optional comment)
app.post(
  '/mood',
  authenticateToken,
  [
    body('datetime').optional().isISO8601().toDate(),
    body('rating').isInt({ min: 0, max: 5 }),
    body('comment').optional().isString().trim().isLength({ max: 500 }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    let { datetime, rating, comment } = req.body;
    const userId = req.user.id;

    // If no datetime is supplied, use today's datetime
    if (!datetime) {
      datetime = new Date().toISOString();
    }

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
            `UPDATE moods SET datetime = ?, rating = ?, comment = ? WHERE id = ?`,
            [datetime, rating, comment, mood.id],
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
              });
            }
          );
        } else {
          db.run(
            `INSERT INTO moods (userId, datetime, rating, comment) VALUES (?, ?, ?, ?)`,
            [userId, datetime, rating, comment],
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
              });
            }
          );
        }
      }
    );
  }
);

// Get all mood entries for the authenticated user
app.get('/moods', authenticateToken, (req, res) => {
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

// Error handling middleware
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

app.listen(port, () => {
  logger.info(`API listening at http://localhost:${port}`);
});

// New route for forgot password
app.post('/forgot-password', (req, res) => {
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
    const resetPasswordExpires = Date.now() + 3600000; // 1 hour

    db.run(
      `UPDATE users SET resetPasswordToken = ?, resetPasswordExpires = ? WHERE id = ?`,
      [resetToken, resetPasswordExpires, user.id],
      (err) => {
        if (err) {
          logger.error('Error in forgot password:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        const resetLink = `http://localhost:${port}/reset-password/${resetToken}`;
        transporter.sendMail({
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
app.post('/reset-password/:token', (req, res) => {
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

// Serve static content from the /app folder
app.use(express.static('app'));

app.get('*', (req, res) => {
  const filePath = path.join(__dirname, 'app', req.path);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.sendFile(path.join(__dirname, 'app', 'index.html'));
  }
});

// Add this near the other middleware
app.use(express.urlencoded({ extended: true }));

// Contact form submission endpoint
app.post(
  '/contact',
  [
    body('name').trim().isLength({ min: 1, max: 100 }).escape(),
    body('email').isEmail().normalizeEmail(),
    body('subject').trim().isLength({ min: 1, max: 200 }).escape(),
    body('message').trim().isLength({ min: 1, max: 1000 }).escape(),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, subject, message } = req.body;

    // Send email
    transporter.sendMail(
      {
        from: GMAIL_USERNAME,
        to: MY_EMAIL, // Send to yourself or a designated contact email
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
