// test-push.js
const axios = require('axios');

const BACKEND_URL = "https://onrender.com";

// 🛠️ PASTE THE REAL TOKEN YOU COPIED FROM ADB LOGCAT HERE:
const REAL_PHONE_TOKEN = "YOUR_COPIED_TOKEN_STRING"; 

const triggerLockScreenTestCall = async () => {
  console.log("🚀 Blasting high-priority wake payload to Render...");
  
  try {
    const response = await axios.post(`${BACKEND_URL}/api/test-voip-push`, {
      token: REAL_PHONE_TOKEN,
      callerName: "Oppo System Tester",
      roomId: "ROOM_SESSION_999"
    });
    
    console.log("✅ Render accepted the request! Check your phone right now!");
  } catch (error) {
    console.error("❌ Test pipeline failed:", error.response ? error.response.data : error.message);
  }
};

triggerLockScreenTestCall();
