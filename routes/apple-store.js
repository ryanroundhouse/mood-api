const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const axios = require('axios');
require('dotenv').config();
const logger = require('../utils/logger');
const { strictLimiter } = require('../middleware/rateLimiter');
const { db } = require('../database');
const { authenticateToken } = require('../middleware/auth');

// Load Apple Store configuration from .env file
const APPLE_SHARED_SECRET = process.env.APPLE_SHARED_SECRET;
const APPLE_VERIFY_URL_PROD = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_VERIFY_URL_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

// Validate required environment variables
if (!APPLE_SHARED_SECRET) {
  logger.error('Missing required environment variable: APPLE_SHARED_SECRET');
}

// Helper function to validate receipt with Apple's servers
const validateReceipt = async (receiptData, url) => {
  try {
    const response = await axios.post(url, {
      'receipt-data': receiptData,
      'password': APPLE_SHARED_SECRET,
      'exclude-old-transactions': true,
    }, {
      timeout: 10000, // 10 second timeout
      headers: {
        'Content-Type': 'application/json'
      }
    });

    return response.data;
  } catch (error) {
    logger.error('Error communicating with Apple servers:', {
      error: error.message,
      url,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error('Failed to communicate with Apple servers');
  }
};

// Helper function to update subscription status
const updateSubscriptionStatus = async (
  originalTransactionId,
  userId,
  accountLevel,
  expirationDate
) => {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE users SET appleSubscriptionId = ?, accountLevel = ?, subscriptionExpiresAt = ? WHERE id = ?`,
      [originalTransactionId, accountLevel, expirationDate, userId],
      (err) => {
        if (err) {
          logger.error('Error updating subscription status:', {
            error: err,
            userId,
            originalTransactionId: originalTransactionId?.substring(0, 10) + '...',
          });
          reject(err);
        } else {
          logger.info('Successfully updated subscription status:', {
            userId,
            accountLevel,
            originalTransactionId: originalTransactionId?.substring(0, 10) + '...',
            expirationDate
          });
          resolve();
        }
      }
    );
  });
};

// Helper function to determine subscription type from product ID
const getSubscriptionDetails = (productId) => {
  const accountLevel = productId.includes('pro') ? 'pro' : 'basic';
  const isMonthly = productId.includes('monthly');
  const isYearly = productId.includes('yearly');
  
  return {
    accountLevel,
    isMonthly,
    isYearly,
    originalProductId: productId
  };
};

// Helper function to explain Apple status codes
const getAppleStatusMeaning = (status) => {
  const meanings = {
    0: 'Receipt is valid',
    21000: 'The App Store could not read the JSON object you provided',
    21002: 'The data in the receipt-data property was malformed or missing',
    21003: 'The receipt could not be authenticated',
    21004: 'The shared secret you provided does not match the shared secret on file',
    21005: 'The receipt server is not currently available',
    21006: 'This receipt is valid but the subscription has expired',
    21007: 'This receipt is from the sandbox environment',
    21008: 'This receipt is from the production environment',
    21010: 'This receipt could not be authorized'
  };
  return meanings[status] || `Unknown status code: ${status}`;
};

// Endpoint to verify and process Apple Store purchase
router.post(
  '/verify-purchase',
  strictLimiter,
  authenticateToken,
  [
    body('receiptData').notEmpty().withMessage('Receipt data is required'),
    body('productId').notEmpty().withMessage('Product ID is required'),
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
      const { receiptData, productId } = req.body;

      // Enhanced logging for incoming request
      logger.info('🔐 [APPLE-VERIFY] Incoming purchase verification request:', {
        userId,
        productId,
        receiptDataLength: receiptData?.length,
        receiptDataPreview: receiptData?.substring(0, 50) + '...',
        userAgent: req.get('User-Agent'),
        ip: req.ip
      });

      if (!APPLE_SHARED_SECRET) {
        logger.error('🔑 [APPLE-VERIFY] Apple shared secret not configured');
        return res.status(500).json({ error: 'Server configuration error' });
      }

      logger.info('🔑 [APPLE-VERIFY] Apple shared secret available, proceeding with verification');

      // First try production environment
      let validationResponse;
      try {
        logger.info('🍎 [APPLE-VERIFY] Attempting production validation...');
        validationResponse = await validateReceipt(receiptData, APPLE_VERIFY_URL_PROD);
        logger.info('🍎 [APPLE-VERIFY] Production validation response:', {
          status: validationResponse.status,
          receiptFound: !!validationResponse.receipt,
          latestReceiptInfoCount: validationResponse.latest_receipt_info?.length || 0
        });
        
        // If receipt is from sandbox, retry with sandbox URL
        if (validationResponse.status === 21007) {
          logger.info('🧪 [APPLE-VERIFY] Sandbox receipt detected, retrying with sandbox URL...');
          validationResponse = await validateReceipt(receiptData, APPLE_VERIFY_URL_SANDBOX);
          logger.info('🧪 [APPLE-VERIFY] Sandbox validation response:', {
            status: validationResponse.status,
            receiptFound: !!validationResponse.receipt,
            latestReceiptInfoCount: validationResponse.latest_receipt_info?.length || 0
          });
        }
      } catch (error) {
        logger.error('❌ [APPLE-VERIFY] Error during receipt validation:', {
          error: error.message,
          stack: error.stack
        });
        return res.status(500).json({ error: 'Error validating receipt with Apple' });
      }

      // Check if receipt is valid
      if (validationResponse.status !== 0) {
        logger.warn('⚠️ [APPLE-VERIFY] Invalid receipt from Apple:', {
          status: validationResponse.status,
          userId,
          productId,
          appleStatusMeaning: getAppleStatusMeaning(validationResponse.status)
        });
        return res.status(400).json({ 
          error: `Invalid receipt. Status: ${validationResponse.status}` 
        });
      }

      // Find the relevant transaction in latest_receipt_info
      const latestReceiptInfo = validationResponse.latest_receipt_info || [];
      const relevantTransaction = latestReceiptInfo.find(
        (transaction) => transaction.product_id === productId
      );

      if (!relevantTransaction) {
        logger.warn('Transaction for product not found in receipt:', {
          productId,
          userId,
          availableProducts: latestReceiptInfo.map(t => t.product_id)
        });
        return res.status(400).json({ 
          error: 'Transaction for this product not found in receipt' 
        });
      }

      // Check if subscription is still active
      const expirationDate = new Date(parseInt(relevantTransaction.expires_date_ms));
      const now = new Date();

      if (expirationDate <= now) {
        logger.warn('Subscription has expired:', {
          userId,
          productId,
          expirationDate,
          now
        });
        return res.status(400).json({ error: 'Subscription has expired' });
      }

      // Get subscription details
      const { accountLevel } = getSubscriptionDetails(productId);

      // Update subscription status in database
      await updateSubscriptionStatus(
        relevantTransaction.original_transaction_id,
        userId,
        accountLevel,
        expirationDate.toISOString()
      );

      logger.info('Apple subscription verified successfully:', {
        userId,
        productId,
        accountLevel,
        expirationDate
      });

      res.json({
        message: 'Purchase verified and processed successfully',
        accountLevel,
        expirationDate: expirationDate.toISOString(),
        originalTransactionId: relevantTransaction.original_transaction_id,
      });

    } catch (error) {
      logger.error('Error processing Apple Store purchase:', {
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

// Endpoint to get subscription status
router.get(
  '/subscription-status',
  strictLimiter,
  authenticateToken,
  async (req, res) => {
    try {
      const userId = req.user.id;
      
      logger.info('📊 [APPLE-STATUS] Subscription status check requested:', {
        userId,
        userAgent: req.get('User-Agent'),
        ip: req.ip
      });

      db.get(
        `SELECT appleSubscriptionId, accountLevel, subscriptionExpiresAt FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err) {
            logger.error('❌ [APPLE-STATUS] Error fetching user subscription status:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user || !user.appleSubscriptionId) {
            logger.info('📊 [APPLE-STATUS] User has no subscription:', { userId });
            return res.json({ status: 'no_subscription' });
          }

          const expirationDate = new Date(user.subscriptionExpiresAt);
          const now = new Date();
          const isActive = expirationDate > now;

          const response = {
            status: isActive ? 'active' : 'expired',
            accountLevel: user.accountLevel,
            expirationDate: user.subscriptionExpiresAt,
            originalTransactionId: user.appleSubscriptionId,
          };

          logger.info('📊 [APPLE-STATUS] Subscription status response:', {
            userId,
            status: response.status,
            accountLevel: response.accountLevel,
            expiresAt: response.expirationDate,
            transactionId: user.appleSubscriptionId?.substring(0, 10) + '...'
          });

          res.json(response);
        }
      );
    } catch (error) {
      logger.error('❌ [APPLE-STATUS] Error checking Apple subscription status:', error);
      res.status(500).json({ error: 'Error checking subscription status' });
    }
  }
);

// Endpoint to handle server-to-server notifications from Apple
router.post('/webhook', async (req, res) => {
  try {
    // Apple sends the notification in a specific format
    const notification = req.body;
    
    if (!notification || !notification.latest_receipt_info) {
      logger.warn('Invalid Apple webhook notification format');
      return res.status(200).json({ status: 'invalid_format' });
    }

    // Extract the latest transaction info
    const latestTransaction = notification.latest_receipt_info;
    const originalTransactionId = latestTransaction.original_transaction_id;
    const expirationDate = new Date(parseInt(latestTransaction.expires_date_ms));
    const now = new Date();

    // Find the user associated with this transaction
    db.get(
      `SELECT id, accountLevel FROM users WHERE appleSubscriptionId = ?`,
      [originalTransactionId],
      async (err, user) => {
        if (err || !user) {
          logger.warn('User not found for Apple webhook notification:', {
            originalTransactionId: originalTransactionId?.substring(0, 10) + '...',
            error: err?.message
          });
          return res.status(200).json({ status: 'user_not_found' });
        }

        // Determine new account level based on expiration
        const newAccountLevel = expirationDate > now ? 'pro' : 'basic';

        try {
          await updateSubscriptionStatus(
            originalTransactionId,
            user.id,
            newAccountLevel,
            expirationDate.toISOString()
          );

          logger.info('Apple webhook processed successfully:', {
            userId: user.id,
            originalTransactionId: originalTransactionId?.substring(0, 10) + '...',
            newAccountLevel,
            expirationDate
          });

          res.status(200).json({ status: 'processed' });
        } catch (updateError) {
          logger.error('Error updating subscription from Apple webhook:', updateError);
          res.status(200).json({ status: 'update_failed' });
        }
      }
    );
  } catch (error) {
    logger.error('Error processing Apple webhook:', error);
    res.status(200).json({ status: 'error' });
  }
});

module.exports = router; 