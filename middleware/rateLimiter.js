const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Helper to identify Pub/Sub requests
const isPubSubRequest = (req) => {
  return req.get('X-Goog-Resource-State') !== undefined;
};

// Create limiters at initialization time
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message:
    'Too many requests for this sensitive operation, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded:', {
      path: req.path,
      ip: req.ip,
      headers: req.headers,
    });
    res.status(429).json({
      error:
        'Too many requests for this sensitive operation, please try again later.',
    });
  },
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded:', {
      path: req.path,
      ip: req.ip,
      headers: req.headers,
    });
    res.status(429).json({
      error: 'Too many requests, please try again later.',
    });
  },
});

// Wrapper middleware to skip rate limiting for Pub/Sub requests
const createLimiterWithPubSubBypass = (limiter) => {
  return (req, res, next) => {
    if (isPubSubRequest(req)) {
      return next();
    }
    return limiter(req, res, next);
  };
};

module.exports = {
  strictLimiter: createLimiterWithPubSubBypass(strictLimiter),
  generalLimiter: createLimiterWithPubSubBypass(generalLimiter),
};
