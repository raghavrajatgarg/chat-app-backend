const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  text: { type: String, required: true },
  sender: { type: String, required: true },
  senderUid: { type: String, required: true },
  avatar: { type: String },
  room: { type: String, default: 'general', required: true }, // Added room field
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Message', MessageSchema);