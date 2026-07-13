'use strict';

// Command Center provider truth: the dashboard API must surface every real
// connected provider account (TikTok AND YouTube), preserve provider
// identity on queue jobs, aggregate by canonical connected-account identity,
// present a private YouTube upload as 'Uploaded Private' (never public
// 'Published'), and never serialize a credential.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ENABLE_INSTAGRAM = 'false';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'CANARY-CC-CLIENT-SECRET-x1y2z3';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const { attachUser, createAdminSessionToken, ADMIN_SESSION_COOKIE } = require('../src/auth');
const config = require('../src/config');

const accountingPromise = import('../src/pages/dashboard-accounting.mjs');

const CANARY_ACCESS_TOKEN = 'CANARY-ACCESS-TOKEN-cc-9a8b7c6d';
const CANARY_REFRESH_TOKEN = 'CANARY-REFRESH-TOKEN-cc-2b3a4f5e';
const CANARY_ENVELOPE_CT = 'CANARY-ENVELOPE-CIPHERTEXT-cc';
const OWNER = config.defaultUserId;

const tiktokAccounts = [
  {
    accountId: 'tt-open-a', open_id: 'tt-open-a', userId: OWNER, provider: 'tiktok', platform: 'tiktok',
    username: 'chanter_tt', displayName: 'CHANTER TikTok', connected: true,
    access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN,
    scope: 'user.info.basic,video.publish', connectedAt: '2026-07-01T00:00:00.000Z'
  },
  {
    accountId: 'tt-open-b', open_id: 'tt-open-b', userId: OWNER, provider: 'tiktok', platform: 'tiktok',
    username: 'cdwarrior_tt', displayName: 'CD Warrior', connected: true,
    access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN,
    scope: 'user.info.basic,video.publish'
  }
];

const youtubeAccounts = [{
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
}];

const posts = [
  {
    id: 'tt-job-posted', userId: OWNER, provider: 'tiktok', platform: 'tiktok',
    accountId: 'tt-open-a', tiktokOpenId: 'tt-open-a', username: 'chanter_tt',
    connectedAccountId: 'tiktok:tt-open-a', campaignId: 'cmp-tt-1',
    status: 'posted', originalName: 'tt-history.mp4', mediaType: 'video',
    mediaUrl: '/assets/chanter-logo.png', caption: 'TikTok history', privacyLevel: 'SELF_ONLY',
    postedAt: new Date().toISOString()
  },
  {
    id: 'tt-job-queued', userId: OWNER, provider: 'tiktok', platform: 'tiktok',
    accountId: 'tt-open-b', tiktokOpenId: 'tt-open-b', username: 'cdwarrior_tt',
    connectedAccountId: 'tiktok:tt-open-b', campaignId: 'cmp-tt-1',
    status: 'scheduled', originalName: 'tt-queued.mp4', mediaType: 'video',
    mediaUrl: '/assets/chanter-logo.png', caption: 'TikTok queued', privacyLevel: 'SELF_ONLY',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString()
  },
  {
    id: 'yt-job-uploaded', userId: OWNER, provider: 'youtube', platform: 'youtube',
    accountId: 'UC-chanter', username: 'chanterCy',
    connectedAccountId: 'youtube:UC-chanter',
    status: 'posted', originalName: 'teaser.mp4', mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/demo/video/upload/teaser.mp4',
    providerStatus: 'uploaded_private', publishId: 'yt-video-777',
    providerMetadata: { youtube: { title: 'Launch teaser', description: '', privacyStatus: 'private', notifySubscribers: false } },
    postedAt: new Date().toISOString(),
    lastResult: {
      ok: true, mode: 'api',
      response: {
        video_id: 'yt-video-777',
        privacy_status: 'private',
        upload_status: 'uploaded',
        access_token: 'CANARY-RESULT-ACCESS-TOKEN',
        client_secret: 'CANARY-RESULT-CLIENT-SECRET',
        externalCustomerId: 'CANARY-RESULT-CUSTOMER-ID'
      },
      completedAt: new Date().toISOString()
    },
    logs: [{ credential: 'CANARY-RAW-LOG-CREDENTIAL' }]
  }
];

storage.getTikTokAccounts = async () => tiktokAccounts;
storage.getTikTokAccount = async (userId, accountId) =>
  tiktokAccounts.find((account) => account.accountId === accountId && account.userId === userId) || null;
storage.getYouTubeAccounts = async () => youtubeAccounts;
storage.getYouTubeAccount = async (userId, accountId) =>
  youtubeAccounts.find((account) => account.accountId === accountId && account.userId === userId) || null;
storage.getPosts = async (userId, accountId) =>
  posts.filter((post) => !accountId || post.accountId === accountId);
storage.getSettings = async () => ({ dailyPostTime: '09:00' });
storage.getDashboardJobs = async () => posts;

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const routes = require('../src/routes');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(attachUser);
app.use('/', routes);

let server;
let baseUrl;
const adminCookie = `${ADMIN_SESSION_COOKIE}=${createAdminSessionToken()}`;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

async function fetchDashboardData() {
  const response = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(response.status, 200);
  return response.json();
}

test('dashboard API surfaces the connected YouTube channel alongside TikTok accounts', async () => {
  const data = await fetchDashboardData();

  assert.deepEqual(
    data.accounts.map((account) => [account.provider, account.id]),
    [['tiktok', 'tt-open-a'], ['tiktok', 'tt-open-b'], ['youtube', 'UC-chanter']]
  );

  const youtubeChannel = data.accounts.find((account) => account.provider === 'youtube');
  assert.equal(youtubeChannel.username, 'chanterCy');
  assert.equal(youtubeChannel.connectedAccountId, 'youtube:UC-chanter');
  assert.equal(youtubeChannel.providerAccountId, 'UC-chanter');
  assert.equal(youtubeChannel.connected, true);
  assert.equal(youtubeChannel.connectionStatus, 'connected');
  assert.equal(youtubeChannel.publishingReady, true);

  // Canonical identity on TikTok accounts too — no legacy-only aliases.
  assert.deepEqual(
    data.accounts.filter((account) => account.provider === 'tiktok').map((account) => account.connectedAccountId),
    ['tiktok:tt-open-a', 'tiktok:tt-open-b']
  );
  assert.deepEqual(
    data.accounts.filter((account) => account.provider === 'tiktok').map((account) => account.providerAccountId),
    ['tt-open-a', 'tt-open-b']
  );

  // Only real, supported providers — nothing invented.
  assert.deepEqual([...new Set(data.accounts.map((account) => account.provider))].sort(), ['tiktok', 'youtube']);
});

test('queue jobs keep provider identity and the private-upload provider status', async () => {
  const data = await fetchDashboardData();

  const youtubeJob = data.jobs.find((job) => job.id === 'yt-job-uploaded');
  assert.equal(youtubeJob.provider, 'youtube');
  assert.equal(youtubeJob.connectedAccountId, 'youtube:UC-chanter');
  assert.equal(youtubeJob.providerStatus, 'uploaded_private');
  assert.equal(youtubeJob.status, 'posted');

  const tiktokJobs = data.jobs.filter((job) => job.provider === 'tiktok');
  assert.deepEqual(tiktokJobs.map((job) => job.id).sort(), ['tt-job-posted', 'tt-job-queued']);
});

test('client aggregation groups the YouTube upload under @chanterCy and keeps global counts accurate', async () => {
  const {
    assignDashboardJobs,
    dashboardProviderOptions,
    filterJobsByProvider,
    groupDashboardJobs,
    isUploadedPrivate,
    UNASSIGNED_ACCOUNT_ID
  } = await accountingPromise;
  const data = await fetchDashboardData();

  const jobs = assignDashboardJobs(data.jobs, data.accounts);
  assert.deepEqual(
    jobs.map((job) => [job.id, job.accountId]),
    [
      ['tt-job-posted', 'tt-open-a'],
      ['tt-job-queued', 'tt-open-b'],
      ['yt-job-uploaded', 'UC-chanter']
    ]
  );
  assert.equal(jobs.some((job) => job.accountId === UNASSIGNED_ACCOUNT_ID), false);

  const groups = groupDashboardJobs(jobs, data.accounts);
  assert.equal(groups.reduce((total, group) => total + group.jobs.length, 0), data.jobs.length);
  const youtubeGroup = groups.find((group) => group.account?.provider === 'youtube');
  assert.equal(youtubeGroup.account.username, 'chanterCy');
  assert.deepEqual(youtubeGroup.jobs.map((job) => job.id), ['yt-job-uploaded']);

  // Provider filter behavior over the real payload.
  assert.deepEqual(dashboardProviderOptions(data.accounts, jobs), ['tiktok', 'youtube']);
  assert.deepEqual(filterJobsByProvider(jobs, 'youtube').map((job) => job.id), ['yt-job-uploaded']);
  assert.deepEqual(filterJobsByProvider(jobs, 'tiktok').map((job) => job.id), ['tt-job-posted', 'tt-job-queued']);
  assert.equal(filterJobsByProvider(jobs, 'all').length, 3);

  // Status truth: the YouTube success is a private upload; the TikTok
  // publish keeps its vocabulary.
  assert.equal(isUploadedPrivate(jobs.find((job) => job.id === 'yt-job-uploaded')), true);
  assert.equal(isUploadedPrivate(jobs.find((job) => job.id === 'tt-job-posted')), false);
});

test('the Command Center UI renders provider truth and the provider filter', () => {
  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /Uploaded Private/);
  assert.match(dashboardSource, /All providers/);
  assert.match(dashboardSource, /providerFilter/);
  assert.match(dashboardSource, /provider-badge/);
  assert.match(dashboardSource, /youtube: 'YouTube'/);
  assert.match(dashboardSource, /isUploadedPrivate/);
});

// ── Real-shape attribution + aggregate status truth ────────────────────────
// The exact field shape of a live private YouTube upload (provider,
// connectedAccountId, accountId, a legacy tiktokOpenId alias carried over
// from the shared account-selection code path, and a campaignId), using
// fictional identifiers so no real production channel/video id is
// persisted in the repo.

const realShapeAccounts = [
  {
    id: 'UC-real-shape', accountId: 'UC-real-shape', provider: 'youtube', platform: 'youtube',
    connectedAccountId: 'youtube:UC-real-shape', providerAccountId: 'UC-real-shape',
    username: 'chanterCy', displayName: 'chanterCy', connected: true, publishingReady: true
  }
];

const realShapeYouTubeJob = {
  id: 'real-shape-yt-job',
  userId: 'owner',
  provider: 'youtube',
  platform: 'youtube',
  accountId: 'UC-real-shape',
  connectedAccountId: 'youtube:UC-real-shape',
  // Real documents carry this legacy alias alongside the canonical fields;
  // resolution must not require it, only tolerate it.
  tiktokOpenId: 'UC-real-shape',
  username: 'chanterCy',
  campaignId: 'real-shape-campaign-1',
  status: 'posted',
  providerStatus: 'uploaded_private',
  providerMetadata: { youtube: { title: 'Integration test', description: '', privacyStatus: 'private', notifySubscribers: false } },
  publishId: 'real-shape-video-id'
};

test('an attributable YouTube release resolves to its real connected channel, never Legacy/Unassigned', async () => {
  const { assignDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const [job] = assignDashboardJobs([realShapeYouTubeJob], realShapeAccounts);

  assert.equal(job.accountId, 'UC-real-shape');
  assert.notEqual(job.accountId, UNASSIGNED_ACCOUNT_ID);
  assert.equal(job.accountAssignment, 'deterministic');
});

test('a genuinely unattributable YouTube record still falls back to Legacy/Unassigned', async () => {
  const { assignDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  // No accountId, connectedAccountId, tiktokOpenId, or username reference at
  // all — the one thing that makes a record truly unattributable — even
  // though a real connected YouTube channel exists in the account list.
  const orphanJob = { id: 'orphan-yt-job', provider: 'youtube', status: 'posted', providerStatus: 'uploaded_private' };
  const [job] = assignDashboardJobs([orphanJob], realShapeAccounts);

  assert.equal(job.accountId, UNASSIGNED_ACCOUNT_ID);
  assert.equal(job.accountAssignment, 'unassigned');
});

test('Campaign Overview labels a private YouTube upload as uploaded_private, never posted/Published, inside a mixed campaign', async () => {
  const { summarizeDashboardCampaigns } = await accountingPromise;
  const tiktokJob = {
    id: 'tt-in-mixed-campaign', provider: 'tiktok', platform: 'tiktok',
    campaignId: 'real-shape-campaign-1', status: 'posted'
  };
  const campaigns = summarizeDashboardCampaigns([tiktokJob, realShapeYouTubeJob]);

  assert.equal(campaigns.length, 1);
  const [campaign] = campaigns;
  assert.equal(campaign.jobCount, 2);
  // The YouTube upload must land under its own bucket, not inflate 'posted'.
  assert.deepEqual(campaign.statusCounts, { posted: 1, uploaded_private: 1 });
  assert.equal(campaign.hasFailures, false);
  assert.equal(campaign.hasRetryRequired, false);
});

test('TikTok-only campaigns keep their existing posted/Published aggregation unchanged', async () => {
  const { summarizeDashboardCampaigns } = await accountingPromise;
  const campaigns = summarizeDashboardCampaigns([
    { id: 'tt-1', provider: 'tiktok', campaignId: 'tiktok-only-campaign', status: 'posted' },
    { id: 'tt-2', provider: 'tiktok', campaignId: 'tiktok-only-campaign', status: 'posted' }
  ]);

  assert.deepEqual(campaigns, [{
    campaignId: 'tiktok-only-campaign',
    jobCount: 2,
    statusCounts: { posted: 2 },
    hasFailures: false,
    hasRetryRequired: false
  }]);
});

test('the dashboard computes top-level counts and status filters from displayStatus, not raw status', () => {
  const dashboardSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  // The private-upload outcome is a real, always-visible aggregate bucket —
  // not a special case bolted onto one card.
  assert.match(dashboardSource, /STATUS_FILTERS = \[.*'uploaded_private'.*\]/);
  assert.match(dashboardSource, /uploaded_private: 'Uploaded Private'/);
  assert.match(dashboardSource, /displayStatus/);
  assert.match(dashboardSource, /result\[job\.displayStatus\]/);
  assert.match(dashboardSource, /statusFilter === 'all' \|\| job\.displayStatus === statusFilter/);
  // The metric-grid no longer hardcodes a second, driftable copy of the
  // status list.
  assert.doesNotMatch(dashboardSource, /\['all', 'scheduled', 'processing', 'posted', 'failed'\]/);
});

test('no credential material ever reaches the dashboard payload', async () => {
  const data = await fetchDashboardData();
  const serialized = JSON.stringify(data);

  assert.doesNotMatch(serialized, /CANARY-/);
  assert.doesNotMatch(serialized, /access_token/);
  assert.doesNotMatch(serialized, /refresh_token/);
  assert.doesNotMatch(serialized, /credential/);
  assert.doesNotMatch(serialized, /tokenPresent/);
  data.accounts.forEach((account) => {
    assert.equal('access_token' in account, false);
    assert.equal('refresh_token' in account, false);
    assert.equal('credential' in account, false);
    assert.equal('token' in account, false);
  });
});
