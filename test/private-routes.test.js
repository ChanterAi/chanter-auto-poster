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
      status: 'accepted', campaignJobStatus: 'accepted',
      acceptedAt: '2026-06-21T10:00:05.000Z', claimAttempts: 2,
      lastResult: {
        ok: true,
        mode: 'api',
        completedAt: '2026-06-21T10:00:05.000Z',
        response: { data: { publish_id: 'publish-abc-123', upload_token: 'raw-response-must-not-render' } }
      },
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

const scheduler = require('../src/scheduler');
const healthySchedulerEvidence = {
  lastTickAt: '2026-06-20T12:00:00.000Z',
  lastTickOk: true,
  lastTickScope: 'process-local',
  lastTickDurable: false,
  lastTickSummary: { checked: 2, posted: 1, failed: 1 },
  durableHeartbeat: {
    durable: true,
    scope: 'firestore',
    status: 'healthy',
    lastTickAt: '2026-06-20T12:00:00.000Z',
    lastTickOk: true,
    ageSeconds: 42,
    stale: false,
    staleAfterSeconds: 300,
    lastTickSummary: { checked: 2, due: 2, posted: 1, failed: 1, accepted: 1 }
  },
  degraded: true,
  degradedReasons: [{ code: 'overdue_scheduled_jobs', message: 'Canonical scheduled jobs are overdue for processing.' }],
  firestoreHealthError: false,
  firestoreHealthFailedQueries: [],
  overdueScheduledCount: 1,
  overdueLegacyPendingCount: 0,
  overdueTotalCount: 1,
  staleProcessingCount: 0,
  activeProcessingCount: 0,
  processingMissingLockCount: 0,
  stuckPendingCount: 0,
  staleLockMinutes: 10,
  maxClaimAttempts: 3
};
scheduler.getSchedulerHealth = async () => healthySchedulerEvidence;

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
  assert.match(autoPosterHtml, /Add TikTok account/);

  // P1.4 luxury console: real monogram asset in the brand lockup + subtitle.
  assert.match(autoPosterHtml, /class="brand-mark" src="\/assets\/chanter-logo\.png" alt="CHANTER monogram"/);
  assert.match(autoPosterHtml, /AI-assisted publishing/);

  assert.match(autoPosterHtml, /data-campaign-verdict/);
  assert.match(autoPosterHtml, /\/api\/campaigns\/preview/);

  // Campaign Command Center: cockpit section with verdict states, no-live
  // demo labeling, and copyable evidence.
  assert.match(autoPosterHtml, /Campaign Command Center/);
  assert.match(autoPosterHtml, /Safe to enqueue — dry-run checks passed\./);
  assert.match(autoPosterHtml, /Blocked — resolve these before creating the campaign\./);
  assert.match(autoPosterHtml, /Accounts selected: /);
  assert.match(autoPosterHtml, /No-live demo: this dry run never calls TikTok/);
  assert.match(autoPosterHtml, /post-simulation demo mode is intentionally not implemented/);
  assert.match(autoPosterHtml, /data-campaign-copy-verdict/);
  assert.match(autoPosterHtml, /data-campaign-copy-evidence/);
  assert.match(autoPosterHtml, /data-campaign-evidence/);
  assert.match(autoPosterHtml, /CAMPAIGN EVIDENCE cmp-1111-2222-3333/);
  assert.match(autoPosterHtml, /publish id: publish-abc-123/);
  assert.match(autoPosterHtml, /error: Rate limit exceeded \(safe to requeue\)/);
  assert.match(autoPosterHtml, /contains no tokens or raw payloads/);

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

  // P1.1 execution evidence: accepted state, attempt times, and counts are
  // visible; raw provider response bodies are not rendered anywhere.
  assert.match(autoPosterHtml, /status: accepted/);
  assert.match(autoPosterHtml, /accepted at: 2026-06-21T10:00:05\.000Z/);
  assert.match(autoPosterHtml, /last attempt: 2026-06-21T10:00:05\.000Z \(api\)/);
  assert.match(autoPosterHtml, /attempts: 2/);
  assert.doesNotMatch(autoPosterHtml, /raw-response-must-not-render/);
  assert.doesNotMatch(autoPosterHtml, /upload_token/);

  // P1.2 Campaign Oracle: deterministic local review renders next to the
  // evidence block with verdict, counts, blocked reason, and next action
  // (details are collapsed for clients but stay in the markup).
  assert.match(autoPosterHtml, /Campaign review/);
  assert.match(autoPosterHtml, /Local, deterministic review — no AI call\./);
  assert.match(autoPosterHtml, /verdict: PARTIAL_SUCCESS/);
  assert.match(autoPosterHtml, /1 of 2 child job\(s\) posted or accepted; 1 blocked \(1 retry-safe, 0 terminal\)\./);
  assert.match(autoPosterHtml, /Blocked: Transient provider rejection: Rate limit exceeded/);
  assert.match(autoPosterHtml, /Next: Requeue only the retry-safe child jobs; leave the posted and accepted jobs untouched\./);
  assert.match(autoPosterHtml, /evidence confidence HIGH/);

  // P1.1 scheduler evidence strip: durable cron heartbeat is readable
  // (client-facing summary line, audit lines inside collapsed details).
  assert.match(autoPosterHtml, /System status/);
  assert.match(autoPosterHtml, /Scheduler last ran/);
  assert.match(autoPosterHtml, /last durable tick:/);
  assert.match(autoPosterHtml, /\(42s ago\) — completed OK/);
  assert.match(autoPosterHtml, /last tick: checked 2 \/ posted 1 \/ accepted 1 \/ failed 1/);
  assert.match(autoPosterHtml, /overdue jobs: 1 \/ stale processing locks: 0/);
  assert.match(autoPosterHtml, /Canonical scheduled jobs are overdue for processing\./);

  // Without a recorded heartbeat the strip says so instead of faking data.
  scheduler.getSchedulerHealth = async () => ({
    ...healthySchedulerEvidence,
    durableHeartbeat: {
      durable: true, scope: 'firestore', status: 'missing',
      lastTickAt: null, lastTickOk: null, ageSeconds: null,
      stale: null, staleAfterSeconds: 300, lastTickSummary: null
    },
    degradedReasons: [{ code: 'scheduler_heartbeat_missing', message: 'No durable scheduler heartbeat has been recorded yet.' }]
  });
  const noHeartbeatResponse = await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } });
  const noHeartbeatHtml = await noHeartbeatResponse.text();
  assert.equal(noHeartbeatResponse.status, 200);
  assert.match(noHeartbeatHtml, /Cron run evidence is not persisted yet\./);
  assert.doesNotMatch(noHeartbeatHtml, /last durable tick:/);
  scheduler.getSchedulerHealth = async () => healthySchedulerEvidence;
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
    readiness: {
      selectedAccountCount: 2,
      maxAccounts: 2,
      accountSelectionMissing: false,
      duplicateAccountSelection: false,
      accountIssues: [],
      scheduleCollisions: ['account-a'],
      blockedCodes: ['CAMPAIGN_SCHEDULE_COLLISION']
    },
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

  // P1.3 Operator Review API: admin-gated, read-only, secret-safe.
  const unauthorizedOperatorReview = await fetch(`${baseUrl}/api/campaigns/cmp-1111-2222-3333/operator-review`);
  assert.equal(unauthorizedOperatorReview.status, 401);

  const operatorReviewResponse = await fetch(`${baseUrl}/api/campaigns/cmp-1111-2222-3333/operator-review`, {
    headers: { Cookie: adminCookie, Accept: 'application/json' }
  });
  assert.equal(operatorReviewResponse.status, 200);
  const operatorReviewText = await operatorReviewResponse.text();
  const operatorReview = JSON.parse(operatorReviewText);
  assert.equal(operatorReview.ok, true);
  assert.equal(operatorReview.campaignId, 'cmp-1111-2222-3333');
  assert.ok(operatorReview.generatedAt);
  assert.equal(operatorReview.campaign.status, 'retry_required');
  assert.equal(operatorReview.campaign.caption, 'Caption A');
  assert.deepEqual(operatorReview.campaign.hashtags, ['#alpha']);
  assert.deepEqual(operatorReview.evidence, {
    childrenTotal: 2,
    postedCount: 0,
    acceptedCount: 1,
    failedCount: 0,
    retryRequiredCount: 1,
    lastTickAt: '2026-06-20T12:00:00.000Z',
    heartbeatStatus: 'healthy'
  });
  assert.equal(operatorReview.oracle.verdict, 'PARTIAL_SUCCESS');
  assert.equal(operatorReview.oracle.evidenceConfidence, 'HIGH');
  assert.ok(operatorReview.safeActions.every((action) => action.destructive === false && action.enabled === false));
  assert.ok(operatorReview.safeActions.some((action) => action.type === 'MANUAL_REVIEW'));
  assert.doesNotMatch(operatorReviewText, /raw-response-must-not-render/);
  assert.doesNotMatch(operatorReviewText, /upload_token/);

  const missingOperatorReview = await fetch(`${baseUrl}/api/campaigns/does-not-exist/operator-review`, {
    headers: { Cookie: adminCookie, Accept: 'application/json' }
  });
  assert.equal(missingOperatorReview.status, 404);
  assert.deepEqual(await missingOperatorReview.json(), {
    ok: false,
    code: 'CAMPAIGN_NOT_FOUND',
    reason: 'Campaign not found.'
  });

  // The operator-review path is read-only: no mutation method is registered.
  const operatorReviewPost = await fetch(`${baseUrl}/api/campaigns/cmp-1111-2222-3333/operator-review`, {
    method: 'POST',
    headers: { Cookie: adminCookie }
  });
  assert.equal(operatorReviewPost.status, 404, 'POST must not exist for the operator-review path');

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
