const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  room: { 
    type: String, 
    required: true, 
    index: true // Indexed for fast querying when switching rooms 
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
    required: true 
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  image: {
    type: String,
    default: null 
  }
});

module.exports = mongoose.model('Message', messageSchema);