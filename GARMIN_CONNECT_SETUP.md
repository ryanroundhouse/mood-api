# Garmin Connect OAuth Integration Setup

This guide explains how to set up Garmin Connect OAuth integration for your mood tracking application.

## Overview

The Garmin Connect integration allows users to authenticate with their Garmin accounts and potentially sync activity and health data with their mood tracking. This integration uses OAuth 1.0a authentication as required by Garmin's API.

## Prerequisites

1. A Garmin Connect IQ developer account
2. A registered application in the Garmin Connect IQ store
3. OAuth 1.0a consumer credentials from Garmin

## Getting Garmin OAuth Credentials

### Step 1: Create a Garmin Developer Account

1. Go to [Garmin Connect IQ Developer Portal](https://developer.garmin.com/connect-iq/)
2. Sign up for a developer account or log in with your existing Garmin account
3. Complete the developer registration process

### Step 2: Register Your Application

1. In the Connect IQ developer portal, create a new application
2. Fill out the application details:
   - **Application Name**: Your mood tracking app name
   - **Description**: Brief description of your application
   - **Category**: Health & Fitness
   - **Privacy Policy URL**: Your privacy policy URL
   - **Terms of Service URL**: Your terms of service URL

### Step 3: Get OAuth Credentials

1. Once your application is approved, navigate to the OAuth settings
2. Note down your:
   - **Consumer Key** (also called Client ID)
   - **Consumer Secret** (also called Client Secret)
3. Set up your callback URL to: `https://yourdomain.com/api/garmin/callback`
   - For development: `http://localhost:3000/api/garmin/callback`
   - Note: The API endpoint redirects to `garmin-callback.html` which automatically closes the popup window

## Environment Configuration

Add the following environment variables to your `.env` file:

```bash
# Garmin Connect OAuth Configuration
GARMIN_CONSUMER_KEY=your_consumer_key_here
GARMIN_CONSUMER_SECRET=your_consumer_secret_here

# Make sure your site URL is correctly set for callbacks
MOOD_SITE_URL=https://yourdomain.com
# For development:
# MOOD_SITE_URL=http://localhost:3000
```

## Database Schema

The integration automatically adds the following columns to your `users` table:

- `garminAccessToken` (TEXT) - Stores the OAuth access token
- `garminTokenSecret` (TEXT) - Stores the OAuth token secret
- `garminUserId` (TEXT) - Stores the Garmin user ID
- `garminConnected` (INTEGER) - Boolean flag indicating connection status

A new table `garmin_request_tokens` is also created to temporarily store OAuth request tokens during the authentication flow.

## API Endpoints

The integration adds the following API endpoints:

### POST `/api/garmin/start-auth`
- **Authentication**: Required (JWT token)
- **Description**: Initiates the OAuth flow and returns an authorization URL
- **Response**: `{ "authUrl": "https://connect.garmin.com/oauthConfirm?oauth_token=..." }`

### GET `/api/garmin/callback`
- **Authentication**: None (public callback endpoint)
- **Description**: Handles the OAuth callback from Garmin
- **Parameters**: `oauth_token`, `oauth_verifier`
- **Redirects**: Back to account settings with success/error parameters

### POST `/api/garmin/disconnect`
- **Authentication**: Required (JWT token)
- **Description**: Disconnects the user's Garmin account
- **Response**: `{ "message": "Garmin account disconnected successfully" }`

### GET `/api/garmin/status`
- **Authentication**: Required (JWT token)
- **Description**: Returns the current Garmin connection status
- **Response**: `{ "connected": true/false, "garminUserId": "..." }`

## User Interface

The integration adds a new section to the account settings page (`account-settings.html`) with:

- Connection status display
- Connect/Disconnect buttons
- Success/error message handling
- OAuth flow management

## Security Considerations

1. **OAuth Tokens**: Access tokens and secrets are stored encrypted in the database
2. **Rate Limiting**: All endpoints use rate limiting to prevent abuse
3. **HTTPS Required**: OAuth callbacks require HTTPS in production
4. **Token Expiration**: Request tokens expire after 10 minutes

## Testing

### Development Testing

1. Set up your `.env` file with test credentials
2. Start your development server: `node server.js`
3. Navigate to `http://localhost:3000/account-settings.html`
4. Log in and test the Garmin Connect integration

### Production Testing

1. Ensure your domain is properly configured in Garmin's developer portal
2. Set up HTTPS for your production domain
3. Update the callback URL in Garmin's settings
4. Test the full OAuth flow

## Troubleshooting

### Common Issues

1. **"Invalid auth code" errors**
   - Check that your consumer key and secret are correct
   - Verify the callback URL matches what's registered with Garmin
   - Ensure request tokens haven't expired (10-minute limit)

2. **"Failed to get request token" errors**
   - Verify your Garmin OAuth credentials
   - Check that your application is approved in the Garmin developer portal
   - Ensure your server can make HTTPS requests to Garmin's API

3. **Callback URL issues**
   - Make sure the callback URL in your Garmin app settings matches your `MOOD_SITE_URL`
   - For development, use `http://localhost:3000`
   - For production, use your actual domain with HTTPS

### Debug Logging

The integration includes comprehensive logging. Check your application logs for:
- OAuth request/response details
- Database operation results
- Error messages with specific failure reasons

## Future Enhancements

This integration provides the foundation for:

1. **Activity Data Sync**: Fetch daily activity summaries
2. **Health Metrics**: Sync heart rate, sleep, and stress data
3. **Automatic Mood Correlation**: Analyze relationships between activity and mood
4. **Wellness Insights**: Provide personalized recommendations based on combined data

## API Documentation References

- [Garmin Connect IQ Developer Guide](https://developer.garmin.com/connect-iq/)
- [Garmin Wellness API Documentation](https://developer.garmin.com/wellness-api/)
- [OAuth 1.0a Specification](https://tools.ietf.org/html/rfc5849)

## Support

For issues specific to this integration, check the application logs and ensure all environment variables are properly configured. For Garmin-specific API issues, consult the Garmin developer documentation or contact Garmin developer support. 