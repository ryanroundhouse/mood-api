const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { google } = require('googleapis');
const logger = require('../utils/logger');
const { strictLimiter } = require('../middleware/rateLimiter');

// Configure Google Play API client
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.GOOGLE_PLAY_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const androidpublisher = google.androidpublisher('v3');

// At the top of the file, add this debug function
const debugAuth = async (auth) => {
  try {
    const authClient = await auth.getClient();
    logger.info('Auth Client Details:', {
      clientEmail: authClient._clientEmail,
      keyId: authClient._keyId,
      projectId: authClient.projectId,
      scopes: authClient.scopes,
      keyFile: process.env.GOOGLE_PLAY_KEY_FILE,
      packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME,
    });

    // Test token generation
    const token = await authClient.getAccessToken();
    logger.info('Access Token Details:', {
      exists: !!token.token,
      expiryDate: token.expiryDate,
    });
  } catch (error) {
    logger.error('Auth Debug Error:', {
      message: error.message,
      stack: error.stack,
      code: error.code,
      details: error.response?.data,
    });
  }
};

// Middleware to verify purchase token
const verifyPurchaseToken = async (req, res, next) => {
  try {
    const { purchaseToken, productId, packageName } = req.body;

    // Log the credentials being used
    const authClient = await auth.getClient();
    logger.info('Auth Client Details:', {
      keyId: authClient._clientId,
      email: authClient._clientEmail,
      scopes: authClient.scopes,
      projectId: authClient.projectId,
    });

    // Log the request details
    logger.info('Making Google Play API request:', {
      packageName,
      productId,
      tokenLength: purchaseToken?.length,
      endpoint: 'purchases.products.get',
    });

    // Test the auth explicitly
    try {
      const tokens = await authClient.getAccessToken();
      logger.info('Successfully got access token:', {
        tokenExists: !!tokens.token,
        expiryDate: tokens.expiryDate,
      });
    } catch (authError) {
      logger.error('Failed to get access token:', {
        error: authError.message,
        code: authError.code,
        details: authError.response?.data,
      });
    }

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
router.post('/pubsub', async (req, res) => {
  // Log every incoming request
  logger.info('Incoming Pub/Sub request', {
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  try {
    // Validate message exists
    if (!req.body || !req.body.message) {
      logger.error('Missing message in request body:', req.body);
      return res.status(200).json({ error: 'Invalid message format' });
    }

    // Log the raw message data
    logger.info('Raw message data:', req.body.message.data);

    // Try decoding
    let messageData;
    try {
      messageData = Buffer.from(req.body.message.data, 'base64').toString();
      logger.info('Decoded message:', messageData);
    } catch (decodeError) {
      logger.error('Failed to decode base64 message:', decodeError);
      return res.status(200).json({ error: 'Invalid message encoding' });
    }

    // Try parsing JSON
    let message;
    try {
      message = JSON.parse(messageData);
      logger.info('Parsed message:', message);
    } catch (parseError) {
      logger.error('Failed to parse JSON:', parseError);
      return res.status(200).json({ error: 'Invalid JSON format' });
    }

    // Validate subscription notification
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

    logger.info('Starting auth debug...');
    await debugAuth(auth);

    const authClient = await auth.getClient();
    logger.info('Got auth client with email:', authClient._clientEmail);

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
    // Return 200 even for errors to prevent retries
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
