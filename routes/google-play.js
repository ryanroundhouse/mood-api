const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { google } = require('googleapis');
const logger = require('../utils/logger');
const { strictLimiter } = require('../middleware/rateLimiter');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');

// Configure Google Play API client
const playAuth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_PLAY_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

// Configure Pub/Sub client
const pubsubAuth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_PUBSUB_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/pubsub'],
});

const androidpublisher = google.androidpublisher('v3');

// Debug function for auth issues
const debugAuth = async (auth, type = 'unknown') => {
  try {
    const authClient = await auth.getClient();

    const token = await authClient.getAccessToken();
    return authClient;
  } catch (error) {
    logger.error(`${type} Auth Debug Error:`, {
      message: error.message,
      stack: error.stack,
      code: error.code,
      details: error.response?.data,
    });
    throw error;
  }
};

// Middleware to verify purchase token
const verifyPurchaseToken = async (req, res, next) => {
  try {
    const { purchaseToken, productId, packageName } = req.body;

    // Get and debug Play Store auth client
    const authClient = await debugAuth(playAuth, 'Play');

    const response = await androidpublisher.purchases.products.get({
      auth: authClient,
      packageName: packageName,
      productId: productId,
      token: purchaseToken,
    });

    if (response.data.purchaseState === 0) {
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
  authenticateToken,
  [
    body('purchaseToken').notEmpty(),
    body('productId').notEmpty(),
    body('packageName').notEmpty(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors in verify-purchase:', {
        errors: errors.array(),
      });
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const userId = req.user.id;
      const productId = req.body.productId;
      const purchaseToken = req.body.purchaseToken;
      const packageName = req.body.packageName;

      logger.info('Starting Google Play purchase verification:', {
        userId,
        productId,
        packageName,
        purchaseToken: purchaseToken.substring(0, 10) + '...', // Log partial token for security
      });

      let accountLevel = 'basic';
      if (productId === 'com.gencorp.moodful_app.pro.monthly') {
        accountLevel = 'pro';
      } else if (productId === 'enterprise_subscription') {
        accountLevel = 'enterprise';
      }

      logger.debug('Determined account level:', { productId, accountLevel });

      // Update using purchaseToken instead of orderId
      db.run(
        `UPDATE users SET googlePlaySubscriptionId = ? WHERE id = ?`,
        [purchaseToken, userId],
        (err) => {
          if (err) {
            logger.error('Error updating user account level in database:', {
              error: err,
              userId,
              purchaseToken: purchaseToken.substring(0, 10) + '...',
            });
            return res.status(500).json({ error: 'Internal server error' });
          }

          logger.info('Successfully processed Google Play purchase:', {
            userId,
            accountLevel,
            subscriptionId: purchaseToken.substring(0, 10) + '...',
          });

          res.json({
            message: 'Purchase verified and processed successfully',
            accountLevel: accountLevel,
          });
        }
      );
    } catch (error) {
      logger.error('Error processing Google Play purchase:', {
        error: {
          message: error.message,
          stack: error.stack,
        },
        userId: req.user.id,
        productId: req.body.productId,
      });
      res.status(500).json({ error: 'Error processing purchase' });
    }
  }
);

// Endpoint to handle subscription status updates from Google Play
router.post('/pubsub', async (req, res) => {
  logger.info('Incoming Pub/Sub request', {
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  try {
    if (!req.body || !req.body.message) {
      logger.error('Missing message in request body:', req.body);
      return res.status(200).json({ error: 'Invalid message format' });
    }

    let messageData;
    try {
      messageData = Buffer.from(req.body.message.data, 'base64').toString();
    } catch (decodeError) {
      logger.error('Failed to decode base64 message:', decodeError);
      return res.status(200).json({ error: 'Invalid message encoding' });
    }

    let message;
    try {
      message = JSON.parse(messageData);
    } catch (parseError) {
      logger.error('Failed to parse JSON:', parseError);
      return res.status(200).json({ error: 'Invalid JSON format' });
    }

    if (!message || !message.subscriptionNotification) {
      logger.error('Invalid notification format:', message);
      return res.status(200).json({ error: 'Invalid notification format' });
    }

    const { subscriptionId, purchaseToken, notificationType } =
      message.subscriptionNotification;

    // Log the contents of subscriptionId, purchaseToken, and notificationType
    logger.info('Subscription Notification Details:', {
      subscriptionId,
      purchaseToken,
      notificationType,
    });

    // Handle different notification types
    switch (notificationType) {
      case 1: // SUBSCRIPTION_CANCELED
      case 3: // SUBSCRIPTION_EXPIRED
        // Update to use purchaseToken instead of subscriptionId
        db.run(
          `UPDATE users SET accountLevel = 'basic' WHERE googlePlaySubscriptionId = ?`,
          [purchaseToken],
          (err) => {
            if (err) {
              logger.error('Error updating user account level to basic:', err);
            } else {
              logger.info(
                `User with purchase token ${purchaseToken} downgraded to basic`
              );
            }
          }
        );
        break;
      case 2: // SUBSCRIPTION_RENEWED
      case 4: // SUBSCRIPTION_RESTARTED
        // Update to use purchaseToken
        db.run(
          `UPDATE users SET accountLevel = 'pro' WHERE googlePlaySubscriptionId = ?`,
          [purchaseToken],
          (err) => {
            if (err) {
              logger.error('Error updating user account level to pro:', err);
            } else {
              logger.info(
                `User with purchase token ${purchaseToken} upgraded to pro (subscription renewed)`
              );
            }
          }
        );
        break;
      case 'SUBSCRIPTION_RECOVERED':
      case 'SUBSCRIPTION_RENEWED':
      case 'SUBSCRIPTION_PURCHASED':
        // Update subscription status to active and set accountLevel to 'pro'
        db.run(
          `UPDATE users SET accountLevel = 'pro' WHERE googlePlaySubscriptionId = ?`,
          [purchaseToken],
          (err) => {
            if (err) {
              logger.error('Error updating user account level to pro:', err);
            } else {
              logger.info(
                `User with purchase token ${purchaseToken} upgraded to pro`
              );
            }
          }
        );
        break;
      default:
        logger.warn('Unhandled notification type:', { notificationType });
    }

    res
      .status(200)
      .json({ message: 'Webhook received and processed successfully' });
  } catch (error) {
    logger.error('Error processing Pub/Sub message:', error);
    return res.status(200).json({ error: 'Error processing message' });
  }
});

// Endpoint to get subscription status
router.get(
  '/subscription-status',
  strictLimiter,
  authenticateToken,
  async (req, res) => {
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
            // Get and debug Play Store auth client for subscription status
            const authClient = await debugAuth(playAuth, 'Play');

            const response = await androidpublisher.purchases.subscriptions.get(
              {
                auth: authClient,
                packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
                subscriptionId: user.googlePlaySubscriptionId,
                token: user.googlePlaySubscriptionId,
              }
            );

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
  }
);

module.exports = router;
