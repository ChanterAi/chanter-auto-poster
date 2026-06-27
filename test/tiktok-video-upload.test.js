'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const test = require('node:test');

const VIDEO_SIZE = 93_751_321;
const EXPECTED_CHUNK_SIZE = 46_875_660;

test('calculates valid TikTok chunks and ranges for a 93.7 MB video', () => {
  const {
    buildVideoPayload,
    calculateTikTokChunks,
    getTikTokChunkRange
  } = require('../src/tiktok');

  assert.deepEqual(calculateTikTokChunks(VIDEO_SIZE), {
    chunkSize: EXPECTED_CHUNK_SIZE,
    totalChunkCount: 2
  });
  assert.deepEqual(calculateTikTokChunks(64 * 1024 * 1024), {
    chunkSize: 64 * 1024 * 1024,
    totalChunkCount: 1
  });
  assert.throws(() => calculateTikTokChunks(0), /Invalid video size/);
  assert.throws(() => calculateTikTokChunks(Number.NaN), /Invalid video size/);
  assert.deepEqual(getTikTokChunkRange(0, EXPECTED_CHUNK_SIZE, 2, VIDEO_SIZE), {
    start: 0,
    end: 46_875_659,
    contentLength: 46_875_660,
    contentRange: 'bytes 0-46875659/93751321'
  });
  assert.deepEqual(getTikTokChunkRange(1, EXPECTED_CHUNK_SIZE, 2, VIDEO_SIZE), {
    start: 46_875_660,
    end: 93_751_320,
    contentLength: 46_875_661,
    contentRange: 'bytes 46875660-93751320/93751321'
  });

  const payload = buildVideoPayload({}, VIDEO_SIZE);
  assert.deepEqual(payload.source_info, {
    source: 'FILE_UPLOAD',
    video_size: VIDEO_SIZE,
    chunk_size: EXPECTED_CHUNK_SIZE,
    total_chunk_count: 2
  });
});

test('uploads a 93.7 MB local video with two sequential PUT requests', async (t) => {
  const storagePath = require.resolve('../src/storage');
  const tiktokPath = require.resolve('../src/tiktok');
  const originalStorageCache = require.cache[storagePath];
  const originalFetch = global.fetch;
  const originalStatSync = fs.statSync;
  const originalCreateReadStream = fs.createReadStream;
  const originalConsoleLog = console.log;
  const requests = [];
  const fileRanges = [];

  delete require.cache[tiktokPath];
  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: {
      getTikTokAccount: async () => ({
        accountId: 'account-a',
        open_id: 'account-a',
        connected: true,
        access_token: 'test-token',
        expires_at: null
      })
    }
  };

  fs.statSync = () => ({ isFile: () => true, size: VIDEO_SIZE });
  fs.createReadStream = (videoPath, options) => {
    fileRanges.push({ videoPath, ...options });
    return Buffer.alloc(0);
  };
  console.log = () => {};
  global.fetch = async (url, options = {}) => {
    const request = { url: String(url), options };
    requests.push(request);

    if (request.url.includes('creator_info')) {
      return new Response(JSON.stringify({
        data: { privacy_level_options: ['SELF_ONLY'] },
        error: { code: 'ok' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    if (request.url.includes('/video/init/')) {
      return new Response(JSON.stringify({
        data: { publish_id: 'publish-id', upload_url: 'https://upload.example.com/video' },
        error: { code: 'ok' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(null, { status: 200 });
  };

  t.after(() => {
    global.fetch = originalFetch;
    fs.statSync = originalStatSync;
    fs.createReadStream = originalCreateReadStream;
    console.log = originalConsoleLog;
    delete require.cache[tiktokPath];
    if (originalStorageCache) require.cache[storagePath] = originalStorageCache;
    else delete require.cache[storagePath];
  });

  const { publishPhotoPost } = require('../src/tiktok');
  const result = await publishPhotoPost({
    userId: 'owner',
    accountId: 'account-a',
    tiktokOpenId: 'account-a',
    mediaType: 'video',
    fileName: 'large-video.mp4',
    privacyLevel: 'SELF_ONLY'
  });

  assert.equal(result.ok, true);

  const initRequest = requests.find((request) => request.url.includes('/video/init/'));
  assert.deepEqual(JSON.parse(initRequest.options.body).source_info, {
    source: 'FILE_UPLOAD',
    video_size: VIDEO_SIZE,
    chunk_size: EXPECTED_CHUNK_SIZE,
    total_chunk_count: 2
  });

  const uploadRequests = requests.filter((request) => request.url === 'https://upload.example.com/video');
  assert.equal(uploadRequests.length, 2);
  assert.deepEqual(uploadRequests.map((request) => request.options.headers), [
    {
      'Content-Type': 'video/mp4',
      'Content-Length': '46875660',
      'Content-Range': 'bytes 0-46875659/93751321'
    },
    {
      'Content-Type': 'video/mp4',
      'Content-Length': '46875661',
      'Content-Range': 'bytes 46875660-93751320/93751321'
    }
  ]);
  assert.deepEqual(fileRanges.map(({ start, end }) => ({ start, end })), [
    { start: 0, end: 46_875_659 },
    { start: 46_875_660, end: 93_751_320 }
  ]);
});
