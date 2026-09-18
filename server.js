const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message');
// Tracks live user profiles using their socket connection keys
const activeUsers = new Map();

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

const { getAuth } = require('firebase-admin/auth');

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) {
    return next(new Error("Authentication error: No token provided"));
  }
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    socket.user = decodedToken; // Attach verified user info to the socket
    next();
  } catch (err) {
    next(new Error("Authentication error: Invalid token"));
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
// 1. Update GET route to filter by room
app.get('/api/messages', async (req, res) => {
  try {
    const room = req.query.room || 'general';
    const messages = await Message.find({ room }).sort({ createdAt: 1 }).exec();
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// 2. Clean, single WebSocket connection block with room support & typing indicators
io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);

  socket.on('user_connected', (userData) => {
    if (userData && userData.uid) {
      // Store user info including current room on the socket object
      socket.userProfile = {
        uid: userData.uid,
        name: userData.name || userData.email,
        avatar: userData.avatar
      };
      socket.currentRoom = 'general'; // Default starting room
      socket.join('general');

      activeUsers.set(socket.id, { ...socket.userProfile, room: socket.currentRoom });
      
      // Broadcast updated active list to everyone
      io.emit('active_users_list', Array.from(activeUsers.values()));
    }
  });

  socket.on('delete_message', async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      // Ensure only the author can delete
      if (message.senderUid !== userId) return;

      const room = message.room;
      await Message.findByIdAndDelete(messageId);

      // Broadcast to everyone in that room (including the sender)
      io.to(room).emit('message_deleted', messageId);
    } catch (err) {
      console.error("Error deleting message via socket:", err);
    }
  });

  socket.on('join_room', (room) => {
    // Leave the old room
    socket.leave(socket.currentRoom);
    
    // Join the new room
    socket.join(room);
    socket.currentRoom = room;
    
    // Update active users map
    if (activeUsers.has(socket.id)) {
      const user = activeUsers.get(socket.id);
      user.room = room;
      activeUsers.set(socket.id, user);
    }

    console.log(`User ${socket.id} successfully joined room: ${room}`);
    io.emit('active_users_list', Array.from(activeUsers.values()));
  });

  // 🌟 Typing indicator events
  socket.on('typing_start', ({ room, userName }) => {
    socket.to(room).emit('display_typing', { userName, room });
  });

  socket.on('typing_stop', ({ room }) => {
    socket.to(room).emit('hide_typing', { room });
  });
// Unified send_message handler
  socket.on('send_message', async (data) => {
    try {
      const newMessage = new Message({
        text: data.text,
        sender: data.sender,
        senderUid: data.senderUid, // Matches frontend data key
        avatar: data.avatar,
        room: data.room || 'general',
        createdAt: new Date()
      });
      
      const savedMessage = await newMessage.save();
      io.to(savedMessage.room).emit('receive_message', savedMessage);
    } catch (error) {
      console.error('❌ Data persistence failure on socket stream:', error);
    }
  });
  socket.on('disconnect', () => {
    if (activeUsers.has(socket.id)) {
      activeUsers.delete(socket.id);
      io.emit('active_users_list', Array.from(activeUsers.values()));
    }
    console.log('User unlinked:', socket.id);
  });
});
// EDIT MESSAGE
app.put('/api/messages/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { text, userId } = req.body;

    const message = await Message.findById(id);
    if (!message) return res.status(404).json({ error: "Message not found" });

    // Ensure only the author can edit
    if (message.senderId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    message.text = text;
    message.edited = true; // Optional flag to show "(edited)" tag
    await message.save();

    // Broadcast update to everyone in the room via Socket.io
    io.to(message.room).emit('message_updated', message);
    res.json(message);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
