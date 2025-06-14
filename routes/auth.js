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

// Function to generate styled verification email HTML
function generateVerificationEmail(userName, verificationLink) {
  const currentDate = new Date().toLocaleDateString('en-US', { 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  });
  
  const greeting = userName ? `Hello ${userName}!` : 'Hello!';
  
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to Moodful - Verify Your Email</title>
        <style>
            body {
                font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
                line-height: 1.6;
                margin: 0;
                padding: 20px;
                background-color: #f8f9fa;
                color: #333;
            }
            .container {
                max-width: 700px;
                margin: 0 auto;
                background-color: white;
                border-radius: 10px;
                box-shadow: 0 0 20px rgba(0,0,0,0.1);
                overflow: hidden;
            }
            .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 40px;
                text-align: center;
            }
            .header h1 {
                margin: 0;
                font-size: 2.2em;
                font-weight: 300;
            }
            .header p {
                margin: 10px 0 0 0;
                font-size: 1.1em;
                opacity: 0.9;
            }
            .content {
                padding: 40px;
            }
            .greeting {
                font-size: 1.1em;
                margin-bottom: 25px;
                color: #2c3e50;
            }
            .welcome-section {
                background: #f8f9fa;
                border-left: 4px solid #667eea;
                padding: 25px;
                margin: 25px 0;
                border-radius: 0 8px 8px 0;
            }
            .welcome-section h3 {
                color: #667eea;
                margin-top: 0;
                font-size: 1.3em;
            }
            .verification-highlight {
                background: #e6ffe6;
                border: 2px solid #28a745;
                padding: 20px;
                margin: 20px 0;
                border-radius: 8px;
                text-align: center;
            }
            .verification-highlight h4 {
                color: #28a745;
                margin-top: 0;
            }
            .cta-button {
                display: inline-block;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white !important;
                padding: 15px 30px;
                text-decoration: none !important;
                border-radius: 25px;
                font-weight: bold;
                margin: 20px 10px 20px 0;
                transition: transform 0.2s;
                font-size: 1.1em;
            }
            .cta-button:hover {
                transform: translateY(-2px);
                color: white !important;
                text-decoration: none !important;
            }
            .cta-button:visited {
                color: white !important;
                text-decoration: none !important;
            }
            .cta-button:active {
                color: white !important;
                text-decoration: none !important;
            }
            .features-section {
                background: #fff3e0;
                border: 2px solid #ff9800;
                padding: 20px;
                margin: 20px 0;
                border-radius: 8px;
            }
            .features-section h4 {
                color: #f57c00;
                margin-top: 0;
            }
            .assurance {
                background: #e8f5e8;
                border: 1px solid #28a745;
                padding: 20px;
                margin: 25px 0;
                border-radius: 8px;
                text-align: center;
            }
            .assurance strong {
                color: #28a745;
            }
            .footer {
                background: #f8f9fa;
                padding: 30px;
                text-align: center;
                color: #6c757d;
                border-top: 1px solid #dee2e6;
                font-size: 0.9em;
            }
            .footer a {
                color: #667eea;
                text-decoration: none;
            }
            .footer a:hover {
                text-decoration: underline;
            }
            ul {
                padding-left: 20px;
            }
            li {
                margin-bottom: 8px;
            }
            .link-backup {
                background: #f8f9fa;
                border: 1px solid #dee2e6;
                padding: 15px;
                margin: 15px 0;
                border-radius: 5px;
                font-size: 0.9em;
                word-break: break-all;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎉 Welcome to Moodful!</h1>
                <p>Just one more step to get started</p>
            </div>
            
            <div class="content">
                <div class="greeting">
                    ${greeting}
                </div>
                
                <p>Thank you for joining Moodful! We're excited to help you track and understand your mood patterns, build healthy habits, and gain valuable insights into your wellbeing journey.</p>
                
                <div class="verification-highlight">
                    <h4>🔐 Please Verify Your Email Address</h4>
                    <p>To activate your account and ensure the security of your data, please click the button below to verify your email address.</p>
                    
                    <a href="${verificationLink}" class="cta-button">✅ Verify My Email</a>
                    
                    <p style="margin-top: 20px; font-size: 0.9em; color: #666;">
                        If the button doesn't work, you can copy and paste this link into your browser:
                    </p>
                    <div class="link-backup">
                        ${verificationLink}
                    </div>
                </div>
                
                <div class="welcome-section">
                    <h3>🌟 What's Next?</h3>
                    <p>Once you verify your email, you'll be able to:</p>
                    <ul>
                        <li>Start tracking your daily mood and energy levels</li>
                        <li>Log activities and see how they impact your wellbeing</li>
                        <li>View personalized insights and mood patterns</li>
                        <li>Set up custom notifications and reminders</li>
                        <li>Access your data from any device</li>
                    </ul>
                </div>
                
                <div class="features-section">
                    <h4>🚀 Getting Started Tips</h4>
                    <ul>
                        <li><strong>Daily Logging:</strong> Try to log your mood consistently for the best insights</li>
                        <li><strong>Track Activities:</strong> Note what you're doing when you log your mood</li>
                        <li><strong>Review Patterns:</strong> Check your dashboard weekly to spot trends</li>
                        <li><strong>Stay Consistent:</strong> Even 30 seconds a day can provide valuable data</li>
                    </ul>
                </div>
                
                <div class="assurance">
                    <strong>🛡️ Your Privacy is Protected</strong><br>
                    All your mood data is encrypted and securely stored. We never share your personal information with third parties, and you have full control over your data at all times.
                </div>
                
                <p>If you have any questions or need help getting started, don't hesitate to reach out to our support team. We're here to help you make the most of your wellbeing journey!</p>
                
                <p style="margin-top: 30px;">
                    Welcome aboard,<br>
                    <strong>The Moodful Team</strong>
                </p>
            </div>
            
            <div class="footer">
                <p>You're receiving this email because you created an account at Moodful.</p>
                <p>
                    <a href="https://moodful.ca">Moodful.ca</a> | 
                    <a href="https://moodful.ca/contact.html">Contact Us</a> | 
                    <a href="https://moodful.ca/privacy.html">Privacy Policy</a>
                </p>
                <p style="margin-top: 15px; font-size: 0.8em; color: #999;">
                    Sent on ${currentDate} | Moodful Account Verification
                </p>
            </div>
        </div>
    </body>
    </html>
  `;
}

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
      logger.error('Validation errors during registration:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, name, password, paymentMethodId } = req.body;
      const hashedPassword = await bcrypt.hash(password, 10);
      const verificationToken = crypto.randomBytes(20).toString('hex');

      let stripeCustomerId = null;
      let stripeSubscriptionId = null;
      let accountLevel = 'basic';
      let stripeSubscriptionStatus = null;

      if (paymentMethodId) {
        logger.info(`Creating Stripe customer and subscription for ${email}`);
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
        stripeSubscriptionStatus = subscription.status;
        
        logger.info(`Stripe subscription created: ID=${subscription.id}, Status=${subscription.status}, PaymentIntentStatus=${subscription.latest_invoice?.payment_intent?.status || 'unknown'}`);

        if (subscription.latest_invoice.payment_intent.status === 'succeeded') {
          accountLevel = 'pro';
          logger.info(`Setting account level to pro for ${email} - Payment succeeded`);
        } else {
          logger.warn(`Payment intent not succeeded for ${email}, status: ${subscription.latest_invoice.payment_intent.status}`);
          // Keep track of subscription status even if payment is not successful yet
          accountLevel = 'basic';
          
          // Make sure we always set the subscriptionStatus correctly regardless of payment state
          stripeSubscriptionStatus = subscription.status || 'incomplete';
        }
      }

      // Insert user into database
      db.run(
        `INSERT INTO users (email, name, password, verificationToken, stripeCustomerId, stripeSubscriptionId, accountLevel, stripeSubscriptionStatus) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          email,
          name,
          hashedPassword,
          verificationToken,
          stripeCustomerId,
          stripeSubscriptionId,
          accountLevel,
          stripeSubscriptionStatus,
        ],
        function (err) {
          if (err) {
            if (err.code === 'SQLITE_CONSTRAINT') {
              return res.status(400).json({ error: 'Email already exists' });
            }
            logger.error(`Error inserting user in database: ${err.message}`);
            return res.status(500).json({ error: 'Error registering user' });
          }

          logger.info(`User inserted in database with ID ${this.lastID}. Account level: ${accountLevel}, Subscription status: ${stripeSubscriptionStatus}`);

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
          try {
            const emailHtml = generateVerificationEmail(name, verificationLink);
            transporter.sendMail({
              from: NOREPLY_EMAIL,
              to: email,
              subject: '🎉 Welcome to Moodful - Please verify your email',
              html: emailHtml,
            });
          } catch (emailError) {
            logger.error('Error generating verification email:', emailError);
            // Fallback to simple email
            transporter.sendMail({
              from: NOREPLY_EMAIL,
              to: email,
              subject: '🎉 Welcome to Moodful - Please verify your email',
              html: `Please click this link to verify your email: <a href="${verificationLink}">${verificationLink}</a>`,
            });
          }

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
