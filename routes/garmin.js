const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const querystring = require('querystring');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');
const { authenticateToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiter');
const logger = require('../utils/logger');
const { db } = require('../database');

// Garmin Connect OAuth endpoints
const GARMIN_REQUEST_TOKEN_URL = 'https://connectapi.garmin.com/oauth-service/oauth/request_token';
const GARMIN_AUTHORIZE_URL = 'https://connect.garmin.com/oauthConfirm';
const GARMIN_ACCESS_TOKEN_URL = 'https://connectapi.garmin.com/oauth-service/oauth/access_token';
const GARMIN_USER_ID_URL = 'https://apis.garmin.com/wellness-api/rest/user/id';
const GARMIN_BACKFILL_SLEEP_URL = 'https://apis.garmin.com/wellness-api/rest/backfill/sleeps';

// OAuth configuration from environment variables
const GARMIN_CONSUMER_KEY = process.env.GARMIN_CONSUMER_KEY;
const GARMIN_CONSUMER_SECRET = process.env.GARMIN_CONSUMER_SECRET;
const BASE_URL = process.env.MOOD_SITE_URL || 'http://localhost:3000';

// OAuth 1.0a helper functions
function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function generateTimestamp() {
  return Math.floor(Date.now() / 1000).toString();
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => {
      return '%' + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

function generateSignatureBaseString(method, url, params) {
  const encodedParams = Object.keys(params)
    .sort()
    .map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
    .join('&');
  
  return `${method}&${percentEncode(url)}&${percentEncode(encodedParams)}`;
}

function generateSignature(baseString, consumerSecret, tokenSecret = '') {
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');
}

function generateAuthorizationHeader(params) {
  const authParams = Object.keys(params)
    .filter(key => key.startsWith('oauth_'))
    .sort()
    .map(key => `${key}="${percentEncode(params[key])}"`)
    .join(', ');
  
  return `OAuth ${authParams}`;
}

function makeOAuthRequest(method, url, params, tokenSecret = '') {
  logger.info(`Making OAuth request: ${method} ${url}`);
  
  // Check if OAuth credentials are available
  if (!GARMIN_CONSUMER_KEY || !GARMIN_CONSUMER_SECRET) {
    logger.error('🔐 Missing Garmin OAuth credentials');
    throw new Error('Missing OAuth credentials');
  }
  
  const oauthParams = {
    oauth_consumer_key: GARMIN_CONSUMER_KEY,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: generateTimestamp(),
    oauth_nonce: generateNonce(),
    oauth_version: '1.0'
  };

  // Separate OAuth params from query params
  const queryParams = {};
  Object.keys(params).forEach(key => {
    if (key.startsWith('oauth_')) {
      oauthParams[key] = params[key];
    } else {
      queryParams[key] = params[key];
    }
  });

  // Include all parameters in signature calculation
  const allParams = { ...oauthParams, ...queryParams };
  const baseString = generateSignatureBaseString(method, url, allParams);
  const signature = generateSignature(baseString, GARMIN_CONSUMER_SECRET, tokenSecret);
  
  oauthParams.oauth_signature = signature;
  
  const authHeader = generateAuthorizationHeader(oauthParams);
  
  // Build final URL with query parameters
  let finalUrl = url;
  if (Object.keys(queryParams).length > 0) {
    const urlParams = new URLSearchParams(queryParams);
    finalUrl = `${url}?${urlParams.toString()}`;
  }
  
  logger.debug(`OAuth signature base string: ${baseString}`);
  logger.debug(`OAuth authorization header: ${authHeader}`);
  
  return fetch(finalUrl, {
    method: method,
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });
}

// Function to request sleep data backfill for the last 30 days
async function requestSleepBackfill(accessToken, tokenSecret) {
  try {
    logger.info('Requesting sleep data backfill for the last 30 days');
    
    // Calculate the time range for sleep data (last 30 days)
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - (30 * 24 * 60 * 60 * 1000)); // 30 days ago
    
    // Convert to Unix timestamps
    const startTs = Math.floor(startTime.getTime() / 1000);
    const endTs = Math.floor(endTime.getTime() / 1000);
    
    // Make the backfill request - query parameters must be passed separately for OAuth signature
    const queryParams = {
      summaryStartTimeInSeconds: startTs.toString(),
      summaryEndTimeInSeconds: endTs.toString()
    };
    
    const response = await makeOAuthRequest('GET', GARMIN_BACKFILL_SLEEP_URL, {
      oauth_token: accessToken,
      ...queryParams  // Include query params in OAuth signature calculation
    }, tokenSecret);

    if (response.ok) {
      logger.info('✓ Sleep backfill request submitted successfully');
      logger.info('🔄 Garmin will process the backfill request asynchronously');
      logger.info('📨 Sleep data will be sent to the webhook endpoint when ready');
      return true;
    } else {
      const errorText = await response.text();
      
      // Try to parse as JSON if possible
      try {
        const errorJson = JSON.parse(errorText);
        logger.error('Parsed error JSON:', errorJson);
      } catch (parseErr) {
        logger.error('Failed to request sleep backfill:', errorText);
      }
      
      return false;
    }
  } catch (error) {
    logger.error('Error requesting sleep backfill:', error);
    return false;
  }
}

// Step 1: Get request token
router.post('/start-auth', strictLimiter, authenticateToken, async (req, res) => {
  try {
    if (!GARMIN_CONSUMER_KEY || !GARMIN_CONSUMER_SECRET) {
      logger.error('Garmin OAuth credentials not configured');
      return res.status(500).json({ error: 'Garmin integration not configured' });
    }

    const userId = req.user.id;
    
    // Use mobile callback URL if provided, otherwise default to web callback
    const requestedCallbackUrl = req.body?.callbackUrl;
    const callbackUrl = requestedCallbackUrl || `${BASE_URL}/api/garmin/callback`;
    
    logger.info(`Starting Garmin OAuth for user ${userId}`);
    
    const response = await makeOAuthRequest('POST', GARMIN_REQUEST_TOKEN_URL, {
      oauth_callback: callbackUrl
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`Failed to get Garmin request token: HTTP ${response.status} ${response.statusText}`);
      logger.error(`Response body: ${errorText || '(empty)'}`);
      logger.error(`Response headers: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
      
      // Check for common issues
      if (response.status === 401) {
        logger.error('🔐 OAuth credentials may be invalid or expired');
      } else if (response.status === 400) {
        logger.error('📝 OAuth request parameters may be malformed');
      } else if (response.status >= 500) {
        logger.error('🔧 Garmin server error - try again later');
      }
      
      return res.status(500).json({ error: 'Failed to start Garmin authentication' });
    }

    const responseText = await response.text();
    const tokenData = querystring.parse(responseText);
    
    if (!tokenData.oauth_token || !tokenData.oauth_token_secret) {
      logger.error('Invalid response from Garmin request token endpoint:', responseText);
      return res.status(500).json({ error: 'Invalid response from Garmin' });
    }
    
    db.run(
      `INSERT OR REPLACE INTO garmin_request_tokens (userId, requestToken, requestTokenSecret, callbackUrl, expiresAt) VALUES (?, ?, ?, ?, ?)`,
      [userId, tokenData.oauth_token, tokenData.oauth_token_secret, callbackUrl, Date.now() + 10 * 60 * 1000], // 10 minutes
      function(err) {
        if (err) {
          logger.error('Error storing Garmin request token:', err);
          return res.status(500).json({ error: 'Error storing authentication data' });
        }

        const authUrl = `${GARMIN_AUTHORIZE_URL}?oauth_token=${tokenData.oauth_token}`;
        res.json({ authUrl });
      }
    );
  } catch (error) {
    logger.error('Error starting Garmin authentication:', error);
    res.status(500).json({ error: 'Error starting Garmin authentication' });
  }
});

// Helper function to handle redirects based on callback URL type
function handleCallbackRedirect(res, callbackUrl, success = false, error = null) {
  if (callbackUrl && callbackUrl.startsWith('moodful://')) {
    // Mobile deep link - just redirect to the deep link
    res.redirect(callbackUrl);
  } else {
    // Web callback - redirect to the HTML page with parameters
    const baseUrl = callbackUrl || `${BASE_URL}/garmin-callback.html`;
    let finalUrl;
    if (success) {
      finalUrl = `${baseUrl}?garmin_success=connected`;
    } else {
      finalUrl = `${baseUrl}?garmin_error=${error || 'unknown_error'}`;
    }
    res.redirect(finalUrl);
  }
}

// Step 2: Handle callback from Garmin
router.get('/callback', async (req, res) => {
  try {
    const { oauth_token, oauth_verifier, garmin_success, garmin_error } = req.query;

    // Check if this is a success/error redirect (not an OAuth callback)
    if (garmin_success || garmin_error) {
      // This is a redirect after OAuth completion, serve the HTML page
      const baseUrl = `${BASE_URL}/garmin-callback.html`;
      let finalUrl;
      if (garmin_success) {
        finalUrl = `${baseUrl}?garmin_success=${garmin_success}`;
      } else {
        finalUrl = `${baseUrl}?garmin_error=${garmin_error}`;
      }
      return res.redirect(finalUrl);
    }

    if (!oauth_token || !oauth_verifier) {
      logger.warn('Missing oauth_token or oauth_verifier in Garmin callback');
      return handleCallbackRedirect(res, null, false, 'missing_params');
    }

    logger.info(`Handling Garmin callback with token: ${oauth_token}`);

    // Get stored request token data
    db.get(
      `SELECT * FROM garmin_request_tokens WHERE requestToken = ? AND expiresAt > ?`,
      [oauth_token, Date.now()],
      async (err, tokenData) => {
        if (err || !tokenData) {
          logger.error('Invalid or expired Garmin request token:', oauth_token);
          return handleCallbackRedirect(res, null, false, 'invalid_token');
        }

        try {
          // Exchange request token for access token
          const response = await makeOAuthRequest('POST', GARMIN_ACCESS_TOKEN_URL, {
            oauth_token: oauth_token,
            oauth_verifier: oauth_verifier
          }, tokenData.requestTokenSecret);

          if (!response.ok) {
            const errorText = await response.text();
            logger.error(`Failed to get Garmin access token: HTTP ${response.status} ${response.statusText}`);
            logger.error(`Response body: ${errorText || '(empty)'}`);
            return handleCallbackRedirect(res, tokenData.callbackUrl, false, 'token_exchange_failed');
          }

          const responseText = await response.text();
          const accessTokenData = querystring.parse(responseText);

          if (!accessTokenData.oauth_token || !accessTokenData.oauth_token_secret) {
            logger.error('Invalid access token response from Garmin:', responseText);
            return handleCallbackRedirect(res, tokenData.callbackUrl, false, 'invalid_access_token');
          }

          // Get Garmin User ID
          const userIdResponse = await makeOAuthRequest('GET', GARMIN_USER_ID_URL, {
            oauth_token: accessTokenData.oauth_token
          }, accessTokenData.oauth_token_secret);

          if (!userIdResponse.ok) {
            logger.error('Failed to get Garmin user ID');
            return handleCallbackRedirect(res, tokenData.callbackUrl, false, 'user_id_failed');
          }

          const userIdData = await userIdResponse.json();
          const garminUserId = userIdData.userId;

          // Store access token and user ID in database
          db.run(
            `UPDATE users SET garminAccessToken = ?, garminTokenSecret = ?, garminUserId = ?, garminConnected = 1 WHERE id = ?`,
            [accessTokenData.oauth_token, accessTokenData.oauth_token_secret, garminUserId, tokenData.userId],
            (updateErr) => {
              if (updateErr) {
                logger.error('Error storing Garmin access token:', updateErr);
                return handleCallbackRedirect(res, tokenData.callbackUrl, false, 'storage_failed');
              }

              // Clean up request token
              db.run(
                `DELETE FROM garmin_request_tokens WHERE userId = ?`,
                [tokenData.userId],
                (deleteErr) => {
                  if (deleteErr) {
                    logger.warn('Error cleaning up Garmin request token:', deleteErr);
                  }
                }
              );

              logger.info(`✅ Successfully connected Garmin account for user ${tokenData.userId}`);
              
              // Automatically request sleep data backfill for the last 30 days
              requestSleepBackfill(accessTokenData.oauth_token, accessTokenData.oauth_token_secret)
                .then((success) => {
                  if (success) {
                    logger.info(`🛌 Sleep backfill initiated for user ${tokenData.userId}`);
                  } else {
                    logger.warn(`Failed to initiate sleep backfill for user ${tokenData.userId}`);
                  }
                })
                .catch((error) => {
                  logger.error(`Error initiating sleep backfill for user ${tokenData.userId}:`, error);
                });
              
              handleCallbackRedirect(res, tokenData.callbackUrl, true);
            }
          );
        } catch (exchangeError) {
          logger.error('Error during Garmin token exchange:', exchangeError);
          handleCallbackRedirect(res, tokenData.callbackUrl, false, 'exchange_failed');
        }
      }
    );
  } catch (error) {
    logger.error('Error handling Garmin callback:', error);
    handleCallbackRedirect(res, null, false, 'callback_failed');
  }
});

// Disconnect Garmin account
router.post('/disconnect', strictLimiter, authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.run(
    `UPDATE users SET garminAccessToken = NULL, garminTokenSecret = NULL, garminUserId = NULL, garminConnected = 0 WHERE id = ?`,
    [userId],
    (err) => {
      if (err) {
        logger.error('Error disconnecting Garmin account:', err);
        return res.status(500).json({ error: 'Error disconnecting Garmin account' });
      }

      logger.info(`🔌 Disconnected Garmin account for user ${userId}`);
      res.json({ message: 'Garmin account disconnected successfully' });
    }
  );
});

// Get Garmin connection status
router.get('/status', authenticateToken, (req, res) => {
  const userId = req.user.id;

  db.get(
    `SELECT garminConnected, garminUserId FROM users WHERE id = ?`,
    [userId],
    (err, user) => {
      if (err) {
        logger.error('Error checking Garmin connection status:', err);
        return res.status(500).json({ error: 'Error checking connection status' });
      }

      res.json({
        connected: !!user?.garminConnected,
        garminUserId: user?.garminUserId || null
      });
    }
  );
});

// Helper function to store sleep summary in database
function storeSleepSummary(sleepSummary) {
  return new Promise((resolve, reject) => {
    // First, find the local user ID from the Garmin user ID
    db.get(
      `SELECT id FROM users WHERE garminUserId = ? AND garminConnected = 1`,
      [sleepSummary.garminUserId],
      (err, user) => {
        if (err) {
          logger.error('Error finding user by Garmin ID:', err);
          reject(err);
          return;
        }

        if (!user) {
          logger.warn(`No local user found for Garmin user ID: ${sleepSummary.garminUserId}`);
          resolve({ status: 'skipped', reason: 'user not found' });
          return;
        }

        // Insert or replace sleep summary (overwrites existing data for same user/date)
        db.run(`
          INSERT OR REPLACE INTO sleep_summaries (
            userId, garminUserId, summaryId, calendarDate, startTimeInSeconds, 
            startTimeOffsetInSeconds, durationInHours, deepSleepDurationInHours,
            lightSleepDurationInHours, remSleepInHours, awakeDurationInHours,
            updatedAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        `, [
          user.id,
          sleepSummary.garminUserId,
          sleepSummary.summaryId,
          sleepSummary.calendarDate,
          sleepSummary.startTimeInSeconds,
          sleepSummary.startTimeOffsetInSeconds,
          sleepSummary.durationInHours,
          sleepSummary.deepSleepDurationInHours,
          sleepSummary.lightSleepDurationInHours,
          sleepSummary.remSleepInHours,
          sleepSummary.awakeDurationInHours
        ], function(insertErr) {
          if (insertErr) {
            logger.error('Error storing sleep summary:', insertErr);
            reject(insertErr);
          } else {
            resolve({ 
              status: 'stored', 
              id: this.lastID,
              action: this.changes > 0 ? 'updated' : 'inserted'
            });
          }
        });
      }
    );
  });
}

// Webhook endpoint to receive sleep data from Garmin Health API
router.post('/sleep-webhook', async (req, res) => {
  try {
    // Handle both raw and pre-parsed request bodies
    let sleepData;
    
    // First, get the raw body content as a string
    let rawBodyContent = '';
    if (Buffer.isBuffer(req.body)) {
      rawBodyContent = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      rawBodyContent = req.body;
    } else if (typeof req.body === 'object' && req.body !== null) {
      // Check if it's already properly parsed JSON
      if (req.body.hasOwnProperty('sleeps') || Array.isArray(req.body)) {
        sleepData = req.body;
      } else {
        // It might be a string-like object, convert to string first
        rawBodyContent = req.body.toString();
      }
    }
    
    // If we don't have sleepData yet, parse the raw content
    if (!sleepData) {
      try {
        sleepData = JSON.parse(rawBodyContent);
      } catch (parseError) {
        logger.error('Failed to parse sleep webhook JSON:', parseError);
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    }

    // Handle different notification types - support both wrapped and direct array formats
    let sleepArray = [];
    if (sleepData.sleeps && Array.isArray(sleepData.sleeps)) {
      sleepArray = sleepData.sleeps;
    } else if (Array.isArray(sleepData)) {
      sleepArray = sleepData;
    }

    if (sleepArray.length > 0) {
      logger.info(`🛌 Received ${sleepArray.length} sleep summaries from Garmin`);
      let storedCount = 0;
      let skippedCount = 0;
      let errorCount = 0;

      for (let i = 0; i < sleepArray.length; i++) {
        const sleep = sleepArray[i];
        
        // Extract essential sleep data and convert durations from seconds to hours
        const sleepSummary = {
          garminUserId: sleep.userId,
          summaryId: sleep.summaryId,
          calendarDate: sleep.calendarDate,
          startTimeInSeconds: sleep.startTimeInSeconds,
          startTimeOffsetInSeconds: sleep.startTimeOffsetInSeconds || 0,
          durationInHours: Math.round((sleep.durationInSeconds || 0) / 3600 * 100) / 100,
          deepSleepDurationInHours: Math.round((sleep.deepSleepDurationInSeconds || 0) / 3600 * 100) / 100,
          lightSleepDurationInHours: Math.round((sleep.lightSleepDurationInSeconds || 0) / 3600 * 100) / 100,
          remSleepInHours: Math.round((sleep.remSleepInSeconds || 0) / 3600 * 100) / 100,
          awakeDurationInHours: Math.round((sleep.awakeDurationInSeconds || 0) / 3600 * 100) / 100
        };

        // Store in database
        try {
          const result = await storeSleepSummary(sleepSummary);
          if (result.status === 'stored') {
            storedCount++;
          } else if (result.status === 'skipped') {
            skippedCount++;
          }
        } catch (storeError) {
          logger.error('Sleep summary storage error:', storeError);
          errorCount++;
        }
      }

      logger.info(`📊 Sleep data processed - Stored: ${storedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`);
    }

    // Always respond with 200 OK to acknowledge receipt
    res.status(200).json({ status: 'received' });

  } catch (error) {
    logger.error('Error processing sleep webhook:', error);
    
    // Still return 200 to avoid retry storms from Garmin
    res.status(200).json({ status: 'error', message: 'Internal processing error' });
  }
});

// Deregistration endpoint to handle user data revocation notifications from Garmin
router.post('/deregister-webhook', async (req, res) => {
  try {
    // Handle both raw and pre-parsed request bodies
    let deregisterData;
    
    if (typeof req.body === 'string') {
      // Raw string body - parse as JSON
      try {
        deregisterData = JSON.parse(req.body);
      } catch (parseError) {
        logger.error('Failed to parse deregistration webhook JSON:', parseError);
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    } else if (typeof req.body === 'object' && req.body !== null) {
      // Already parsed by Express middleware
      deregisterData = req.body;
    } else {
      // Handle Buffer or other types
      try {
        const bodyStr = req.body.toString('utf8');
        deregisterData = JSON.parse(bodyStr);
      } catch (parseError) {
        logger.error('Failed to parse deregistration webhook JSON:', parseError);
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    }

    // Handle deregistration notification
    if (deregisterData.deregistrations && Array.isArray(deregisterData.deregistrations)) {
      logger.info(`🚫 Processing ${deregisterData.deregistrations.length} Garmin deregistration(s)`);
      
      let processedCount = 0;
      let errorCount = 0;

      for (const dereg of deregisterData.deregistrations) {
        try {
          const garminUserId = dereg.userId;
          
          if (!garminUserId) {
            logger.warn('Missing userId in deregistration data:', dereg);
            errorCount++;
            continue;
          }

          // Find and deactivate the user's Garmin connection
          db.run(
            `UPDATE users SET 
             garminAccessToken = NULL, 
             garminTokenSecret = NULL, 
             garminUserId = NULL, 
             garminConnected = 0 
             WHERE garminUserId = ? AND garminConnected = 1`,
            [garminUserId],
            function(err) {
              if (err) {
                logger.error(`Error deregistering Garmin user ${garminUserId}:`, err);
                errorCount++;
              } else if (this.changes > 0) {
                logger.info(`✅ Deregistered Garmin user ${garminUserId}`);
                processedCount++;
              } else {
                logger.warn(`⚠ No active Garmin connection found for user ID ${garminUserId}`);
              }
            }
          );

        } catch (processingError) {
          logger.error('Error processing individual deregistration:', processingError);
          errorCount++;
        }
      }

      if (processedCount > 0 || errorCount > 0) {
        logger.info(`📊 Deregistration processed - Success: ${processedCount}, Errors: ${errorCount}`);
      }

    } else if (deregisterData.userId) {
      // Handle single user deregistration (alternative format)
      const garminUserId = deregisterData.userId;
      logger.info(`🚫 Processing single Garmin deregistration for user ID: ${garminUserId}`);

      db.run(
        `UPDATE users SET 
         garminAccessToken = NULL, 
         garminTokenSecret = NULL, 
         garminUserId = NULL, 
         garminConnected = 0 
         WHERE garminUserId = ? AND garminConnected = 1`,
        [garminUserId],
        function(err) {
          if (err) {
            logger.error(`Error deregistering Garmin user ${garminUserId}:`, err);
          } else if (this.changes > 0) {
            logger.info(`✅ Deregistered Garmin user ${garminUserId}`);
          } else {
            logger.warn(`⚠ No active Garmin connection found for user ID ${garminUserId}`);
          }
        }
      );
    } else {
      logger.warn('No valid deregistration data found in notification');
    }

    // Always respond with 200 OK to acknowledge receipt
    res.status(200).json({ status: 'received' });

  } catch (error) {
    logger.error('Error processing deregistration webhook:', error);
    
    // Still return 200 to avoid retry storms from Garmin
    res.status(200).json({ status: 'error', message: 'Internal processing error' });
  }
});

// User permission change endpoint to handle permission change notifications from Garmin
router.post('/user-permission-change-webhook', async (req, res) => {
  try {
    logger.info('🔄 Garmin user permission change received');

    // Always respond with 200 OK to acknowledge receipt
    res.status(200).json({ status: 'received' });

  } catch (error) {
    logger.error('Error processing user permission change webhook:', error);
    
    // Still return 200 to avoid retry storms from Garmin
    res.status(200).json({ status: 'error', message: 'Internal processing error' });
  }
});

module.exports = router; 