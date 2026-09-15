const express = require('express');
const http = http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message'); // Make sure your Message model path matches your project structure

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

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch(err => console.error('MongoDB connection error:', err));

// 1. Health check route for cron-job.org uptime monitor (Returns 200 OK)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// 2. Fetch chat history route (loads all messages ordered oldest to newest)
app.get('/api/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ createdAt: 1 });
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Protected API Room Route
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

// Socket.io Real-time Connection
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // Listen for new messages from clients, save to MongoDB, and broadcast
  socket.on('send_message', async (data) => {
    try {
      const newMessage = new Message(data);
      await newMessage.save();
      io.emit('receive_message', newMessage);
    } catch (error) {
      console.error('Error saving message via socket:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
