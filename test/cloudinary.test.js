'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('uploads through the server SDK with auto resource type, retries, and checks health', async (t) => {
  process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
  process.env.CLOUDINARY_API_KEY = 'test-key';
  process.env.CLOUDINARY_API_SECRET = 'test-secret';
  process.env.CLOUDINARY_UPLOAD_ATTEMPTS = '3';
  process.env.CLOUDINARY_RETRY_BASE_MS = '100';

  const configPath = require.resolve('../src/config');
  const modulePath = require.resolve('../src/cloudinary');
  delete require.cache[configPath];
  delete require.cache[modulePath];

  const sdk = require('cloudinary').v2;
  const originals = {
    upload: sdk.uploader.upload,
    destroy: sdk.uploader.destroy,
    ping: sdk.api.ping,
    resource: sdk.api.resource
  };
  const uploadCalls = [];
  const destroyCalls = [];
  let uploadBehavior = async (source, options) => ({
    secure_url: source.endsWith('.mp4')
      ? 'https://res.cloudinary.com/test/video/upload/video.mp4'
      : 'https://res.cloudinary.com/test/image/upload/image.jpg',
    public_id: source.endsWith('.mp4') ? 'uploads/video' : 'uploads/image',
    resource_type: source.endsWith('.mp4') ? 'video' : 'image',
    bytes: 10
  });

  sdk.uploader.upload = async (source, options) => {
    uploadCalls.push({ source, options });
    return uploadBehavior(source, options);
  };
  sdk.uploader.destroy = async (publicId, options) => {
    destroyCalls.push({ publicId, options });
    return { result: 'ok' };
  };
  sdk.api.ping = async () => ({ status: 'ok' });
  sdk.api.resource = async (publicId) => ({ public_id: publicId });

  const cloudinary = require('../src/cloudinary');
  t.after(() => {
    sdk.uploader.upload = originals.upload;
    sdk.uploader.destroy = originals.destroy;
    sdk.api.ping = originals.ping;
    sdk.api.resource = originals.resource;
    delete require.cache[configPath];
    delete require.cache[modulePath];
  });

  const image = await cloudinary.uploadMediaFile({
    path: 'small.jpg',
    mimetype: 'image/jpeg',
    size: 10
  });
  const video = await cloudinary.uploadMediaFile({
    path: 'small.mp4',
    mimetype: 'video/mp4',
    size: 10
  });

  assert.equal(uploadCalls[0].options.resource_type, 'auto');
  assert.equal(uploadCalls[1].options.resource_type, 'auto');
  assert.equal('api_secret' in uploadCalls[0].options, false);
  assert.equal(image.resourceType, 'image');
  assert.equal(video.resourceType, 'video');
  assert.match(image.mediaUrl, /^https:\/\/res\.cloudinary\.com\//);

  let retryAttempts = 0;
  uploadBehavior = async () => {
    retryAttempts += 1;
    if (retryAttempts < 3) {
      const error = new Error('Connection reset');
      error.code = 'ECONNRESET';
      throw error;
    }
    return {
      secure_url: 'https://res.cloudinary.com/test/image/upload/retry.jpg',
      public_id: 'uploads/retry',
      resource_type: 'image'
    };
  };
  await cloudinary.uploadMediaFile({ path: 'retry.jpg', mimetype: 'image/jpeg', size: 10 });
  assert.equal(retryAttempts, 3);

  uploadBehavior = async (source) => ({
    secure_url: 'https://res.cloudinary.com/test/image/upload/health.gif',
    public_id: 'health/check',
    resource_type: 'image',
    bytes: String(source).length
  });
  const health = await cloudinary.checkCloudinaryHealth({ writeTest: true });
  assert.equal(health.ok, true);
  assert.equal(health.provider, 'cloudinary');
  assert.deepEqual(health.writeTest, {
    requested: true,
    write: true,
    read: true,
    delete: true
  });

  await cloudinary.destroyMediaAsset('uploads/video', 'video');
  assert.equal(destroyCalls.at(-1).publicId, 'uploads/video');
  assert.equal(destroyCalls.at(-1).options.resource_type, 'video');
});
