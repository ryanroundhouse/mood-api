# Testing Stripe Payments in the Mood API

This document provides instructions for setting up and testing Stripe payment processing in your development environment.

## Initial Configuration

1. **Create a Stripe account**
   - Sign up at [https://dashboard.stripe.com/register](https://dashboard.stripe.com/register)
   - Make sure to switch to **Test mode** (toggle in the Stripe dashboard)

2. **Gather required credentials**
   - From the Stripe Dashboard, go to Developers → API keys
   - Copy your **Secret Key** (starts with `sk_test_`)
   - **NEVER use production keys** for testing

3. **Create a test product and price**
   - Go to Products → Add Product
   - Create a product for your subscription (e.g., "Pro Plan")
   - Add a recurring price (monthly/yearly)
   - Copy the **Price ID** (starts with `price_`)

4. **Configure your `.env` file**
   ```
   # Stripe Configuration
   STRIPE_SECRET_KEY=sk_test_...your_test_key_here...
   STRIPE_PRICE_ID=price_...your_price_id_here...
   STRIPE_WEBHOOK_SECRET=whsec_...your_webhook_secret_here...
   ```

## Setting Up Webhook Testing

1. **Install the Stripe CLI**
   - Follow instructions at [https://stripe.com/docs/stripe-cli](https://stripe.com/docs/stripe-cli)
   - Use for local testing without exposing your local server

2. **Login to Stripe CLI**
   ```bash
   stripe login
   ```

3. **Forward webhooks to your local server**
   ```bash
   stripe listen --forward-to http://localhost:3000/stripe/webhook
   ```
   - Copy the webhook signing secret provided
   - Add this as `STRIPE_WEBHOOK_SECRET` in your `.env` file

## Testing Payment Scenarios

### Create a Test Customer and Subscription

1. Use the app's UI to create a subscription with a test card
   - Test card number: `4242 4242 4242 4242`
   - Any future expiration date
   - Any 3-digit CVC
   - Any postal code

### Test Failed Payments

Use these test card numbers for different scenarios:
- `4000 0000 0000 0341` - Card declined
- `4000 0000 0000 9995` - Insufficient funds

### Test Subscription Events

```bash
# Test a failed payment
stripe trigger invoice.payment_failed

# Test subscription moving to past_due
stripe trigger customer.subscription.updated \
  --add data.object.id=sub_1RIKKYQuF6M0Ys2eJfGjlYf5 \
  --add data.object.customer=cus_SCjoAJyZ7Z0zwA \
  --add data.object.status=past_due

# Test subscription cancellation
stripe trigger customer.subscription.deleted \
  --add data.object.id=sub_1RIKKYQuF6M0Ys2eJfGjlYf5 \
  --add data.object.customer=cus_SCjoAJyZ7Z0zwA
```

## Important Notes

- **The webhook handling system is not fully tested** - While the code in `routes/stripe.js` includes webhook endpoints to handle various subscription events, they haven't undergone comprehensive testing.
- **Monitor your application logs** - Watch for webhook processing messages to verify proper handling.
- **Database Verification** - After triggering events, check your database to verify subscription status updates.
- **Never use real cards** - Always use [Stripe's test card numbers](https://docs.stripe.com/testing#cards) for testing.
- **Keep your test keys private** - Even though these are test credentials, don't commit them to public repositories.

## Troubleshooting

- **Webhook not received**: Make sure your Stripe CLI is running and forwarding to the correct URL
- **Payment failures**: Check application logs for error messages
- **Subscription status not updated**: Verify the webhook was received and processed correctly

For more information, refer to the [Stripe API Documentation](https://docs.stripe.com/api) and [Testing Guide](https://docs.stripe.com/testing). 