'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');
const storage = require('../src/storage');
const instagram = require('../src/instagram');

const REQUIRED_KEYS = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'INSTAGRAM_BUSINESS_ACCOUNT_ID',
  'FACEBOOK_PAGE_ID'
];

test('Instagram configuration is optional for startup and dry-run but required before live API calls', async (t) => {
  const originalConfig = { ...config.instagram };
  const originalGetInstagramAuth = storage.getInstagramAuth;
  const originalFetch = global.fetch;
  let storedAuth = {};
  let fetchCalls = 0;

  storage.getInstagramAuth = async () => storedAuth;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error('Instagram Graph API should not be called in this test');
  };
  t.after(() => {
    Object.assign(config.instagram, originalConfig);
    storage.getInstagramAuth = originalGetInstagramAuth;
    global.fetch = originalFetch;
  });

  await t.test('reports missing keys and completes a story dry-run without network access', async () => {
    Object.assign(config.instagram, {
      appId: '',
      appSecret: '',
      accessToken: '',
      instagramBusinessAccountId: '',
      facebookPageId: '',
      testMode: true,
      publishEnabled: false
    });
    storedAuth = {};
    fetchCalls = 0;

    assert.deepEqual(await instagram.getInstagramHealth(), {
      success: true,
      platform: 'instagram',
      configured: false,
      canPublish: false,
      mode: 'dry-run',
      missing: REQUIRED_KEYS,
      message: 'Instagram publishing is not configured yet. The app can run in dry-run mode.'
    });

    const result = await instagram.publishInstagramMedia({
      publishType: 'story',
      mediaUrl: 'http://localhost:3000/uploads/story.mp4',
      caption: 'Local story preview'
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'dry-run');
    assert.equal(result.published, false);
    assert.equal(result.response.apiCalled, false);
    assert.equal(result.response.publishKind, 'story');
    assert.equal(fetchCalls, 0);
  });

  await t.test('blocks live publishing with the exact safe missing-key contract', async () => {
    Object.assign(config.instagram, {
      appId: '',
      appSecret: '',
      accessToken: '',
      instagramBusinessAccountId: '',
      facebookPageId: '',
      testMode: false,
      publishEnabled: true
    });
    storedAuth = {};
    fetchCalls = 0;

    const result = await instagram.publishInstagramMedia({
      publishType: 'story',
      mediaUrl: 'https://cdn.example.com/story.mp4'
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INSTAGRAM_NOT_CONFIGURED');
    assert.equal(
      result.message,
      'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.'
    );
    assert.deepEqual(result.missing, REQUIRED_KEYS);
    assert.equal(fetchCalls, 0);
  });

  await t.test('reports live capability only when all required configuration exists', async () => {
    Object.assign(config.instagram, {
      appId: 'meta-app-id',
      appSecret: 'meta-app-secret',
      accessToken: '',
      instagramBusinessAccountId: '',
      facebookPageId: '',
      testMode: false,
      publishEnabled: true
    });
    storedAuth = {
      access_token: 'stored-access-token',
      instagram_business_account_id: 'instagram-business-id',
      facebook_page_id: 'facebook-page-id',
      expires_at: null
    };

    assert.deepEqual(await instagram.getInstagramHealth(), {
      success: true,
      platform: 'instagram',
      configured: true,
      canPublish: true,
      mode: 'live',
      missing: [],
      message: 'Instagram publishing is configured.'
    });
  });
});
