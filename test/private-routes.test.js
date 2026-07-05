'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.CRON_SECRET = 'test-cron-secret';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const autoCaption = require('../src/autoCaption');
const autoMusic = require('../src/autoMusic');
const { attachUser } = require('../src/auth');

const accounts = [
  { accountId: 'account-a', open_id: 'account-a', username: 'account_a', connected: true },
  { accountId: 'account-b', open_id: 'account-b', username: 'account_b', connected: true }
];
const postsByAccount = {
  'account-a': [{
    id: 'post-a', accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a',
    status: 'posted', originalName: 'account-a-history.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Account A history', hashtags: '#a',
    privacyLevel: 'SELF_ONLY', postedAt: new Date().toISOString(),
    lastInstagramResult: { ok: false, reason: 'Hidden integration error' }
  }],
  'account-b': [{
    id: 'post-b', accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b',
    status: 'scheduled', originalName: 'account-b-queue.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Account B queue', hashtags: '#b',
    privacyLevel: 'SELF_ONLY', scheduledAt: new Date(Date.now() + 60_000).toISOString()
  }]
};

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) => accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async (userId, accountId) => postsByAccount[accountId] || [];
storage.getCampaigns = async () => [{
  id: 'cmp-1111-2222-3333',
  campaignId: 'cmp-1111-2222-3333',
  mediaReference: { originalName: 'campaign.mp4' },
  createdAt: '2026-06-20T10:00:00.000Z',
  campaignStatus: 'retry_required',
  selectedAccountIds: ['account-a', 'account-b'],
  scheduleBaseTime: '2026-06-21T10:00:00.000Z',
  staggerMinutes: 15,
  childJobIds: ['child-a-posted-11', 'child-b-retry-22'],
  scheduleSlotIds: [],
  childJobs: [
    {
      id: 'child-a-posted-11', accountId: 'account-a', username: 'account_a',
      caption: 'Caption A', hashtags: '#alpha',
      scheduledAt: '2026-06-21T10:00:00.000Z',
      status: 'posted', campaignJobStatus: 'posted',
      publishId: 'publish-abc-123', errorMessage: '', errorEvidence: null
    },
    {
      id: 'child-b-retry-22', accountId: 'account-b', username: 'account_b',
      caption: 'Caption B', hashtags: '#beta',
      scheduledAt: '2026-06-21T10:15:00.000Z',
      status: 'failed', campaignJobStatus: 'retry_required',
      publishId: '', errorMessage: 'Rate limit exceeded',
      errorEvidence: { ok: false, retryable: true, reason: 'Rate limit exceeded' }
    }
  ]
}];
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getCounts = async () => ({
  total: 0,
  pending: 0,
  scheduled: 0,
  processing: 0,
  ready: 0,
  posted: 0,
  failed: 0
});
storage.getDashboardJobs = async () => Object.values(postsByAccount).flat();
storage.getRecentJobs = async () => [{
  id: 'debug-processing',
  status: 'processing',
  scheduledAt: '2026-06-20T11:59:00.000Z',
  originalName: 'debug-video.mp4',
  caption: 'Debug queue item',
  privacyLevel: 'SELF_ONLY',
  lockedAt: '2026-06-20T12:00:00.000Z',
  lockedBy: 'worker-123',
  claimAttempts: 2,
  publishId: 'publish-123',
  errorMessage: 'TikTok publishing is not configured.',
  lastResult: {
    ok: false,
    mode: 'api',
    code: 'TIKTOK_NOT_CONFIGURED',
    reason: 'TikTok publishing is not configured.',
    response: { token: 'must-not-be-exposed' },
    completedAt: '2026-06-20T12:01:00.000Z'
  },
  createdAt: '2026-06-20T11:55:00.000Z',
  postedAt: null,
  updatedAt: '2026-06-20T12:01:00.000Z'
}];
tiktok.getTikTokAuthStatus = async (accountId) => ({
  connected: Boolean(accountId), accountId, open_id: accountId, username: accountId === 'account-b' ? 'account_b' : 'account_a'
});
tiktok.queryCreatorInfo = async (accountId) => ({
  creator_username: accountId === 'account-b' ? 'account_b' : 'account_a',
  privacy_level_options: ['SELF_ONLY']
});
instagram.getInstagramAuthStatus = async () => {
  throw new Error('Instagram status must not be requested while the feature is disabled');
};
const missingInstagramKeys = [
  'META_APP_ID',
  'META_APP_SECRET',
  'META_ACCESS_TOKEN',
  'INSTAGRAM_BUSINESS_ACCOUNT_ID',
  'FACEBOOK_PAGE_ID'
];
instagram.getInstagramHealth = async () => ({
  success: true,
  platform: 'instagram',
  configured: false,
  canPublish: false,
  mode: 'dry-run',
  missing: missingInstagramKeys,
  message: 'Instagram publishing is not configured yet. The app can run in dry-run mode.'
});
instagram.publishInstagramMedia = async () => ({
  ok: false,
  success: false,
  platform: 'instagram',
  code: 'INSTAGRAM_NOT_CONFIGURED',
  message: 'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.',
  missing: missingInstagramKeys,
  mode: 'api',
  published: false,
  reason: 'Instagram publishing is not configured.'
});
let analyzedVideoPath = '';
let musicVideoPath = '';
autoCaption.analyzeVideoForCaption = async (videoPath, draft) => {
  analyzedVideoPath = videoPath;
  assert.equal(draft.caption, 'Manual fallback');
  return {
    caption: 'Generated hook\nGenerated caption',
    hashtags: '#one #two #three #four #five #six #seven #eight',
    generatedCaption: 'Generated caption',
    hook: 'Generated hook',
    hashtagList: ['#one', '#two', '#three', '#four', '#five', '#six', '#seven', '#eight'],
    metadata: { durationSeconds: 5, width: 1080, height: 1920, hasAudio: true },
    transcriptUsed: true,
    transcriptionWarning: '',
    analysisWarning: '',
    provider: 'gemini',
    fallbackUsed: false,
    musicCategory: 'anime-epic',
    musicMood: 'heroic uplifting',
    musicIntensity: 0.78,
    musicTags: ['anime', 'heroic']
  };
};
autoMusic.isAutoMusicConfigured = () => true;
autoMusic.prepareAutoMusic = async ({ videoPath, analysis }) => {
  musicVideoPath = videoPath;
  assert.equal(analysis.musicCategory, 'anime-epic');
  return {
    token: 'signed-prepared-media-token',
    track: { id: 'anime-epic-demo-01', category: 'anime-epic' },
    render: { hasOriginalAudio: true, musicVolume: 0.2, durationSeconds: 5 }
  };
};

const routes = require('../src/routes');

test('serves the AutoPoster page and dashboard at both private routes', async (t) => {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(routes);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const [unauthorizedAutoPoster, unauthorizedDashboard, unauthorizedApi, unauthorizedConnect, unauthorizedCaption] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter`, { redirect: 'manual' }),
    fetch(`${baseUrl}/private/autoposter/dashboard`, { redirect: 'manual' }),
    fetch(`${baseUrl}/api/private/autoposter/dashboard`),
    fetch(`${baseUrl}/connect/tiktok`, { redirect: 'manual' }),
    fetch(`${baseUrl}/api/auto-caption`, { method: 'POST', headers: { Accept: 'application/json' } })
  ]);
  assert.equal(unauthorizedAutoPoster.status, 302);
  assert.match(unauthorizedAutoPoster.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedDashboard.status, 302);
  assert.match(unauthorizedDashboard.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedApi.status, 401);
  assert.deepEqual(await unauthorizedApi.json(), { ok: false, reason: 'Admin authentication required' });
  assert.equal(unauthorizedCaption.status, 401);
  assert.deepEqual(await unauthorizedCaption.json(), { ok: false, reason: 'Admin authentication required' });
  assert.equal(unauthorizedConnect.status, 302);
  assert.match(unauthorizedConnect.headers.get('location'), /^\/admin-login/);

  const instagramHealthResponse = await fetch(`${baseUrl}/api/instagram/health`);
  assert.equal(instagramHealthResponse.status, 200);
  assert.deepEqual(await instagramHealthResponse.json(), {
    success: true,
    platform: 'instagram',
    configured: false,
    canPublish: false,
    mode: 'dry-run',
    missing: missingInstagramKeys,
    message: 'Instagram publishing is not configured yet. The app can run in dry-run mode.'
  });

  const loginPageResponse = await fetch(`${baseUrl}/admin-login`);
  const loginPageHtml = await loginPageResponse.text();
  assert.equal(loginPageResponse.status, 200);
  assert.match(loginPageHtml, /Admin login/);
  assert.doesNotMatch(loginPageHtml, /test-admin-password-123/);

  const failedLogin = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'incorrect-password', returnTo: '/private/autoposter' })
  });
  assert.equal(failedLogin.status, 401);
  assert.equal(failedLogin.headers.get('set-cookie'), null);

  const loginResponse = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.equal(loginResponse.status, 302);
  assert.equal(loginResponse.headers.get('location'), '/private/autoposter');
  assert.match(adminCookie, /^chanter_admin_session=/);
  assert.match(String(loginResponse.headers.get('set-cookie')), /HttpOnly/i);
  assert.match(String(loginResponse.headers.get('set-cookie')), /SameSite=Lax/i);

  const [autoPosterResponse, dashboardResponse] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } }),
    fetch(`${baseUrl}/private/autoposter/dashboard`, { headers: { Cookie: adminCookie } })
  ]);
  const [autoPosterHtml, dashboardHtml] = await Promise.all([
    autoPosterResponse.text(),
    dashboardResponse.text()
  ]);

  assert.equal(autoPosterResponse.status, 200);
  assert.match(autoPosterHtml, /Create &amp; Schedule/);
  assert.match(autoPosterHtml, /data-auto-caption-toggle/);
  assert.match(autoPosterHtml, /data-auto-music-toggle/);
  assert.match(autoPosterHtml, /Turn on Auto Music/);
  assert.match(autoPosterHtml, /Turn on Auto Caption/);
  assert.match(autoPosterHtml, /href="\/private\/autoposter\/dashboard"/);
  assert.match(autoPosterHtml, /account-a-history\.jpg/);
  assert.doesNotMatch(autoPosterHtml, /account-b-queue\.jpg/);
  assert.match(autoPosterHtml, /Switch \/ Connect another/);
  assert.match(autoPosterHtml, /data-campaign-verdict/);
  assert.match(autoPosterHtml, /\/api\/campaigns\/preview/);

  // Campaign history surfaces parent + child job visibility fields.
  assert.match(autoPosterHtml, /Campaign cmp-1111/);
  assert.match(autoPosterHtml, /retry required/, 'derived retry_required status must be readable');
  assert.match(autoPosterHtml, /job child-a- \/ account account-a \/ publish publish-abc-123/);
  assert.match(autoPosterHtml, /job child-b- \/ account account-b/);
  assert.match(autoPosterHtml, /title="child-a-posted-11"/);
  assert.match(autoPosterHtml, /title="child-b-retry-22"/);
  assert.match(autoPosterHtml, /Rate limit exceeded \(safe to requeue\)/);
  assert.doesNotMatch(autoPosterHtml, /job child-a-[^<]*publish publish-abc-123[^<]*safe to requeue/,
    'error evidence must stay on the failed child, not leak onto the published one');
  assert.match(autoPosterHtml, /Instagram: Not configured/);
  assert.match(autoPosterHtml, /Dry-run mode active/);
  assert.match(autoPosterHtml, /Add Meta API keys to enable Instagram publishing/);

  assert.equal(dashboardResponse.status, 200);
  assert.match(dashboardHtml, /AutoPoster Control Room/);

  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /href="\/private\/autoposter"/);

  const dashboardDataResponse = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, {
    headers: { Cookie: adminCookie }
  });
  const dashboardData = await dashboardDataResponse.json();
  assert.equal(dashboardDataResponse.status, 200);
  assert.equal(dashboardData.selectedAccountId, 'account-a');
  assert.deepEqual(dashboardData.accounts.map((account) => account.id), ['account-a', 'account-b']);
  assert.deepEqual(dashboardData.jobs.map((job) => job.accountId).sort(), ['account-a', 'account-b']);

  const debugJobsResponse = await fetch(`${baseUrl}/api/debug/jobs`, {
    headers: { 'x-cron-secret': 'test-cron-secret' }
  });
  const debugJobs = await debugJobsResponse.json();
  assert.equal(debugJobsResponse.status, 200);
  assert.equal(debugJobs.jobs[0].id, 'debug-processing');
  assert.equal(debugJobs.jobs[0].lockedAt, '2026-06-20T12:00:00.000Z');
  assert.equal(debugJobs.jobs[0].lockedBy, 'worker-123');
  assert.equal(debugJobs.jobs[0].claimAttempts, 2);
  assert.equal(debugJobs.jobs[0].publishId, 'publish-123');
  assert.equal(debugJobs.jobs[0].errorMessage, 'TikTok publishing is not configured.');
  assert.deepEqual(debugJobs.jobs[0].lastAttempt, {
    ok: false,
    mode: 'api',
    code: 'TIKTOK_NOT_CONFIGURED',
    reason: 'TikTok publishing is not configured.',
    completedAt: '2026-06-20T12:01:00.000Z'
  });
  assert.doesNotMatch(JSON.stringify(debugJobs), /must-not-be-exposed/);

  const blockedInstagramPublish = await fetch(`${baseUrl}/api/instagram/publish`, {
    method: 'POST',
    headers: {
      Cookie: adminCookie,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ publishType: 'story', mediaUrl: 'https://cdn.example.com/story.mp4' })
  });
  assert.equal(blockedInstagramPublish.status, 503);
  assert.deepEqual(await blockedInstagramPublish.json(), {
    success: false,
    platform: 'instagram',
    code: 'INSTAGRAM_NOT_CONFIGURED',
    message: 'Instagram publishing is not configured. Add the required Meta API keys to enable publishing.',
    missing: missingInstagramKeys
  });

  const captionBody = new FormData();
  captionBody.append('video', new Blob([Buffer.from('test-video')], { type: 'video/mp4' }), 'sample.mp4');
  captionBody.append('caption', 'Manual fallback');
  captionBody.append('hashtags', '#manual');
  captionBody.append('autoMusic', '1');
  const captionResponse = await fetch(`${baseUrl}/api/auto-caption`, {
    method: 'POST',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: captionBody
  });
  const captionResult = await captionResponse.json();
  assert.equal(captionResponse.status, 200);
  assert.equal(captionResult.caption, 'Generated hook\nGenerated caption');
  assert.equal(captionResult.analysis.frameCount, 5);
  assert.equal(captionResult.analysis.transcriptUsed, true);
  assert.equal(captionResult.analysis.provider, 'gemini');
  assert.equal(captionResult.analysis.fallbackUsed, false);
  assert.equal(captionResult.music.prepared, true);
  assert.equal(captionResult.music.token, 'signed-prepared-media-token');
  assert.equal(captionResult.music.track.category, 'anime-epic');
  assert.ok(analyzedVideoPath);
  assert.equal(musicVideoPath, analyzedVideoPath);
  assert.equal(fs.existsSync(analyzedVideoPath), false);

  let failedVideoPath = '';
  autoCaption.analyzeVideoForCaption = async (videoPath) => {
    failedVideoPath = videoPath;
    const error = new Error('Provider unavailable');
    error.code = 'AI_REQUEST_FAILED';
    throw error;
  };
  const failedCaptionBody = new FormData();
  failedCaptionBody.append('video', new Blob([Buffer.from('test-video')], { type: 'video/mp4' }), 'failure.mp4');
  failedCaptionBody.append('caption', 'Keep this manual caption');
  failedCaptionBody.append('hashtags', '#manual');
  const failedCaptionResponse = await fetch(`${baseUrl}/api/auto-caption`, {
    method: 'POST',
    headers: { Cookie: adminCookie, Accept: 'application/json' },
    body: failedCaptionBody
  });
  const failedCaptionResult = await failedCaptionResponse.json();
  assert.equal(failedCaptionResponse.status, 422);
  assert.equal(failedCaptionResult.fallback.caption, 'Keep this manual caption');
  assert.equal(failedCaptionResult.requiresManualCaption, false);
  assert.match(failedCaptionResult.reason, /manual caption was kept/i);
  assert.ok(failedVideoPath);
  assert.equal(fs.existsSync(failedVideoPath), false);

  const switchResponse = await fetch(`${baseUrl}/private/autoposter/account`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ accountId: 'account-b' })
  });
  const accountCookie = String(switchResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.equal(switchResponse.status, 302);
  assert.match(accountCookie, /autoposter_tiktok_account_id=account-b/);

  const accountBResponse = await fetch(`${baseUrl}/private/autoposter`, {
    headers: { Cookie: `${adminCookie}; ${accountCookie}` }
  });
  const accountBHtml = await accountBResponse.text();
  assert.match(accountBHtml, /account-b-queue\.jpg/);
  assert.doesNotMatch(accountBHtml, /account-a-history\.jpg/);

  // Campaign dry-run preview API: admin-gated passthrough that maps the
  // create form's slot fields onto the preview draft without writing anything.
  const unauthorizedPreview = await fetch(`${baseUrl}/api/campaigns/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ campaignAccountId1: 'account-a' })
  });
  assert.equal(unauthorizedPreview.status, 401);

  let previewedUserId = null;
  let previewedDraft = null;
  const previewDocument = {
    mode: 'preview',
    safeToEnqueue: false,
    campaign: {
      platform: 'tiktok',
      baseScheduledAt: '2026-07-04T10:00:00.000Z',
      staggerMinutes: 15,
      selectedAccountIds: ['account-a', 'account-b']
    },
    childJobs: [],
    errors: [{ code: 'CAMPAIGN_SCHEDULE_COLLISION', message: 'Another post for this TikTok account is already scheduled.' }],
    warnings: []
  };
  storage.previewTikTokCampaign = async (userId, draft) => {
    previewedUserId = userId;
    previewedDraft = draft;
    return previewDocument;
  };
  const previewResponse = await fetch(`${baseUrl}/api/campaigns/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      campaignBaseScheduledAt: '2026-07-04T10:00',
      timezoneOffsetMinutes: '0',
      campaignAccountId1: ' account-a ',
      campaignCaption1: 'Caption A',
      campaignHashtags1: '#alpha',
      campaignAccountId2: 'account-b',
      campaignCaption2: 'Caption B',
      campaignHashtags2: '#beta'
    })
  });
  assert.equal(previewResponse.status, 200);
  assert.deepEqual(await previewResponse.json(), previewDocument);
  assert.ok(previewedUserId, 'preview must run as the authenticated admin user');
  assert.equal(previewedDraft.baseScheduledAt, '2026-07-04T10:00:00.000Z');
  assert.deepEqual(previewedDraft.jobs, [
    { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
    { accountId: 'account-b', caption: 'Caption B', hashtags: '#beta' }
  ]);

  let savedPatch = null;
  let savedAccountId = null;
  storage.updatePost = async (userId, postId, patch, accountId) => {
    savedPatch = patch;
    savedAccountId = accountId;
    return { id: postId, accountId, ...patch };
  };
  const saveResponse = await fetch(`${baseUrl}/posts/post-a`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({
      caption: 'Updated TikTok post',
      hashtags: '#updated',
      privacyLevel: 'SELF_ONLY',
      scheduledAt: '',
      timezoneOffsetMinutes: '0'
    })
  });

  assert.equal(saveResponse.status, 302);
  assert.ok(savedPatch);
  assert.equal(savedAccountId, 'account-a');
  assert.equal(Object.hasOwn(savedPatch, 'instagramMediaUrl'), false);
});
