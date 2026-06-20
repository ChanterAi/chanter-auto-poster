'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const test = require('node:test');

test('normalizes Render credentials for Firebase Admin Firestore', async (t) => {
  const previous = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_PROJECT_ID = 'storage-auth-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@storage-auth-test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .replace(/\n/g, '\\n');

  const configPath = require.resolve('../src/config');
  const firestorePath = require.resolve('../src/firestore');
  delete require.cache[configPath];
  delete require.cache[firestorePath];

  const firebase = require('../src/firestore');
  t.after(async () => {
    await firebase.getFirebaseApp().delete();
    for (const [name, value] of Object.entries({
      FIREBASE_PROJECT_ID: previous.projectId,
      FIREBASE_CLIENT_EMAIL: previous.clientEmail,
      FIREBASE_PRIVATE_KEY: previous.privateKey
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[configPath];
    delete require.cache[firestorePath];
  });

  const checked = firebase.validateFirebaseConfig();
  const app = firebase.getFirebaseApp();

  assert.ok(checked.privateKey.includes('\n'));
  assert.equal(checked.projectId, 'storage-auth-test');
  assert.ok(app.options.credential);
});
