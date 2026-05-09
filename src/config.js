const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);

module.exports = {
  appName: 'CHANTER Auto Poster',
  port,
  rootDir,
  dataDir: path.join(rootDir, 'data'),
  uploadsDir: path.join(rootDir, 'uploads'),
  postsFile: path.join(rootDir, 'data', 'posts.json'),
  settingsFile: path.join(rootDir, 'data', 'settings.json'),
  tiktokAuthFile: path.join(rootDir, 'data', 'tiktok_auth.json'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
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
  }
};
