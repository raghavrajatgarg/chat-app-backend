const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

function getEncryptionKey() {
  const encodedKey = process.env.MESSAGE_ENCRYPTION_KEY?.trim();
  if (!encodedKey) {
    throw new Error('MESSAGE_ENCRYPTION_KEY is not configured.');
  }
  const key = Buffer.from(encodedKey.trim(), 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encodedKey) || key.length !== 32 || key.toString('base64') !== encodedKey) {
    throw new Error('MESSAGE_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
  }
  return key;
}

function encryptMessageContent(content) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(content), 'utf8'),
    cipher.final(),
  ]);
  return {
    version: ENVELOPE_VERSION,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptMessageContent(envelope) {
  if (!envelope || envelope.version !== ENVELOPE_VERSION) {
    throw new Error('Unsupported stored message encryption format.');
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    getEncryptionKey(),
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function serializeMessage(message) {
  const record = typeof message.toObject === 'function' ? message.toObject() : { ...message };
  if (record.encryptedContent && !record.contentCiphertext) {
    delete record.encryptedContent;
    return { ...record, text: '[This message was encrypted with the previous device-based system and cannot be opened here.]', image: null, audio: null };
  }
  if (!record.contentCiphertext) return record;
  const content = decryptMessageContent(record.contentCiphertext);
  delete record.contentCiphertext;
  return { ...record, ...content };
}

module.exports = { encryptMessageContent, decryptMessageContent, serializeMessage, validateEncryptionKey: getEncryptionKey };
