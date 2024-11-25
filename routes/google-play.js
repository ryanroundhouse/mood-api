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

// Add this check to verify service account setup
const verifyServiceAccount = async () => {
  try {
    const client = await playAuth.getClient();
    if (!client.key) {
      throw new Error('Service account key not found');
    }
    logger.info('Google Play service account authenticated successfully');
    return client;
  } catch (error) {
    logger.error('Google Play service account authentication failed:', {
      error: error.message,
      keyFile: process.env.GOOGLE_PLAY_KEY_FILE,
    });
    throw error;
  }
};

// Call this when your server starts
verifyServiceAccount().catch((error) => {
  logger.error('Failed to initialize Google Play service account:', error);
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

// Add this new function to handle subscription updates
const updateSubscriptionStatus = async (
  purchaseToken,
  userId,
  accountLevel
) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET googlePlaySubscriptionId = ?, accountLevel = ? WHERE id = ?`,
      [purchaseToken, accountLevel, userId],
      (err) => {
        if (err) {
          logger.error('Error updating subscription status:', {
            error: err,
            userId,
            purchaseToken: purchaseToken.substring(0, 10) + '...',
          });
          reject(err);
        } else {
          logger.info('Successfully updated subscription status:', {
            userId,
            accountLevel,
            purchaseToken: purchaseToken.substring(0, 10) + '...',
          });
          resolve();
        }
      }
    );
  });
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

      // First verify the purchase with Google Play
      const authClient = await debugAuth(playAuth, 'Play');
      const response = await androidpublisher.purchases.subscriptions.get({
        auth: authClient,
        packageName: packageName,
        subscriptionId: productId,
        token: purchaseToken,
      });

      // Check if subscription is active
      if (response.data.paymentState !== 1) {
        return res
          .status(400)
          .json({ error: 'Invalid or inactive subscription' });
      }

      const accountLevel = productId.includes('pro') ? 'pro' : 'basic';

      // Update subscription status
      await updateSubscriptionStatus(purchaseToken, userId, accountLevel);

      res.json({
        message: 'Purchase verified and processed successfully',
        accountLevel,
        expiryTimeMillis: response.data.expiryTimeMillis,
      });
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
  try {
    if (!req.body || !req.body.message) {
      return res.status(200).json({ error: 'Invalid message format' });
    }

    let messageData;
    try {
      messageData = Buffer.from(req.body.message.data, 'base64').toString();
    } catch (decodeError) {
      return res.status(200).json({ error: 'Invalid message encoding' });
    }

    let message;
    try {
      message = JSON.parse(messageData);
    } catch (parseError) {
      return res.status(200).json({ error: 'Invalid JSON format' });
    }

    if (!message || !message.subscriptionNotification) {
      return res.status(200).json({ error: 'Invalid notification format' });
    }

    const { subscriptionId, purchaseToken, notificationType } =
      message.subscriptionNotification;

    // Find the user associated with this purchase token
    db.get(
      `SELECT id, accountLevel FROM users WHERE googlePlaySubscriptionId = ?`,
      [purchaseToken],
      async (err, user) => {
        if (err || !user) {
          return res.status(200).end();
        }

        let newAccountLevel;
        switch (notificationType) {
          case 1: // SUBSCRIPTION_CANCELED
          case 3: // SUBSCRIPTION_EXPIRED
          case 13: // SUBSCRIPTION_ON_HOLD
            newAccountLevel = 'basic';
            break;
          case 2: // SUBSCRIPTION_RENEWED
          case 4: // SUBSCRIPTION_RESTARTED
            newAccountLevel = 'pro';
            break;
          default:
            return res.status(200).end();
        }

        await updateSubscriptionStatus(purchaseToken, user.id, newAccountLevel);
        res.status(200).json({ message: 'Webhook processed successfully' });
      }
    );
  } catch (error) {
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
