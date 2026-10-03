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
// 📁 File path: messageEncryption.js
function serializeMessage(msg) {
  // 1. Safely handle mongoose documents by converting them to a plain JS object
  const msgObj = msg && typeof msg.toObject === 'function' ? msg.toObject() : msg;
  
  if (!msgObj) return null;

  // 2. Setup fallbacks for decryption fields
  let decryptedContent = { text: '', image: null, audio: null, attachment: null };
  try {
    if (msgObj.contentCiphertext) {
      // Ensure decryptMessageContent is imported and available in this file context
      decryptedContent = decryptMessageContent(msgObj.contentCiphertext);
    } else {
      decryptedContent = { 
        text: msgObj.text || '', 
        image: msgObj.image || null, 
        audio: msgObj.audio || null,
        attachment: null,
      };
    }
  } catch (err) {
    console.error("❌ Decryption failed for message ID:", msgObj._id, err);
  }

  // 3. Map out reactions array securely into grouped frontend structures
  const groupedReactions = {};
  const rawReactions = Array.isArray(msgObj.reactions) ? msgObj.reactions : [];
  
  rawReactions.forEach(r => {
    if (r && r.emoji && r.userId) {
      if (!groupedReactions[r.emoji]) {
        groupedReactions[r.emoji] = [];
      }
      groupedReactions[r.emoji].push(r.userId);
    }
  });

return {
  _id: msgObj._id,
  room: msgObj.room,
  sender: msgObj.sender,
  senderUid: msgObj.senderUid,
  createdAt: msgObj.createdAt,
  edited: msgObj.edited || false,
  parentId: msgObj.parentId || null,
  text: decryptedContent.text,
  image: decryptedContent.image,
  audio: decryptedContent.audio,
  attachment: decryptedContent.attachment || null,
  reactions: groupedReactions,
  readBy: Array.isArray(msgObj.readBy) ? msgObj.readBy.map(r => ({
    uid: r.userId,
    readAt: r.readAt
  })) : []
};
}

// Ensure it is exported cleanly at the bottom along with encrypt/decrypt methods
module.exports = {
  serializeMessage,
  encryptMessageContent,
  decryptMessageContent,
};
