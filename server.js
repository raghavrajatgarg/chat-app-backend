// server/server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const Message = require('./models/Message');

const app = express();
app.use(cors());

// 1. Connect to MongoDB Atlas using YOUR actual connection string
const MONGO_URI = 'mongodb+srv://raghavscts_db_user:Qeboqy85O0875IdZ@chat-app.aacxagz.mongodb.net/chatapp?retryWrites=true&w=majority&appName=chat-app';

mongoose.connect(MONGO_URI)
  .then(() => console.log('Successfully connected to MongoDB Atlas!'))
  .catch((err) => console.error('MongoDB connection error:', err));

// 2. Create HTTP server & attach Socket.io
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 3. Real-Time Socket Connections
io.on('connection', async (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Fetch and send past 50 messages to the newly connected user
  try {
    const pastMessages = await Message.find().sort({ createdAt: 1 }).limit(50);
    socket.emit('load_history', pastMessages);
  } catch (err) {
    console.error('Error fetching chat history:', err);
  }

  // Listen for 'send_message' event from client
  socket.on('send_message', async (data) => {
    try {
      // Save message permanently to MongoDB
      const newMessage = new Message(data);
      await newMessage.save();

      // Broadcast saved message to all connected users
      io.emit('receive_message', data);
    } catch (err) {
      console.error('Error saving message to database:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});