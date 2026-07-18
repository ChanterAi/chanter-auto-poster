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
const TIKTOK_ACCOUNT_ID = 'tt-site-account';

const youtubeAccounts = [];
const tiktokAccounts = [{
  accountId: TIKTOK_ACCOUNT_ID,
  open_id: TIKTOK_ACCOUNT_ID,
  userId: OWNER,
  provider: 'tiktok',
  platform: 'tiktok',
  username: 'tiktok_only_target',
  displayName: 'TikTok only target',
  connected: true,
  access_token: 'CANARY-TIKTOK-ACCESS',
  refresh_token: 'CANARY-TIKTOK-REFRESH',
  scope: 'user.info.basic,video.publish'
}];
const posts = [];

storage.getTikTokAccounts = async () => tiktokAccounts;
storage.getTikTokAccount = async (userId, accountId) =>
  tiktokAccounts.find((account) => account.accountId === accountId && account.userId === userId) || null;
storage.getTikTokAuth = async () => ({ connected: true, access_token: 'CANARY-TIKTOK-ACCESS', open_id: TIKTOK_ACCOUNT_ID });
storage.getYouTubeAccounts = async () => youtubeAccounts;
storage.getYouTubeAccount = async (userId, accountId) =>
  youtubeAccounts.find((account) => account.accountId === accountId && account.userId === userId) || null;
storage.getPosts = async () => posts;
storage.getPost = async (userId, id, accountId) => {
  const post = posts.find((item) => item.id === id) || null;
  if (!post || (accountId && post.accountId !== accountId)) return null;
  return post;
};
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getDashboardJobs = async () => posts;
tiktok.getTikTokAuthStatus = async () => ({ connected: true, accountId: TIKTOK_ACCOUNT_ID });
tiktok.queryCreatorInfo = async () => ({ privacy_level_options: [] });
instagram.getInstagramAuthStatus = async () => ({ connected: false, state: 'disconnected', label: 'Disconnected' });
instagram.getInstagramHealth = async () => ({ configured: false, canPublish: false, missing: [] });
autoCaption.hasConfiguredCaptionProvider = () => false;
autoMusic.isAutoMusicConfigured = () => false;

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
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
  const youtubeTargetInputs = html.match(/<input\s+type="radio"\s+name="youtubeChannelId"[\s\S]*?\/>/g) || [];
  assert.equal(youtubeTargetInputs.length, 1, 'one ready YouTube target is rendered once');
  assert.match(youtubeTargetInputs[0], /value="UC-chanter"/);
  assert.match(youtubeTargetInputs[0], /data-channel-provider="youtube"/);
  assert.match(youtubeTargetInputs[0], /checked/, 'the sole YouTube target is selected automatically');
  assert.doesNotMatch(youtubeTargetInputs[0], new RegExp(TIKTOK_ACCOUNT_ID), 'YouTube targets never contain TikTok identities');
  assert.match(html, /data-provider-targets="youtube" hidden/);
  assert.match(html, /data-provider-targets="tiktok"/);
  assert.match(html, new RegExp(`name="targetChannels"[\\s\\S]*?value="${TIKTOK_ACCOUNT_ID}"`));
  assert.match(html, /\[data-provider-targets\]\[hidden\][^}]*display:\s*none\s*!important/);
  // Custody: the encrypted envelope never reaches the page.
  assert.doesNotMatch(html, new RegExp(CANARY_ENVELOPE_CT));
  assert.doesNotMatch(html, /CANARY-SITE-CLIENT-SECRET/);
});

test('multiple YouTube accounts require explicit selection and exclude non-ready channels', async () => {
  youtubeAccounts.push(
    {
      ...youtubeAccounts[0],
      accountId: 'UC-second',
      id: 'UC-second',
      channelId: 'UC-second',
      username: 'secondChannel',
      displayName: 'Second Channel'
    },
    {
      ...youtubeAccounts[0],
      accountId: 'UC-not-ready',
      id: 'UC-not-ready',
      channelId: 'UC-not-ready',
      username: 'blockedChannel',
      displayName: 'Blocked Channel',
      grantedScopes: 'https://www.googleapis.com/auth/youtube.readonly',
      scope: 'https://www.googleapis.com/auth/youtube.readonly'
    }
  );

  const html = await renderPage();
  const youtubeTargetInputs = html.match(/<input\s+type="radio"\s+name="youtubeChannelId"[\s\S]*?\/>/g) || [];
  assert.equal(youtubeTargetInputs.length, 2, 'only publishing-ready YouTube accounts are targets');
  youtubeTargetInputs.forEach((input) => assert.doesNotMatch(input, /checked/, 'multiple targets start unselected'));
  assert.match(youtubeTargetInputs.map(String).join('\n'), /value="UC-chanter"/);
  assert.match(youtubeTargetInputs.map(String).join('\n'), /value="UC-second"/);
  assert.doesNotMatch(youtubeTargetInputs.map(String).join('\n'), /UC-not-ready/);

  youtubeAccounts.splice(1);
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

test('a YouTube-only workspace can manage its queue without a TikTok connection', async (t) => {
  tiktokAccounts.splice(0);
  const post = posts[0];
  Object.assign(post, {
    status: 'scheduled',
    approved: false,
    approvedAt: null,
    approvalState: 'unapproved',
    providerStatus: '',
    lastResult: null
  });

  const approvalCalls = [];
  storage.approvePost = async (userId, postId, meta, accountId) => {
    approvalCalls.push({ userId, postId, meta, accountId });
    Object.assign(post, { approved: true, approvedAt: new Date().toISOString(), approvalState: 'approved' });
    return post;
  };
  const approve = await fetch(`${baseUrl}/posts/${post.id}/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie, Origin: baseUrl },
    body: new URLSearchParams({ accountId: post.accountId })
  });
  assert.equal(approve.status, 302);
  assert.equal(approvalCalls.length, 1);
  assert.equal(approvalCalls[0].accountId, 'UC-chanter');

  const scheduler = require('../src/scheduler');
  const originalProcessPost = scheduler.processPost;
  let providerAttempts = 0;
  scheduler.processPost = async (postId) => {
    providerAttempts += 1;
    assert.equal(postId, post.id);
    return { ok: true, mode: 'api' };
  };
  t.after(() => { scheduler.processPost = originalProcessPost; });
  const publishNow = await fetch(`${baseUrl}/posts/${post.id}/prepare`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie, Origin: baseUrl },
    body: new URLSearchParams({ accountId: post.accountId, force: '1' })
  });
  assert.equal(publishNow.status, 302);
  assert.equal(providerAttempts, 1, 'the mocked shared worker path is reached once');

  post.status = 'failed';
  post.claimAttempts = 0;
  post.publishAttemptBudget = 1;
  const retryCalls = [];
  storage.retryFailedPost = async (userId, postId, accountId, workspaceScope) => {
    retryCalls.push({ userId, postId, accountId, workspaceScope });
    post.status = post.scheduledAt ? 'scheduled' : 'pending';
    post.failedAt = null;
    post.providerStatus = null;
    post.history = [...post.history, { event: 'retry_requested' }];
    return {
      outcome: 'retried',
      post,
      claimAttempts: post.claimAttempts,
      effectiveAttemptBudget: post.publishAttemptBudget
    };
  };
  const retry = await fetch(`${baseUrl}/posts/${post.id}/pending`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie, Origin: baseUrl },
    body: new URLSearchParams({ accountId: post.accountId })
  });
  assert.equal(retry.status, 302);
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].accountId, 'UC-chanter');
  assert.equal(post.claimAttempts, 0);
  assert.equal(post.publishAttemptBudget, 1);
  assert.equal(post.history.at(-1).event, 'retry_requested');

  post.status = 'failed';
  post.claimAttempts = 1;
  const exhausted = { ...post, history: post.history.map((entry) => ({ ...entry })) };
  storage.retryFailedPost = async () => ({
    outcome: 'attempt_budget_exhausted',
    post,
    claimAttempts: 1,
    effectiveAttemptBudget: 1
  });
  const rejectedRetry = await fetch(`${baseUrl}/posts/${post.id}/pending`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie, Origin: baseUrl },
    body: new URLSearchParams({ accountId: post.accountId })
  });
  assert.equal(rejectedRetry.status, 302);
  assert.match(
    decodeURIComponent(rejectedRetry.headers.get('location')),
    /cannot be retried under its current authorization/i
  );
  assert.deepEqual(post, exhausted);

  const deleteCalls = [];
  storage.deletePost = async (userId, postId, accountId, workspaceScope) => {
    deleteCalls.push({ userId, postId, accountId, workspaceScope });
    return true;
  };
  const remove = await fetch(`${baseUrl}/posts/${post.id}/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: adminCookie, Origin: baseUrl }
  });
  assert.equal(remove.status, 302);
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].accountId, undefined, 'admin delete remains provider-neutral');
  assert.equal(deleteCalls[0].workspaceScope.workspaceId.length > 0, true);
});
