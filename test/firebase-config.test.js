'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const test = require('node:test');

test('normalizes Render credentials and gives Storage the explicit v10 JWT client', async (t) => {
  const previous = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_PROJECT_ID = 'storage-auth-test';
  process.env.FIREBASE_CLIENT_EMAIL = 'firebase-adminsdk@storage-auth-test.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .replace(/\n/g, '\\n');
  process.env.FIREBASE_STORAGE_BUCKET = 'gs://storage-auth-test.appspot.com/';

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
      FIREBASE_PRIVATE_KEY: previous.privateKey,
      FIREBASE_STORAGE_BUCKET: previous.storageBucket
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete require.cache[configPath];
    delete require.cache[firestorePath];
  });

  const checked = firebase.validateFirebaseConfig();
  const app = firebase.getFirebaseApp();
  const bucket = firebase.getStorageBucket();
  const explicitAuthClient = await bucket.storage.authClient.getClient();

  assert.ok(checked.privateKey.includes('\n'));
  assert.equal(checked.storageBucket, 'storage-auth-test.appspot.com');
  assert.equal(app.options.storageBucket, 'storage-auth-test.appspot.com');
  assert.equal(bucket.name, 'storage-auth-test.appspot.com');
  assert.equal(explicitAuthClient.constructor.name, 'JWT');
  assert.equal(bucket.storage.retryOptions.autoRetry, false);
});
