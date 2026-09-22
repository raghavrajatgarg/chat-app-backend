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
const webpush = require('web-push');

// Identify your application securely to global push routing centers
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
// Add this new endpoint to fetch replies for a specific parent message
app.get('/api/messages/thread', async (req, res) => {
  try {
    const { parentId } = req.query;
    if (!parentId) {
      return res.status(400).json({ error: 'parentId parameter is required' });
    }
    const replies = await Message.find({ parentId }).sort({ createdAt: 1 });
    res.json(replies);
  } catch (err) {
    console.error('[SERVER ERROR] Failed to fetch thread replies:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
// GET search messages across the whole history of a room
app.get('/api/messages/search', async (req, res) => {
  try {
    const { room, query } = req.query;
    
    if (!room || !query) {
      return res.status(400).json({ error: 'Room and query parameters are required' });
    }

    // Case-insensitive regex search across the entire database for this room
    // Limit to 50 results to keep it snappy and prevent overloading the client
    const messages = await Message.find({
      room: room,
      text: { $regex: query, $options: 'i' }
    })
    .sort({ createdAt: 1 })
    .limit(50);

    res.json(messages);
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
app.get('/api/messages', async (req, res) => {
  console.log('[SERVER DEBUG] Incoming GET /api/messages request:', req.query);
  try {
    const { room, before, limit = 30 } = req.query;
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
    res.json(messages.reverse());
  } catch (err) {
    console.error('[SERVER ERROR] Failed to fetch messages:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ lastSeen: -1 }).exec();
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

io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);
  socket.on('send_message', async (data, callback) => {
    try {
      const rateLimitKey = `rate_limit:${data.senderUid}`;
      const requestCount = await redisClient.incr(rateLimitKey);
      if (requestCount === 1) await redisClient.expire(rateLimitKey, 2);
      if (requestCount > 5) {
        if (typeof callback === 'function') callback({ success: false, error: 'You are sending messages too fast.' });
        return;
      }

      const newMessage = new Message({
        text: data.text,
        sender: data.sender,
        senderUid: data.senderUid, 
        avatar: data.avatar,
        room: data.room || 'general',
        parentId: data.parentId || null, // ✨ Support for threads
        image: data.image || null,
        createdAt: new Date()
      });
      
      const savedMessage = await newMessage.save();
      
      // Broadcast to everyone in the room (main feed or thread handles filtering client-side)
      io.emit('receive_message', savedMessage);

      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      console.error('❌ Error sending message:', error);
      if (typeof callback === 'function') callback({ success: false, error: error.message });
    }
  });

  socket.on('mark_messages_read', async ({ messageIds, userId, room }) => {
    try {
      await Message.updateMany(
        { _id: { $in: messageIds } },
        { $addToSet: { readBy: userId } }
      );
      io.to(room).emit('messages_read_update', { messageIds, userId, room });
    } catch (err) {
      console.error("Error updating read receipts:", err);
    }
  });

  socket.on('user_connected', async (userData) => {
    if (userData && userData.uid) {
      console.log(`📡 Registration Sync for ${userData.name}:`, userData.pushSubscription ? "✅ TOKEN FOUND" : "❌ NO TOKEN ATTACHED");
      
      try {
        await User.findOneAndUpdate(
          { uid: userData.uid },
          { name: userData.name, email: userData.email, avatar: userData.avatar, lastSeen: new Date() },
          { upsert: true, new: true }
        );
      } catch (dbErr) {
        console.error("❌ Failed to save user to database:", dbErr);
      }

      socket.userProfile = {
        uid: userData.uid,
        name: userData.name || userData.email,
        avatar: userData.avatar,
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

  socket.on('edit_message', async ({ messageId, text, userId, room }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.senderUid !== userId) return;

      message.text = text;
      message.edited = true; 
      await message.save();

      io.to(room).emit('message_updated', message);
    } catch (err) {
      console.error("❌ Error editing message:", err);
    }
  });

  socket.on('join_room', async (room) => {
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