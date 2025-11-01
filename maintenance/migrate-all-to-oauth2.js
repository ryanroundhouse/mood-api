const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Garmin OAuth configuration
const GARMIN_CONSUMER_KEY = process.env.GARMIN_CONSUMER_KEY;
const GARMIN_CONSUMER_SECRET = process.env.GARMIN_CONSUMER_SECRET;
const GARMIN_OAUTH2_CLIENT_SECRET = process.env.GARMIN_OAUTH2_CLIENT_SECRET;
const GARMIN_TOKEN_EXCHANGE_URL = 'https://apis.garmin.com/partner-gateway/rest/user/token-exchange';

// Log file
const LOG_FILE = path.join(__dirname, 'oauth2-migration.log');

// OAuth 1.0a helper functions (from routes/garmin.js)
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
  // Check if OAuth credentials are available
  if (!GARMIN_CONSUMER_KEY || !GARMIN_CONSUMER_SECRET) {
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
    
    return fetch(finalUrl, {
      method: method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
}

// Helper function to get user by ID
function getUserById(db, userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
      if (err) {
        reject(err);
      } else {
        resolve(user);
      }
    });
  });
}

// Helper function to log to both console and file
function log(message, type = 'info') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
  
  console.log(logMessage);
  fs.appendFileSync(LOG_FILE, logMessage + '\n');
}

// Migrate a single user from OAuth 1.0 to OAuth 2.0
async function migrateUser(db, user) {
  const userId = user.id;
  const email = user.email || `User ${userId}`;
  
  try {
    log(`Starting OAuth 2.0 migration for user ${userId} (${email})`);
    
    // Check if already migrated
    if (user.garminOAuthVersion === 'v2') {
      log(`User ${userId} already migrated to OAuth 2.0`, 'warn');
      return { success: false, reason: 'already_migrated', userId, email };
    }
    
    // Check if OAuth 1.0 credentials exist
    if (!user.garminAccessToken || !user.garminTokenSecret) {
      log(`User ${userId} missing OAuth 1.0 credentials`, 'warn');
      return { success: false, reason: 'no_oauth1_credentials', userId, email };
    }
    
    // Check if OAuth 2.0 credentials are configured
    if (!GARMIN_OAUTH2_CLIENT_SECRET) {
      log('OAuth 2.0 client secret not configured', 'error');
      throw new Error('OAuth 2.0 migration not yet configured on server');
    }
    
    // Call Garmin token exchange endpoint (must be signed with OAuth 1.0)
    log(`Calling token exchange endpoint for user ${userId}`);
    const response = await makeOAuthRequest('POST', GARMIN_TOKEN_EXCHANGE_URL, {
      oauth_token: user.garminAccessToken
    }, user.garminTokenSecret);
    
    if (!response.ok) {
      const errorText = await response.text();
      log(`Token exchange failed for user ${userId}: ${errorText}`, 'error');
      return { 
        success: false, 
        reason: 'token_exchange_failed', 
        error: errorText,
        userId, 
        email 
      };
    }
    
    const oauth2Tokens = await response.json();
    log(`Received OAuth 2.0 tokens for user ${userId}`);
    
    // Store OAuth 2.0 tokens in database
    await new Promise((resolve, reject) => {
      db.run(`
        UPDATE users 
        SET garminAccessTokenV2 = ?,
            garminRefreshToken = ?,
            garminTokenExpiry = ?,
            garminOAuthVersion = 'v2'
        WHERE id = ?
      `, [
        oauth2Tokens.access_token,
        oauth2Tokens.refresh_token,
        Date.now() + (oauth2Tokens.expires_in * 1000),
        userId
      ], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    
    log(`Successfully migrated user ${userId} to OAuth 2.0`);
    return { success: true, userId, email };
  } catch (error) {
    log(`Error migrating user ${userId} to OAuth 2.0: ${error.message}`, 'error');
    return { 
      success: false, 
      reason: 'error', 
      error: error.message,
      userId, 
      email 
    };
  }
}

// Main migration function
async function migrateAllUsers() {
  // Check required environment variables
  if (!GARMIN_CONSUMER_KEY || !GARMIN_CONSUMER_SECRET) {
    log('Missing GARMIN_CONSUMER_KEY or GARMIN_CONSUMER_SECRET', 'error');
    process.exit(1);
  }
  
  if (!GARMIN_OAUTH2_CLIENT_SECRET) {
    log('Missing GARMIN_OAUTH2_CLIENT_SECRET. Please add it to your .env file.', 'error');
    process.exit(1);
  }
  
  const db = new sqlite3.Database(path.join(__dirname, '..', 'database.sqlite'));
  
  try {
    log('='.repeat(80));
    log('Starting OAuth 2.0 migration for all Garmin users');
    log('='.repeat(80));
    
    // Find all users with Garmin connected that are not on OAuth 2.0
    const users = await new Promise((resolve, reject) => {
      db.all(`
        SELECT id, email, garminConnected, garminOAuthVersion, 
               garminAccessToken, garminTokenSecret
        FROM users 
        WHERE garminConnected = 1 
          AND (garminOAuthVersion IS NULL OR garminOAuthVersion != 'v2')
          AND garminAccessToken IS NOT NULL
          AND garminTokenSecret IS NOT NULL
      `, [], (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    
    log(`Found ${users.length} users to migrate`);
    
    if (users.length === 0) {
      log('No users found to migrate. All users are already on OAuth 2.0!');
      return;
    }
    
    // Track results
    const results = {
      total: users.length,
      succeeded: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
    
    // Migrate each user sequentially (to avoid rate limiting)
    for (let i = 0; i < users.length; i++) {
      const user = users[i];
      log(`\nProcessing user ${i + 1}/${users.length}: ${user.email || `User ${user.id}`}`);
      
      const result = await migrateUser(db, user);
      
      if (result.success) {
        results.succeeded++;
      } else {
        if (result.reason === 'already_migrated' || result.reason === 'no_oauth1_credentials') {
          results.skipped++;
        } else {
          results.failed++;
          results.errors.push(result);
        }
      }
      
      // Small delay between requests to be respectful to Garmin's API
      if (i < users.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Print summary
    log('\n' + '='.repeat(80));
    log('Migration Summary');
    log('='.repeat(80));
    log(`Total users: ${results.total}`);
    log(`Successfully migrated: ${results.succeeded}`);
    log(`Failed: ${results.failed}`);
    log(`Skipped: ${results.skipped}`);
    
    if (results.errors.length > 0) {
      log('\nErrors:');
      results.errors.forEach((error, index) => {
        log(`  ${index + 1}. User ${error.userId} (${error.email}): ${error.reason} - ${error.error || 'N/A'}`);
      });
    }
    
    log('\nMigration completed!');
    log('='.repeat(80));
    
  } catch (error) {
    log(`Fatal error during migration: ${error.message}`, 'error');
    console.error(error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run the migration
if (require.main === module) {
  log('Starting OAuth 2.0 migration script...');
  migrateAllUsers()
    .then(() => {
      log('Script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      log(`Script failed: ${error.message}`, 'error');
      console.error(error);
      process.exit(1);
    });
}

module.exports = { migrateAllUsers, migrateUser };

