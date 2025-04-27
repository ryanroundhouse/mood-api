const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const logger = require('../utils/logger');
const { strictLimiter } = require('../middleware/rateLimiter');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');

// Load Google Play configuration from .env file
const GOOGLE_PLAY_KEY_FILE = process.env.GOOGLE_PLAY_KEY_FILE;
const GOOGLE_PLAY_PACKAGE_NAME = process.env.GOOGLE_PLAY_PACKAGE_NAME;
const GOOGLE_PUBSUB_KEY_FILE = process.env.GOOGLE_PUBSUB_KEY_FILE;

// Validate required environment variables
if (!GOOGLE_PLAY_KEY_FILE) {
  logger.error('Missing required environment variable: GOOGLE_PLAY_KEY_FILE');
}
if (!GOOGLE_PLAY_PACKAGE_NAME) {
  logger.error('Missing required environment variable: GOOGLE_PLAY_PACKAGE_NAME');
}
if (!GOOGLE_PUBSUB_KEY_FILE) {
  logger.error('Missing required environment variable: GOOGLE_PUBSUB_KEY_FILE');
}

// Helper function to check if a file exists and is accessible
const verifyKeyFileAccessible = (filePath) => {
  if (!filePath) return false;
  
  try {
    // Convert relative paths to absolute if needed
    const resolvedPath = path.isAbsolute(filePath) 
      ? filePath 
      : path.resolve(process.cwd(), filePath);
    
    // Check if file exists and is accessible
    fs.accessSync(resolvedPath, fs.constants.R_OK);
    logger.info(`Key file verified at: ${resolvedPath}`);
    return resolvedPath;
  } catch (error) {
    logger.error(`Key file inaccessible: ${filePath}`, {
      error: error.message,
      cwd: process.cwd(),
      resolvedPath: path.isAbsolute(filePath) 
        ? filePath 
        : path.resolve(process.cwd(), filePath)
    });
    return false;
  }
};

// Verify key files before initializing auth
const resolvedPlayKeyFile = verifyKeyFileAccessible(GOOGLE_PLAY_KEY_FILE);
const resolvedPubSubKeyFile = verifyKeyFileAccessible(GOOGLE_PUBSUB_KEY_FILE);

// Configure Google Play API client
const playAuth = new google.auth.GoogleAuth({
  keyFile: resolvedPlayKeyFile || GOOGLE_PLAY_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

// Add this check to verify service account setup
const verifyServiceAccount = async () => {
  try {
    if (!resolvedPlayKeyFile) {
      throw new Error(`Service account key file not found or not accessible: ${GOOGLE_PLAY_KEY_FILE}`);
    }
    
    logger.info('Attempting to authenticate with Google Play service account...');
    const client = await playAuth.getClient();
    
    if (!client.key) {
      throw new Error('Service account key not found in client');
    }
    
    logger.info('Google Play service account authenticated successfully', {
      email: client.email || 'unknown'
    });
    
    return client;
  } catch (error) {
    logger.error('Google Play service account authentication failed:', {
      error: error.message,
      stack: error.stack,
      keyFile: GOOGLE_PLAY_KEY_FILE,
      resolvedKeyFile: resolvedPlayKeyFile
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
  keyFile: resolvedPubSubKeyFile || GOOGLE_PUBSUB_KEY_FILE,
  scopes: ['https://www.googleapis.com/auth/pubsub'],
});

const androidpublisher = google.androidpublisher('v3');

// Debug function for auth issues
const debugAuth = async (auth, type = 'unknown') => {
  try {
    logger.info(`Attempting to get ${type} auth client...`);
    
    // Check which key file is being used
    const keyFile = type === 'Play' 
      ? resolvedPlayKeyFile || GOOGLE_PLAY_KEY_FILE
      : resolvedPubSubKeyFile || GOOGLE_PUBSUB_KEY_FILE;
    
    if (!keyFile || (typeof keyFile === 'string' && !resolvedPlayKeyFile && type === 'Play')) {
      throw new Error(`No valid key file available for ${type} auth`);
    }
    
    const authClient = await auth.getClient();
    logger.info(`Successfully got ${type} auth client`);
    
    try {
      const token = await authClient.getAccessToken();
      logger.info(`Successfully got access token for ${type} auth`);
      return authClient;
    } catch (tokenError) {
      logger.error(`Failed to get access token for ${type} auth:`, {
        error: tokenError.message,
        stack: tokenError.stack
      });
      throw tokenError;
    }
  } catch (error) {
    logger.error(`${type} Auth Debug Error:`, {
      message: error.message,
      stack: error.stack,
      code: error.code,
      details: error.response?.data,
      keyFile: type === 'Play' 
        ? GOOGLE_PLAY_KEY_FILE 
        : GOOGLE_PUBSUB_KEY_FILE,
      resolvedKeyFile: type === 'Play' 
        ? resolvedPlayKeyFile 
        : resolvedPubSubKeyFile
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

// Add this helper function to determine subscription type
const getSubscriptionDetails = (productId, purchaseData) => {
  const isPromo = purchaseData.promotionType !== undefined;
  const baseProductId = productId.replace('-7dayfree-199', ''); // Strip promo suffix
  const accountLevel = baseProductId.includes('pro') ? 'pro' : 'basic';
  
  return {
    isPromo,
    accountLevel,
    originalProductId: baseProductId
  };
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

      const authClient = await debugAuth(playAuth, 'Play');

      // Log detailed request information
      logger.info('Attempting subscription verification with:', {
        packageName,
        productId,
        tokenLength: purchaseToken?.length,
        authScopes: authClient.scopes,
        serviceAccountEmail: authClient.email,
      });

      try {
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

        // Get subscription details including promo information
        const { isPromo, accountLevel } = getSubscriptionDetails(productId, response.data);

        // Log promotional purchase if applicable
        if (isPromo) {
          logger.info('Processing promotional subscription:', {
            userId: req.user.id,
            productId,
            promotionType: response.data.promotionType,
          });
        }

        // Update subscription status
        await updateSubscriptionStatus(purchaseToken, userId, accountLevel);

        res.json({
          message: 'Purchase verified and processed successfully',
          accountLevel,
          expiryTimeMillis: response.data.expiryTimeMillis,
          isPromo,
        });
      } catch (error) {
        logger.error('Detailed Google Play API error:', {
          error: {
            message: error.message,
            code: error.code,
            status: error.status,
            details: error.response?.data,
            scopes: authClient.scopes,
            serviceAccount: authClient.email,
          },
          request: {
            packageName,
            productId,
            hasToken: !!purchaseToken,
          },
        });
        throw error;
      }
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
          case 12: // SUBSCRIPTION_PAUSED
          case 10: // SUBSCRIPTION_REVOKED
          case 11: // SUBSCRIPTION_EXPIRED_FROM_BILLING_RETRY
            newAccountLevel = 'basic';
            break;
          case 2: // SUBSCRIPTION_RENEWED
          case 4: // SUBSCRIPTION_RESTARTED
          case 7: // SUBSCRIPTION_PURCHASED
          case 9: // SUBSCRIPTION_DEFERRED
          case 8: // SUBSCRIPTION_PRICE_CHANGE_CONFIRMED
            newAccountLevel = 'pro';
            break;
          default:
            logger.info('Unhandled subscription notification type:', {
              notificationType,
            });
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
                packageName: GOOGLE_PLAY_PACKAGE_NAME,
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
