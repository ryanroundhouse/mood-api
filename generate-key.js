const crypto = require('crypto');

// Generate a 256-bit (32-byte) key and convert it to hex
const key = crypto.randomBytes(32).toString('hex');
console.log('ENCRYPTION_KEY=' + key);
