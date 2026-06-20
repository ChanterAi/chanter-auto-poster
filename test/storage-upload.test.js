'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('persists Cloudinary image/video URLs and keeps public URL fallback', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const committed = [];
  const uploadCalls = [];
  const destroyed = [];
  const timestamp = { toDate: () => new Date('2026-06-20T12:00:00.000Z') };
  let uploadBehavior = async (file) => ({
    mediaUrl: file.mimetype.startsWith('video/')
      ? 'https://res.cloudinary.com/test/video/upload/video.mp4'
      : 'https://res.cloudinary.com/test/image/upload/image.jpg',
    publicId: file.mimetype.startsWith('video/') ? 'uploads/video' : 'uploads/image',
    resourceType: file.mimetype.startsWith('video/') ? 'video' : 'image'
  });

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async (file) => {
        uploadCalls.push(file);
        return uploadBehavior(file);
      },
      destroyMediaAsset: async (publicId, resourceType) => destroyed.push({ publicId, resourceType }),
      checkCloudinaryHealth: async ({ writeTest }) => ({
        ok: true,
        provider: 'cloudinary',
        writeTest: { requested: writeTest }
      })
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
      Timestamp: { now: () => timestamp, fromDate: () => timestamp },
      FieldValue: { serverTimestamp: () => timestamp, increment: () => 1 }
    }
  };

  const storage = require('../src/storage');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-cloudinary-test-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    delete require.cache[storagePath];
    delete require.cache[mapperPath];
    delete require.cache[firestorePath];
    delete require.cache[cloudinaryPath];
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

  assert.equal(uploadCalls.length, 2);
  assert.equal(imagePost.mediaSource, 'cloudinary');
  assert.equal(imagePost.mediaUrl, 'https://res.cloudinary.com/test/image/upload/image.jpg');
  assert.equal(imagePost.mediaPath, imagePost.mediaUrl);
  assert.equal(imagePost.cloudinaryPublicId, 'uploads/image');
  assert.equal(imagePost.mediaStoragePath, '');
  assert.equal(videoPost.mediaType, 'video');
  assert.equal(videoPost.mediaUrl, 'https://res.cloudinary.com/test/video/upload/video.mp4');
  assert.equal(videoPost.cloudinaryResourceType, 'video');

  const restoredImagePost = require('../src/postsMapper').postFromDoc({
    id: committed[0].ref.id,
    data: () => committed[0].data
  });
  assert.equal(restoredImagePost.mediaUrl, imagePost.mediaUrl);
  assert.equal(restoredImagePost.cloudinaryPublicId, imagePost.cloudinaryPublicId);

  uploadBehavior = async () => {
    const error = new Error('Cloudinary unavailable');
    error.code = 'CLOUDINARY_UPLOAD_FAILED';
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
  assert.equal(fallbackPost.mediaUrl, 'https://cdn.example.com/fallback.jpg');

  const callsBeforeUrlOnly = uploadCalls.length;
  const [urlOnlyPost] = await storage.addUploadedPosts('owner', [], {
    publicMediaUrl: 'https://cdn.example.com/public-only.jpg'
  });
  assert.equal(uploadCalls.length, callsBeforeUrlOnly);
  assert.equal(urlOnlyPost.mediaSource, 'public_url');
  assert.equal(committed.length, 4);

  const health = await storage.checkMediaStorageHealth({ writeTest: true });
  assert.deepEqual(health, {
    ok: true,
    provider: 'cloudinary',
    writeTest: { requested: true }
  });
  assert.deepEqual(destroyed, []);
});
