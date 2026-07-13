'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';
process.env.OPENAI_API_KEY = 'test-openai-key';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const storage = require('../src/storage');
const tiktok = require('../src/tiktok');
const scheduler = require('../src/scheduler');
const applicationService = require('../src/autoposterApplicationService');
const { attachUser } = require('../src/auth');
const { attachClientSession } = require('../src/clientAuth');

// Two tenants sharing the same underlying app placeholder userId ("owner")
// but isolated from each other purely via accountId — this is exactly the
// boundary the client portal must enforce.
const accounts = {
  'account-a': {
    accountId: 'account-a', id: 'account-a', open_id: 'account-a', userId: 'owner',
    username: 'account_a', displayName: 'Account A', avatarUrl: '', connected: true,
    clientLoginId: 'login-a', clientAccessSecretHash: 'hash-a', clientAccessEnabled: true,
    updatedAt: new Date().toISOString()
  },
  'account-b': {
    accountId: 'account-b', id: 'account-b', open_id: 'account-b', userId: 'owner',
    username: 'account_b', displayName: 'Account B', avatarUrl: '', connected: true,
    clientLoginId: 'login-b', clientAccessSecretHash: 'hash-b', clientAccessEnabled: true,
    updatedAt: new Date().toISOString()
  }
};
const postsByAccount = {
  'account-a': [{
    id: 'post-a', accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a',
    status: 'posted', originalName: 'account-a-history.jpg', mediaType: 'photo',
    mediaUrl: 'https://cdn.example.com/account-a-history.jpg', caption: 'Account A history', hashtags: '#a',
    privacyLevel: 'SELF_ONLY', postedAt: new Date().toISOString(),
    lastResult: { ok: true, reason: 'Posted', response: { access_token: 'should-never-leak' } }
  }],
  'account-b': [{
    id: 'post-b', accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b',
    status: 'scheduled', originalName: 'account-b-queue.jpg', mediaType: 'photo',
    mediaUrl: 'https://cdn.example.com/account-b-queue.jpg', caption: 'Account B queue', hashtags: '#b',
    privacyLevel: 'SELF_ONLY', scheduledAt: new Date(Date.now() + 60_000).toISOString()
  }]
};

storage.resolveClientAccount = async (userId, accountId) => {
  const account = accounts[accountId];
  if (!account || account.userId !== userId || account.clientAccessEnabled === false) return null;
  return account;
};
storage.getTikTokAccount = async (userId, accountId) => accounts[accountId] || null;
storage.getPosts = async (userId, accountId) => postsByAccount[accountId] || [];
storage.getCounts = async (userId, accountId) => {
  const posts = postsByAccount[accountId] || [];
  return posts.reduce((counts, post) => {
    counts.total += 1;
    counts[post.status] = (counts[post.status] || 0) + 1;
    return counts;
  }, { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 });
};
storage.getPost = async (userId, id, accountId) => {
  const post = Object.values(postsByAccount).flat().find((p) => p.id === id);
  if (!post) return null;
  if (accountId && post.accountId !== accountId) return null;
  return post;
};
storage.verifyClientAccessCode = async (rawCode) => {
  if (rawCode === 'login-a.secret-a') return accounts['account-a'];
  if (rawCode === 'login-b.secret-b') return accounts['account-b'];
  return null;
};
storage.updatePost = async (userId, id, patch, accountId) => ({ id, accountId, ...patch });
storage.deletePost = async (userId, id, accountId) => {
  const post = Object.values(postsByAccount).flat().find((p) => p.id === id);
  return Boolean(post && (!accountId || post.accountId === accountId));
};

tiktok.getTikTokAuthStatus = async () => ({ connected: true });

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const clientRoutes = require('../src/clientRoutes');
const routes = require('../src/routes');

async function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(attachUser);
  app.use(attachClientSession);
  app.use('/', clientRoutes);
  app.use('/', routes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return server;
}

test('client portal isolates tenants and blocks admin/debug leakage', async (t) => {
  const server = await buildApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  // Unauthenticated access to the client portal must fail closed to login,
  // never to a broad/empty dashboard.
  const unauthedPortal = await fetch(`${baseUrl}/client/autoposter`, { redirect: 'manual' });
  assert.equal(unauthedPortal.status, 302);
  assert.match(unauthedPortal.headers.get('location'), /^\/client\/autoposter\/login/);

  // A wrong/garbage access code must not authenticate.
  const badLogin = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'not-a-real-code' })
  });
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers.get('set-cookie'), null);

  // Correct code for account A logs in and is bound to account A only.
  const loginA = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'login-a.secret-a' })
  });
  assert.equal(loginA.status, 302);
  assert.equal(loginA.headers.get('location'), '/client/autoposter');
  const cookieA = String(loginA.headers.get('set-cookie') || '').split(';')[0];
  assert.match(cookieA, /^chanter_client_session=/);
  assert.match(String(loginA.headers.get('set-cookie')), /HttpOnly/i);

  const portalA = await fetch(`${baseUrl}/client/autoposter`, { headers: { Cookie: cookieA } });
  const portalAHtml = await portalA.text();
  assert.equal(portalA.status, 200);

  // Sees its own data...
  assert.match(portalAHtml, /account-a-history\.jpg/);
  assert.match(portalAHtml, /Account A history/);
  assert.match(portalAHtml, /You are connected as @account_a/);

  // ...and never account B's data.
  assert.doesNotMatch(portalAHtml, /account-b-queue\.jpg/);
  assert.doesNotMatch(portalAHtml, /Account B queue/);
  assert.doesNotMatch(portalAHtml, /account_b/);

  // No admin/debug surface leaks into the client template.
  assert.doesNotMatch(portalAHtml, /Switch channel/i);
  assert.doesNotMatch(portalAHtml, /Connect Another Channel/i);
  assert.doesNotMatch(portalAHtml, /Command Center/i);
  assert.doesNotMatch(portalAHtml, /Target Publishing Channels/i);
  assert.doesNotMatch(portalAHtml, /should-never-leak/); // raw lastResult debug dump

  // Log in as account B in a separate session and confirm the reverse.
  const loginB = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'login-b.secret-b' })
  });
  const cookieB = String(loginB.headers.get('set-cookie') || '').split(';')[0];
  const portalB = await fetch(`${baseUrl}/client/autoposter`, { headers: { Cookie: cookieB } });
  const portalBHtml = await portalB.text();
  assert.match(portalBHtml, /account-b-queue\.jpg/);
  assert.doesNotMatch(portalBHtml, /account-a-history\.jpg/);

  // Account A's session cannot delete/act on account B's post id, even
  // though it's a directly-guessable id (post-b) — storage-layer ownership
  // check must reject it.
  const crossTenantDelete = await fetch(`${baseUrl}/client/autoposter/posts/post-b/delete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookieA }
  });
  assert.equal(crossTenantDelete.status, 302);
  assert.match(crossTenantDelete.headers.get('location'), /notice=Post%20not%20found/);

  // Revoking access mid-session (fail-closed re-check) must immediately
  // block further access, not wait for token expiry.
  accounts['account-a'].clientAccessEnabled = false;
  const revokedAccess = await fetch(`${baseUrl}/client/autoposter`, { redirect: 'manual', headers: { Cookie: cookieA } });
  assert.equal(revokedAccess.status, 302);
  assert.match(revokedAccess.headers.get('location'), /^\/client\/autoposter\/login/);
  accounts['account-a'].clientAccessEnabled = true; // restore for any later assertions
});

test('client portal shows empty/disconnected states without exposing other data', async (t) => {
  accounts['account-a'].connected = false;
  const emptyAccountId = 'account-empty';
  accounts[emptyAccountId] = {
    accountId: emptyAccountId, id: emptyAccountId, open_id: emptyAccountId, userId: 'owner',
    username: '', displayName: '', avatarUrl: '', connected: false,
    clientLoginId: 'login-empty', clientAccessSecretHash: 'hash-empty', clientAccessEnabled: true,
    updatedAt: null
  };
  postsByAccount[emptyAccountId] = [];
  storage.verifyClientAccessCode = async (rawCode) => {
    if (rawCode === 'login-empty.secret-empty') return accounts[emptyAccountId];
    if (rawCode === 'login-a.secret-a') return accounts['account-a'];
    if (rawCode === 'login-b.secret-b') return accounts['account-b'];
    return null;
  };

  const server = await buildApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const login = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'login-empty.secret-empty' })
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
  const portal = await fetch(`${baseUrl}/client/autoposter`, { headers: { Cookie: cookie } });
  const html = await portal.text();

  assert.equal(portal.status, 200);
  assert.match(html, /Disconnected/);
  assert.match(html, /Reconnect TikTok/);
  assert.match(html, /No posts yet/);
  assert.doesNotMatch(html, /account-a-history\.jpg/);
  assert.doesNotMatch(html, /account-b-queue\.jpg/);

  accounts['account-a'].connected = true;
});

test('commercial denial removes the uploaded client media before redirecting', async (t) => {
  accounts['account-a'].connected = true;
  const server = await buildApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/client/autoposter/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ accessCode: 'login-a.secret-a' })
  });
  const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];

  const originalSchedulePost = applicationService.schedulePost;
  applicationService.schedulePost = async () => {
    throw new applicationService.AutoPosterApplicationError(
      'Starter scheduled post limit reached (30/30).',
      {
        status: 409,
        code: 'monthly_post_limit_reached',
        details: { current: 30, limit: 30, remaining: 0 }
      }
    );
  };
  t.after(() => { applicationService.schedulePost = originalSchedulePost; });

  const form = new FormData();
  form.set('caption', 'Denied upload cleanup');
  form.set('media', new Blob(['safe-test-video'], { type: 'video/mp4' }), 'denied.mp4');
  const uploadsDir = require('../src/config').uploadsDir;
  const beforeFiles = new Set(await fs.readdir(uploadsDir));
  const response = await fetch(`${baseUrl}/client/autoposter/upload`, {
    method: 'POST',
    redirect: 'manual',
    headers: { Cookie: cookie },
    body: form
  });

  assert.equal(response.status, 302);
  assert.match(decodeURIComponent(response.headers.get('location')), /Starter scheduled post limit reached/);
  // Multer succeeded, then the application-service denial cleanup removed
  // the only matching temporary file. No provider or queue operation ran.
  const leftovers = (await fs.readdir(uploadsDir))
    .filter((name) => !beforeFiles.has(name) && name.startsWith('client-'));
  assert.deepEqual(leftovers, []);
});
