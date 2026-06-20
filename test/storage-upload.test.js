'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('uploads small images and videos, retries safely, and preserves URL fallback', async (t) => {
  process.env.FIREBASE_STORAGE_UPLOAD_ATTEMPTS = '3';
  process.env.FIREBASE_STORAGE_RETRY_BASE_MS = '100';
  process.env.FIREBASE_STORAGE_BUFFER_THRESHOLD_BYTES = '10485760';

  const firestorePath = require.resolve('../src/firestore');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  const configPath = require.resolve('../src/config');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];
  delete require.cache[configPath];

  const committed = [];
  const saveCalls = [];
  const timestamp = { toDate: () => new Date('2026-06-20T12:00:00.000Z') };
  let saveBehavior = async () => {};
  let bucketMetadataBehavior = async () => {};
  const objectData = new Map();

  const bucket = {
    name: 'test-project.appspot.com',
    getMetadata: () => bucketMetadataBehavior(),
    file(objectPath) {
      return {
        async save(buffer, options) {
          saveCalls.push({ objectPath, buffer, options });
          await saveBehavior();
          objectData.set(objectPath, Buffer.from(buffer));
        },
        async download() {
          return [objectData.get(objectPath) || Buffer.alloc(0)];
        },
        async delete() {
          objectData.delete(objectPath);
        },
        createWriteStream() {
          throw new Error('Small test media should use file.save(buffer)');
        }
      };
    }
  };
  const postsCollection = {
    where: () => ({ select: () => ({ get: async () => ({ docs: [] }) }) }),
    doc: (id) => ({ id })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      configDoc: () => ({}),
      getFirestore: () => ({
        batch: () => ({
          set: (ref, data) => committed.push({ ref, data }),
          commit: async () => {}
        })
      }),
      getFirebaseApp: () => ({}),
      getStorageBucket: () => bucket,
      Timestamp: { now: () => timestamp, fromDate: () => timestamp },
      FieldValue: { serverTimestamp: () => timestamp, increment: () => 1 }
    }
  };

  const storage = require('../src/storage');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-storage-test-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete require.cache[storagePath];
    delete require.cache[mapperPath];
    delete require.cache[firestorePath];
  });

  const imagePath = path.join(tempDir, 'small.jpg');
  const videoPath = path.join(tempDir, 'small.mp4');
  fs.writeFileSync(imagePath, Buffer.from('small-image'));
  fs.writeFileSync(videoPath, Buffer.from('small-mp4'));

  const [imagePost] = await storage.addUploadedPosts('owner', [{
    path: imagePath,
    size: fs.statSync(imagePath).size,
    filename: 'small.jpg',
    originalname: 'small.jpg',
    mimetype: 'image/jpeg'
  }]);
  const [videoPost] = await storage.addUploadedPosts('owner', [{
    path: videoPath,
    size: fs.statSync(videoPath).size,
    filename: 'small.mp4',
    originalname: 'small.mp4',
    mimetype: 'video/mp4'
  }]);

  assert.equal(saveCalls[0].options.resumable, false);
  assert.equal(saveCalls[0].options.validation, false);
  assert.equal(saveCalls[1].options.resumable, false);
  assert.equal(saveCalls[1].options.validation, false);
  assert.equal(imagePost.mediaSource, 'firebase_storage');
  assert.equal(videoPost.mediaType, 'video');
  assert.match(imagePost.mediaPath, /^https:\/\/firebasestorage\.googleapis\.com\//);
  assert.ok(imagePost.mediaStoragePath.startsWith('uploads/'));
  assert.ok(!imagePost.mediaPath.startsWith('/uploads/'));
  const restoredImagePost = require('../src/postsMapper').postFromDoc({
    id: committed[0].ref.id,
    data: () => committed[0].data
  });
  assert.equal(restoredImagePost.mediaPath, imagePost.mediaPath);
  assert.equal(restoredImagePost.mediaStoragePath, imagePost.mediaStoragePath);

  let retryAttempts = 0;
  saveBehavior = async () => {
    retryAttempts += 1;
    if (retryAttempts < 3) {
      const error = new Error('Premature close');
      error.code = 'ERR_STREAM_PREMATURE_CLOSE';
      throw error;
    }
  };
  await storage.addUploadedPosts('owner', [{
    path: imagePath,
    size: fs.statSync(imagePath).size,
    filename: 'retry.jpg',
    originalname: 'retry.jpg',
    mimetype: 'image/jpeg'
  }]);
  assert.equal(retryAttempts, 3);

  saveBehavior = async () => {
    const error = new Error('Premature close');
    error.code = 'ERR_STREAM_PREMATURE_CLOSE';
    throw error;
  };
  const [fallbackPost] = await storage.addUploadedPosts('owner', [{
    path: imagePath,
    size: fs.statSync(imagePath).size,
    filename: 'fallback.jpg',
    originalname: 'fallback.jpg',
    mimetype: 'image/jpeg'
  }], { publicMediaUrl: 'https://cdn.example.com/fallback.jpg' });
  assert.equal(fallbackPost.mediaSource, 'public_url');
  assert.equal(fallbackPost.storageFallback, true);
  assert.equal(fallbackPost.mediaPath, 'https://cdn.example.com/fallback.jpg');

  const callsBeforeUrlOnly = saveCalls.length;
  const [urlOnlyPost] = await storage.addUploadedPosts('owner', [], {
    publicMediaUrl: 'https://cdn.example.com/public-only.jpg'
  });
  assert.equal(saveCalls.length, callsBeforeUrlOnly);
  assert.equal(urlOnlyPost.mediaSource, 'public_url');
  assert.equal(committed.length, 5);

  saveBehavior = async () => {};
  bucketMetadataBehavior = async () => [{ name: bucket.name }];
  const health = await storage.checkStorageHealth({ writeTest: true });
  assert.equal(health.ok, true);
  assert.equal(health.adminInitialized, true);
  assert.equal(health.bucketAccessible, true);
  assert.deepEqual(health.writeTest, {
    requested: true,
    write: true,
    read: true,
    delete: true
  });

  bucketMetadataBehavior = async () => {
    const error = new Error('Forbidden');
    error.response = { status: 403 };
    throw error;
  };
  const deniedHealth = await storage.checkStorageHealth();
  assert.equal(deniedHealth.ok, false);
  assert.deepEqual(deniedHealth.error, {
    code: 'FIREBASE_BUCKET_NOT_ACCESSIBLE',
    message: 'Firebase Storage bucket is not accessible. Check the bucket name and service-account permissions.'
  });
});
