// 1. Import the specific auth tool directly from the library bundle
const { getAuth } = require('firebase-admin/auth');
// Import your existing configured initialization setup
require('../firebaseAdmin'); 

const checkAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // 2. FIX: Use the dedicated modern token verifier method
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken; // Contains uid, email, name
    next();
  } catch (error) {
    console.error("❌ ACTUAL FIREBASE VALIDATION FAILURE:", error);
    return res.status(401).json({ error: "Unauthorized: Invalid or expired token" });
  }
};

module.exports = checkAuth;
