const admin = require("../firebaseAdmin");

const checkAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized: No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken; // Contains uid, email, name
    next();
  } catch (error) {
    // 🔍 CRITICAL DEBUG LINE: This prints the exact reason to your Render terminal!
    console.error("❌ FIREBASE VERIFICATION CRASH:", error);
    
    return res.status(401).json({ 
      error: "Unauthorized: Invalid or expired token",
      debugMessage: error.message, // Temporarily passing this to the frontend alert box
      debugCode: error.code
    });
  }
};

module.exports = checkAuth;
