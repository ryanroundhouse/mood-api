const crypto = require('crypto');
const logger = require('./logger');

// Get the encryption key from environment variables with validation
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

// Validate encryption key
if (!ENCRYPTION_KEY) {
  logger.error('ENCRYPTION_KEY environment variable is missing');
} else if (Buffer.from(ENCRYPTION_KEY, 'hex').length !== 32) {
  logger.error('ENCRYPTION_KEY must be a 32-byte hex string (64 characters)');
}

function encrypt(text) {
  if (!text) return null;
  
  try {
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
  } catch (error) {
    logger.error('Encryption error:', error);
    return null;
  }
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
