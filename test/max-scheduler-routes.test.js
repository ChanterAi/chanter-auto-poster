'use strict';

// Max Scheduler + Release Queue visibility: route + rendering behavior.
// Exercises the real Express routes with mocked storage, covering explicit
// start date/time + per-channel offset scheduling, the All Channels /
// Active Channel view toggle, parent campaign summaries, preflight guards,
// and channel-switch isolation — all with real token-shaped strings present
// in the mocked account data so any leak would be caught.

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
const { attachUser } = require('../src/auth');

const accounts = [
  {
    accountId: 'chanter-open-id', open_id: 'chanter-open-id', username: '__chanter',
    displayName: 'CHANTER', connected: true, access_token: 'secret-token-chanter', refresh_token: 'secret-refresh-chanter'
  },
  {
    accountId: 'cdwarrior-open-id', open_id: 'cdwarrior-open-id', username: '_cdwarrior',
    displayName: 'CD Warrior', connected: true, access_token: 'secret-token-cdwarrior', refresh_token: 'secret-refresh-cdwarrior'
  },
  {
    accountId: 'retired-open-id', open_id: 'retired-open-id', username: 'retired_channel',
    displayName: 'Retired', connected: false, access_token: '', refresh_token: ''
  }
];

// A pre-existing two-channel campaign so the default view, the campaign
// summary strip, and the All Channels / Active Channel toggle all have
// real data to render against.
const queueJobs = [
  {
    id: 'job-chanter-1', accountId: 'chanter-open-id', tiktokOpenId: 'chanter-open-id', username: '__chanter',
    campaignId: 'cmpAAAAAAAA', status: 'scheduled', originalName: 'chanter-queued.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'Chanter queued', hashtags: '#chanter', privacyLevel: 'SELF_ONLY',
    scheduledAt: '2026-07-07T09:00:00.000Z', createdAt: '2026-07-06T00:00:00.000Z',
    channelOrder: 0, channelOffsetMinutes: 0
  },
  {
    id: 'job-cdwarrior-1', accountId: 'cdwarrior-open-id', tiktokOpenId: 'cdwarrior-open-id', username: '_cdwarrior',
    campaignId: 'cmpAAAAAAAA', status: 'scheduled', originalName: 'cdwarrior-queued.jpg', mediaType: 'photo',
    mediaUrl: '/assets/chanter-logo.png', caption: 'CD Warrior queued', hashtags: '#cdw', privacyLevel: 'SELF_ONLY',
    scheduledAt: '2026-07-07T09:05:00.000Z', createdAt: '2026-07-06T00:00:00.000Z',
    channelOrder: 1, channelOffsetMinutes: 5
  }
];

const addUploadedPostsCalls = [];
const applyExplicitScheduleCalls = [];
const autoScheduleCalls = [];
const updatePostCalls = [];

storage.getTikTokAccounts = async () => accounts;
storage.getTikTokAccount = async (userId, accountId) =>
  accounts.find((account) => account.accountId === accountId) || null;
storage.getPosts = async (userId, accountId) =>
  queueJobs.filter((job) => !accountId || job.accountId === accountId);
storage.getDashboardJobs = async () => queueJobs;
storage.getSettings = async () => ({ dailyPostTime: '18:00' });
storage.getCounts = async (userId, accountId) => {
  const jobs = queueJobs.filter((job) => !accountId || job.accountId === accountId);
  return jobs.reduce(
    (counts, job) => { counts.total += 1; counts[job.status] = (counts[job.status] || 0) + 1; return counts; },
    { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
  );
};
storage.addUploadedPosts = async (userId, files, defaults) => {
  addUploadedPostsCalls.push({ userId, files, defaults });
  const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
    ? defaults.accounts
    : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username }];
  const campaignId = `cmp-new-${addUploadedPostsCalls.length}`;
  const created = targets.map((target, index) => ({
    id: `created-${addUploadedPostsCalls.length}-${index}`,
    accountId: target.accountId,
    tiktokOpenId: target.tiktokOpenId || target.accountId,
    username: target.username,
    campaignId,
    status: 'pending',
    storageFallback: false,
    autoMusicApplied: false,
    createdAt: new Date().toISOString()
  }));
  queueJobs.push(...created);
  return created;
};
storage.applyExplicitSchedule = async (userId, posts, plan) => {
  applyExplicitScheduleCalls.push({ posts, plan });
  const planByAccount = new Map(plan.channels.map((channel) => [channel.accountId, channel]));
  let count = 0;
  posts.forEach((post) => {
    const planChannel = planByAccount.get(post.accountId);
    if (!planChannel) return;
    const job = queueJobs.find((item) => item.id === post.id);
    if (job) {
      job.scheduledAt = planChannel.scheduledAt;
      job.status = 'scheduled';
      job.channelOffsetMinutes = planChannel.offsetMinutes;
      job.channelOrder = planChannel.order;
      job.campaignStartAt = plan.baseAt;
    }
    count += 1;
  });
  return count;
};
storage.autoSchedulePosts = async (userId, postIds, accountId) => {
  autoScheduleCalls.push({ postIds, accountId });
  postIds.forEach((id) => {
    const job = queueJobs.find((item) => item.id === id);
    if (job) job.status = 'scheduled';
  });
  return postIds.length;
};
storage.updatePost = async (userId, id, patch) => {
  updatePostCalls.push({ id, patch });
  const job = queueJobs.find((item) => item.id === id);
  if (job) Object.assign(job, patch);
  return job;
};
tiktok.getTikTokAuthStatus = async (accountId) => {
  const account = accounts.find((item) => item.accountId === accountId);
  return { connected: Boolean(account && account.connected), accountId };
};
tiktok.queryCreatorInfo = async (accountId) => ({
  creator_username: (accounts.find((item) => item.accountId === accountId) || {}).username || '',
  privacy_level_options: ['SELF_ONLY']
});
instagram.getInstagramHealth = async () => ({
  success: true, platform: 'instagram', configured: true, canPublish: false, mode: 'dry-run', missing: [], message: 'ok'
});

const routes = require('../src/routes');

test('Max Scheduler campaign creation and Release Queue visibility', async (t) => {
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
  // Defensive isolation: restore the env vars this file sets on top of
  // whatever the runner provided, even though node --test already gives
  // every test file its own process/module cache.
  const envSnapshot = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    ENABLE_INSTAGRAM: process.env.ENABLE_INSTAGRAM
  };
  t.after(() => { Object.assign(process.env, envSnapshot); });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const loginResponse = await fetch(`${baseUrl}/admin-login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-admin-password-123', returnTo: '/private/autoposter' })
  });
  const adminCookie = String(loginResponse.headers.get('set-cookie') || '').split(';')[0];
  assert.match(adminCookie, /^chanter_admin_session=/);

  // ── Default view: the seeded campaign spans 2 channels, so the queue
  // defaults to All Channels and shows a parent campaign summary ─────────
  const defaultResponse = await fetch(`${baseUrl}/private/autoposter`, { headers: { Cookie: adminCookie } });
  const defaultHtml = await defaultResponse.text();
  assert.equal(defaultResponse.status, 200);
  assert.match(defaultHtml, /@__chanter/);
  assert.match(defaultHtml, /@_cdwarrior/);
  assert.match(defaultHtml, /Campaign cmpAAAAA/);
  assert.match(defaultHtml, /class="btn btn-primary" href="\?queueView=all"/);
  assert.doesNotMatch(defaultHtml, /Showing jobs for active channel only/);
  // Release Plan intake fields are present.
  assert.match(defaultHtml, /name="startDate"/);
  assert.match(defaultHtml, /name="startTime"/);
  assert.match(defaultHtml, /name="offsetMinutes"/);

  // ── Active Channel mode: only the active channel's job, plus the
  // required explanatory copy ─────────────────────────────────────────────
  const activeResponse = await fetch(`${baseUrl}/private/autoposter?queueView=active`, { headers: { Cookie: adminCookie } });
  const activeHtml = await activeResponse.text();
  assert.equal(activeResponse.status, 200);
  // The channel picker always lists every account regardless of queue
  // view, so the channel-scoping check has to look at queue-card-only
  // content (the job's original filename), not the bare @handle.
  assert.match(activeHtml, /chanter-queued\.jpg/);
  assert.doesNotMatch(activeHtml, /cdwarrior-queued\.jpg/);
  assert.match(activeHtml, /Showing jobs for active channel only\. Switch to All Channels to view all campaign jobs\./);
  assert.match(activeHtml, /class="btn btn-primary" href="\?queueView=active"/);

  // ── All Channels mode explicitly requested ──────────────────────────────
  const allResponse = await fetch(`${baseUrl}/private/autoposter?queueView=all`, { headers: { Cookie: adminCookie } });
  const allHtml = await allResponse.text();
  assert.equal(allResponse.status, 200);
  assert.match(allHtml, /chanter-queued\.jpg/);
  assert.match(allHtml, /cdwarrior-queued\.jpg/);
  assert.match(allHtml, /2 channels/);
  assert.match(allHtml, /2 jobs/);

  // No token or secret values are rendered in any view mode.
  for (const html of [defaultHtml, activeHtml, allHtml]) {
    assert.doesNotMatch(html, /secret-token/);
    assert.doesNotMatch(html, /secret-refresh/);
    assert.doesNotMatch(html, /access_token/);
  }

  // ── Max Scheduler: two channels, explicit start date/time, default offset ──
  const dualBody = new FormData();
  dualBody.append('publicMediaUrl', 'https://cdn.example.com/asset.jpg');
  dualBody.append('caption', 'Max Scheduler drop');
  dualBody.append('targetChannels', 'chanter-open-id');
  dualBody.append('targetChannels', 'cdwarrior-open-id');
  dualBody.append('startDate', '2026-07-07');
  dualBody.append('startTime', '09:00');
  dualBody.append('timezoneOffsetMinutes', '0');
  const dualResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: dualBody
  });
  assert.equal(dualResponse.status, 302);
  assert.equal(applyExplicitScheduleCalls.length, 1, 'Max Scheduler path was used instead of autoSchedulePosts');
  assert.equal(autoScheduleCalls.length, 0);
  const firstPlan = applyExplicitScheduleCalls[0].plan;
  assert.equal(firstPlan.baseAt, '2026-07-07T09:00:00.000Z');
  assert.equal(firstPlan.channels[0].accountId, 'chanter-open-id');
  assert.equal(firstPlan.channels[0].scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(firstPlan.channels[1].accountId, 'cdwarrior-open-id');
  assert.equal(firstPlan.channels[1].scheduledAt, '2026-07-07T09:05:00.000Z');
  const createdChanterJob = queueJobs.find((job) => job.id.startsWith('created-1-') && job.accountId === 'chanter-open-id');
  const createdCdwarriorJob = queueJobs.find((job) => job.id.startsWith('created-1-') && job.accountId === 'cdwarrior-open-id');
  assert.equal(createdChanterJob.scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(createdCdwarriorJob.scheduledAt, '2026-07-07T09:05:00.000Z');
  assert.equal(createdCdwarriorJob.channelOffsetMinutes, 5);

  // ── Custom offset (+10 minutes) ─────────────────────────────────────────
  const customOffsetBody = new FormData();
  customOffsetBody.append('publicMediaUrl', 'https://cdn.example.com/asset.jpg');
  customOffsetBody.append('caption', 'Custom offset drop');
  customOffsetBody.append('targetChannels', 'chanter-open-id');
  customOffsetBody.append('targetChannels', 'cdwarrior-open-id');
  customOffsetBody.append('startDate', '2026-07-08');
  customOffsetBody.append('startTime', '10:00');
  customOffsetBody.append('offsetMinutes', '10');
  customOffsetBody.append('timezoneOffsetMinutes', '0');
  const customOffsetResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: customOffsetBody
  });
  assert.equal(customOffsetResponse.status, 302);
  const secondPlan = applyExplicitScheduleCalls[1].plan;
  assert.equal(secondPlan.channels[1].scheduledAt, '2026-07-08T10:10:00.000Z');

  // ── Preflight: Max Scheduler blocks a disconnected channel server-side ──
  const disconnectedBody = new FormData();
  disconnectedBody.append('publicMediaUrl', 'https://cdn.example.com/asset.jpg');
  disconnectedBody.append('targetChannels', 'retired-open-id');
  const beforeDisconnected = addUploadedPostsCalls.length;
  const disconnectedResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: disconnectedBody
  });
  assert.equal(disconnectedResponse.status, 302);
  assert.match(String(disconnectedResponse.headers.get('location')), /reconnected/);
  assert.equal(addUploadedPostsCalls.length, beforeDisconnected, 'the pre-existing connected-channel guard already blocks this before Max Scheduler runs');

  // ── Single-channel campaign at an explicit start date/time ──────────────
  const soloBody = new FormData();
  soloBody.append('publicMediaUrl', 'https://cdn.example.com/asset.jpg');
  soloBody.append('caption', 'Solo Max Scheduler drop');
  soloBody.append('startDate', '2026-07-09');
  soloBody.append('startTime', '08:00');
  soloBody.append('timezoneOffsetMinutes', '0');
  const soloResponse = await fetch(`${baseUrl}/upload`, {
    method: 'POST', redirect: 'manual', headers: { Cookie: adminCookie }, body: soloBody
  });
  assert.equal(soloResponse.status, 302);
  const soloPlan = applyExplicitScheduleCalls[applyExplicitScheduleCalls.length - 1].plan;
  assert.equal(soloPlan.channels.length, 1);
  assert.equal(soloPlan.channels[0].scheduledAt, '2026-07-09T08:00:00.000Z');

  // ── Changing the active channel does not mutate a Max Scheduler job's
  // scheduledAt/offset ─────────────────────────────────────────────────────
  const beforeSwitch = JSON.stringify(queueJobs);
  const updateCallsBeforeSwitch = updatePostCalls.length;
  const switchResponse = await fetch(`${baseUrl}/private/autoposter/account`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: adminCookie },
    body: new URLSearchParams({ accountId: 'cdwarrior-open-id' })
  });
  assert.equal(switchResponse.status, 302);
  assert.equal(JSON.stringify(queueJobs), beforeSwitch, 'switching the active channel must not change any queued job');
  assert.equal(updatePostCalls.length, updateCallsBeforeSwitch);

  // ── Dashboard: All Channels / per-channel filter is present and carries
  // no secrets, alongside the campaign/channel fields it's built from ──────
  const dashboardResponse = await fetch(`${baseUrl}/api/private/autoposter/dashboard`, { headers: { Cookie: adminCookie } });
  const dashboardData = await dashboardResponse.json();
  assert.equal(dashboardResponse.status, 200);
  assert.ok(dashboardData.accounts.some((account) => account.username === '__chanter'));
  assert.ok(dashboardData.accounts.some((account) => account.username === '_cdwarrior'));
  dashboardData.accounts.forEach((account) => {
    assert.equal('access_token' in account, false);
    assert.equal('refresh_token' in account, false);
  });
  assert.doesNotMatch(JSON.stringify(dashboardData), /secret-token|secret-refresh/);

  const dashboardSource = require('node:fs').readFileSync(
    path.join(__dirname, '..', 'src', 'pages', 'AutoPosterDashboard.jsx'),
    'utf8'
  );
  assert.match(dashboardSource, /option value="all">All channels<\/option>/);
  assert.match(dashboardSource, /accountFilter/);
  assert.match(dashboardSource, /summarizeDashboardCampaigns/);
});
