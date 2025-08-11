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
const APPLE_APP_STORE_SERVER_API_BASE = 'https://api.storekit.itunes.apple.com';
const APPLE_APP_STORE_SERVER_API_SANDBOX = 'https://api.storekit-sandbox.itunes.apple.com';

// JWT verification libraries
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

// Cache for Apple's public keys
let applePublicKeysCache = null;
let appleKeyCacheExpiry = null;

// Helper function to fetch Apple's public keys for JWT verification
const fetchApplePublicKeys = async () => {
  try {
    // Check if we have cached keys that are still valid
    if (applePublicKeysCache && appleKeyCacheExpiry && Date.now() < appleKeyCacheExpiry) {
      logger.info('🔑 [APPLE-KEYS] Using cached Apple public keys');
      return applePublicKeysCache;
    }

    logger.info('🔑 [APPLE-KEYS] Fetching Apple public keys from Apple servers');
    
    // Fetch Apple's public keys from their well-known endpoint
    const response = await axios.get('https://appleid.apple.com/auth/keys', {
      timeout: 10000,
      headers: {
        'Accept': 'application/json'
      }
    });

    if (!response.data || !response.data.keys) {
      throw new Error('Invalid response from Apple keys endpoint');
    }

    // Cache the keys for 1 hour
    applePublicKeysCache = response.data.keys;
    appleKeyCacheExpiry = Date.now() + (60 * 60 * 1000); // 1 hour

    logger.info('🔑 [APPLE-KEYS] Successfully fetched and cached Apple public keys:', {
      keyCount: response.data.keys.length,
      cacheExpiryTime: new Date(appleKeyCacheExpiry).toISOString()
    });

    return applePublicKeysCache;

  } catch (error) {
    logger.error('❌ [APPLE-KEYS] Error fetching Apple public keys:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw new Error('Failed to fetch Apple public keys');
  }
};

// Helper function to convert JWK to PEM format
const jwkToPem = (jwk) => {
  try {
    // Convert the JWK to a crypto KeyObject
    const keyObject = crypto.createPublicKey({
      key: jwk,
      format: 'jwk'
    });

    // Export as PEM
    return keyObject.export({
      type: 'spki',
      format: 'pem'
    });
  } catch (error) {
    logger.error('❌ [APPLE-KEYS] Error converting JWK to PEM:', error);
    throw new Error('Failed to convert JWK to PEM format');
  }
};

// Helper function to verify StoreKit 2 signed transaction
const verifySignedTransaction = async (signedTransactionInfo, enableSignatureVerification = false) => {
  try {
    logger.info('🔐 [APPLE-MODERN] Verifying StoreKit 2 signed transaction');
    
    // Decode the JWT without verification first to get header info
    const decoded = jwt.decode(signedTransactionInfo, { complete: true });
    
    if (!decoded) {
      throw new Error('Invalid JWT format');
    }

    logger.info('🔍 [APPLE-MODERN] JWT Header:', {
      algorithm: decoded.header.alg,
      keyId: decoded.header.kid,
      type: decoded.header.typ
    });

    logger.info('🔍 [APPLE-MODERN] JWT Payload preview:', {
      transactionId: decoded.payload.transactionId,
      originalTransactionId: decoded.payload.originalTransactionId,
      productId: decoded.payload.productId,
      environment: decoded.payload.environment,
      expiresDate: decoded.payload.expiresDate
    });

    // Check if we should do signature verification
    if (!enableSignatureVerification && process.env.NODE_ENV !== 'production') {
      logger.info('🧪 [APPLE-MODERN] Development mode: Trusting JWT content without signature verification');
      return decoded.payload;
    }

    // Handle Xcode testing scenario - these JWTs are not signed by Apple
    if (decoded.header.keyId === 'Apple_Xcode_Key') {
      logger.warn('⚠️ [APPLE-MODERN] Detected Xcode test environment - JWT signature cannot be verified');
      if (process.env.NODE_ENV !== 'production') {
        logger.info('🧪 [APPLE-MODERN] Allowing Xcode test JWT in development');
        return decoded.payload;
      } else {
        throw new Error('Xcode test JWTs not allowed in production');
      }
    }

    // Perform actual JWT signature verification with Apple's public keys
    logger.info('🔐 [APPLE-MODERN] Performing signature verification with Apple public keys');

    // Fetch Apple's public keys
    const appleKeys = await fetchApplePublicKeys();
    
    // Find the matching key by keyId
    const keyId = decoded.header.kid;
    const matchingKey = appleKeys.find(key => key.kid === keyId);
    
    if (!matchingKey) {
      throw new Error(`No matching Apple public key found for keyId: ${keyId}`);
    }

    logger.info('🔑 [APPLE-MODERN] Found matching Apple public key:', {
      keyId: matchingKey.kid,
      keyType: matchingKey.kty,
      algorithm: matchingKey.alg
    });

    // Convert JWK to PEM format
    const publicKeyPem = jwkToPem(matchingKey);

    // Verify the JWT signature
    const verifiedPayload = jwt.verify(signedTransactionInfo, publicKeyPem, {
      algorithms: ['ES256'], // Apple uses ES256 for signing
      clockTolerance: 60 // Allow 60 seconds clock skew
    });

    logger.info('✅ [APPLE-MODERN] JWT signature verified successfully');
    return verifiedPayload;

  } catch (error) {
    logger.error('❌ [APPLE-MODERN] Error verifying signed transaction:', {
      error: error.message,
      jwtPreview: signedTransactionInfo?.substring(0, 100) + '...'
    });
    throw error;
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

// Apple status codes removed - not needed for StoreKit 2 JWT verification

// Modern endpoint for StoreKit 2 transaction verification
router.post(
  '/verify-transaction',
  strictLimiter,
  authenticateToken,
  [
    body('signedTransactionInfo').notEmpty().withMessage('Signed transaction info is required'),
    body('productId').notEmpty().withMessage('Product ID is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn('Validation errors in verify-transaction:', {
        errors: errors.array(),
      });
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const userId = req.user.id;
      const { signedTransactionInfo, productId } = req.body;
      
      // Check if signature verification is requested via query parameter
      const enableSignatureVerification = req.query.verify_signature === 'true';

      logger.info('🚀 [APPLE-MODERN] Incoming StoreKit 2 transaction verification:', {
        userId,
        productId,
        jwtLength: signedTransactionInfo?.length,
        enableSignatureVerification,
        userAgent: req.get('User-Agent'),
        ip: req.ip
      });

      // Verify the signed transaction JWT
      const transactionData = await verifySignedTransaction(signedTransactionInfo, enableSignatureVerification);

      // Validate product ID matches
      if (transactionData.productId !== productId) {
        logger.warn('⚠️ [APPLE-MODERN] Product ID mismatch:', {
          expected: productId,
          received: transactionData.productId
        });
        return res.status(400).json({ error: 'Product ID mismatch' });
      }

      // Check if subscription is still active
      const expirationDate = new Date(transactionData.expiresDate);
      const now = new Date();

      if (expirationDate <= now) {
        logger.warn('⚠️ [APPLE-MODERN] Subscription has expired:', {
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
        transactionData.originalTransactionId,
        userId,
        accountLevel,
        expirationDate.toISOString()
      );

      logger.info('✅ [APPLE-MODERN] StoreKit 2 subscription verified successfully:', {
        userId,
        productId,
        accountLevel,
        expirationDate,
        environment: transactionData.environment
      });

      res.json({
        message: 'StoreKit 2 transaction verified and processed successfully',
        accountLevel,
        expirationDate: expirationDate.toISOString(),
        originalTransactionId: transactionData.originalTransactionId,
        environment: transactionData.environment
      });

    } catch (error) {
      logger.error('❌ [APPLE-MODERN] Error processing StoreKit 2 transaction:', {
        error: {
          message: error.message,
          stack: error.stack,
        },
        userId: req.user.id,
        productId: req.body.productId,
      });
      res.status(500).json({ error: 'Error processing StoreKit 2 transaction' });
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

// Endpoint to handle server-to-server notifications from Apple (StoreKit 2)
// Handles subscription lifecycle events like renewals, expirations, refunds, etc.
// Similar to Google Play Pub/Sub notifications but uses Apple's signed JWT format
router.post('/webhook', async (req, res) => {
  try {
    const notification = req.body;
    
    // Log the raw webhook notification for debugging
    logger.info('🔔 [APPLE-WEBHOOK] StoreKit 2 webhook notification received:', {
      fullNotification: JSON.stringify(notification, null, 2),
      headers: req.headers,
      ip: req.ip
    });
    
    // StoreKit 2 webhook format includes signedPayload
    if (!notification || !notification.signedPayload) {
      logger.warn('Invalid StoreKit 2 webhook notification format - missing signedPayload');
      return res.status(200).json({ status: 'invalid_format' });
    }

    try {
      // Decode the signed payload (JWS)
      const decodedPayload = jwt.decode(notification.signedPayload, { complete: true });
      
      if (!decodedPayload || !decodedPayload.payload) {
        logger.warn('Could not decode webhook signedPayload');
        return res.status(200).json({ status: 'invalid_payload' });
      }

      logger.info('🔍 [APPLE-WEBHOOK] Decoded webhook payload:', {
        notificationType: decodedPayload.payload.notificationType,
        subtype: decodedPayload.payload.subtype,
        bundleId: decodedPayload.payload.data?.bundleId
      });

      const data = decodedPayload.payload.data;
      const notificationType = decodedPayload.payload.notificationType;
      const subtype = decodedPayload.payload.subtype;

      logger.info('🔍 [APPLE-WEBHOOK] Processing webhook notification:', {
        notificationType,
        subtype,
        bundleId: data?.bundleId,
        environment: data?.environment
      });

      // Extract transaction information from signedTransactionInfo if present
      let transactionData = null;
      if (data?.signedTransactionInfo) {
        try {
          const transactionDecoded = jwt.decode(data.signedTransactionInfo, { complete: true });
          transactionData = transactionDecoded?.payload;
          
          logger.info('🔍 [APPLE-WEBHOOK] Transaction data extracted:', {
            originalTransactionId: transactionData?.originalTransactionId,
            productId: transactionData?.productId,
            expiresDate: transactionData?.expiresDate
          });
        } catch (transactionError) {
          logger.error('❌ [APPLE-WEBHOOK] Error decoding transaction data:', transactionError);
        }
      }

      // If we don't have transaction data, try signedRenewalInfo
      if (!transactionData && data?.signedRenewalInfo) {
        try {
          const renewalDecoded = jwt.decode(data.signedRenewalInfo, { complete: true });
          const renewalData = renewalDecoded?.payload;
          
          logger.info('🔍 [APPLE-WEBHOOK] Renewal data extracted:', {
            originalTransactionId: renewalData?.originalTransactionId,
            productId: renewalData?.productId,
            autoRenewStatus: renewalData?.autoRenewStatus
          });
          
          // Use renewal data as fallback
          transactionData = renewalData;
        } catch (renewalError) {
          logger.error('❌ [APPLE-WEBHOOK] Error decoding renewal data:', renewalError);
        }
      }

      if (!transactionData || !transactionData.originalTransactionId) {
        logger.warn('⚠️ [APPLE-WEBHOOK] No valid transaction data found in webhook');
        return res.status(200).json({ status: 'no_transaction_data' });
      }

      // Find the user associated with this original transaction ID
      db.get(
        `SELECT id, accountLevel FROM users WHERE appleSubscriptionId = ?`,
        [transactionData.originalTransactionId],
        async (err, user) => {
          if (err) {
            logger.error('❌ [APPLE-WEBHOOK] Database error:', err);
            return res.status(200).json({ status: 'database_error' });
          }

          if (!user) {
            logger.warn('⚠️ [APPLE-WEBHOOK] User not found for transaction:', {
              originalTransactionId: transactionData.originalTransactionId?.substring(0, 10) + '...'
            });
            return res.status(200).json({ status: 'user_not_found' });
          }

          // Determine new account level based on notification type
          // Apple StoreKit 2 notification types documentation:
          // - SUBSCRIBED: Initial subscription purchase
          // - DID_RENEW: Subscription renewed successfully
          // - DID_RECOVER: Subscription recovered from billing retry
          // - EXPIRED: Subscription expired
          // - DID_FAIL_TO_RENEW: Subscription failed to renew
          // - GRACE_PERIOD_EXPIRED: Grace period ended (can be active or expired)
          // - REFUND: Transaction was refunded
          // - REVOKE: Family sharing revoked access
          // - DID_CHANGE_RENEWAL_PREF: User changed renewal preference
          // - DID_CHANGE_RENEWAL_STATUS: Auto-renewal status changed
          // - PRICE_INCREASE: User consented to price increase
          
          let newAccountLevel = user.accountLevel; // Default to current level
          
          switch (notificationType) {
            case 'SUBSCRIBED':
            case 'DID_RENEW':
            case 'DID_RECOVER':
            case 'GRACE_PERIOD_EXPIRED':
              newAccountLevel = 'pro';
              break;
              
            case 'EXPIRED':
            case 'DID_FAIL_TO_RENEW':
            case 'REFUND':
            case 'REVOKE':
              newAccountLevel = 'basic';
              break;
              
            case 'DID_CHANGE_RENEWAL_PREF':
            case 'DID_CHANGE_RENEWAL_STATUS':
            case 'PRICE_INCREASE':
              // Keep current level for preference/status changes
              break;
              
            default:
              logger.info('🔄 [APPLE-WEBHOOK] Unhandled notification type:', {
                notificationType,
                subtype
              });
              return res.status(200).json({ status: 'unhandled_type' });
          }

          // Update subscription status if account level changed
          if (newAccountLevel !== user.accountLevel) {
            try {
              // Calculate expiration date if available
              let expirationDate = null;
              if (transactionData.expiresDate) {
                expirationDate = new Date(transactionData.expiresDate).toISOString();
              }

              await updateSubscriptionStatus(
                transactionData.originalTransactionId,
                user.id,
                newAccountLevel,
                expirationDate
              );

              logger.info('✅ [APPLE-WEBHOOK] Subscription status updated:', {
                userId: user.id,
                originalTransactionId: transactionData.originalTransactionId?.substring(0, 10) + '...',
                oldLevel: user.accountLevel,
                newLevel: newAccountLevel,
                notificationType,
                expirationDate
              });

              res.status(200).json({ 
                status: 'processed',
                accountLevelChanged: true,
                oldLevel: user.accountLevel,
                newLevel: newAccountLevel
              });

            } catch (updateError) {
              logger.error('❌ [APPLE-WEBHOOK] Error updating subscription status:', updateError);
              res.status(200).json({ status: 'update_failed' });
            }
          } else {
            logger.info('📊 [APPLE-WEBHOOK] No account level change needed:', {
              userId: user.id,
              currentLevel: user.accountLevel,
              notificationType
            });
            res.status(200).json({ 
              status: 'acknowledged',
              accountLevelChanged: false,
              currentLevel: user.accountLevel
            });
          }
        }
      );

    } catch (jwtError) {
      logger.error('Error decoding webhook JWT:', jwtError);
      res.status(200).json({ status: 'jwt_decode_error' });
    }

  } catch (error) {
    logger.error('Error processing StoreKit 2 webhook:', error);
    res.status(200).json({ status: 'error' });
  }
});

module.exports = router; 