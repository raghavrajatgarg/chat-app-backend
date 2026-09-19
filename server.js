const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message');

const activeUsers = new Map();

dns.setServers(['8.8.8.8', '1.1.1.1']);
const getPrivateRoomId = (uid1, uid2) => {
  return [uid1, uid2].sort().join('_');
};

const app = express();
app.use(cors());

// 🌟 FIX 1: Max out incoming body parser JSON limits for Base64 payloads (Set to 10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);

// 🌟 FIX 2: Max out WebSockets buffer frame limits to accept large file data arrays
const io = new Server(server, {
  maxHttpBufferSize: 1e7, // 10 Megabytes limit frame structural ceiling
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
    socket.user = decodedToken; 
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

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.post('/api/room', checkAuth, async (req, res) => {
  try {
    const { roomName } = req.body;
    res.status(200).json({ message: `Room '${roomName}' successfully created!` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const room = req.query.room || 'general';
    const messages = await Message.find({ room }).sort({ createdAt: 1 }).exec();
    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);

  socket.on('user_connected', (userData) => {
    if (userData && userData.uid) {
      socket.userProfile = {
        uid: userData.uid,
        name: userData.name || userData.email,
        avatar: userData.avatar
      };
      socket.currentRoom = 'general'; 
      socket.join('general');

      activeUsers.set(socket.id, { ...socket.userProfile, room: socket.currentRoom });
      io.emit('active_users_list', Array.from(activeUsers.values()));
    }
  });

  socket.on('delete_message', async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || message.senderUid !== userId) return;

      const room = message.room;
      await Message.findByIdAndDelete(messageId);
      io.to(room).emit('message_deleted', messageId);
    } catch (err) {
      console.error("Error deleting message:", err);
    }
  });

  socket.on('join_room', (room) => {
    socket.leave(socket.currentRoom);
    socket.join(room);
    socket.currentRoom = room;
    
    if (activeUsers.has(socket.id)) {
      const user = activeUsers.get(socket.id);
      user.room = room;
      activeUsers.set(socket.id, user);
    }
    io.emit('active_users_list', Array.from(activeUsers.values()));
  });

  socket.on('typing_start', ({ room, userName }) => {
    socket.to(room).emit('display_typing', { userName, room });
  });

  socket.on('typing_stop', ({ room }) => {
    socket.to(room).emit('hide_typing', { room });
  });

  // 🌟 FIX 3: Capture, save, and broadcast the image string field seamlessly
  socket.on('send_message', async (data, callback) => {
    try {
      const newMessage = new Message({
        text: data.text,
        sender: data.sender,
        senderUid: data.senderUid, 
        avatar: data.avatar,
        room: data.room || 'general',
        image: data.image || null, // Capture incoming base64 image strings safely
        createdAt: new Date()
      });
      
      const savedMessage = await newMessage.save();
      io.to(savedMessage.room).emit('receive_message', savedMessage);
      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      console.error('❌ Data persistence failure on socket stream:', error);
    }
  });

  socket.on('disconnect', () => {
    if (activeUsers.has(socket.id)) {
      activeUsers.delete(socket.id);
      io.emit('active_users_list', Array.from(activeUsers.values()));
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
