# Garmin OAuth 2.0 Migration Plan

## Overview

This document outlines the migration strategy from OAuth 1.0a to OAuth 2.0 for the Garmin Connect integration. OAuth 1.0 will be retired on **December 31, 2026**.

**Key Changes:**
- OAuth 1.0a (HMAC-SHA1 signatures) → OAuth 2.0 (Bearer tokens)
- New token exchange endpoint for migrating existing users
- Updated PING/PUSH notification structure with additional token parameter
- User ID remains primary identifier (already implemented ✓)
- Support for refresh tokens for long-term access

---

## Current Implementation Status

### ✅ Already Compatible
- **User ID as Primary Identifier**: Your app already uses `garminUserId` as the main identifier in webhooks
- **Webhook Endpoints**: All webhook handlers (sleep, dailies, deregister) already use `userId` from the payload
- **Database Schema**: Stores `garminUserId`, `garminAccessToken`, `garminTokenSecret`, and `garminConnected` flag

### ⚠️ Requires Changes
- **OAuth Flow**: Currently uses OAuth 1.0a signature-based authentication
- **Token Storage**: Need to add support for OAuth 2.0 access tokens and refresh tokens
- **Token Refresh Logic**: OAuth 2.0 tokens expire and require refresh
- **API Request Signing**: Change from OAuth 1.0a signatures to Bearer token authentication
- **Webhook Structure**: PING/PULL partners need to handle additional token parameter in callback URL

---

## Migration Timeline

### Phase 1: Pre-Migration (Before Contacting Garmin)
- [ ] Audit all existing users with Garmin connections
- [ ] Extract and store User IDs for all connected users (already doing this ✓)
- [ ] Review and test current webhook handlers
- [ ] Prepare code changes for OAuth 2.0 support

### Phase 2: Request Migration (Contact Garmin)
- [x] Email `connect-support@developer.garmin.com` with:
  - Consumer Key(s): `GARMIN_CONSUMER_KEY` from environment
  - Confirm webhook URLs are ready for new PING structure
  - Request migration to OAuth 2.0
- [x] Wait for confirmation from Garmin support
- [ ] Retrieve new OAuth 2.0 secret from developer portal

### Phase 3: Implementation (After Garmin Enables OAuth 2.0)
- [x] Update database schema for OAuth 2.0 tokens
- [ ] Implement OAuth 2.0 authorization flow (new users) - *Optional for now*
- [x] Implement token exchange for existing users
- [x] Update API request methods to use Bearer tokens
- [x] Implement token refresh logic
- [ ] Update webhook handlers for new PING structure - *Will auto-handle after migration*
- [ ] Test with development/staging users

### Phase 4: Migration & Monitoring
- [ ] Migrate existing users via token exchange
- [ ] Monitor for 30-day transition period
- [ ] Handle any migration errors
- [ ] Complete migration before OAuth 1.0 retirement (12/31/2026)

---

## Technical Implementation Details

### 1. Database Schema Changes

Add new columns to the `users` table:

```sql
-- OAuth 2.0 token fields
ALTER TABLE users ADD COLUMN garminAccessTokenV2 TEXT;
ALTER TABLE users ADD COLUMN garminRefreshToken TEXT;
ALTER TABLE users ADD COLUMN garminTokenExpiry INTEGER;  -- Unix timestamp
ALTER TABLE users ADD COLUMN garminOAuthVersion TEXT DEFAULT 'v1';  -- 'v1' or 'v2'

-- Keep existing OAuth 1.0 columns during transition period:
-- garminAccessToken (OAuth 1.0)
-- garminTokenSecret (OAuth 1.0)
```

### 2. OAuth 2.0 Authorization Flow (New Users)

Update the authorization endpoints in `routes/garmin.js`:

**New OAuth 2.0 Endpoints:**
```javascript
// OAuth 2.0 Configuration
const GARMIN_OAUTH2_AUTHORIZE_URL = 'https://connect.garmin.com/oauthConfirm';
const GARMIN_OAUTH2_TOKEN_URL = 'https://connectapi.garmin.com/oauth-service/oauth/token';
const GARMIN_OAUTH2_CLIENT_ID = process.env.GARMIN_CONSUMER_KEY;
const GARMIN_OAUTH2_CLIENT_SECRET = process.env.GARMIN_OAUTH2_CLIENT_SECRET; // New secret from portal
```

**Step 1: Authorization Request**
```javascript
// Replace OAuth 1.0 request token flow with:
const authUrl = `${GARMIN_OAUTH2_AUTHORIZE_URL}?` +
  `client_id=${GARMIN_OAUTH2_CLIENT_ID}&` +
  `response_type=code&` +
  `redirect_uri=${encodeURIComponent(callbackUrl)}&` +
  `scope=wellness_api`;  // Add required scopes
```

**Step 2: Token Exchange**
```javascript
// Exchange authorization code for tokens
const tokenResponse = await fetch(GARMIN_OAUTH2_TOKEN_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Authorization': `Basic ${Buffer.from(`${GARMIN_OAUTH2_CLIENT_ID}:${GARMIN_OAUTH2_CLIENT_SECRET}`).toString('base64')}`
  },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code: authorizationCode,
    redirect_uri: callbackUrl
  })
});

const tokens = await tokenResponse.json();
// tokens = { access_token, refresh_token, expires_in, token_type: 'Bearer' }
```

### 3. Token Exchange for Existing Users

Create a new endpoint to migrate existing OAuth 1.0 users:

```javascript
// POST /api/garmin/migrate-to-oauth2
router.post('/migrate-to-oauth2', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  // Get user's OAuth 1.0 credentials
  const user = await getUserById(userId);
  
  if (!user.garminAccessToken || !user.garminTokenSecret) {
    return res.status(400).json({ error: 'No OAuth 1.0 credentials found' });
  }
  
  // Call Garmin token exchange endpoint
  const GARMIN_TOKEN_EXCHANGE_URL = 'https://apis.garmin.com/partner-gateway/rest/user/token-exchange';
  
  // Must be signed with OAuth 1.0 credentials
  const response = await makeOAuthRequest('POST', GARMIN_TOKEN_EXCHANGE_URL, {
    oauth_token: user.garminAccessToken
  }, user.garminTokenSecret);
  
  if (!response.ok) {
    logger.error('Token exchange failed:', await response.text());
    return res.status(500).json({ error: 'Failed to exchange token' });
  }
  
  const oauth2Tokens = await response.json();
  // oauth2Tokens = { access_token, refresh_token, expires_in }
  
  // Store OAuth 2.0 tokens
  await db.run(`
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
  ]);
  
  logger.info(`✅ Migrated user ${userId} to OAuth 2.0`);
  res.json({ success: true, message: 'Successfully migrated to OAuth 2.0' });
});
```

### 4. Token Refresh Logic

Implement automatic token refresh:

```javascript
async function refreshGarminAccessToken(userId) {
  const user = await getUserById(userId);
  
  if (!user.garminRefreshToken) {
    throw new Error('No refresh token available');
  }
  
  const response = await fetch(GARMIN_OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${Buffer.from(`${GARMIN_OAUTH2_CLIENT_ID}:${GARMIN_OAUTH2_CLIENT_SECRET}`).toString('base64')}`
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: user.garminRefreshToken
    })
  });
  
  if (!response.ok) {
    throw new Error('Failed to refresh token');
  }
  
  const tokens = await response.json();
  
  // Update database
  await db.run(`
    UPDATE users 
    SET garminAccessTokenV2 = ?,
        garminTokenExpiry = ?
    WHERE id = ?
  `, [
    tokens.access_token,
    Date.now() + (tokens.expires_in * 1000),
    userId
  ]);
  
  return tokens.access_token;
}

// Helper function to get valid access token
async function getValidAccessToken(userId) {
  const user = await getUserById(userId);
  
  // Check if using OAuth 2.0
  if (user.garminOAuthVersion === 'v2') {
    // Check if token is expired or about to expire (5 min buffer)
    if (!user.garminTokenExpiry || user.garminTokenExpiry < Date.now() + 300000) {
      return await refreshGarminAccessToken(userId);
    }
    return user.garminAccessTokenV2;
  } else {
    // Still using OAuth 1.0 - return existing token
    return user.garminAccessToken;
  }
}
```

### 5. Update API Request Methods

Replace `makeOAuthRequest()` function with version-aware requests:

```javascript
async function makeGarminApiRequest(method, url, userId, params = {}) {
  const user = await getUserById(userId);
  
  if (user.garminOAuthVersion === 'v2') {
    // OAuth 2.0: Use Bearer token
    const accessToken = await getValidAccessToken(userId);
    
    const queryString = new URLSearchParams(params).toString();
    const fullUrl = queryString ? `${url}?${queryString}` : url;
    
    return fetch(fullUrl, {
      method: method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
  } else {
    // OAuth 1.0: Use existing signature-based method
    return makeOAuthRequest(method, url, {
      oauth_token: user.garminAccessToken,
      ...params
    }, user.garminTokenSecret);
  }
}
```

### 6. Update Webhook Handlers

The webhook handlers already use `userId` as the primary identifier, which is good! However, you need to ensure the new PING structure is handled:

**Current Webhook Format (PUSH):**
```json
{
  "sleeps": [{
    "userId": "4aacafe82427c251df9c9592d0c06768",
    "summaryId": "...",
    "calendarDate": "2024-01-01",
    ...
  }]
}
```

**New PING Structure (PING/PULL partners):**
According to section 4.2, the callback URL will include an additional `token` parameter:

```json
{
  "sleeps": [{
    "userId": "4aacafe82427c251df9c9592d0c06768",
    "uploadStartTimeInSeconds": 1444937651,
    "uploadEndTimeInSeconds": 1444937902,
    "callbackURL": "https://apis.garmin.com/wellness-api/rest/sleeps?uploadStartTimeInSeconds=1444937651&uploadEndTimeInSeconds=1444937902&token=<additional_token>"
  }]
}
```

**Action Required:**
- If you're using PUSH notifications (data included in webhook), no changes needed
- If you're using PING/PULL (callback URLs), ensure your server honors the callback URL directly with the new token parameter

### 7. Update Backfill Requests

Update the `requestSleepBackfill` and `requestDailiesBackfill` functions:

```javascript
async function requestSleepBackfill(userId) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - (30 * 24 * 60 * 60 * 1000));
  
  const startTs = Math.floor(startTime.getTime() / 1000);
  const endTs = Math.floor(endTime.getTime() / 1000);
  
  const response = await makeGarminApiRequest('GET', GARMIN_BACKFILL_SLEEP_URL, userId, {
    summaryStartTimeInSeconds: startTs.toString(),
    summaryEndTimeInSeconds: endTs.toString()
  });
  
  return response.ok;
}
```

---

## Testing Strategy

### 1. Pre-Migration Testing
- [ ] Test current OAuth 1.0 flow with test user
- [ ] Verify all webhook handlers receive and process data correctly
- [ ] Confirm User ID is being stored for all users

### 2. Development Testing (After Garmin Enables OAuth 2.0)
- [ ] Test new user registration with OAuth 2.0
- [ ] Test token exchange with a test OAuth 1.0 user
- [ ] Test token refresh logic
- [ ] Test API requests with Bearer tokens
- [ ] Verify webhook data still processes correctly

### 3. Staging/Production Testing
- [ ] Migrate 1-2 test users first
- [ ] Monitor for 24 hours
- [ ] Gradually migrate users in batches
- [ ] Monitor error logs and user reports

---

## Rollout Plan

### Week 1-2: Preparation
1. Contact Garmin support to request migration
2. Implement database changes
3. Develop OAuth 2.0 support code
4. Create comprehensive tests

### Week 3-4: Implementation
1. Deploy code to staging environment
2. Test with development users
3. Prepare monitoring dashboards
4. Create user communication plan

### Week 5-6: Gradual Migration
1. Deploy to production
2. Migrate 10% of users via token exchange
3. Monitor for issues
4. Expand to 50% of users
5. Complete migration for all users

### Week 7-8: Monitoring & Cleanup
1. Monitor during 30-day OAuth 1.0 validity period
2. Handle any edge cases
3. Remove OAuth 1.0 code after migration complete
4. Update documentation

---

## Migration Checklist

### Pre-Migration
- [ ] Audit all Garmin-connected users
- [ ] Verify User IDs are stored for all users
- [ ] Review current webhook implementation
- [ ] Document current OAuth 1.0 flow

### Contact Garmin
- [ ] Email connect-support@developer.garmin.com
- [ ] Provide consumer key: `$GARMIN_CONSUMER_KEY`
- [ ] Confirm PUSH webhook structure readiness
- [ ] Wait for OAuth 2.0 enablement confirmation
- [ ] Retrieve new OAuth 2.0 client secret from portal

### Implementation
- [ ] Add OAuth 2.0 database columns
- [ ] Implement OAuth 2.0 authorization flow
- [ ] Implement token exchange endpoint
- [ ] Implement token refresh logic
- [ ] Update API request methods
- [ ] Test in development environment
- [ ] Update environment variables

### Deployment
- [ ] Deploy to staging
- [ ] Test with staging users
- [ ] Deploy to production
- [ ] Create migration endpoint
- [ ] Monitor logs and metrics

### Migration
- [ ] Migrate test users (10%)
- [ ] Monitor for 48 hours
- [ ] Migrate remaining users in batches
- [ ] Monitor during 30-day transition
- [ ] Document any issues and resolutions

### Post-Migration
- [ ] Verify all users migrated successfully
- [ ] Remove OAuth 1.0 code (after 30 days)
- [ ] Update documentation
- [ ] Archive this migration guide

---

## Code Files to Modify

### Primary Changes
1. **routes/garmin.js** - Main OAuth flow and API requests
2. **database.js** - Database schema updates
3. **app/garmin-callback.html** - OAuth 2.0 callback handling (minimal changes)

### Testing Files
1. **scripts/test-garmin-connection.py** - Update for OAuth 2.0 testing
2. **scripts/fetch-garmin-sleep.py** - Update API request signing

---

## Environment Variables

Add to `.env`:

```bash
# OAuth 2.0 Credentials (after Garmin enables OAuth 2.0)
GARMIN_OAUTH2_CLIENT_SECRET=your_oauth2_secret_here

# Existing variables (keep during transition)
GARMIN_CONSUMER_KEY=your_consumer_key_here
GARMIN_CONSUMER_SECRET=your_consumer_secret_here
```

---

## Monitoring & Alerts

### Key Metrics to Monitor
- OAuth 2.0 token exchange success rate
- Token refresh success rate
- API request failure rates
- Webhook processing errors
- User migration completion rate

### Log What to Watch
- Token exchange failures
- Token refresh failures
- API authentication errors (401)
- Webhook parsing errors
- User ID lookup failures

---

## Rollback Plan

During the 30-day transition period:
1. OAuth 1.0 tokens remain valid
2. If OAuth 2.0 issues occur, can temporarily revert to OAuth 1.0
3. After 30 days, rollback not possible - OAuth 1.0 tokens expire
4. Ensure thorough testing before 30-day deadline

---

## Support Resources

- **Garmin Developer Support**: connect-support@developer.garmin.com
- **Garmin Developer Portal**: https://developer.garmin.com
- **OAuth 2.0 Specification**: https://oauth.net/2/
- **Health API Documentation**: Referenced in `/docs/Health_API_1.1.2.md`

---

## Risk Assessment

### High Risk
- ❌ Missing 30-day migration window (OAuth 1.0 tokens expire)
- ❌ Token exchange failures for large user base

### Medium Risk
- ⚠️ Token refresh implementation bugs
- ⚠️ Webhook structure changes breaking integrations

### Low Risk
- ✅ Database schema changes (straightforward ALTER TABLE)
- ✅ User ID already being used (compliant with new requirements)

---

## Timeline

- **Now**: Preparation and planning
- **Week 1-2**: Contact Garmin, implement changes
- **Week 3-4**: Testing and staging deployment
- **Week 5-8**: Gradual production migration
- **Before 12/31/2026**: Complete migration (deadline)

**Recommended Start Date**: Within next 1-2 months to allow ample time for testing and migration.

---

## Questions for Garmin Support

When contacting connect-support@developer.garmin.com:

1. What is the exact format of the token exchange API response?
2. Are there rate limits for the token exchange endpoint?
3. What is the typical access token lifetime for OAuth 2.0?
4. Will refresh tokens ever expire? If so, what's the lifetime?
5. Are there any changes to webhook retry logic with OAuth 2.0?
6. What is the recommended batch size for migrating users?
7. Are there any scopes we need to request for OAuth 2.0?
8. Will the User ID format change with OAuth 2.0?

---

## Notes

- **Good News**: Your app already uses `garminUserId` as the primary identifier, so you're compliant with the new requirements!
- **Webhook Format**: Your PUSH webhooks already extract `userId` from the payload, so minimal changes needed
- **30-Day Grace Period**: OAuth 1.0 tokens remain valid for 30 days after exchange, providing a safety buffer
- **No Forced Downtime**: Migration can happen gradually without user impact

---

**Last Updated**: October 4, 2025
**Migration Deadline**: December 31, 2026
**Status**: Planning Phase

