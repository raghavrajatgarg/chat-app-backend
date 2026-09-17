const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');

// 1. Separate the service account object completely 
const serviceAccountConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  // FIX: Added .replace(/\n/g, '\n') to catch keys containing literal multiline breaks
  privateKey: process.env.FIREBASE_PRIVATE_KEY 
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n').replace(/\n/g, '\n') 
    : undefined
};

// 2. Use the dedicated modern initialization function path
initializeApp({
  credential: cert(serviceAccountConfig)
});

module.exports = admin;
