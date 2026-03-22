const test = require('node:test');
const assert = require('node:assert/strict');

const {
  hasActiveManualProGrant,
  resolveEffectiveAccountLevel,
} = require('../utils/accountLevel');

test('resolveEffectiveAccountLevel preserves paid pro users without manual grant', () => {
  assert.equal(
    resolveEffectiveAccountLevel({ accountLevel: 'pro', manualProExpiresAt: null }),
    'pro'
  );
});

test('resolveEffectiveAccountLevel upgrades basic users with active manual grant', () => {
  assert.equal(
    resolveEffectiveAccountLevel({
      accountLevel: 'basic',
      manualProExpiresAt: '2999-01-01T00:00:00.000Z',
    }),
    'pro'
  );
});

test('resolveEffectiveAccountLevel leaves basic users basic when manual grant expired', () => {
  assert.equal(
    resolveEffectiveAccountLevel({
      accountLevel: 'basic',
      manualProExpiresAt: '2000-01-01T00:00:00.000Z',
    }),
    'basic'
  );
});

test('hasActiveManualProGrant ignores invalid timestamps', () => {
  assert.equal(hasActiveManualProGrant({ manualProExpiresAt: 'not-a-date' }), false);
});
