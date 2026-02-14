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

// Garmin Connect OAuth fallbacks (integration will not work without real values)
process.env.GARMIN_CONSUMER_KEY = process.env.GARMIN_CONSUMER_KEY || 'dummy_consumer_key';
process.env.GARMIN_CONSUMER_SECRET = process.env.GARMIN_CONSUMER_SECRET || 'dummy_consumer_secret';

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
  const cookieParser = require('cookie-parser');
  console.log('✓ cookie-parser loaded');
  const cors = require('cors');
  console.log('✓ cors loaded');
  const path = require('path');
  console.log('✓ path loaded');
  
  // Try loading each module separately with diagnostic logging
  console.log('Loading database...');
  const database = require('./database');
  console.log('✓ database loaded');
  
  console.log('Loading analytics...');
  const analytics = require('./analytics');
  console.log('✓ analytics loaded');
  
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
  
  console.log('Loading apple-store routes...');
  const appleStoreRoutes = require('./routes/apple-store');
  console.log('✓ apple-store routes loaded');
  
  console.log('Loading mood routes...');
  const moodRoutes = require('./routes/moods');
  console.log('✓ mood routes loaded');
  
  console.log('Loading garmin routes...');
  const garminRoutes = require('./routes/garmin');
  console.log('✓ garmin routes loaded');

  const app = express();
  // Security: avoid framework fingerprinting
  app.disable('x-powered-by');
  const port = 3000;
  // Treat anything other than explicit "production" as development-like.
  // This avoids accidentally enabling production-only middleware (rate limiting, strict CORS)
  // when NODE_ENV is set to values like "sandbox", "staging", etc.
  const isDevelopment = process.env.NODE_ENV !== 'production';

  console.log('Initializing database...');
  // Initialize database
  database.initializeDatabase();
  console.log('✓ Database initialized');

  console.log('Initializing analytics database...');
  // Initialize analytics database
  analytics.initializeAnalyticsDatabase();
  console.log('✓ Analytics database initialized');

  // Trust proxy settings (add this before other middleware)
  app.set('trust proxy', 1);

  // Baseline security headers (CSP, HSTS, etc.)
  const {
    createSecurityHeadersMiddleware,
  } = require('./middleware/securityHeaders');
  app.use(createSecurityHeadersMiddleware({ isDevelopment }));

  // CORS configuration
  // - Dev: allow all origins
  // - Prod: allow only known site origins (plus requests with no Origin, e.g. curl/health checks)
  const allowedOrigins = [
    'https://moodful.ca',
    'https://blog.graham.pub',
    'https://ryangraham.ca',
    'https://www.ryangraham.ca',
    // Common local dev origins (optional in prod; harmless since Origin must match)
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ];

  const corsOptions = {
    origin: (origin, callback) => {
      if (isDevelopment) return callback(null, true);
      if (!origin) return callback(null, true); // non-browser or same-origin without Origin header
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  // Parse Cookie header so routes can read HttpOnly refresh cookies
  app.use(cookieParser());

  // Special handling for Stripe webhooks - must use raw body parser
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  
  // Special handling for Garmin webhooks - need larger size limit for sleep data
  app.use('/api/garmin/sleep-webhook', express.raw({ 
    type: 'application/json',
    limit: '10mb'  // Allow up to 10MB for large sleep data backfills
  }));
  
  // Standard middleware for all other routes
  app.use(express.json({ limit: '2mb' }));  // Increase default limit from 100kb to 2mb
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  // Rate limiting
  if (!isDevelopment) {
    // Only rate-limit API endpoints (never static assets like /login.html, /api-script.js)
    app.use('/api', generalLimiter);
  }

  console.log('Setting up routes...');
  // Deprecation signaling for legacy auth endpoints under /api/*
  // Canonical non-cookie auth prefix is /api/auth/*
  const {
    createLegacyApiAuthDeprecationMiddleware,
  } = require('./middleware/legacyAuthDeprecation');
  const legacyApiAuthDeprecation = createLegacyApiAuthDeprecationMiddleware({
    logger,
  });

  app.use('/api', legacyApiAuthDeprecation, authRoutes);
  app.use('/api/auth', authRoutes);
  // Web-only cookie-based auth endpoints (kept separate so mobile can keep using /api/auth/* JSON tokens)
  app.use('/api/web-auth', authRoutes);
  app.use('/api/user', userRoutes);
  app.use('/api/stripe', stripeRoutes);
  app.use('/api/contact', contactRoutes);
  app.use('/api/google-play', googlePlayRoutes);
  app.use('/api/apple-store', appleStoreRoutes);
  app.use('/api/garmin', garminRoutes);
  app.use('/api/moods', moodRoutes);
  app.use('/api/mood', moodRoutes);
  console.log('✓ Routes configured');

  // Server-side auth gating for authenticated HTML pages (defense-in-depth).
  // Must be registered before express.static() so unauth users don't receive page contents.
  const {
    createRequireWebRefreshAuth,
  } = require('./middleware/requireWebRefreshAuth');
  const requireWebRefreshAuth = createRequireWebRefreshAuth();

  app.get('/dashboard.html', requireWebRefreshAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'app', 'dashboard.html'));
  });
  app.get('/weekly-summary.html', requireWebRefreshAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'app', 'weekly-summary.html'));
  });
  app.get('/account-settings.html', requireWebRefreshAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'app', 'account-settings.html'));
  });

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
