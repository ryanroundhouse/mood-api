const crypto = require('crypto');
const logger = require('./logger');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    ENCRYPTION_ALGORITHM,
    Buffer.from(ENCRYPTION_KEY, 'hex'),
    iv
  );

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decrypt(encryptedData) {
  if (!encryptedData) {
    return null;
  }

  try {
    const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');

    if (!ivHex || !authTagHex || !encryptedText) {
      logger.warn('Malformed encrypted data encountered');
      return null;
    }

    const decipher = crypto.createDecipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      Buffer.from(ivHex, 'hex')
    );

    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (error) {
    logger.error('Error decrypting data:', error);
    return null;
  }
}

module.exports = { encrypt, decrypt };
