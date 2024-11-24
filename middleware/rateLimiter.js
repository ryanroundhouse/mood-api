const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

// Helper to identify Pub/Sub requests
const isPubSubRequest = (req) => {
  return req.get('X-Goog-Resource-State') !== undefined;
};

const createLimiter = (options) => {
  return (req, res, next) => {
    if (isPubSubRequest(req)) {
      return next();
    }

    return rateLimit({
      ...options,
      handler: (req, res) => {
        logger.warn('Rate limit exceeded:', {
          path: req.path,
          ip: req.ip,
          headers: req.headers,
        });
        res.status(429).json({
          error: options.message || 'Too many requests',
        });
      },
    })(req, res, next);
  };
};

const strictLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message:
    'Too many requests for this sensitive operation, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const generalLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { strictLimiter, generalLimiter };
