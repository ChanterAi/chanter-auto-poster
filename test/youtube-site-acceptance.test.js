'use strict';

// Phase 14 site acceptance for the configured provider: the real page must
// truthfully represent every YouTube state — configured-but-disconnected,
// connected (@chanterCy), queued/awaiting approval as Private, and uploaded
// private with the stored video ID — without hard-coded account data and
// without leaking a single credential.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'CANARY-SITE-CLIENT-SECRET-x1y2z3';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const autoCaption = require('../src/autoCaption');
const autoMusic = require('../src/autoMusic');
const { attachUser, csrfOriginCheck, createAdminSessionToken, ADMIN_SESSION_COOKIE } = require('../src/auth');
const config = require('../src/config');

const CANARY_ENVELOPE_CT = 'CANARY-ENVELOPE-CIPHERTEXT';
const OWNER = config.defaultUserId;

const youtubeAccounts = [];
const posts = [];

storage.getTikTokAccounts = async () => [];
storage.getTikTokAccount = async () => null;
storage.getTikTokAuth = async () => ({ connected: false, access_token: '', open_id: '' });
storage.getYouTubeAccounts = async () => youtubeAccounts;
storage.getYouTubeAccount = async (userId, accountId) =>
  youtubeAccounts.find((account) => account.accountId === accountId && account.userId === userId) || null;
storage.getPosts = async () => posts;
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getDashboardJobs = async () => posts;
tiktok.getTikTokAuthStatus = async () => ({ connected: false });
tiktok.queryCreatorInfo = async () => ({ privacy_level_options: [] });
instagram.getInstagramAuthStatus = async () => ({ connected: false, state: 'disconnected', label: 'Disconnected' });
instagram.getInstagramHealth = async () => ({ configured: false, canPublish: false, missing: [] });
autoCaption.hasConfiguredCaptionProvider = () => false;
autoMusic.isAutoMusicConfigured = () => false;

const routes = require('../src/routes');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use(csrfOriginCheck);
app.use('/', routes);

let server;
let baseUrl;
const adminCookie = `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken()}`;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function renderPage() {
  const response = await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  return response.text();
}

test('configured but disconnected: a real Connect YouTube control, no fake channel data', async () => {
  const html = await renderPage();
  assert.match(html, /aria-label="YouTube provider"/);
  assert.match(html, /Not connected/);
  assert.match(html, /href="\/connect\/youtube"/);
  assert.match(html, /Connect YouTube/);
  assert.doesNotMatch(html, /@chanterCy/, 'no channel identity is invented before a real connection');
  // The "implemented but not configured" copy must not appear on a
  // configured deployment (the Instagram banner has its own unrelated
  // "Not configured" text, so the match is scoped to the YouTube wording).
  assert.doesNotMatch(html, /implemented but not configured/);
});

test('connected: safe channel identity, readiness, reauthorization state, and disconnect control', async () => {
  youtubeAccounts.push({
    accountId: 'UC-chanter',
    id: 'UC-chanter',
    userId: OWNER,
    provider: 'youtube',
    platform: 'youtube',
    channelId: 'UC-chanter',
    username: 'chanterCy',
    displayName: 'chanterCy',
    avatarUrl: '',
    connected: true,
    tokenPresent: true,
    refreshTokenPresent: true,
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    grantedScopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    reauthorizationRequired: false,
    connectedAt: '2026-07-11T00:00:00.000Z',
    credential: { v: 1, alg: 'aes-256-gcm', kv: 1, iv: 'iv', ct: CANARY_ENVELOPE_CT, tag: 'tag' }
  });

  const html = await renderPage();
  assert.match(html, /@chanterCy/);
  assert.match(html, /Connected/);
  assert.match(html, /Ready to publish \(private uploads only\)/);
  assert.match(html, /action="\/disconnect\/youtube"/);
  // Provider target selection appears once a channel is connected.
  assert.match(html, /Target Provider/);
  assert.match(html, /name="youtubeTitle"/);
  assert.match(html, /Private \(locked\)/);
  assert.match(html, /name="youtubeChannelId"/);
  // Custody: the encrypted envelope never reaches the page.
  assert.doesNotMatch(html, new RegExp(CANARY_ENVELOPE_CT));
  assert.doesNotMatch(html, /CANARY-SITE-CLIENT-SECRET/);
});

test('reauthorization required is displayed truthfully with a real reauthorize control', async () => {
  youtubeAccounts[0].reauthorizationRequired = true;
  const html = await renderPage();
  assert.match(html, /Reauthorization required/);
  assert.match(html, /reauthorize=UC-chanter/);
  youtubeAccounts[0].reauthorizationRequired = false;
});

test('queue states: awaiting approval as Private, then uploaded private with the video ID', async () => {
  posts.push({
    id: 'yt-post-1',
    userId: OWNER,
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    username: 'chanterCy',
    connectedAccountId: 'youtube:UC-chanter',
    originalName: 'teaser.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/teaser.mp4',
    status: 'scheduled',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    approved: false,
    approvalState: 'unapproved',
    providerMetadata: { youtube: { title: 'Launch teaser', description: '', privacyStatus: 'private', notifySubscribers: false } },
    providerStatus: '',
    publishId: '',
    history: []
  });

  let html = await renderPage();
  assert.match(html, /YouTube · Private/);
  assert.match(html, /Approval required/);
  assert.match(html, /YouTube title: Launch teaser/);
  assert.match(html, /Privacy: Private \(locked\)/);
  assert.match(html, /Notifications: Disabled/);

  // After the supervised upload: posted + video ID + truthful private state.
  posts[0].status = 'posted';
  posts[0].approved = true;
  posts[0].approvalState = 'approved';
  posts[0].publishId = 'yt-video-777';
  posts[0].providerStatus = 'uploaded_private';
  posts[0].lastResult = {
    ok: true,
    mode: 'api',
    response: { video_id: 'yt-video-777', privacy_status: 'private', upload_status: 'uploaded' },
    completedAt: new Date().toISOString()
  };

  html = await renderPage();
  assert.match(html, /Uploaded private/);
  assert.match(html, /Video ID: yt-video-777/);
  assert.match(html, /uploaded_private/);
  assert.match(html, /Subscriber notifications/);
  // Upload success is not presented as processing completion.
  assert.match(html, /does not mean processing is complete/i);
});

test('outcome_unknown renders as a reconciliation requirement, never success or clean failure', async () => {
  posts[0].status = 'outcome_unknown';
  posts[0].publishId = '';
  posts[0].providerStatus = 'provider_reconciliation_required';
  posts[0].lastResult = {
    ok: false,
    mode: 'api',
    outcomeUnknown: true,
    code: 'PROVIDER_RECONCILIATION_REQUIRED',
    reason: 'YouTube upload did not return a definitive result. A video may exist; reconcile before retrying.'
  };
  const html = await renderPage();
  assert.match(html, /Outcome unknown/);
  assert.match(html, /reconcile/i);
  assert.match(html, /duplicate upload/i);
});
