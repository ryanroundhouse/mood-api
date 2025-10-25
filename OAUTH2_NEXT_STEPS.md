# OAuth 2.0 Migration - Your Next Steps

## ✅ What's Been Completed

I've implemented the core OAuth 2.0 migration infrastructure:

1. **Database Schema** - Added 4 new columns to support OAuth 2.0:
   - `garminAccessTokenV2` - OAuth 2.0 access token
   - `garminRefreshToken` - Refresh token for getting new access tokens
   - `garminTokenExpiry` - Timestamp when the access token expires
   - `garminOAuthVersion` - Tracks which OAuth version the user is on ('v1' or 'v2')

2. **Token Management** - Implemented automatic token refresh:
   - `refreshGarminAccessToken()` - Automatically refreshes expired tokens
   - `getValidAccessToken()` - Gets a valid token, refreshing if needed

3. **Dual OAuth Support** - API requests now work with both OAuth 1.0 and 2.0:
   - `makeGarminApiRequest()` - Automatically uses the right OAuth version per user

4. **Token Exchange Endpoint** - New endpoint to migrate existing users:
   - `POST /api/garmin/migrate-to-oauth2` - Migrates OAuth 1.0 users to OAuth 2.0

5. **Enhanced Status Endpoint** - Updated to show OAuth version:
   - `GET /api/garmin/status` - Now includes `oauthVersion` field

---

## 🎯 Immediate Action Items (DO THIS FIRST!)

### Step 1: Get Your OAuth 2.0 Secret 🔑

1. Go to [Garmin Developer Portal](https://developer.garmin.com)
2. Sign in with your developer account
3. Navigate to **Apps** tab
4. Find your app
5. Look for the new **OAuth 2.0 Client Secret** (Garmin just enabled this for you)
6. Copy the secret

### Step 2: Update Your Environment Variables

Add the OAuth 2.0 secret to your `.env` file:

```bash
# Add this new variable:
GARMIN_OAUTH2_CLIENT_SECRET=your_oauth2_secret_here

# Keep your existing variables (these are still needed during transition):
GARMIN_CONSUMER_KEY=your_existing_consumer_key
GARMIN_CONSUMER_SECRET=your_existing_consumer_secret
```

### Step 3: Restart Your Server

```bash
# Stop your server if it's running
# Then start it again to load the new environment variable
npm start
```

The new database columns will be automatically added when the server starts!

---

## 🧪 Testing the Migration

### Test with Your Own Account (Recommended)

If you have a Garmin device and a test account on your app:

1. **Check current status:**
   ```bash
   curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:3000/api/garmin/status
   ```
   Should show: `"oauthVersion": "v1"`

2. **Migrate to OAuth 2.0:**
   ```bash
   curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:3000/api/garmin/migrate-to-oauth2
   ```
   Should return: `{"success": true, "message": "Successfully migrated to OAuth 2.0"}`

3. **Verify migration:**
   ```bash
   curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:3000/api/garmin/status
   ```
   Should now show: `"oauthVersion": "v2"`

4. **Check that data still flows:**
   - Sleep data and daily summaries should continue to arrive via webhooks
   - No disruption to existing functionality

---

## 📊 What's Working Now

### OAuth 1.0 Users (Existing)
- ✅ Continue to work exactly as before
- ✅ Can be migrated to OAuth 2.0 at any time
- ✅ No disruption to service

### OAuth 2.0 Users (After Migration)
- ✅ Use modern Bearer token authentication
- ✅ Automatic token refresh (no more expired tokens!)
- ✅ Same webhooks and data flow as before

### New Users
- ℹ️ Currently still use OAuth 1.0 flow
- ℹ️ Can migrate to OAuth 2.0 after connecting
- ⏳ Full OAuth 2.0 signup flow can be added later

---

## 🚀 Migration Strategy

### Option A: Gradual Migration (Recommended)

Migrate users in batches to monitor for issues:

1. **Week 1**: Migrate 10-20 test users
   - Monitor logs for any errors
   - Verify data continues flowing

2. **Week 2**: Migrate 25% of users
   - Continue monitoring
   - Address any edge cases

3. **Week 3**: Migrate remaining 75% of users
   - Complete the migration
   - Monitor for 30-day OAuth 1.0 grace period

### Option B: User-Initiated Migration

Add a button in your app's Garmin settings:
- "Upgrade to OAuth 2.0 (Recommended)"
- Calls `POST /api/garmin/migrate-to-oauth2`
- Show success message

---

## 📝 Migration Checklist

- [ ] Retrieve OAuth 2.0 client secret from Garmin portal
- [ ] Add `GARMIN_OAUTH2_CLIENT_SECRET` to `.env`
- [ ] Restart server (database columns auto-added)
- [ ] Test migration with your own account
- [ ] Verify OAuth 2.0 user receives webhook data
- [ ] Choose migration strategy (gradual vs user-initiated)
- [ ] Begin migrating users
- [ ] Monitor error logs during migration
- [ ] Complete migration before 30-day OAuth 1.0 grace period

---

## 🔍 Monitoring & Troubleshooting

### Check Database Columns Were Added

```bash
sqlite3 database.sqlite "PRAGMA table_info(users);"
```

Look for:
- `garminAccessTokenV2`
- `garminRefreshToken`
- `garminTokenExpiry`
- `garminOAuthVersion`

### Check User's OAuth Version

```bash
sqlite3 database.sqlite "SELECT id, email, garminConnected, garminOAuthVersion FROM users WHERE garminConnected = 1;"
```

### View Migration Logs

Check your application logs for:
- `Starting OAuth 2.0 migration for user X`
- `Successfully migrated user X to OAuth 2.0`
- `Failed to refresh token` (if token refresh fails)

### Common Issues

1. **"OAuth 2.0 migration not yet configured on server"**
   - You haven't added `GARMIN_OAUTH2_CLIENT_SECRET` to `.env`
   - Or you haven't restarted the server

2. **"No OAuth 1.0 credentials found"**
   - User hasn't connected their Garmin account yet
   - They need to connect first, then migrate

3. **"Failed to exchange token with Garmin"**
   - Check that the OAuth 2.0 secret is correct
   - Verify with Garmin support that OAuth 2.0 is enabled
   - Check application logs for detailed error

---

## 🎉 Benefits of OAuth 2.0

- **Better Security**: Bearer tokens instead of signature-based auth
- **Automatic Token Refresh**: No more expired credentials
- **Modern Standard**: Industry standard authentication
- **Simplified Code**: Less complex than OAuth 1.0a signatures
- **Future-Proof**: Required by December 31, 2026

---

## 📞 Need Help?

- **Garmin Support**: connect-support@developer.garmin.com
- **Migration Guide**: See `GARMIN_OAUTH2_MIGRATION.md` for detailed implementation
- **API Documentation**: Check `/docs` folder for Garmin API specs

---

## ⏰ Important Dates

- **OAuth 1.0 Retirement**: December 31, 2026
- **30-Day Grace Period**: After token exchange, OAuth 1.0 tokens remain valid for 30 days
- **Recommended Completion**: Within next 2-3 months to allow time for testing

---

**Last Updated**: October 25, 2025  
**Status**: Ready for testing and migration  
**Next Step**: Get OAuth 2.0 secret from Garmin portal and add to `.env`

