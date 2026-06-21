'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const instagram = require('../src/instagram');
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

  const [unauthorizedAutoPoster, unauthorizedDashboard, unauthorizedApi, unauthorizedConnect] = await Promise.all([
    fetch(`${baseUrl}/private/autoposter`, { redirect: 'manual' }),
    fetch(`${baseUrl}/private/autoposter/dashboard`, { redirect: 'manual' }),
    fetch(`${baseUrl}/api/private/autoposter/dashboard`),
    fetch(`${baseUrl}/connect/tiktok`, { redirect: 'manual' })
  ]);
  assert.equal(unauthorizedAutoPoster.status, 302);
  assert.match(unauthorizedAutoPoster.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedDashboard.status, 302);
  assert.match(unauthorizedDashboard.headers.get('location'), /^\/admin-login/);
  assert.equal(unauthorizedApi.status, 401);
  assert.deepEqual(await unauthorizedApi.json(), { ok: false, reason: 'Admin authentication required' });
  assert.equal(unauthorizedConnect.status, 302);
  assert.match(unauthorizedConnect.headers.get('location'), /^\/admin-login/);

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
  assert.match(autoPosterHtml, /href="\/private\/autoposter\/dashboard"/);
  assert.match(autoPosterHtml, /account-a-history\.jpg/);
  assert.doesNotMatch(autoPosterHtml, /account-b-queue\.jpg/);
  assert.match(autoPosterHtml, /Switch \/ Connect another/);
  assert.doesNotMatch(autoPosterHtml, /Instagram/i);

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
