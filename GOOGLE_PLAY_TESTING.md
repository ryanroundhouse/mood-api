# Testing Google Play Payments in the Mood API

This document provides instructions for setting up and testing Google Play in-app purchase/subscription processing in your development environment.

## Initial Configuration

1. **Set up a Google Play Developer Account**
   - Register at [https://play.google.com/console/](https://play.google.com/console/)
   - Make sure you have access to your app's Developer Console

2. **Create Service Account Keys**
   - Go to Google Cloud Console → IAM & Admin → Service Accounts
   - Create a service account for Google Play API access
   - Create a JSON key file and download it
   - Create a separate service account for Google PubSub if needed

3. **Configure In-App Products in Play Console**
   - Set up your subscription products in the Play Console
   - Make note of the product IDs you create

4. **Configure your `.env` file**
   ```
   # Google Play Configuration
   GOOGLE_PLAY_KEY_FILE=path/to/your-play-api-key.json
   GOOGLE_PLAY_PACKAGE_NAME=your.app.package.name
   GOOGLE_PUBSUB_KEY_FILE=path/to/your-pubsub-key.json
   ```

## Testing In-App Purchases

### Setting Up a Test Environment

1. **Use Google's Test Track**
   - Upload a version of your app to the internal test track
   - Add test users to your testing program
   - Make sure your app is properly configured with the Billing Library

2. **Set Up Test Subscriptions**
   - Go to Play Console → Your App → Monetize → Products → Subscriptions
   - Create test subscriptions with appropriate pricing tiers
   - Note the product IDs of your test subscriptions

### Verifying Purchases

The following endpoints are available for testing:

1. **Verify a new purchase**
   ```
   POST /google-play/verify-purchase
   
   {
     "purchaseToken": "purchase_token_from_app",
     "productId": "your_product_id",
     "packageName": "your.app.package.name"
   }
   ```

2. **Check subscription status**
   ```
   GET /google-play/subscription-status
   ```

### Testing with Real Devices

1. **Install your app from the test track**
2. **Make a test purchase**
   - Use a test payment method in Google Play
   - Complete the purchase flow in your app
   - Verify that the app correctly calls your backend API

3. **Verify the purchase on your backend**
   - Check your server logs for the verification request
   - Confirm the user's account level was updated correctly
   - Check the database for the updated `googlePlaySubscriptionId`

## Testing Subscription Lifecycle Events

### Manual Testing

To test subscription lifecycle events manually:

1. **Purchase a subscription** through the test app
2. **Cancel the subscription** in Google Play
3. **Watch your server logs** for PubSub notifications
4. **Check the database** to verify account level changes

### PubSub Testing

For testing the PubSub integration:

1. **Set up a Google Cloud PubSub topic**
   - Configure real-time developer notifications in Play Console
   - Point to your PubSub topic

2. **Configure PubSub push endpoint**
   - Set up your server's `/google-play/pubsub` endpoint as a push subscriber
   - Ensure it's accessible via HTTPS for Google PubSub

3. **Simulate subscription events**
   - Google doesn't provide direct tools to simulate events
   - You'll need to rely on real purchases and cancellations

## Important Notes

- **The webhook handling system is not fully tested** - While the code in `routes/google-play.js` includes endpoints to handle subscription notifications, they haven't undergone comprehensive testing.
- **Service account permissions are critical** - Make sure your service account has the appropriate permissions for the Android Publisher API.
- **Key file paths** - Ensure the key files are in the location specified in your .env file. The system checks for both absolute and relative paths.
- **JSON key files are sensitive** - Never commit these files to repositories or share them publicly.
- **Logs are your friend** - The system includes detailed logging for debugging authentication and API issues.

## Troubleshooting

- **Authentication errors**: Check that your service account key files are correctly configured and accessible
- **Missing environment variables**: Ensure all required variables are set in your .env file
- **API errors**: Look for detailed error logs including status codes and response data
- **PubSub issues**: Verify that your endpoint is correctly configured and accessible to Google

For more information, refer to the [Google Play Billing Library Documentation](https://developer.android.com/google/play/billing) and [Real-time Developer Notifications](https://developer.android.com/google/play/billing/getting-ready#configure-rtdn). 