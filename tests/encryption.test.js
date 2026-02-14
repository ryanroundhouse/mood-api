const test = require('node:test');
const assert = require('node:assert/strict');

function loadEncryptionWithKey(hexKey) {
  process.env.ENCRYPTION_KEY = hexKey;
  delete require.cache[require.resolve('../utils/encryption')];
  return require('../utils/encryption');
}

test('encrypt/decrypt roundtrip returns original plaintext', async () => {
  const { encrypt, decrypt } = loadEncryptionWithKey('a'.repeat(64));

  const plaintext = 'hello moodful';
  const encrypted = encrypt(plaintext);

  assert.equal(typeof encrypted, 'string');
  assert.notEqual(encrypted.length, 0);
  assert.equal(decrypt(encrypted), plaintext);
});

test('encrypt returns null for empty input', async () => {
  const { encrypt } = loadEncryptionWithKey('b'.repeat(64));
  assert.equal(encrypt(''), null);
  assert.equal(encrypt(null), null);
});

test('decrypt returns null for malformed payload', async () => {
  const { decrypt } = loadEncryptionWithKey('c'.repeat(64));
  assert.equal(decrypt('not:enough'), null);
  assert.equal(decrypt(''), null);
  assert.equal(decrypt(null), null);
});

