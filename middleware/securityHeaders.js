const helmet = require('helmet');

// Baseline security headers applied at the Express layer.
//
// Notes:
// - CSP is intentionally permissive for now (allows inline scripts/styles)
//   because the static site under /app includes inline <style> and <script>.
// - HSTS is only emitted for HTTPS requests in production-like mode.
function createSecurityHeadersMiddleware({ isDevelopment }) {
  const enableHsts = !isDevelopment;

  const cspDirectives = {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
    formAction: ["'self'"],

    // Allow same-origin assets + data URIs (icons, inline SVG images, etc.)
    imgSrc: ["'self'", 'data:', 'https://stripe.com'],

    // Static site contains inline <style> and inline style attributes.
    styleSrc: ["'self'", "'unsafe-inline'"],

    // Static site contains inline <script type="module"> blocks.
    // Third-party scripts currently used:
    // - Stripe.js (register/account settings)
    // - Google reCAPTCHA v3 (contact form)
    scriptSrc: [
      "'self'",
      "'unsafe-inline'",
      'https://js.stripe.com',
      'https://www.google.com',
      'https://www.gstatic.com',
    ],

    // dashboard.html currently uses inline event handlers (e.g. onclick="...").
    // Helmet defaults set `script-src-attr 'none'`, which breaks those handlers.
    // Baseline policy intentionally allows inline while we keep inline handlers.
    scriptSrcAttr: ["'unsafe-inline'"],

    // Stripe + reCAPTCHA often require frames.
    frameSrc: [
      'https://js.stripe.com',
      'https://hooks.stripe.com',
      'https://checkout.stripe.com',
      'https://www.google.com',
      'https://recaptcha.google.com',
    ],

    // XHR/fetch/websocket destinations.
    connectSrc: [
      "'self'",
      'https://api.stripe.com',
      'https://www.google.com',
      'https://www.gstatic.com',
    ],
  };

  const helmetMiddleware = helmet({
    // We set this explicitly below to avoid accidentally sending HSTS on HTTP.
    hsts: false,
    // Helps avoid adding accidental DNS prefetching surface.
    dnsPrefetchControl: { allow: false },
    // XFO complements CSP frame-ancestors for older UAs.
    frameguard: { action: 'deny' },
    // Recommended baseline hardening.
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: {
      useDefaults: true,
      directives: cspDirectives,
    },
  });

  return function securityHeaders(req, res, next) {
    // First, apply helmet's collection of headers.
    helmetMiddleware(req, res, (err) => {
      if (err) return next(err);

      // Permissions-Policy isn't consistently covered across helmet versions;
      // set it explicitly.
      res.setHeader(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=()'
      );

      // Only send HSTS over HTTPS in production mode.
      // With `trust proxy` enabled, req.secure respects X-Forwarded-Proto.
      if (enableHsts && req.secure) {
        res.setHeader(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains'
        );
      }

      return next();
    });
  };
}

module.exports = {
  createSecurityHeadersMiddleware,
};

