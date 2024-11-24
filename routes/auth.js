const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { v4: uuidv4 } = require('uuid');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const transporter = require('../utils/mailer');

const BASE_URL = process.env.MOOD_SITE_URL || 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET;
const NOREPLY_EMAIL = process.env.NOREPLY_EMAIL;

// Register endpoint
router.post(
  '/register',
  strictLimiter,
  [
    body('email').isEmail(),
    body('name').optional().trim().escape(),
    body('password').isLength({ min: 6 }),
    body('paymentMethodId').optional().isString(),
  ],
  async (req, res) => {
    // Reference to register route in server.js
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
        // Create Stripe customer and handle subscription
        // Reference to stripe customer creation in server.js
        const customer = await stripe.customers.create({
          email,
          name,
          metadata: { verificationToken },
        });

        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: customer.id,
        });

        await stripe.customers.update(customer.id, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });

        const subscription = await stripe.subscriptions.create({
          customer: customer.id,
          items: [{ price: process.env.STRIPE_PRICE_ID }],
          expand: ['latest_invoice.payment_intent'],
        });

        stripeCustomerId = customer.id;
        stripeSubscriptionId = subscription.id;

        if (subscription.latest_invoice.payment_intent.status === 'succeeded') {
          accountLevel = 'pro';
        }
      }

      // Insert user into database
      db.run(
        `INSERT INTO users (email, name, password, verificationToken, stripeCustomerId, stripeSubscriptionId, accountLevel) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
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

          // Insert default notification settings
          db.run(
            `INSERT INTO user_settings (userId) VALUES (?)`,
            [this.lastID],
            (settingsErr) => {
              if (settingsErr) {
                logger.error(
                  'Error inserting default user settings:',
                  settingsErr
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

// Login endpoint
router.post('/login', strictLimiter, async (req, res) => {
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
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 days

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

// Verify email endpoint
router.get('/verify/:token', (req, res) => {
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
          res.redirect(
            `/verified.html?verified=true&email=${encodeURIComponent(
              user.email
            )}`
          );
        }
      );
    }
  );
});

// Forgot password endpoint
router.post('/forgot-password', strictLimiter, (req, res) => {
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

        const resetLink = `${BASE_URL}/reset.html?token=${resetToken}`;
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

// Reset password endpoint
router.post('/reset-password/:token', strictLimiter, (req, res) => {
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

// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
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

// Logout endpoint
router.post('/logout', authenticateToken, (req, res) => {
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

module.exports = router;
