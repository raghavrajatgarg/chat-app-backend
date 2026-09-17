const admin = require('firebase-admin');
const { initializeApp, cert } = require('firebase-admin/app');

// Ensure the private key handles escaped newlines properly
const formattedPrivateKey = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined;

const serviceAccountConfig = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: formattedPrivateKey
};

initializeApp({
  credential: cert(serviceAccountConfig)
});

module.exports = admin;
