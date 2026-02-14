const { db: defaultDb } = require('../database');

function getLastCookieValue(cookieHeader, cookieName) {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const needle = `${cookieName}=`;
  let idx = -1;
  let next = cookieHeader.indexOf(needle);
  while (next !== -1) {
    idx = next;
    next = cookieHeader.indexOf(needle, next + needle.length);
  }
  if (idx === -1) return null;
  const valueStart = idx + needle.length;
  const valueEnd = cookieHeader.indexOf(';', valueStart);
  const rawValue =
    valueEnd === -1 ? cookieHeader.slice(valueStart) : cookieHeader.slice(valueStart, valueEnd);
  return rawValue || null;
}

function createRequireWebRefreshAuth({
  db = defaultDb,
  loginPath = '/login.html',
} = {}) {
  return function requireWebRefreshAuth(req, res, next) {
    // Defense-in-depth: do not allow caching of authenticated HTML.
    res.setHeader('Cache-Control', 'no-store');

    // Prefer the last refreshToken cookie if duplicates exist.
    const refreshToken =
      getLastCookieValue(req.headers && req.headers.cookie, 'refreshToken') ||
      (req.cookies && req.cookies.refreshToken);
    if (!refreshToken) return res.redirect(302, loginPath);

    db.get(
      `SELECT userId FROM refresh_tokens WHERE token = ? AND expiresAt > ?`,
      [refreshToken, Date.now()],
      (err, row) => {
        if (err || !row) return res.redirect(302, loginPath);
        return next();
      }
    );
  };
}

module.exports = {
  createRequireWebRefreshAuth,
};

