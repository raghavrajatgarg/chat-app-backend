const admin = require('firebase-admin');

// Safely extract the credential method handling module default fallbacks
const firebaseCredential = admin.credential || (admin.default && admin.default.credential);

if (!firebaseCredential) {
  throw new Error("Firebase Admin SDK failed to parse the credential sub-module targets.");
}

// Fail-fast safety checks to prevent silent server container hang ups
if (!process.env.FIREBASE_PROJECT_ID || !process.env.FIREBASE_PRIVATE_KEY) {
  console.error("❌ CRITICAL: Missing necessary Firebase Environment Variables in deployment cluster.");
}

admin.initializeApp({
  credential: firebaseCredential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Safely transforms raw configuration literals into true RSA signature breaks
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  })
});

module.exports = admin;
