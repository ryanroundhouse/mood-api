const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');

function getRateLimitKey(req) {
  // Prefer Cloudflare’s client IP header when behind CF.
  // This avoids rate-limiting all users together on a CF egress IP.
  const cfConnectingIp = req.get('cf-connecting-ip');
  if (cfConnectingIp && typeof cfConnectingIp === 'string') {
    return cfConnectingIp.trim();
  }

  // Fall back to X-Forwarded-For (first hop) when present.
  const xForwardedFor = req.get('x-forwarded-for');
  if (xForwardedFor && typeof xForwardedFor === 'string') {
    const first = xForwardedFor.split(',')[0]?.trim();
    if (first) return first;
  }

  // Finally fall back to Express’ resolved IP.
  return req.ip;
}

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
  keyGenerator: getRateLimitKey,
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
  max: 500,
  message: 'Too many requests, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
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
  // Expose for unit tests
  __test__: { getRateLimitKey },
};
