const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);
const ENABLE_INSTAGRAM = envFlag('ENABLE_INSTAGRAM', false);
const metaGraphVersion = process.env.META_GRAPH_VERSION || process.env.INSTAGRAM_GRAPH_VERSION || 'v24.0';
const firebasePrivateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n').trim() || '';
const requestedAiProvider = String(process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();
const aiProvider = ['gemini', 'openai', 'qwen'].includes(requestedAiProvider)
  ? requestedAiProvider
  : 'gemini';

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
  ENABLE_INSTAGRAM,
  appName: 'CHANTER AutoPoster',
  port,
  rootDir,
  // NOTE: the running app no longer reads these — Firestore is the source
  // of truth now. They're kept only so src/migrate-to-firestore.js can
  // find your old local data on its one-time run.
  dataDir: path.join(rootDir, 'data'),
  uploadsDir: path.join(rootDir, 'uploads'),
  postsFile: path.join(rootDir, 'data', 'posts.json'),
  settingsFile: path.join(rootDir, 'data', 'settings.json'),
  tiktokAuthFile: path.join(rootDir, 'data', 'tiktok_auth.json'),
  instagramAuthFile: path.join(rootDir, 'data', 'instagram_auth.json'),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  cronSecret: process.env.CRON_SECRET || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  adminSessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  adminSessionHours: Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 12)),
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  appTimeZone: process.env.APP_TIME_ZONE || process.env.TZ || 'UTC',

  // Placeholder identity until real auth exists (see src/auth.js). Every
  // Firestore post document is tagged with this userId today, so the
  // multi-user plumbing (queries, ownership checks, security rules) is
  // already in place and just needs a real value plugged in later.
  defaultUserId: process.env.APP_DEFAULT_USER_ID || 'owner',

  scheduler: {
    // How long a post is allowed to sit in "processing" before the
    // watchdog assumes the worker crashed and reclaims it.
    staleLockMinutes: Number(process.env.SCHEDULER_STALE_LOCK_MINUTES || 20),
    // After this many claim attempts, stop retrying and mark it failed
    // instead of looping forever on a poison-pill post.
    maxClaimAttempts: Number(
      process.env.SCHEDULER_MAX_CLAIM_ATTEMPTS || process.env.SCHEDULER_MAX_ATTEMPTS || 5
    )
  },

  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || '',
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL || '',
    privateKey: firebasePrivateKey
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    uploadAttempts: Number(process.env.CLOUDINARY_UPLOAD_ATTEMPTS || 3),
    retryBaseMs: Number(process.env.CLOUDINARY_RETRY_BASE_MS || 500),
    folder: process.env.CLOUDINARY_FOLDER || 'chanter-auto-poster/uploads'
  },

  autoCaption: {
    aiProvider,
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    geminiBaseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
    geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    openAiApiKey: process.env.OPENAI_API_KEY || '',
    openAiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    captionModel: process.env.OPENAI_CAPTION_MODEL || 'gpt-5.5',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe',
    qwenApiKey: process.env.QWEN_API_KEY || '',
    qwenBaseUrl: (process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, ''),
    qwenModel: process.env.QWEN_MODEL || 'qwen-vl-max',
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
    ffmpegTimeoutMs: Math.max(10_000, Number(process.env.AUTO_CAPTION_FFMPEG_TIMEOUT_MS || 120_000)),
    requestTimeoutMs: Math.max(10_000, Number(process.env.AUTO_CAPTION_REQUEST_TIMEOUT_MS || 120_000)),
    maxAudioSeconds: Math.max(0, Number(process.env.AUTO_CAPTION_MAX_AUDIO_SECONDS || 600)),
    maxTranscriptChars: Math.max(1_000, Number(process.env.AUTO_CAPTION_MAX_TRANSCRIPT_CHARS || 12_000))
  },

  autoMusic: {
    libraryDir: path.join(rootDir, 'music-library'),
    catalogPath: path.join(rootDir, 'music-library', 'musicCatalog.json'),
    backgroundVolume: Math.min(0.25, Math.max(0.15, Number(process.env.AUTO_MUSIC_BACKGROUND_VOLUME || 0.2))),
    fadeSeconds: Math.max(0.1, Number(process.env.AUTO_MUSIC_FADE_SECONDS || 0.8)),
    renderTimeoutMs: Math.max(30_000, Number(process.env.AUTO_MUSIC_RENDER_TIMEOUT_MS || 10 * 60_000)),
    tokenTtlMs: Math.max(60_000, Number(process.env.AUTO_MUSIC_TOKEN_TTL_MINUTES || 30) * 60_000),
    tokenSecret:
      process.env.AUTO_MUSIC_TOKEN_SECRET ||
      process.env.ADMIN_SESSION_SECRET ||
      process.env.ADMIN_PASSWORD ||
      ''
  },

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
    privacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY',
    requestTimeoutMs: Number(process.env.TIKTOK_REQUEST_TIMEOUT_MS || 30_000),
    uploadTimeoutMs: Number(process.env.TIKTOK_UPLOAD_TIMEOUT_MS || 15 * 60_000)
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

/**
 * Validates that critical secrets are present at startup.
 * Called from server.js after config is loaded.
 * Returns an array of warning messages for missing optional config;
 * throws for truly required config (handled by auth.js and firestore.js).
 */
function validateSecrets() {
  const warnings = [];

  if (!cronSecret) {
    warnings.push('CRON_SECRET is not set — /api/cron/tick will reject all external requests');
  }
  if (!adminSessionSecret) {
    warnings.push('ADMIN_SESSION_SECRET is not set — deriving from ADMIN_PASSWORD (less secure, set a separate secret)');
  }
  if (!firebase.projectId) {
    warnings.push('FIREBASE_PROJECT_ID is not set — Firestore will fail on first request');
  }
  if (!cloudinary.cloudName) {
    warnings.push('CLOUDINARY_CLOUD_NAME is not set — media uploads will fail');
  }
  if (!tiktok.clientKey || !tiktok.clientSecret) {
    warnings.push('TIKTOK_CLIENT_KEY/SECRET not set — TikTok OAuth will not work');
  }

  return warnings;
}

// Expose nested objects for validateSecrets
const { cronSecret, adminSessionSecret, firebase, cloudinary, tiktok } = module.exports;

module.exports.validateSecrets = validateSecrets;
