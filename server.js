require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message');
const User = require('./models/User');
const { encryptMessageContent, decryptMessageContent, serializeMessage, validateEncryptionKey } = require('./messageEncryption');
const webpush = require('web-push');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
const { getAuth } = require('firebase-admin/auth');
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  process.env.VAPID_PUBLIC_KEY || "YOUR_GENERATED_PUBLIC_KEY_HERE",
  process.env.VAPID_PRIVATE_KEY || "YOUR_GENERATED_PRIVATE_KEY_HERE"
);

dns.setServers(['8.8.8.8', '1.1.1.1']);

const app = express();
app.use(cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);

// 1. Initialize Redis Clients for Pub/Sub & Socket.io multi-server routing
const redisClient = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});
const subClient = redisClient.duplicate();

redisClient.on('error', (err) => console.error('Redis Client Error', err));
subClient.on('error', (err) => console.error('Redis Sub Client Error', err));

const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 5000,
  pingTimeout: 2000,
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
const PUBLIC_ROOMS = new Set(['general', 'tech', 'random', 'gaming']);

function canAccessRoom(room, uid) {
  if (!room || !uid) return false;
  return PUBLIC_ROOMS.has(room) || room.split('_').includes(uid);
}

// File Upload REST Endpoint
app.post('/api/upload', checkAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: 'chat_app_uploads', resource_type: 'auto' },
        (error, uploadedFile) => error ? reject(error) : resolve(uploadedFile)
      );
      stream.end(req.file.buffer);
    });
    res.json({ url: result.secure_url });
  } catch (err) {
    console.error('❌ Cloudinary Upload Error:', err);
    res.status(500).json({ error: 'File upload failed', details: err.message });
  }
});

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
// Add this new endpoint to fetch replies for a specific parent message
app.get('/api/messages/thread', checkAuth, async (req, res) => {
  try {
    const { parentId } = req.query;
    if (!parentId) {
      return res.status(400).json({ error: 'parentId parameter is required' });
    }
    const parentMessage = await Message.findById(parentId).select('room');
    if (!parentMessage || !canAccessRoom(parentMessage.room, req.user.uid)) {
      return res.status(403).json({ error: 'You do not have access to this thread' });
    }
    const replies = await Message.find({ parentId }).sort({ createdAt: 1 });
    res.json(replies.map(serializeMessage));
  } catch (err) {
    console.error('[SERVER ERROR] Failed to fetch thread replies:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET search messages across the whole history of a room
app.get('/api/messages/search', checkAuth, async (req, res) => {
  try {
    const { room, query } = req.query;
    
    if (!room || !query) {
      return res.status(400).json({ error: 'Room and query parameters are required' });
    }
    if (!canAccessRoom(room, req.user.uid)) {
      return res.status(403).json({ error: 'You do not have access to this room' });
    }

    const matches = [];
    const cursor = Message.find({ room }).sort({ createdAt: -1 }).cursor();
    try {
      for await (const storedMessage of cursor) {
        const message = serializeMessage(storedMessage);
        if (message.text && message.text.toLowerCase().includes(String(query).toLowerCase())) {
          matches.push(message);
          if (matches.length === 50) break;
        }
      }
    } finally {
      await cursor.close();
    }
    res.json(matches.reverse());
  } catch (err) {
    console.error('Failed to execute search:', err);
    res.status(500).json({ error: 'Internal server error during search' });
  }
});

const MONGO_URI = process.env.MONGO_URI || "YOUR_MONGODB_ATLAS_CONNECTION_STRING";

app.get('/ping', (req, res) => {
  res.status(200).send('Server is awake! 🚀');
});

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
app.get('/api/messages', checkAuth, async (req, res) => {
  console.log('[SERVER DEBUG] Incoming GET /api/messages request:', req.query);
  try {
    const { room, before, limit = 30 } = req.query;
    if (!canAccessRoom(room, req.user.uid)) {
      return res.status(403).json({ error: 'You do not have access to this room' });
    }
    console.log(`[SERVER DEBUG] Parsed params -> room: ${room}, before: ${before}, limit: ${limit}`);
    
    let query = { room };

    if (before) {
      query.createdAt = { $lt: new Date(before) };
      console.log('[SERVER DEBUG] Added before filter to query:', query.createdAt);
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit));

    console.log(`[SERVER DEBUG] Successfully found ${messages.length} messages from DB for room: ${room}`);
    res.json(messages.reverse().map(serializeMessage));
  } catch (err) {
    console.error('[SERVER ERROR] Failed to fetch messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/users', checkAuth, async (req, res) => {
  try {
    const users = await User.find({}).select('uid name email avatar lastSeen').sort({ lastSeen: -1 }).exec();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to fetch and broadcast current active users from Redis
async function broadcastActiveUsers() {
  try {
    const allUsersObj = await redisClient.hGetAll('active_users');
    const usersList = Object.values(allUsersObj).map(u => JSON.parse(u));
    io.emit('active_users_list', usersList);
  } catch (err) {
    console.error("❌ Error fetching active users from Redis:", err);
  }
}
const userSockets = new Map();
io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);
  socket.on('send_message', async (data, callback) => {
    try {
      const room = data.room || 'general';
      if (!canAccessRoom(room, socket.user.uid)) {
        if (typeof callback === 'function') callback({ success: false, error: 'You do not have access to this room.' });
        return;
      }
      if (data.parentId) {
        const parentMessage = await Message.findById(data.parentId).select('room');
        if (!parentMessage || parentMessage.room !== room) {
          if (typeof callback === 'function') callback({ success: false, error: 'Invalid thread parent.' });
          return;
        }
      }
      const rateLimitKey = `rate_limit:${socket.user.uid}`;
      const requestCount = await redisClient.incr(rateLimitKey);
      if (requestCount === 1) await redisClient.expire(rateLimitKey, 2);
      if (requestCount > 5) {
        if (typeof callback === 'function') callback({ success: false, error: 'You are sending messages too fast.' });
        return;
      }

      const newMessage = new Message({
        text: '',
        contentCiphertext: encryptMessageContent({
          text: data.text || '',
          image: data.image || null,
          audio: data.audio || null,
        }),
        sender: socket.user.name || socket.user.email || 'User',
        senderUid: socket.user.uid,
        audio: null,
        avatar: socket.user.picture || null,
        room,
        parentId: data.parentId || null, // ✨ Support for threads
        image: null,
        clientMessageId: data.clientMessageId,
        createdAt: new Date(),
        reactions: null
      });
      
      const savedMessage = await newMessage.save();

      // Broadcast to everyone in the room (main feed or thread handles filtering client-side)
      io.to(room).emit('receive_message', serializeMessage(savedMessage));

      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      console.error('❌ Error sending message:', error);
      if (typeof callback === 'function') callback({ success: false, error: error.message });
    }
    
  });
       // Store mapping of firebaseUid -> socket.id
socket.on("realRegisterUser", (firebaseUid) => {
    if (firebaseUid) {
      userSockets.set(firebaseUid, socket.id);
      console.log(`✅ User successfully mapped: ${firebaseUid} -> ${socket.id}`);
    }
  });

  // 2. Start Call
// Automatically register the user using their authenticated Firebase token data
  if (socket.user && socket.user.uid) {
    userSockets.set(socket.user.uid, socket.id);
    console.log(`✅ User automatically mapped: ${socket.user.uid} -> ${socket.id}`);
  }

  // 1. Start Call
  socket.on("start_call", ({ signal, to, name }) => {
    console.log(`📞 Start call from ${socket.user.uid} to ${to}`);
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("incoming_call", {
        signal,
        from: socket.user.uid,
        name,
      });
    } else {
      console.warn(`❌ Target user ${to} not found in userSockets map!`);
    }
  });

  // 2. Answer Call
  socket.on("answer_call", ({ signal, to }) => {
    console.log(`✅ Answer call to ${to}`);
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("call_accepted", signal);
    }
  });

  // 3. ICE Candidates
  socket.on("ice_candidate", ({ target, to }) => {
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice_candidate", target);
    }
  });

  // 4. Hangup Call
  socket.on("hangup_call", ({ to }) => {
    const targetSocketId = userSockets.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("call_ended");
    }
  });

  socket.on("disconnect", () => {
    for (let [uid, sId] of userSockets.entries()) {
      if (sId === socket.id) {
        userSockets.delete(uid);
        break;
      }
    }
});

  socket.on('mark_messages_read', async ({ messageIds, room }) => {
    try {
      if (!canAccessRoom(room, socket.user.uid)) return;
      await Message.updateMany(
        { _id: { $in: messageIds }, room },
        { $addToSet: { readBy: socket.user.uid } }
      );
      io.to(room).emit('messages_read_update', { messageIds, userId: socket.user.uid, room });
    } catch (err) {
      console.error("Error updating read receipts:", err);
    }
  });

  socket.on('toggle_reaction', async ({ messageId, emoji }) => {
  try {
    const message = await Message.findById(messageId);
    if (!message) return;
    if (!canAccessRoom(message.room, socket.user.uid)) return;

    let reactions = message.reactions || [];
    const existingIndex = reactions.findIndex(r => r.userId === socket.user.uid && r.emoji === emoji);

    if (existingIndex > -1) {
      // Remove reaction if user clicks the same emoji again
      reactions.splice(existingIndex, 1);
    } else {
      // Add new reaction
      reactions.push({ emoji, userId: socket.user.uid });
    }

    message.reactions = reactions;
    await message.save();

    io.to(message.room).emit('message_updated', serializeMessage(message));
  } catch (err) {
    console.error('Error toggling reaction:', err);
  }
});

  socket.on('user_connected', async (userData) => {
    if (userData) {
      const uid = socket.user.uid;
      const name = socket.user.name || socket.user.email || 'User';
      const email = socket.user.email || null;
      const avatar = socket.user.picture || null;
      console.log(`📡 Registration Sync for ${name}:`, userData.pushSubscription ? "✅ TOKEN FOUND" : "❌ NO TOKEN ATTACHED");
      
      try {
        await User.findOneAndUpdate(
          { uid },
          { name, email, avatar, lastSeen: new Date() },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.error("❌ Failed to save user to database:", dbErr);
      }

      socket.userProfile = {
        uid,
        name,
        avatar,
        pushSubscription: userData.pushSubscription || null 
      };

      socket.currentRoom = 'general'; 
      socket.join('general');

      // Store active user session in Redis Hash
      await redisClient.hSet('active_users', socket.id, JSON.stringify({ 
        ...socket.userProfile, 
        room: socket.currentRoom 
      }));

      await broadcastActiveUsers();
    }
  });

  socket.on('profile_updated', async ({ name }) => {
    const trimmedName = typeof name === 'string' ? name.trim().slice(0, 50) : '';
    if (!trimmedName) return;
    socket.user.name = trimmedName;
    try {
      await User.findOneAndUpdate(
        { uid: socket.user.uid },
        { name: trimmedName, lastSeen: new Date() },
        { upsert: true }
      );
      if (socket.userProfile) {
        socket.userProfile.name = trimmedName;
        await redisClient.hSet('active_users', socket.id, JSON.stringify({ ...socket.userProfile, room: socket.currentRoom }));
        await broadcastActiveUsers();
      }
    } catch (error) {
      console.error('Failed to update display name:', error);
    }
  });

  socket.on('delete_message', async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message || message.senderUid !== socket.user.uid) return;

      const room = message.room;
      await Message.findByIdAndDelete(messageId);
      io.to(room).emit('message_deleted', messageId);
    } catch (err) {
      console.error("Error deleting message:", err);
    }
  });

  socket.on('edit_message', async ({ messageId, text }, callback) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.senderUid !== socket.user.uid) return;

      const content = message.contentCiphertext
        ? decryptMessageContent(message.contentCiphertext)
        : { text: message.text || '', image: message.image || null, audio: message.audio || null };
      content.text = text;
      message.text = '';
      message.image = null;
      message.audio = null;
      message.contentCiphertext = encryptMessageContent(content);
      message.edited = true; 
      await message.save();

      io.to(message.room).emit('message_updated', serializeMessage(message));
      if (typeof callback === 'function') callback({ success: true });
    } catch (err) {
      console.error("❌ Error editing message:", err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
    }
  });

  socket.on('join_room', async (room) => {
    if (!canAccessRoom(room, socket.user.uid)) return;
    socket.leave(socket.currentRoom);
    socket.join(room);
    socket.currentRoom = room;
    
    // Update room placement in Redis active users hash
    const existingDataStr = await redisClient.hGet('active_users', socket.id);
    if (existingDataStr) {
      const user = JSON.parse(existingDataStr);
      user.room = room;
      await redisClient.hSet('active_users', socket.id, JSON.stringify(user));
    }
    
    await broadcastActiveUsers();
  });

  socket.on('typing_start', ({ room, userName }) => {
    socket.to(room).emit('display_typing', { userName, room });
  });

 socket.on('typing_stop', ({ room }) => {
    socket.to(room).emit('hide_typing', { room });
  });

  socket.on('disconnect', async () => {
    console.log(`🔴 User disconnected: ${socket.id}`);
    await redisClient.hDel('active_users', socket.id);
    await broadcastActiveUsers();
  });
}); // 👈 This correctly closes io.on('connection')

// Startup sequence connecting Redis, MongoDB, and HTTP Server
const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    validateEncryptionKey();
    await Promise.all([
      redisClient.connect(),
      subClient.connect(),
      mongoose.connect(MONGO_URI)
    ]);
    console.log('Successfully connected to Redis & MongoDB Atlas!');

    // Attach Socket.io Redis adapter for cross-instance coordination
    io.adapter(createAdapter(redisClient, subClient));

    server.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server components:', err);
  }
}

startServer();