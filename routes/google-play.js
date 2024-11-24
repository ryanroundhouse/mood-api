const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { google } = require('googleapis');
const logger = require('../utils/logger');
const { strictLimiter } = require('../middleware/rateLimiter');

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

    // Log the raw client to see its structure
    logger.info(`${type} Raw Auth Client:`, {
      properties: Object.keys(authClient),
      credentials: authClient.credentials,
      jsonContent: authClient.jsonContent, // Some clients store info here
      key: authClient.key, // Some store it here
      email: authClient.email, // Try different property names
      serviceAccountEmail: authClient.serviceAccountEmail,
      client_email: authClient._clientEmail || authClient.client_email,
    });

    logger.info(`${type} Auth Client Details:`, {
      clientEmail: authClient._clientEmail || authClient.client_email,
      keyId: authClient._keyId,
      projectId: authClient.projectId,
      scopes: authClient.scopes,
      keyFile:
        type === 'Play'
          ? process.env.GOOGLE_PLAY_KEY_FILE
          : process.env.GOOGLE_PUBSUB_KEY_FILE,
    });

    const token = await authClient.getAccessToken();
    logger.info(`${type} Access Token Details:`, {
      exists: !!token.token,
      expiryDate: token.expiryDate,
      token: token.token.substring(0, 10) + '...',
    });
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

    logger.info('Making Google Play API request:', {
      packageName,
      productId,
      tokenLength: purchaseToken?.length,
      endpoint: 'purchases.products.get',
    });

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

    logger.info('Raw message data:', req.body.message.data);

    let messageData;
    try {
      messageData = Buffer.from(req.body.message.data, 'base64').toString();
      logger.info('Decoded message:', messageData);
    } catch (decodeError) {
      logger.error('Failed to decode base64 message:', decodeError);
      return res.status(200).json({ error: 'Invalid message encoding' });
    }

    let message;
    try {
      message = JSON.parse(messageData);
      logger.info('Parsed message:', message);
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

    logger.info('Processing notification:', {
      subscriptionId,
      notificationType,
    });

    // Get and debug Play Store auth client for subscription verification
    const authClient = await debugAuth(playAuth, 'Play');

    logger.info('Making Play Store API request:', {
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      subscriptionId,
      purchaseToken: purchaseToken.substring(0, 10) + '...',
    });

    const response = await androidpublisher.purchases.subscriptions.get({
      auth: authClient,
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
      subscriptionId: subscriptionId,
      token: purchaseToken,
    });

    logger.info('Got subscription response:', response.data);

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
    logger.error('Error processing Pub/Sub message:', error);
    return res.status(200).json({ error: 'Error processing message' });
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
          // Get and debug Play Store auth client for subscription status
          const authClient = await debugAuth(playAuth, 'Play');

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
