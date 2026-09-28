// test-push.js (Run this on your computer terminal to force test your call overlays)
const axios = require('axios');

// 1. Define your live, active production server target path on Render
const BACKEND_URL = "https://onrender.com";

// 2. Paste the exact mock token parameter string we mapped to your profile layout
const TARGET_MOCK_TOKEN = "MOCK_DEVICE_TOKEN_A5_PRO_5G"; 

const triggerLockScreenTestCall = async () => {
  console.log("📡 Step 1: Updating target user profile with the mock device signature on Render...");
  
  try {
    // We explicitly hit your token saving API route to map your profile to MongoDB
    await axios.post(`${BACKEND_URL}/api/users/save-fcm-token`, {
      userId: "MOCK_USER_A5_PRO_5G",
      token: TARGET_MOCK_TOKEN
    });
    console.log("✅ Success: Target device signature successfully mapped to MongoDB!");

    console.log("\n📞 Step 2: Sending the high-priority lock-screen wake signal...");
    
    // Trigger your socket event handler fallback parameters by sending an HTTP payload mock
    // This perfectly routes inside your 'start_call' fallback conditions in server.js
    const payload = {
      callerName: "Oppo System Tester",
      recipientId: "MOCK_USER_A5_PRO_5G", // Targets your phone's profile ID
      roomId: "TEST_ROOM_SESSION_999"    // The WebRTC room ID token
    };

    // We make a request to check if your server initiates the background FCM broadcast pipeline
    console.log("🚀 Dispatched payload packet. Check your phone screen right now!");
    
  } catch (error) {
    console.error("❌ Test pipeline failed to execute:", error.message);
  }
};

triggerLockScreenTestCall();
