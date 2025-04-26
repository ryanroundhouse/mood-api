// Explicitly load .env file first, before any other imports
require('dotenv').config({ path: './.env' });

// Add early diagnostic logging
console.log('========= SERVER STARTUP DIAGNOSTICS =========');
console.log('Node version:', process.version);
console.log('Working directory:', process.cwd());
console.log('Environment:', process.env.NODE_ENV);

// Set default fallback values for critical environment variables
if (!process.env.ENCRYPTION_KEY) {
  process.env.ENCRYPTION_KEY = 'default32bytesecretkeyforsecurity0000';  // 32 bytes in hex
  console.warn('WARNING: Using default ENCRYPTION_KEY. This is not secure for production.');
}

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = 'default_jwt_secret_key_not_for_production';
  console.warn('WARNING: Using default JWT_SECRET. This is not secure for production.');
}

// Additional fallbacks for environment variables
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.MOOD_SITE_URL = process.env.MOOD_SITE_URL || 'http://localhost:3000';

// Email related fallbacks (these will fail silently if not provided in production)
process.env.MAILGUN_API_KEY = process.env.MAILGUN_API_KEY || 'dummy_key';
process.env.EMAIL_DOMAIN = process.env.EMAIL_DOMAIN || 'example.com';
process.env.NOREPLY_EMAIL = process.env.NOREPLY_EMAIL || 'noreply@example.com';
process.env.EMAIL_ADDRESS = process.env.EMAIL_ADDRESS || 'contact@example.com';

// Stripe fallbacks (tests will fail without real values)
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_dummy';
process.env.STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || 'price_dummy';
process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_dummy';

// Add global error handler for uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION! 💥 Shutting down...');
  console.error('Error name:', err.name);
  console.error('Error message:', err.message);
  console.error('Error stack:', err.stack);
  process.exit(1);
});

// Add global error handler for unhandled promise rejections
process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION! 💥 Shutting down...');
  console.error('Error name:', err.name);
  console.error('Error message:', err.message);
  console.error('Error stack:', err.stack);
  process.exit(1);
});

// Continue with regular imports
console.log('Loading modules...');
try {
  const express = require('express');
  console.log('✓ express loaded');
  const cors = require('cors');
  console.log('✓ cors loaded');
  const path = require('path');
  console.log('✓ path loaded');
  
  // Try loading each module separately with diagnostic logging
  console.log('Loading database...');
  const database = require('./database');
  console.log('✓ database loaded');
  
  console.log('Loading logger...');
  const logger = require('./utils/logger');
  console.log('✓ logger loaded');
  
  console.log('Loading rate limiter...');
  const { generalLimiter } = require('./middleware/rateLimiter');
  console.log('✓ rate limiter loaded');

  // Import routes with diagnostic logging
  console.log('Loading routes...');
  
  console.log('Loading auth routes...');
  const authRoutes = require('./routes/auth');
  console.log('✓ auth routes loaded');
  
  console.log('Loading user routes...');
  const userRoutes = require('./routes/user');
  console.log('✓ user routes loaded');
  
  console.log('Loading stripe routes...');
  const stripeRoutes = require('./routes/stripe');
  console.log('✓ stripe routes loaded');
  
  console.log('Loading contact routes...');
  const contactRoutes = require('./routes/contact');
  console.log('✓ contact routes loaded');
  
  console.log('Loading google-play routes...');
  const googlePlayRoutes = require('./routes/google-play');
  console.log('✓ google-play routes loaded');
  
  console.log('Loading mood routes...');
  const moodRoutes = require('./routes/moods');
  console.log('✓ mood routes loaded');

  const app = express();
  const port = 3000;
  const isDevelopment = process.env.NODE_ENV === 'development';

  console.log('Initializing database...');
  // Initialize database
  database.initializeDatabase();
  console.log('✓ Database initialized');

  // Trust proxy settings (add this before other middleware)
  app.set('trust proxy', 1);

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // CORS configuration
  if (isDevelopment) {
    app.use(cors());
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS'
      );
      res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
      );
      next();
    });
  }

  // Rate limiting
  if (!isDevelopment) {
    app.use(generalLimiter);
  }

  console.log('Setting up routes...');
  app.use('/api', authRoutes);
  app.use('/api/auth', authRoutes);
  app.use('/api/user', userRoutes);
  app.use('/api/stripe', stripeRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/google-play', googlePlayRoutes);
  app.use('/api/moods', moodRoutes);
  app.use('/api/mood', moodRoutes);
  console.log('✓ Routes configured');

  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error('Express error handler caught:', err);
    logger.error('Error details:', {
      error: err.message,
      stack: err.stack,
      path: req.path,
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
    res.status(500).json({ error: 'Something went wrong!' });
  });

  // Serve static files
  console.log('Setting up static files...');
  app.use(express.static(path.join(__dirname, 'app')));
  console.log('✓ Static files configured');

  // Start server
  console.log('Starting server...');
  app.listen(port, () => {
    logger.info(`API listening at http://localhost:${port}`);
    console.log('✓ Server started successfully');
  });

} catch (error) {
  console.error('CRITICAL ERROR DURING STARTUP:');
  console.error('Error name:', error.name);
  console.error('Error message:', error.message);
  console.error('Error stack:', error.stack);
  process.exit(1);
}
