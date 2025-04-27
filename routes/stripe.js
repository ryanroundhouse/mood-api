const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticateToken } = require('../middleware/auth');
const { strictLimiter } = require('../middleware/rateLimiter');
const { db } = require('../database');
const logger = require('../utils/logger');

// Stripe webhook endpoint - must be before any express.json() middleware
router.post(
  '/webhook',
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      // Make sure req.body is available as a Buffer
      const payload = req.body;
      
      if (!Buffer.isBuffer(payload)) {
        logger.error('Webhook payload is not a Buffer');
        return res.status(400).send('Webhook Error: Payload must be provided as raw Buffer');
      }
      
      event = stripe.webhooks.constructEvent(
        payload,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
      
      logger.info(`Webhook received: ${event.type}`);
    } catch (err) {
      logger.error('Webhook signature verification failed:', err);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      // Handle the event
      switch (event.type) {
        case 'payment_intent.succeeded':
          const paymentIntent = event.data.object;
          logger.info(
            `PaymentIntent for ${paymentIntent.amount} was successful! ID: ${paymentIntent.id}, Customer: ${paymentIntent.customer || 'none'}`
          );
          
          // If there's a customer ID, look up the user
          if (paymentIntent.customer) {
            db.get(
              `SELECT id, email FROM users WHERE stripeCustomerId = ?`,
              [paymentIntent.customer],
              (err, user) => {
                if (err) {
                  logger.error('Error finding user for payment intent:', err);
                } else if (user) {
                  logger.info(`Payment is for user ${user.id} (${user.email})`);
                } else {
                  logger.warn(`No user found for Stripe customer: ${paymentIntent.customer}`);
                }
              }
            );
          }
          break;
          
        case 'invoice.payment_succeeded':
          const invoice = event.data.object;
          if (invoice.subscription) {
            // Log detailed information
            logger.info(`Invoice payment succeeded: ID=${invoice.id}, Customer=${invoice.customer}, Subscription=${invoice.subscription}`);
            
            // Update subscription status in the database
            await handleSuccessfulPayment(invoice);
          }
          break;
          
        case 'invoice.payment_failed':
          const failedInvoice = event.data.object;
          if (failedInvoice.subscription) {
            // Log detailed information
            logger.info(`Invoice payment failed: ID=${failedInvoice.id}, Customer=${failedInvoice.customer}, Subscription=${failedInvoice.subscription}`);
            
            // Handle failed payment - possibly notify user
            await handleFailedPayment(failedInvoice);
          }
          break;
          
        case 'customer.subscription.created':
          const newSubscription = event.data.object;
          logger.info(`New subscription created: ID=${newSubscription.id}, Customer=${newSubscription.customer}, Status=${newSubscription.status}`);
          
          // Log user information if we can find them
          db.get(
            `SELECT id, email FROM users WHERE stripeCustomerId = ?`,
            [newSubscription.customer],
            (err, user) => {
              if (err) {
                logger.error('Error finding user for new subscription:', err);
              } else if (user) {
                logger.info(`Subscription created for user ${user.id} (${user.email})`);
              } else {
                logger.warn(`No user found for Stripe customer: ${newSubscription.customer}`);
              }
            }
          );
          break;
          
        case 'customer.subscription.updated':
          const updatedSubscription = event.data.object;
          logger.info(`Subscription updated: ID=${updatedSubscription.id}, Customer=${updatedSubscription.customer}, Status=${updatedSubscription.status}`);
          await handleSubscriptionUpdate(updatedSubscription);
          break;
          
        case 'customer.subscription.deleted':
          const canceledSubscription = event.data.object;
          logger.info(`Subscription canceled: ID=${canceledSubscription.id}, Customer=${canceledSubscription.customer}`);
          await handleSubscriptionCancellation(canceledSubscription);
          break;
          
        default:
          logger.warn(`Unhandled stripe event type ${event.type}`);
      }

      res.json({ received: true });
    } catch (error) {
      logger.error(`Error handling webhook event ${event.type}:`, error);
      res.status(500).json({ error: 'Webhook processing error' });
    }
  }
);

// Helper functions for webhook event handling
async function handleSuccessfulPayment(invoice) {
  try {
    const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
    const customerId = invoice.customer;
    
    // Find the user with this Stripe customer ID
    db.get(
      `SELECT id FROM users WHERE stripeCustomerId = ?`,
      [customerId],
      (err, user) => {
        if (err || !user) {
          return logger.error('Error finding user for successful payment:', err || 'User not found');
        }
        
        // Update the subscription status if needed
        db.run(
          `UPDATE users SET accountLevel = 'pro', stripeSubscriptionStatus = ? WHERE id = ?`,
          [subscription.status, user.id],
          (updateErr) => {
            if (updateErr) {
              logger.error('Error updating subscription status:', updateErr);
            } else {
              logger.info(`Updated subscription status for user ${user.id} to ${subscription.status}`);
            }
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error processing successful payment:', error);
  }
}

async function handleFailedPayment(invoice) {
  try {
    const customerId = invoice.customer;
    
    // Find the user with this Stripe customer ID
    db.get(
      `SELECT id, email FROM users WHERE stripeCustomerId = ?`,
      [customerId],
      (err, user) => {
        if (err || !user) {
          return logger.error('Error finding user for failed payment:', err || 'User not found');
        }
        
        // Log the failed payment - in a real app, you'd notify the user
        logger.warn(`Payment failed for user ${user.id} (${user.email}). Invoice ID: ${invoice.id}`);
        
        // You might want to update the subscription status in your database
        db.run(
          `UPDATE users SET stripeSubscriptionStatus = 'past_due' WHERE id = ?`,
          [user.id],
          (updateErr) => {
            if (updateErr) {
              logger.error('Error updating subscription status to past_due:', updateErr);
            }
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error processing failed payment:', error);
  }
}

async function handleSubscriptionUpdate(subscription) {
  try {
    const customerId = subscription.customer;
    const status = subscription.status;
    
    // Find the user with this Stripe customer ID
    db.get(
      `SELECT id FROM users WHERE stripeCustomerId = ?`,
      [customerId],
      (err, user) => {
        if (err || !user) {
          return logger.error('Error finding user for subscription update:', err || 'User not found');
        }
        
        // Update the subscription status
        db.run(
          `UPDATE users SET stripeSubscriptionStatus = ? WHERE id = ?`,
          [status, user.id],
          (updateErr) => {
            if (updateErr) {
              logger.error('Error updating subscription status:', updateErr);
            } else {
              logger.info(`Updated subscription status for user ${user.id} to ${status}`);
            }
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error processing subscription update:', error);
  }
}

async function handleSubscriptionCancellation(subscription) {
  try {
    const customerId = subscription.customer;
    
    // Find the user with this Stripe customer ID
    db.get(
      `SELECT id FROM users WHERE stripeCustomerId = ?`,
      [customerId],
      (err, user) => {
        if (err || !user) {
          return logger.error('Error finding user for subscription cancellation:', err || 'User not found');
        }
        
        // Downgrade the user to basic and clear subscription ID
        db.run(
          `UPDATE users SET accountLevel = 'basic', stripeSubscriptionId = NULL, stripeSubscriptionStatus = 'canceled' WHERE id = ?`,
          [user.id],
          (updateErr) => {
            if (updateErr) {
              logger.error('Error downgrading user after cancellation:', updateErr);
            } else {
              logger.info(`User ${user.id} downgraded to basic after subscription cancellation`);
            }
          }
        );
      }
    );
  } catch (error) {
    logger.error('Error processing subscription cancellation:', error);
  }
}

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
          `UPDATE users SET stripeSubscriptionId = ?, accountLevel = 'pro', stripeSubscriptionStatus = ? WHERE id = ?`,
          [subscription.id, subscription.status, userId],
          (updateErr) => {
            if (updateErr) {
              logger.error(
                'Error updating subscription ID and account level:',
                updateErr
              );
              return res.status(500).json({ error: 'Internal server error' });
            }

            logger.info(`User upgraded to Pro: ${user.email}`);
            
            // Return more detailed subscription info to the client
            res.json({ 
              message: 'Your account has been upgraded to Pro!',
              subscription: {
                id: subscription.id,
                status: subscription.status,
                currentPeriodEnd: new Date(subscription.current_period_end * 1000),
                // Include payment intent status if it exists
                paymentStatus: subscription.latest_invoice?.payment_intent?.status || 'unknown'
              }
            });
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
        `SELECT stripeSubscriptionId, email FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err) {
            logger.error('Error fetching user details:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user || !user.stripeSubscriptionId) {
            return res.status(404).json({ error: 'Subscription not found' });
          }

          try {
            // Retrieve current subscription before canceling
            const currentSubscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            
            // Cancel the Stripe subscription at period end to avoid immediate cancellation
            // This allows user to continue using pro features until the end of their billing period
            const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
              cancel_at_period_end: true
            });
            
            // Update user subscription status to reflect pending cancellation
            // The actual downgrade to 'basic' will happen via webhook when subscription is fully canceled
            db.run(
              `UPDATE users SET stripeSubscriptionStatus = 'canceling' WHERE id = ?`,
              [userId],
              (updateErr) => {
                if (updateErr) {
                  logger.error('Error updating subscription status:', updateErr);
                  return res.status(500).json({ error: 'Internal server error' });
                }

                logger.info(`User subscription set to cancel at period end: ${user.email}`);
                res.json({
                  message: 'Your subscription will be canceled at the end of the current billing period.',
                  currentPeriodEnd: new Date(currentSubscription.current_period_end * 1000)
                });
              }
            );
          } catch (stripeError) {
            // Handle case where subscription might be invalid in Stripe
            logger.error('Stripe error during downgrade:', stripeError);
            
            // If Stripe can't find the subscription, clean up local database
            if (stripeError.code === 'resource_missing') {
              db.run(
                `UPDATE users SET stripeSubscriptionId = NULL, accountLevel = 'basic', stripeSubscriptionStatus = 'canceled' WHERE id = ?`,
                [userId],
                (cleanupErr) => {
                  if (cleanupErr) {
                    logger.error('Error cleaning up invalid subscription:', cleanupErr);
                    return res.status(500).json({ error: 'Internal server error' });
                  }
                  
                  logger.info(`Cleaned up invalid subscription for user: ${user.email}`);
                  res.json({ message: 'Your account has been downgraded to Basic.' });
                }
              );
            } else {
              res.status(500).json({ error: 'An error occurred with the payment provider. Please try again.' });
            }
          }
        }
      );
    } catch (error) {
      logger.error('Error during downgrade:', error);
      res.status(500).json({ error: 'An error occurred. Please try again.' });
    }
  }
);

// Add a route to check subscription status
router.get('/subscription', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    db.get(
      `SELECT accountLevel, stripeSubscriptionId, stripeSubscriptionStatus FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching subscription details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        // Return basic subscription info to user
        const subscriptionDetails = {
          accountLevel: user.accountLevel,
          status: user.stripeSubscriptionStatus || 'none'
        };
        
        // If there's an active subscription, get more details from Stripe
        if (user.stripeSubscriptionId && user.stripeSubscriptionStatus !== 'canceled') {
          try {
            const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            subscriptionDetails.currentPeriodEnd = new Date(subscription.current_period_end * 1000);
            subscriptionDetails.cancelAtPeriodEnd = subscription.cancel_at_period_end;
          } catch (stripeError) {
            // If there's an error retrieving from Stripe, just return basic info
            logger.warn(`Could not retrieve subscription from Stripe: ${stripeError.message}`);
          }
        }
        
        res.json(subscriptionDetails);
      }
    );
  } catch (error) {
    logger.error('Error retrieving subscription status:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Add a route to get subscription details
router.get('/subscription-details', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    logger.info(`Fetching subscription details for user ${userId}`);
    db.get(
      `SELECT stripeSubscriptionId, stripeSubscriptionStatus, stripeCustomerId, accountLevel FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching subscription details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user) {
          logger.warn(`User not found when fetching subscription details: ${userId}`);
          return res.status(404).json({ error: 'User not found' });
        }
        
        logger.info(`User ${userId} subscription data: Level=${user.accountLevel}, SubscriptionID=${user.stripeSubscriptionId}, Status=${user.stripeSubscriptionStatus}`);
        
        // Default response with no subscription
        const response = {
          hasActiveSubscription: false
        };
        
        // If there's an active subscription, get more details from Stripe
        if (user.stripeSubscriptionId && 
            ['active', 'trialing', 'past_due', 'canceling'].includes(user.stripeSubscriptionStatus)) {
          try {
            logger.info(`Retrieving subscription details from Stripe for ${user.stripeSubscriptionId}`);
            const subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            logger.info(`Stripe subscription details: Status=${subscription.status}, CancelAtPeriodEnd=${subscription.cancel_at_period_end}`);
            
            response.hasActiveSubscription = true;
            response.status = subscription.status;
            response.cancelAtPeriodEnd = subscription.cancel_at_period_end;
            
            // Current period info
            if (subscription.current_period_end) {
              response.currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
            }
            
            // Determine expiration date based on status and cancel_at_period_end
            if (subscription.cancel_at_period_end) {
              response.willExpireOn = new Date(subscription.current_period_end * 1000).toISOString();
            } else if (subscription.cancel_at) {
              response.willExpireOn = new Date(subscription.cancel_at * 1000).toISOString();
            }
            
            // If subscription is active and will renew, get next invoice date
            if (!subscription.cancel_at_period_end && 
                ['active', 'trialing'].includes(subscription.status)) {
              try {
                const upcomingInvoice = await stripe.invoices.retrieveUpcoming({
                  subscription: subscription.id
                });
                if (upcomingInvoice && upcomingInvoice.next_payment_attempt) {
                  response.nextPaymentAttempt = new Date(upcomingInvoice.next_payment_attempt * 1000).toISOString();
                }
              } catch (invoiceErr) {
                logger.warn('Could not retrieve upcoming invoice:', invoiceErr.message);
              }
            }
          } catch (stripeErr) {
            logger.warn(`Could not retrieve subscription from Stripe: ${stripeErr.message}`);
            // If we have a Pro user with an invalid subscription in Stripe, log extra details for debugging
            if (user.accountLevel === 'pro') {
              logger.error(`Invalid subscription state: User ${userId} has pro accountLevel but Stripe error for subscription ${user.stripeSubscriptionId}: ${stripeErr.message}`);
              
              // Check if customer exists in Stripe
              if (user.stripeCustomerId) {
                try {
                  const customer = await stripe.customers.retrieve(user.stripeCustomerId);
                  logger.info(`Stripe customer found: ${user.stripeCustomerId}, Default payment method: ${customer.invoice_settings?.default_payment_method || 'none'}`);
                } catch (customerErr) {
                  logger.error(`Error retrieving Stripe customer: ${customerErr.message}`);
                }
              }
            }
          }
        } else if (user.accountLevel === 'pro') {
          // This is the case where a user has pro level but no active subscription
          logger.warn(`User ${userId} has pro account level but no active subscription! SubscriptionID: ${user.stripeSubscriptionId}, Status: ${user.stripeSubscriptionStatus}`);
          
          // Check if customer exists in Stripe
          if (user.stripeCustomerId) {
            try {
              const customer = await stripe.customers.retrieve(user.stripeCustomerId);
              logger.info(`Stripe customer found: ${user.stripeCustomerId}, Default payment method: ${customer.invoice_settings?.default_payment_method || 'none'}`);
              
              // Check for any subscriptions on the customer
              const subscriptions = await stripe.subscriptions.list({
                customer: user.stripeCustomerId,
                limit: 10,
              });
              
              if (subscriptions.data.length > 0) {
                logger.info(`Found ${subscriptions.data.length} subscriptions for customer ${user.stripeCustomerId}:`);
                subscriptions.data.forEach((sub, i) => {
                  logger.info(`Subscription ${i+1}: ID=${sub.id}, Status=${sub.status}, Created=${new Date(sub.created * 1000).toISOString()}`);
                });
                
                // If there is a valid active subscription, update the user's database record
                const activeSubscription = subscriptions.data.find(sub => 
                  ['active', 'trialing'].includes(sub.status)
                );
                
                if (activeSubscription) {
                  logger.info(`Auto-repairing subscription for user ${userId} using customer ${user.stripeCustomerId}`);
                  db.run(
                    `UPDATE users SET stripeSubscriptionId = ?, stripeSubscriptionStatus = ? WHERE id = ?`,
                    [activeSubscription.id, activeSubscription.status, userId],
                    (updateErr) => {
                      if (updateErr) {
                        logger.error(`Error auto-repairing subscription: ${updateErr.message}`);
                      } else {
                        logger.info(`Successfully repaired subscription link for user ${userId} with customer ${user.stripeCustomerId}`);
                        // Update response to show the active subscription
                        response.hasActiveSubscription = true;
                        response.status = activeSubscription.status;
                        response.cancelAtPeriodEnd = activeSubscription.cancel_at_period_end;
                        
                        if (activeSubscription.current_period_end) {
                          response.currentPeriodEnd = new Date(activeSubscription.current_period_end * 1000).toISOString();
                        }
                      }
                    }
                  );
                }
              } else {
                logger.info(`No subscriptions found for Stripe customer ${user.stripeCustomerId}`);
              }
            } catch (customerErr) {
              logger.error(`Error retrieving Stripe customer: ${customerErr.message}`);
            }
          } else {
            // Try to find a customer by email if we don't have a customerId
            try {
              // Get user email from database
              db.get(
                `SELECT email FROM users WHERE id = ?`, 
                [userId],
                async (emailErr, userData) => {
                  if (emailErr || !userData) {
                    logger.error(`Error retrieving user email: ${emailErr?.message || 'User not found'}`);
                    return;
                  }
                  
                  // Search for customer by email
                  const customers = await stripe.customers.list({
                    email: userData.email,
                    limit: 1
                  });
                  
                  if (customers.data.length > 0) {
                    const customer = customers.data[0];
                    logger.info(`Found Stripe customer by email: ${customer.id}`);
                    
                    // Check for subscriptions
                    const subscriptions = await stripe.subscriptions.list({
                      customer: customer.id,
                      limit: 3
                    });
                    
                    if (subscriptions.data.length > 0) {
                      logger.info(`Found ${subscriptions.data.length} subscriptions for customer ${customer.id}`);
                      
                      // If there is a valid active subscription, update the user's database record
                      const activeSubscription = subscriptions.data.find(sub => 
                        ['active', 'trialing'].includes(sub.status)
                      );
                      
                      if (activeSubscription) {
                        logger.info(`Auto-repairing subscription for user ${userId} using customer ${customer.id}`);
                        db.run(
                          `UPDATE users SET stripeCustomerId = ?, stripeSubscriptionId = ?, stripeSubscriptionStatus = ? WHERE id = ?`,
                          [customer.id, activeSubscription.id, activeSubscription.status, userId],
                          (updateErr) => {
                            if (updateErr) {
                              logger.error(`Error auto-repairing subscription: ${updateErr.message}`);
                            } else {
                              logger.info(`Successfully repaired subscription link for user ${userId} with customer ${customer.id}`);
                              // Update response to show the active subscription
                              response.hasActiveSubscription = true;
                              response.status = activeSubscription.status;
                              response.cancelAtPeriodEnd = activeSubscription.cancel_at_period_end;
                              
                              if (activeSubscription.current_period_end) {
                                response.currentPeriodEnd = new Date(activeSubscription.current_period_end * 1000).toISOString();
                              }
                            }
                          }
                        );
                      }
                    }
                  } else {
                    logger.info(`No Stripe customer found for email: ${userData.email}`);
                  }
                }
              );
            } catch (searchErr) {
              logger.error(`Error searching for customer by email: ${searchErr.message}`);
            }
          }
        }
        
        logger.info(`Returning subscription details response: ${JSON.stringify(response)}`);
        res.json(response);
      }
    );
  } catch (error) {
    logger.error('Error retrieving subscription details:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Renew subscription endpoint
router.post(
  '/renew',
  authenticateToken,
  strictLimiter,
  async (req, res) => {
    const userId = req.user.id;

    try {
      // Fetch user details from the database
      db.get(
        `SELECT stripeSubscriptionId, stripeCustomerId FROM users WHERE id = ?`,
        [userId],
        async (err, user) => {
          if (err) {
            logger.error('Error fetching user details:', err);
            return res.status(500).json({ error: 'Internal server error' });
          }

          if (!user || !user.stripeSubscriptionId) {
            return res.status(404).json({ error: 'Subscription not found' });
          }

          try {
            // Get the current subscription
            const currentSubscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
            
            if (!currentSubscription.cancel_at_period_end) {
              return res.status(400).json({ error: 'This subscription is not scheduled for cancellation' });
            }
            
            // Reactivate the subscription by setting cancel_at_period_end to false
            const subscription = await stripe.subscriptions.update(user.stripeSubscriptionId, {
              cancel_at_period_end: false
            });
            
            // Update user subscription status in database
            db.run(
              `UPDATE users SET stripeSubscriptionStatus = ? WHERE id = ?`,
              [subscription.status, userId],
              (updateErr) => {
                if (updateErr) {
                  logger.error('Error updating subscription status:', updateErr);
                  return res.status(500).json({ error: 'Internal server error' });
                }

                logger.info(`User subscription renewed: ${userId}`);
                res.json({
                  message: 'Your subscription has been successfully renewed.',
                  status: subscription.status
                });
              }
            );
          } catch (stripeError) {
            logger.error('Stripe error during renewal:', stripeError);
            res.status(500).json({ error: 'An error occurred with the payment provider. Please try again.' });
          }
        }
      );
    } catch (error) {
      logger.error('Error during subscription renewal:', error);
      res.status(500).json({ error: 'An error occurred. Please try again.' });
    }
  }
);

// Fetch user's payment methods
router.get('/payment-methods', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  
  try {
    db.get(
      `SELECT stripeCustomerId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user || !user.stripeCustomerId) {
          return res.status(404).json({ error: 'User not found or no payment methods available' });
        }
        
        try {
          // First get the customer to determine the default payment method
          const customer = await stripe.customers.retrieve(user.stripeCustomerId);
          const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
          
          // Retrieve customer's payment methods
          const paymentMethods = await stripe.paymentMethods.list({
            customer: user.stripeCustomerId,
            type: 'card'
          });
          
          // Format response to include only necessary information, marking default method
          const formattedPaymentMethods = paymentMethods.data.map(pm => ({
            id: pm.id,
            brand: pm.card.brand,
            last4: pm.card.last4,
            expMonth: pm.card.exp_month,
            expYear: pm.card.exp_year,
            isDefault: pm.id === defaultPaymentMethodId
          }));
          
          res.json(formattedPaymentMethods);
        } catch (stripeError) {
          logger.error('Stripe error fetching payment methods:', stripeError);
          res.status(500).json({ error: 'Error retrieving payment methods' });
        }
      }
    );
  } catch (error) {
    logger.error('Error fetching payment methods:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Update payment method
router.post('/update-payment-method', authenticateToken, strictLimiter, async (req, res) => {
  const { paymentMethodId } = req.body;
  const userId = req.user.id;
  
  if (!paymentMethodId) {
    return res.status(400).json({ error: 'Payment method ID is required' });
  }
  
  try {
    db.get(
      `SELECT stripeCustomerId, stripeSubscriptionId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user || !user.stripeCustomerId) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        try {
          // Attach the new payment method to the customer if it's not already attached
          try {
            await stripe.paymentMethods.attach(paymentMethodId, {
              customer: user.stripeCustomerId
            });
          } catch (attachErr) {
            // If the error is because the payment method is already attached, we can proceed
            if (attachErr.code !== 'payment_method_already_attached') {
              throw attachErr;
            }
          }
          
          // Set it as the default payment method for the customer
          await stripe.customers.update(user.stripeCustomerId, {
            invoice_settings: {
              default_payment_method: paymentMethodId
            }
          });
          
          // If the customer has an active subscription, update that too
          if (user.stripeSubscriptionId) {
            await stripe.subscriptions.update(user.stripeSubscriptionId, {
              default_payment_method: paymentMethodId
            });
          }
          
          logger.info(`Payment method updated for user: ${userId}`);
          res.json({ message: 'Payment method updated successfully' });
        } catch (stripeError) {
          logger.error('Stripe error updating payment method:', stripeError);
          res.status(500).json({ error: 'Error updating payment method' });
        }
      }
    );
  } catch (error) {
    logger.error('Error updating payment method:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Delete payment method
router.delete('/payment-method/:id', authenticateToken, async (req, res) => {
  const paymentMethodId = req.params.id;
  const userId = req.user.id;
  
  if (!paymentMethodId) {
    return res.status(400).json({ error: 'Payment method ID is required' });
  }
  
  try {
    db.get(
      `SELECT stripeCustomerId, stripeSubscriptionId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user || !user.stripeCustomerId) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        try {
          // Check if this is the default payment method
          const customer = await stripe.customers.retrieve(user.stripeCustomerId);
          const defaultPaymentMethodId = customer.invoice_settings?.default_payment_method;
          
          // Prevent deleting the default payment method
          if (defaultPaymentMethodId === paymentMethodId) {
            return res.status(400).json({ 
              error: 'Cannot delete your default payment method. Please set another card as default first.' 
            });
          }
          
          // Check if we have multiple payment methods
          const paymentMethods = await stripe.paymentMethods.list({
            customer: user.stripeCustomerId,
            type: 'card'
          });
          
          // Prevent deleting the only payment method
          if (paymentMethods.data.length <= 1) {
            return res.status(400).json({ 
              error: 'Cannot delete your only payment method. Please add another payment method before deleting this one.' 
            });
          }
          
          // Detach the payment method
          await stripe.paymentMethods.detach(paymentMethodId);
          
          logger.info(`Payment method deleted for user: ${userId}`);
          res.json({ message: 'Payment method deleted successfully' });
        } catch (stripeError) {
          logger.error('Stripe error deleting payment method:', stripeError);
          res.status(500).json({ error: 'Error deleting payment method' });
        }
      }
    );
  } catch (error) {
    logger.error('Error deleting payment method:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

// Set payment method as default
router.post('/set-default-payment-method', authenticateToken, strictLimiter, async (req, res) => {
  const { paymentMethodId } = req.body;
  const userId = req.user.id;
  
  if (!paymentMethodId) {
    return res.status(400).json({ error: 'Payment method ID is required' });
  }
  
  try {
    db.get(
      `SELECT stripeCustomerId, stripeSubscriptionId FROM users WHERE id = ?`,
      [userId],
      async (err, user) => {
        if (err) {
          logger.error('Error fetching user details:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }
        
        if (!user || !user.stripeCustomerId) {
          return res.status(404).json({ error: 'User not found' });
        }
        
        try {
          // Set it as the default payment method for the customer
          await stripe.customers.update(user.stripeCustomerId, {
            invoice_settings: {
              default_payment_method: paymentMethodId
            }
          });
          
          // If the customer has an active subscription, update that too
          if (user.stripeSubscriptionId) {
            await stripe.subscriptions.update(user.stripeSubscriptionId, {
              default_payment_method: paymentMethodId
            });
          }
          
          logger.info(`Default payment method updated for user: ${userId}`);
          res.json({ message: 'Default payment method updated successfully' });
        } catch (stripeError) {
          logger.error('Stripe error updating default payment method:', stripeError);
          res.status(500).json({ error: 'Error updating default payment method' });
        }
      }
    );
  } catch (error) {
    logger.error('Error updating default payment method:', error);
    res.status(500).json({ error: 'An error occurred. Please try again.' });
  }
});

module.exports = router;
