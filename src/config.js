const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const metaGraphVersion = process.env.META_GRAPH_VERSION || process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';

function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function envInverseFlag(name, fallback = true) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
  appName: 'CHANTER Auto Poster',
  port,
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  uploadsDir: path.join(rootDir, 'uploads'),
  postsFile: path.join(rootDir, 'data', 'posts.json'),
  settingsFile: path.join(rootDir, 'data', 'settings.json'),
  tiktokAuthFile: path.join(rootDir, 'data', 'tiktok_auth.json'),
  instagramAuthFile: path.join(rootDir, 'data', 'instagram_auth.json'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  cronSecret: process.env.CRON_SECRET || '',
  tiktok: {
    clientKey: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
    redirectUri:
      process.env.TIKTOK_REDIRECT_URI || `http://localhost:${port}/auth/tiktok/callback`,
    scopes: process.env.TIKTOK_SCOPES || 'user.info.basic,video.publish',
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    contentPostInitUrl:
      process.env.TIKTOK_CONTENT_POST_INIT_URL ||
      'https://open.tiktokapis.com/v2/post/publish/content/init/',
    privacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY'
  },
  instagram: {
    appId: process.env.META_APP_ID || process.env.INSTAGRAM_APP_ID || '',
    appSecret: process.env.META_APP_SECRET || process.env.INSTAGRAM_APP_SECRET || '',
    redirectUri:
      process.env.META_REDIRECT_URI ||
      process.env.INSTAGRAM_REDIRECT_URI ||
      `http://localhost:${port}/auth/instagram/callback`,
    scopes:
      process.env.INSTAGRAM_SCOPES ||
      'instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement',
    graphVersion: metaGraphVersion,
    authUrl:
      process.env.META_AUTH_URL ||
      `https://www.facebook.com/${metaGraphVersion}/dialog/oauth`,
    graphBaseUrl: (process.env.META_GRAPH_BASE_URL || 'https://graph.facebook.com').replace(/\/+$/, ''),
    accessToken: process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '',
    instagramBusinessAccountId: process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || '',
    facebookPageId: process.env.FACEBOOK_PAGE_ID || '',
    testMode: envInverseFlag('INSTAGRAM_TEST_MODE', true),
    publishEnabled: envFlag('INSTAGRAM_PUBLISH_ENABLED', false)
  }
};
