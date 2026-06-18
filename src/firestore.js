'use strict';

const admin = require('firebase-admin');
const config = require('./config');

let app = null;
let firestore = null;

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

  const { projectId, clientEmail } = config.firebase;
  // Render (and most dashboards) store multi-line secrets with literal
  // "\n" sequences instead of real newlines — undo that or the PEM key
  // fails to parse.
  const privateKey = String(config.firebase.privateKey || '').replace(/\\n/g, '\n');

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase Admin credentials are missing. Set FIREBASE_PROJECT_ID ' +
        '(or VITE_FIREBASE_PROJECT_ID), FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY.'
    );
  }

  app = admin.initializeApp({
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    storageBucket: config.firebase.storageBucket || undefined
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
  getFirebaseApp,
  getFirestore,
  postsCollection,
  configDoc,
  // Static namespaces — safe to read without an initialized app.
  Timestamp: admin.firestore.Timestamp,
  FieldValue: admin.firestore.FieldValue
};
