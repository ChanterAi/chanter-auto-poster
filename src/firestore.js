'use strict';

const admin = require('firebase-admin');
const config = require('./config');

let app = null;
let firestore = null;
let firebaseConfigValidated = false;

function getNormalizedPrivateKey() {
  return String(config.firebase.privateKey || '').replace(/\\n/g, '\n').trim();
}

function validateFirebaseConfig() {
  const { projectId, clientEmail, storageBucket } = config.firebase;
  const privateKey = getNormalizedPrivateKey();
  const missing = [];

  if (!projectId) missing.push('FIREBASE_PROJECT_ID (or VITE_FIREBASE_PROJECT_ID)');
  if (!clientEmail) missing.push('FIREBASE_CLIENT_EMAIL');
  if (!privateKey) missing.push('FIREBASE_PRIVATE_KEY');
  if (!storageBucket) missing.push('FIREBASE_STORAGE_BUCKET');

  if (missing.length > 0) {
    throw new Error(`Firebase Admin configuration is missing: ${missing.join(', ')}`);
  }
  if (!String(clientEmail).includes('@')) {
    throw new Error('FIREBASE_CLIENT_EMAIL is not a valid service-account email');
  }
  if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
    throw new Error('FIREBASE_PRIVATE_KEY is not a valid PEM private key after newline normalization');
  }

  if (!firebaseConfigValidated) {
    console.log('[firebase] configuration validated', {
      projectIdSet: true,
      clientEmailSet: true,
      privateKeySet: true,
      storageBucketSet: true
    });
    firebaseConfigValidated = true;
  }

  return { projectId, clientEmail, privateKey, storageBucket };
}

/**
 * Lazily initializes the Firebase Admin SDK from service-account
 * credentials. Lazy on purpose: requiring this module (or anything that
 * requires it) must never make a network call or throw just because the
 * process happened to load it — only an actual Firestore operation should
 * trigger credential validation. That keeps `node --check` / `require()`
 * smoke tests safe to run without real credentials.
 */
function getFirebaseApp() {
  if (app) return app;

  const { projectId, clientEmail, privateKey, storageBucket } = validateFirebaseConfig();
  // Render (and most dashboards) store multi-line secrets with literal
  // "\n" sequences instead of real newlines — undo that or the PEM key
  // fails to parse.
  app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    storageBucket
  });

  return app;
}

function getFirestore() {
  if (!firestore) {
    firestore = getFirebaseApp().firestore();
    // Several call sites build partial patch objects that may contain
    // `undefined` for fields they don't intend to touch — without this,
    // Firestore throws instead of just ignoring them.
    firestore.settings({ ignoreUndefinedProperties: true });
  }
  return firestore;
}

function postsCollection() {
  return getFirestore().collection('posts');
}

function configDoc(name) {
  return getFirestore().collection('config').doc(name);
}

module.exports = {
  admin,
  validateFirebaseConfig,
  getFirebaseApp,
  getFirestore,
  postsCollection,
  configDoc,
  // Static namespaces — safe to read without an initialized app.
  Timestamp: admin.firestore.Timestamp,
  FieldValue: admin.firestore.FieldValue
};
