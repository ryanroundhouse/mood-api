const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./database');
const logger = require('./utils/logger');
const { generalLimiter } = require('./middleware/rateLimiter');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const stripeRoutes = require('./routes/stripe');
const contactRoutes = require('./routes/contact');
const googlePlayRoutes = require('./routes/google-play');
const moodRoutes = require('./routes/moods');

const app = express();
const port = 3000;
const isDevelopment = process.env.NODE_ENV === 'development';

// Initialize database
initializeDatabase();

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

app.use('/api', authRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/google-play', googlePlayRoutes);
app.use('/api/moods', moodRoutes);
app.use('/api/mood', moodRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
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
app.use(express.static(path.join(__dirname, 'app')));

// Start server
app.listen(port, () => {
  logger.info(`API listening at http://localhost:${port}`);
});
