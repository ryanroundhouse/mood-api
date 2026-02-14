function createLegacyApiAuthDeprecationMiddleware({ logger, sunset } = {}) {
  const legacyAuthSunset = sunset || process.env.LEGACY_AUTH_API_SUNSET || '2026-06-01T00:00:00Z';

  return function legacyApiAuthDeprecation(req, res, next) {
    // When mounted at '/api', req.path is the path remainder (e.g. '/login', '/user/settings')
    const p = req.path || '';

    // Do not treat canonical or web-cookie paths as legacy
    if (p === '/auth' || p.startsWith('/auth/')) return next();
    if (p === '/web-auth' || p.startsWith('/web-auth/')) return next();

    const isLegacyAuthPath =
      p === '/login' ||
      p === '/register' ||
      p === '/forgot-password' ||
      p === '/refresh-token' ||
      p === '/logout' ||
      p.startsWith('/reset-password/') ||
      p.startsWith('/verify/');

    if (!isLegacyAuthPath) return next();

    // RFC 8594-ish deprecation hinting (best-effort; harmless for non-browser clients)
    res.setHeader('Deprecation', 'true');
    res.setHeader('Sunset', legacyAuthSunset);
    res.setHeader('Link', '</api/auth/>; rel="successor-version"');

    try {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('DEPRECATED_AUTH_PREFIX', {
          originalUrl: req.originalUrl,
          method: req.method,
          userAgent: req.headers && req.headers['user-agent'],
          ip: req.ip,
        });
      }
    } catch {
      // Never fail requests due to logging
    }

    return next();
  };
}

module.exports = { createLegacyApiAuthDeprecationMiddleware };
