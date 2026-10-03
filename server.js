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
const { encryptMessageContent, decryptMessageContent, serializeMessage } = require('./messageEncryption');
const webpush = require('web-push');
const cloudinary = require('cloudinary').v2;
const multer = require('multer');
// server.js (Firebase setup section wrapper update)
const { initializeApp, cert, getApps, getApp } = require('firebase-admin/app');
const { getAuth: firebaseGetAuth } = require('firebase-admin/auth');
const { getMessaging } = require('firebase-admin/messaging'); // Make sure this line is imported!

let firebaseApp;
let getAuth;

try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }
  if (getApps().length === 0) {
    firebaseApp = initializeApp({ credential: cert(serviceAccount) });
  } else {
    firebaseApp = getApp();
  }
  getAuth = () => firebaseGetAuth(firebaseApp);
} catch (error) {
  console.error("❌ Firebase initialization crash:", error.message);
}


// Leave your Webpush configurations intact directly below:
webpush.setVapidDetails(
  'mailto:your-email@example.com',
  process.env.VAPID_PUBLIC_KEY || "YOUR_GENERATED_PUBLIC_KEY_HERE",
  process.env.VAPID_PRIVATE_KEY || "YOUR_GENERATED_PRIVATE_KEY_HERE"
);

const crypto = require('crypto');

const secureToken = crypto.randomBytes(32).toString('hex');
console.log(secureToken);

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

// Keep SDP out of FCM and share pending offers across server instances.
const PENDING_CALL_TTL_MS = 65000;
const pendingCallKey = (calleeUid) => `pending_call:${calleeUid}`;

async function setPendingCall(calleeUid, entry) {
  if (!calleeUid) return;
  await redisClient.set(
    pendingCallKey(calleeUid),
    JSON.stringify({ ...entry, at: Date.now() }),
    { EX: Math.ceil(PENDING_CALL_TTL_MS / 1000) }
  );
}

async function getPendingCall(calleeUid) {
  if (!calleeUid) return null;
  const serialized = await redisClient.get(pendingCallKey(calleeUid));
  if (!serialized) return null;

  let entry;
  try {
    entry = JSON.parse(serialized);
  } catch {
    await redisClient.del(pendingCallKey(calleeUid));
    return null;
  }

  if (Date.now() - entry.at > PENDING_CALL_TTL_MS) {
    await redisClient.del(pendingCallKey(calleeUid));
    return null;
  }
  return entry;
}

async function clearPendingCall(calleeUid) {
  if (calleeUid) await redisClient.del(pendingCallKey(calleeUid));
}

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
// REST Endpoint to save unique hardware FCM tokens from Capacitor mobile app
app.post('/api/users/save-fcm-token', checkAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token is required' });

    const userFields = { fcmToken: token };
    if (req.user.name) userFields.name = req.user.name;
    if (req.user.email) userFields.email = req.user.email;
    if (req.user.picture) userFields.avatar = req.user.picture;

    await User.findOneAndUpdate(
      { uid: req.user.uid },
      { $set: userFields },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(200).json({ success: true, message: 'FCM Token linked successfully' });
  } catch (err) {
    console.error('❌ Error mapping FCM token:', err);
    res.status(500).json({ error: 'Internal server error' });
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
          attachment: data.attachment || null,
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
    // Personal room used for call signalling. Rooms are coordinated by the
    // Redis adapter, so a call still reaches the callee when the two users
    // are connected to different server instances.
    socket.join(`user:${socket.user.uid}`);
    console.log(`✅ User automatically mapped: ${socket.user.uid} -> ${socket.id}`);
  }

  // 1. Start Call
  // server.js: Update your data block inside socket.on("start_call")
  socket.on("start_call", async ({ signal, to, name, roomId }) => {
    console.log(`📞 Start call from ${socket.user.uid} to ${to}`);

    const callId = roomId || socket.user.uid;

    // Remember the offer so the callee can pull it after answering (cold start
    // / lock-screen accept). Cleared on answer, decline or hangup.
    await setPendingCall(to, {
      signal,
      from: socket.user.uid,
      name: name || "Incoming Call",
      callId,
    });

    // Fan the ring out through the callee's personal room (works on every
    // node via the Redis adapter).
    io.to(`user:${to}`).emit("incoming_call", {
      signal,
      from: socket.user.uid,
      name,
      roomId: callId
    });

    // Always mirror the ring over FCM as well. Without this, a callee whose app
    // is backgrounded but still holds a live socket never receives a
    // lock-screen / full-screen incoming call - only the in-app modal fires.
    try {
      const recipientUser = await User.findOne({ uid: to });

      if (recipientUser && recipientUser.fcmToken) {
        const pushMessage = {
          token: recipientUser.fcmToken,
          android: {
            priority: "high" // Wakes up the device CPU
          },
          data: {
            isVoip: "true", // Checked by the Java background listener
            roomId: callId,
            callerName: name || "Incoming Call",
            fromUid: socket.user.uid,
            hasSignal: "true" // SDP is pulled over the socket to stay under FCM's 4 KB cap
          }
        };

        await getMessaging(firebaseApp).send(pushMessage);
        console.log(`✅ VoIP high-priority push successfully sent to Google servers for user ${to}`);
      } else {
        console.warn(`❌ Could not send push. No registered FCM token found for user ${to}`);
      }
    } catch (err) {
      console.error("❌ Failed to route background FCM VoIP push:", err);
    }
  });


  // 2. Answer Call
  socket.on("answer_call", async ({ signal, to }) => {
    console.log(`✅ Answer call to ${to}`);
    await clearPendingCall(socket.user.uid);
    io.to(`user:${to}`).emit("call_accepted", signal);
  });

  // 3. ICE Candidates
  socket.on("ice_candidate", ({ target, to }) => {
    io.to(`user:${to}`).emit("ice_candidate", target);
  });

  // 4b. Callee pulls the stored offer after answering from a cold start /
  //     lock screen (the offer was intentionally not shipped in the FCM push).
  socket.on("request_pending_call", async (payload, callback) => {
    const ack = typeof callback === "function" ? callback : () => {};
    try {
      const entry = await getPendingCall(socket.user.uid);
      if (!entry) {
        ack({ call: null });
        return;
      }
      ack({
        call: {
          signal: entry.signal,
          from: entry.from,
          name: entry.name,
          roomId: entry.callId,
        },
      });
    } catch (error) {
      console.error("Failed to retrieve pending call offer:", error);
      ack({ call: null });
    }
  });

  // 4. Hangup Call
  socket.on("hangup_call", async ({ to }) => {
    await Promise.all([
      clearPendingCall(to),
      clearPendingCall(socket.user.uid),
    ]);
    io.to(`user:${to}`).emit("call_ended");
  });

  socket.on("disconnect", () => {
    for (let [uid, sId] of userSockets.entries()) {
      if (sId === socket.id) {
        userSockets.delete(uid);
        break;
      }
    }
  });// 📁 File path: server.js (Around line 250)
  socket.on('mark_messages_read', async ({ messageIds, room }) => {
    try {
      if (!canAccessRoom(room, socket.user.uid)) return;

      for (const messageId of messageIds) {
        await Message.updateOne(
          {
            _id: messageId,
            room,
            // ⚡️ CRITICAL PROTECTION CONDITIONAL: Only target the message document 
            // if this specific user has NEVER read it yet.
            'readBy.userId': { $ne: socket.user.uid }
          },
          {
            // ⚡️ THE PERMANENT DATABASE FIX: Using $addToSet instead of $push 
            // guarantees MongoDB rejects duplicates from secondary browser tab connections!
            $addToSet: {
              readBy: {
                userId: socket.user.uid,
                readAt: new Date()
              }
            }
          }
        );
      }

      io.to(room).emit('messages_read_update', { messageIds, userId: socket.user.uid, room });
    } catch (err) {
      console.error("Error updating read receipts loop:", err);
    }
  });


  // 📁 Inside server.js, update your event listener block:
  socket.on('toggle_reaction', async ({ messageId, emoji }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;
      if (!canAccessRoom(message.room, socket.user.uid)) return;

      // Type checking: Ensures data treats values as arrays securely
      let reactions = Array.isArray(message.reactions) ? message.reactions : [];

      const existingIndex = reactions.findIndex(
        (r) => r.userId === socket.user.uid && r.emoji === emoji
      );

      if (existingIndex > -1) {
        // Remove reaction if the user clicks the same emoji again
        reactions.splice(existingIndex, 1);
      } else {
        // Add new reaction array entry tracking elements
        reactions.push({ emoji, userId: socket.user.uid });
      }

      message.reactions = reactions;
      await message.save();

      // Broadcasts updated schema tray straight out to everyone in the room loop
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
      // Stay subscribed to every public room (not just the active one) so
      // unread counts can be tracked client-side for rooms you're not viewing.
      PUBLIC_ROOMS.forEach((publicRoom) => socket.join(publicRoom));

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

  socket.on('mass_delete_messages', async ({ messageIds, room }) => {
    try {
      if (!Array.isArray(messageIds) || messageIds.length === 0) return;
      if (!canAccessRoom(room, socket.user.uid)) return;

      // Only ever delete messages that both belong to this room AND were sent
      // by the requesting user - same ownership rule as single delete_message.
      const deletable = await Message.find({
        _id: { $in: messageIds },
        room,
        senderUid: socket.user.uid,
      }).select('_id');

      if (!deletable.length) return;

      const deletableIds = deletable.map((msg) => msg._id.toString());
      await Message.deleteMany({ _id: { $in: deletableIds } });

      io.to(room).emit('messages_deleted', deletableIds);
    } catch (err) {
      console.error('Error mass deleting messages:', err);
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
    // Only leave the previous room if it was a private (DM) room - sockets
    // stay joined to every public room permanently so unread counts work.
    if (!PUBLIC_ROOMS.has(socket.currentRoom)) {
      socket.leave(socket.currentRoom);
    }
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
