function hasActiveManualProGrant(user, now = new Date()) {
  if (!user || !user.manualProExpiresAt) {
    return false;
  }

  const expiresAt = new Date(user.manualProExpiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return false;
  }

  return expiresAt > now;
}

function resolveEffectiveAccountLevel(user, now = new Date()) {
  if (!user) {
    return 'basic';
  }

  if (user.accountLevel === 'enterprise' || user.accountLevel === 'pro') {
    return user.accountLevel;
  }

  if (hasActiveManualProGrant(user, now)) {
    return 'pro';
  }

  return 'basic';
}

module.exports = {
  hasActiveManualProGrant,
  resolveEffectiveAccountLevel,
};
