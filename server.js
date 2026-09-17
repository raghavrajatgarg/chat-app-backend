const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message');

dns.setServers(['8.8.8.8', '1.1.1.1']);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const MONGO_URI = process.env.MONGO_URI || "YOUR_MONGODB_ATLAS_CONNECTION_STRING";

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake! 🚀');
});

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch(err => console.error('MongoDB connection error:', err));

console.log("🕵️ DIAGNOSTIC: Server is validating tokens using Firebase ID:", process.env.FIREBASE_PROJECT_ID);

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: 1 }).exec();
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/room', checkAuth, async (req, res) => {
  try {
    const { uid, email, name } = req.user;
    const { roomName } = req.body;
    
    res.status(200).json({ 
      message: `Room '${roomName}' successfully created!`, 
      owner: name || email 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// SINGLE, CLEAN WEBSOCKET CONNECTION BLOCK
io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);

  socket.on('send_message', async (data) => {
    try {
      const newMessage = new Message({
        text: data.text,
        sender: data.sender,
        senderUid: data.senderUid,
        avatar: data.avatar,
        createdAt: data.createdAt || new Date()
      });
      
      const savedMessage = await newMessage.save();
      io.emit('receive_message', savedMessage);
    } catch (error) {
      console.error('❌ Data persistence failure on socket stream:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User unlinked:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
