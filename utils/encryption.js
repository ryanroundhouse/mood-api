const crypto = require('crypto');
const logger = require('./logger');

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encrypt(text) {
  if (!text) return null;

  try {
    logger.info(`Encrypting text of length: ${text.length}`);
    logger.info(`Using key of length: ${ENCRYPTION_KEY.length}`);

    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      ENCRYPTION_ALGORITHM,
      Buffer.from(ENCRYPTION_KEY, 'hex'),
      iv
    );

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    const result = `${iv.toString('hex')}:${authTag.toString(
      'hex'
    )}:${encrypted}`;
    logger.info(
      `Encrypted result format check: ${
        result.includes(':') ? 'valid' : 'invalid'
      }`
    );
    return result;
  } catch (error) {
    logger.error('Encryption error:', error);
    throw error; // Rethrow to make encryption failures visible
  }
}

function decrypt(encryptedData) {
  if (!encryptedData) {
    logger.warn('Attempted to decrypt null/undefined data');
    return null;
  }

  try {
    logger.info(
      `Attempting to decrypt data: ${encryptedData.substring(0, 20)}...`
    );
    logger.info(`Using key of length: ${ENCRYPTION_KEY.length}`);

    const [ivHex, authTagHex, encryptedText] = encryptedData.split(':');

    logger.info(
      `Decryption parts - IV: ${ivHex?.length}chars, AuthTag: ${authTagHex?.length}chars, EncryptedText: ${encryptedText?.length}chars`
    );

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

    logger.info('Decryption successful');
    return decrypted;
  } catch (error) {
    logger.error('Decryption error:', {
      error: error.message,
      stack: error.stack,
      encryptedDataLength: encryptedData?.length,
      keyLength: ENCRYPTION_KEY?.length,
    });
    return null;
  }
}

module.exports = { encrypt, decrypt };
