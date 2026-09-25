const { cert, getApps, initializeApp } = require('firebase-admin/app');

// Clean parsing syntax for private key formatting structures
const privateKeyFormat = process.env.FIREBASE_PRIVATE_KEY
  ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : undefined;

const requiredCredentials = {
  projectId: process.env.FIREBASE_PROJECT_ID,
  clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  privateKey: privateKeyFormat,
};

if (Object.values(requiredCredentials).some((value) => !value)) {
  throw new Error('Missing FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, or FIREBASE_PRIVATE_KEY environment variable.');
}

const firebaseApp = getApps()[0] || initializeApp({
  credential: cert(requiredCredentials),
});

module.exports = firebaseApp;
