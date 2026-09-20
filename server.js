const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const dns = require('dns');
const checkAuth = require('./middleware/auth');
const Message = require('./models/Message');
const User = require('./models/User')
const activeUsers = new Map();
const webpush = require('web-push');

// Identify your application securely to global push routing centers
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  process.env.VAPID_PUBLIC_KEY || "YOUR_GENERATED_PUBLIC_KEY_HERE",
  process.env.VAPID_PRIVATE_KEY || "YOUR_GENERATED_PRIVATE_KEY_HERE"
);

dns.setServers(['8.8.8.8', '1.1.1.1']);
const getPrivateRoomId = (uid1, uid2) => {
  return [uid1, uid2].sort().join('_');
};

const app = express();
app.use(cors());

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e7,
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  pingInterval: 5000, // The server pings the client every 10 seconds
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

app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find({}).sort({ lastSeen: -1 }).exec();
    res.status(200).json(users);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('📡 Real-time user linked to node:', socket.id);

  // ✅ Cleaned up single user_connected block with DB sync
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

  socket.on('edit_message', async ({ messageId, text, userId, room }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.senderUid !== userId) {
        console.log("⚠️ Edit action blocked: User validation keys mismatch.");
        return;
      }

      message.text = text;
      message.edited = true; 
      await message.save();

      io.to(room).emit('message_updated', message);
      console.log(`📝 Message ${messageId} successfully updated via WebSocket pipeline.`);
    } catch (err) {
      console.error("❌ Data persistence exception during message edit streaming pass:", err);
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

  socket.on('send_message', async (data, callback) => {
    try {
      const newMessage = new Message({
        text: data.text,
        sender: data.sender,
        senderUid: data.senderUid, 
        avatar: data.avatar,
        room: data.room || 'general',
        image: data.image || null,
        createdAt: new Date()
      });
      
      const savedMessage = await newMessage.save();
      io.emit('receive_message', savedMessage);

      const targets = Array.from(activeUsers.entries());
      targets.forEach(([socketId, userNode]) => {
        const isUserInDifferentRoom = userNode.room !== savedMessage.room;
        const isNotTheSender = userNode.uid !== savedMessage.senderUid;
        
        if (isUserInDifferentRoom && isNotTheSender && userNode.pushSubscription) {
          const fcmPayload = {
            notification: {
              title: `#${savedMessage.room} | ${savedMessage.sender}`,
              body: savedMessage.text !== "\u200B" ? savedMessage.text : "Sent an image asset 📷"
            },
            data: {
              icon: savedMessage.avatar || 'https://placeholder.com',
              url: 'https://vercel.app'
            },
            token: userNode.pushSubscription
          };

          const { getMessaging } = require('firebase-admin/messaging');
          getMessaging().send(fcmPayload)
            .then((res) => console.log('✅ FCM Background Push dispatched successfully:', res))
            .catch((err) => console.error('❌ Failed to push to FCM infrastructure network:', err));
        }
      });

      if (typeof callback === 'function') callback({ success: true });
    } catch (error) {
      console.error('❌ Data persistence failure on socket stream:', error);
      if (typeof callback === 'function') callback({ success: false, error: error.message });
    }
  });

socket.on('disconnect', () => {
  console.log(`🔴 User disconnected: ${socket.id}`);
  
  // Check if the user exists in your active users map/array
  if (activeUsers.has(socket.id)) {
    // 1. Remove them from the list
    activeUsers.delete(socket.id);
    
    // 2. 🚨 CRITICAL: Broadcast the updated list to EVERYONE immediately
    io.emit('active_users_list', Array.from(activeUsers.values())); 
  }
});
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});