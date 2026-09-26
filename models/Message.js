// models/Message.js
const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  room: { 
    type: String, 
    required: true, 
    index: true 
  },
  parentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Message',
    default: null,
    index: true
  },
  senderUid: { 
    type: String, 
    required: true 
  },
  sender: { 
    type: String, 
    required: true 
  },
  avatar: { 
    type: String 
  },
  text: { 
    type: String, 
    default: ''
  },
  contentCiphertext: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  encryptedContent: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  clientMessageId: {
    type: String,
    default: null
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  image: {
    type: String,
    default: null 
  },
  readBy: {
    type: [String],
    default: []
  },
  audio: {
    type: String,
    default: null
  },
  reactions: { emoji: String, userId: String }
});

module.exports = mongoose.model('Message', messageSchema);