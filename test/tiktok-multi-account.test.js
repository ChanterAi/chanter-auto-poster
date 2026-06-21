'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('publishes each job with the token belonging to its TikTok account', async (t) => {
  const storagePath = require.resolve('../src/storage');
  const tiktokPath = require.resolve('../src/tiktok');
  delete require.cache[tiktokPath];

  const accounts = {
    'account-a': {
      accountId: 'account-a', open_id: 'account-a', connected: true,
      access_token: 'token-a', refresh_token: 'refresh-a', expires_at: null
    },
    'account-b': {
      accountId: 'account-b', open_id: 'account-b', connected: true,
      access_token: 'token-b', refresh_token: 'refresh-b', expires_at: null
    }
  };
  const requestedTokens = [];

  require.cache[storagePath] = {
    id: storagePath,
    filename: storagePath,
    loaded: true,
    exports: {
      getTikTokAccount: async (userId, accountId) => accounts[accountId] || null,
      saveTikTokAccount: async (userId, auth) => auth
    }
  };

  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    requestedTokens.push({ url: String(url), authorization: options.headers.Authorization });
    if (String(url).includes('creator_info')) {
      return new Response(JSON.stringify({
        data: { creator_username: 'creator', privacy_level_options: ['SELF_ONLY'] },
        error: { code: 'ok' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: { publish_id: 'publish-id' },
      error: { code: 'ok' }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  t.after(() => {
    global.fetch = originalFetch;
    delete require.cache[tiktokPath];
    delete require.cache[storagePath];
  });

  const tiktok = require('../src/tiktok');
  const basePost = {
    userId: 'owner', platform: 'tiktok', mediaType: 'photo',
    mediaUrl: 'https://cdn.example.com/post.jpg', privacyLevel: 'SELF_ONLY'
  };
  const resultA = await tiktok.publishPhotoPost({
    ...basePost, accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a'
  });
  const resultB = await tiktok.publishPhotoPost({
    ...basePost, accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b'
  });

  assert.equal(resultA.ok, true);
  assert.equal(resultB.ok, true);
  assert.deepEqual(requestedTokens.map((request) => request.authorization), [
    'Bearer token-a', 'Bearer token-a', 'Bearer token-b', 'Bearer token-b'
  ]);

  const requestsBeforeLegacy = requestedTokens.length;
  const legacyResult = await tiktok.publishPhotoPost({ ...basePost, accountId: 'legacy' });
  assert.equal(legacyResult.ok, false);
  assert.match(legacyResult.reason, /unassigned/i);
  assert.equal(requestedTokens.length, requestsBeforeLegacy);
});
