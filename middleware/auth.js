const jwt = require('jsonwebtoken');
const { db } = require('../database');
const { resolveEffectiveAccountLevel } = require('../utils/accountLevel');
const JWT_SECRET = process.env.JWT_SECRET;

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token == null) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, tokenUser) => {
    if (err) return res.sendStatus(401);

    db.get(
      `SELECT id, accountLevel, manualProExpiresAt FROM users WHERE id = ?`,
      [tokenUser.id],
      (dbErr, user) => {
        if (dbErr) return res.sendStatus(500);
        if (!user) return res.sendStatus(401);

        req.user = {
          id: user.id,
          accountLevel: resolveEffectiveAccountLevel(user),
        };
        next();
      }
    );
  });
}

module.exports = { authenticateToken };
