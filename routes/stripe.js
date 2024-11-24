const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticateToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiter');
const { db } = require('../database');
const logger = require('../utils/logger');

// Stripe webhook endpoint
router.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      logger.error('Webhook signature verification failed:', err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object;
        logger.info(
          `PaymentIntent for ${paymentIntent.amount} was successful!`
        );
        // Handle successful payment here
        break;
      // Add more event types as needed
      default:
        logger.warn(`Unhandled stripe event type ${event.type}`);
    }

    res.json({ received: true });
  }
);

// Upgrade account endpoint
router.post('/upgrade', authenticateToken, strictLimiter, async (req, res) => {
  const { paymentMethodId } = req.body;
  const userId = req.user.id;

  try {
    // Fetch user details from the database
    db.get(
      `SELECT email, name, stripeCustomerId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }

        let stripeCustomerId = user.stripeCustomerId;

        if (!stripeCustomerId) {
          // Create Stripe customer if not already created
          const customer = await stripe.customers.create({
            email: user.email,
            name: user.name,
          });

          stripeCustomerId = customer.id;

          // Update user with the new Stripe customer ID
          db.run(
            `UPDATE users SET stripeCustomerId = ? WHERE id = ?`,
            [stripeCustomerId, userId],
            (updateErr) => {
              if (updateErr) {
                logger.error('Error updating Stripe customer ID:', updateErr);
                return res.status(500).json({ error: 'Internal server error' });
              }
            }
          );
        }

        // Attach payment method to customer
        await stripe.paymentMethods.attach(paymentMethodId, {
          customer: stripeCustomerId,
        });

        // Set the default payment method for the customer
        await stripe.customers.update(stripeCustomerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId,
          },
        });

        // Create subscription
        const subscription = await stripe.subscriptions.create({
          customer: stripeCustomerId,
          items: [{ price: process.env.STRIPE_PRICE_ID }],
          expand: ['latest_invoice.payment_intent'],
        });

        // Update user with the new subscription ID and account level
        db.run(
          `UPDATE users SET stripeSubscriptionId = ?, accountLevel = 'pro' WHERE id = ?`,
          [subscription.id, userId],
          (updateErr) => {
            if (updateErr) {
              logger.error(
                'Error updating subscription ID and account level:',
                updateErr
              );
              return res.status(500).json({ error: 'Internal server error' });
            }

            logger.info(`User upgraded to Pro: ${user.email}`);
            res.json({ message: 'Your account has been upgraded to Pro!' });
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error during upgrade:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Downgrade account endpoint
router.post(
  '/downgrade',
  authenticateToken,
  strictLimiter,
  async (req, res) => {
    const userId = req.user.id;

    try {
      // Fetch user details from the database
      db.get(
        `SELECT stripeSubscriptionId FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err) {
            logger.error('Error fetching user details:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user || !user.stripeSubscriptionId) {
            return res.status(404).json({ error: 'Subscription not found' });
          }

          // Cancel the Stripe subscription
          await stripe.subscriptions.cancel(user.stripeSubscriptionId);

          // Update user account level to 'basic' and remove subscription ID
          db.run(
            `UPDATE users SET stripeSubscriptionId = NULL, accountLevel = 'basic' WHERE id = ?`,
            [userId],
            (updateErr) => {
              if (updateErr) {
                logger.error('Error updating account level:', updateErr);
                return res.status(500).json({ error: 'Internal server error' });
              }

              logger.info(`User downgraded to Basic: ${userId}`);
              res.json({
                message: 'Your account has been downgraded to Basic.',
              });
            }
          );
        }
      );
    } catch (error) {
      logger.error('Error during downgrade:', error);
      res.status(500).json({ error: 'An error occurred. Please try again.' });
    }
  }
);

module.exports = router;
