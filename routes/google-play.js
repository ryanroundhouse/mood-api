const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis'); // Make sure to install: npm install googleapis
const winston = require('winston');
const { strictLimiter } = require('../middleware/rateLimiter');

// Reuse the logger from the main application
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

// Configure Google Play API client
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_PLAY_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const androidpublisher = google.androidpublisher('v3');

// Middleware to verify purchase token
const verifyPurchaseToken = async (req, res, next) => {
  try {
    const { purchaseToken, productId, packageName } = req.body;
    const authClient = await auth.getClient();

    const response = await androidpublisher.purchases.products.get({
      auth: authClient,
      packageName: packageName,
      productId: productId,
      token: purchaseToken,
    });

    if (response.data.purchaseState === 0) {
      // 0 means purchased
      req.purchaseData = response.data;
      next();
    } else {
      res.status(400).json({ error: 'Invalid purchase' });
    }
  } catch (error) {
    logger.error('Error verifying purchase token:', error);
    res.status(500).json({ error: 'Error verifying purchase' });
  }
};

// Endpoint to verify and process a new purchase
router.post(
  '/verify-purchase',
  strictLimiter,
  [
    body('purchaseToken').notEmpty(),
    body('productId').notEmpty(),
    body('packageName').notEmpty(),
  ],
  verifyPurchaseToken,
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      // Update user's account level based on the product purchased
      const userId = req.user.id;
      const productId = req.body.productId;

      let accountLevel = 'basic';
      if (productId === 'pro_subscription') {
        accountLevel = 'pro';
      } else if (productId === 'enterprise_subscription') {
        accountLevel = 'enterprise';
      }

      // Update the user's account level in the database
      db.run(
        `UPDATE users SET accountLevel = ?, googlePlaySubscriptionId = ? WHERE id = ?`,
        [accountLevel, req.purchaseData.orderId, userId],
        (err) => {
          if (err) {
            logger.error('Error updating user account level:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          logger.info(
            `User ${userId} upgraded to ${accountLevel} via Google Play`
          );
          res.json({
            message: 'Purchase verified and processed successfully',
            accountLevel: accountLevel,
          });
        }
      );
    } catch (error) {
      logger.error('Error processing purchase:', error);
      res.status(500).json({ error: 'Error processing purchase' });
    }
  }
);

// Endpoint to handle subscription status updates from Google Play
router.post('/webhook', strictLimiter, async (req, res) => {
  try {
    const notification = req.body;

    if (!notification || !notification.subscriptionNotification) {
      return res.status(400).json({ error: 'Invalid notification format' });
    }

    const { subscriptionId, purchaseToken, notificationType } =
      notification.subscriptionNotification;

    // Verify the subscription status
    const authClient = await auth.getClient();
    const response = await androidpublisher.purchases.subscriptions.get({
      auth: authClient,
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      subscriptionId: subscriptionId,
      token: purchaseToken,
    });

    // Handle different notification types
    switch (notificationType) {
      case 1: // Subscription recovered
      case 2: // Renewal success
        // Update user's subscription status
        db.run(
          `UPDATE users SET accountLevel = 'pro' WHERE googlePlaySubscriptionId = ?`,
          [subscriptionId],
          (err) => {
            if (err) {
              logger.error('Error updating subscription status:', err);
            }
          }
        );
        break;

      case 3: // Subscription canceled
      case 4: // Subscription on hold
      case 6: // Subscription expired
        // Downgrade user's account
        db.run(
          `UPDATE users SET accountLevel = 'basic' WHERE googlePlaySubscriptionId = ?`,
          [subscriptionId],
          (err) => {
            if (err) {
              logger.error('Error downgrading user account:', err);
            }
          }
        );
        break;

      default:
        logger.info(`Unhandled notification type: ${notificationType}`);
    }

    res.status(200).json({ message: 'Webhook processed successfully' });
  } catch (error) {
    logger.error('Error processing Google Play webhook:', error);
    res.status(500).json({ error: 'Error processing webhook' });
  }
});

// Endpoint to get subscription status
router.get('/subscription-status', strictLimiter, async (req, res) => {
  try {
    const userId = req.user.id;

    db.get(
      `SELECT googlePlaySubscriptionId, accountLevel FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user subscription status:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!user || !user.googlePlaySubscriptionId) {
          return res.json({ status: 'no_subscription' });
        }

        try {
          const authClient = await auth.getClient();
          const response = await androidpublisher.purchases.subscriptions.get({
            auth: authClient,
            packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
            subscriptionId: user.googlePlaySubscriptionId,
            token: user.googlePlaySubscriptionId,
          });

          res.json({
            status: 'active',
            expiryTimeMillis: response.data.expiryTimeMillis,
            autoRenewing: response.data.autoRenewing,
            accountLevel: user.accountLevel,
          });
        } catch (error) {
          logger.error(
            'Error fetching subscription details from Google Play:',
            error
          );
          res.json({
            status: 'error',
            accountLevel: user.accountLevel,
          });
        }
      }
    );
  } catch (error) {
    logger.error('Error checking subscription status:', error);
    res.status(500).json({ error: 'Error checking subscription status' });
  }
});

module.exports = router;
