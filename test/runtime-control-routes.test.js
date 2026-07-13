'use strict';

// Agent Runtime control surface (P1B) — token auth, tenant scoping, media
// policy reuse, idempotent scheduling, truthful failures, and the guarantee
// that nothing on these routes can reach TikTok publishing code.

process.env.RUNTIME_CONTROL_TOKEN = 'test-runtime-token-1234567890';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const express = require('express');

const config = require('../src/config');
const storage = require('../src/storage');
const applicationService = require('../src/autoposterApplicationService');

const TOKEN = 'test-runtime-token-1234567890';

const accounts = [
  { accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok', username: 'creator_a', connected: true },
  { accountId: 'account-cold', open_id: 'open-cold', userId: 'owner', platform: 'tiktok', username: 'creator_cold', connected: false }
];

function makePost(overrides = {}) {
  return {
    id: 'post-1',
    userId: 'owner',
    accountId: 'account-a',
    username: 'creator_a',
    status: 'scheduled',
    scheduledAt: '2026-07-11T09:00:00.000Z',
    approved: false,
    approvedAt: null,
    approvedBy: '',
    mediaType: 'video',
    caption: 'First drop',
    createdAt: '2026-07-10T08:00:00.000Z',
    updatedAt: '2026-07-10T08:00:00.000Z',
    postedAt: null,
    publishId: '',
    claimAttempts: 0,
    lastResult: null,
    runtimeIdempotencyKey: '',
    runtimeScheduledBy: '',
    ...overrides
  };
}

// Mutable behavior the tests steer per scenario.
const state = {
  posts: [makePost()],
  getPostsError: null,
  addUploadedPostsCalls: [],
  updatePostCalls: [],
  updatePostResult: 'apply', // 'apply' | 'null' | 'throw'
  tiktokTouched: []
};

storage.getTikTokAccount = async (userId, accountId) => {
  if (userId !== config.defaultUserId) return null;
  return accounts.find((account) => account.accountId === accountId) || null;
};
storage.getYouTubeAccount = async () => null;
storage.getPosts = async (userId, accountId) => {
  if (state.getPostsError) throw state.getPostsError;
  if (userId !== config.defaultUserId) return [];
  return state.posts.filter((post) => !accountId || post.accountId === accountId);
};
storage.getPost = async (userId, id, accountId) => {
  if (userId !== config.defaultUserId) return null;
  const post = state.posts.find((item) => item.id === id) || null;
  if (!post) return null;
  if (accountId && post.accountId !== accountId) return null;
  return post;
};
storage.addUploadedPosts = async (userId, files, defaults) => {
  state.addUploadedPostsCalls.push({ userId, files, defaults });
  // Mirror the real chokepoint's video-only URL refusal (mediaPolicy-backed).
  const { isVideoMediaUrl } = require('../src/mediaPolicy');
  const url = String(defaults.publicMediaUrl || '').trim();
  if (url && !isVideoMediaUrl(url)) {
    const error = new Error('TikTok posting is video-only. The Public Media URL must point directly to an MP4, MOV, or WebM video file.');
    error.status = 400;
    throw error;
  }
  const target = defaults.accounts[0];
  const created = makePost({
    id: `created-${state.addUploadedPostsCalls.length}`,
    accountId: target.accountId,
    username: target.username,
    status: defaults.scheduledAt ? 'scheduled' : 'pending',
    scheduledAt: defaults.scheduledAt || null,
    caption: String(defaults.caption || ''),
    idempotencyKey: defaults.idempotencyKey || '',
    runtimeIdempotencyKey: defaults.runtimeIdempotencyKey || '',
    runtimeScheduledBy: defaults.runtimeScheduledBy || ''
  });
  state.posts.push(created);
  return [created];
};
storage.updatePost = async (userId, id, patch, accountId, historyEvent) => {
  state.updatePostCalls.push({ userId, id, patch, accountId, historyEvent });
  if (state.updatePostResult === 'throw') throw new Error('Firestore update failed');
  if (state.updatePostResult === 'null') return null;
  const scheduled = makePost({
    id,
    accountId,
    status: 'scheduled',
    scheduledAt: patch.scheduledAt,
    runtimeIdempotencyKey: patch.runtimeIdempotencyKey,
    runtimeScheduledBy: patch.runtimeScheduledBy
  });
  state.posts.push(scheduled);
  return scheduled;
};

// Trip-wire: none of these may ever be called from the runtime control surface.
const tiktok = require('../src/tiktok');
for (const key of Object.keys(tiktok)) {
  if (typeof tiktok[key] === 'function') {
    const name = key;
    tiktok[name] = async () => {
      state.tiktokTouched.push(name);
      throw new Error(`runtime control surface must never call tiktok.${name}`);
    };
  }
}

const { installCommercialFixture } = require('./helpers/commercial-fixture');
installCommercialFixture(require('../src/commercialService'), storage);
const runtimeControlRoutes = require('../src/runtimeControlRoutes');

function futureIso(minutesAhead = 90) {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

test('runtime control routes: auth, scoping, media policy, idempotent scheduling', async (t) => {
  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  // Mirror server.js's error middleware for /api/ JSON error truthfulness.
  app.use((error, req, res, next) => {
    if (!error) { next(); return; }
    res.status(error.status || 500).json({ ok: false, reason: error.message || 'Unexpected server error' });
  });

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const call = (method, pathName, { token = TOKEN, body } = {}) =>
    fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        ...(token === null ? {} : { 'x-chanter-runtime-token': token }),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json'
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });

  // ── Fail closed: no token configured -> 503 for everything ──────────────
  const configuredToken = config.runtimeControl.token;
  config.runtimeControl.token = '';
  const disabled = await call('GET', '/api/runtime/queue');
  assert.equal(disabled.status, 503);
  assert.equal((await disabled.json()).ok, false);
  config.runtimeControl.token = configuredToken;

  // ── Unauthorized: missing or wrong token never reaches storage ──────────
  const before = state.addUploadedPostsCalls.length;
  for (const token of [null, 'wrong-token']) {
    const refused = await call('POST', '/api/runtime/schedule', {
      token,
      body: { accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k' }
    });
    assert.equal(refused.status, 401);
    const payload = await refused.json();
    assert.equal(payload.ok, false);
    assert.equal(payload.code, 'unauthorized');
  }
  assert.equal(state.addUploadedPostsCalls.length, before, 'unauthorized calls must not create posts');

  // ── Queue list: authorized scope, bounded, truthful empty, failure ──────
  const list = await call('GET', '/api/runtime/queue?accountId=account-a&limit=10');
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.count, 1);
  assert.equal(listBody.scope.accountId, 'account-a');
  assert.equal(listBody.items[0].id, 'post-1');
  assert.equal(listBody.items[0].approved, false);
  assert.equal(listBody.items[0].mediaUrl, undefined, 'raw media URLs are not exposed');
  assert.equal(listBody.items[0].provider, 'tiktok', 'queue items expose canonical provider identity');
  assert.equal(typeof listBody.items[0].connectedAccountId, 'string', 'connected-account identity is safe metadata');

  const unknownScope = await call('GET', '/api/runtime/queue?accountId=account-nope');
  assert.equal(unknownScope.status, 404);
  assert.equal((await unknownScope.json()).code, 'not_found');

  const badLimit = await call('GET', '/api/runtime/queue?limit=0');
  assert.equal(badLimit.status, 400);

  const savedPosts = state.posts;
  state.posts = [];
  const empty = await call('GET', '/api/runtime/queue');
  const emptyBody = await empty.json();
  assert.equal(empty.status, 200);
  assert.equal(emptyBody.ok, true);
  assert.equal(emptyBody.count, 0);
  assert.deepEqual(emptyBody.items, []);
  state.posts = savedPosts;

  state.getPostsError = new Error('Firestore unavailable');
  const failedList = await call('GET', '/api/runtime/queue');
  assert.equal(failedList.status, 500);
  assert.equal((await failedList.json()).ok, false, 'downstream failure is never an empty success');
  state.getPostsError = null;

  // ── Post status: found, missing, and account-scope isolation ────────────
  const status = await call('GET', '/api/runtime/posts/post-1/status');
  const statusBody = await status.json();
  assert.equal(status.status, 200);
  assert.equal(statusBody.post.status, 'scheduled');
  assert.equal(statusBody.post.approved, false);
  assert.equal(statusBody.post.lastErrorMessage, '');

  const missing = await call('GET', '/api/runtime/posts/nope/status');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not_found');

  const wrongScope = await call('GET', '/api/runtime/posts/post-1/status?accountId=account-cold');
  assert.equal(wrongScope.status, 404, 'a post outside the account scope is not found (existing convention)');

  // ── Media validation: reuses mediaPolicy verbatim ────────────────────────
  const mediaCases = [
    [{ fileName: 'clip.mp4', mimeType: 'video/mp4' }, { valid: true, classification: 'video' }],
    [{ fileName: 'photo.jpg', mimeType: 'image/jpeg' }, { valid: false, rejectionCode: 'image_mime' }],
    [{ fileName: 'photo.png', mimeType: 'application/octet-stream' }, { valid: false, rejectionCode: 'image_extension' }],
    [{ fileName: 'clip.png', mimeType: 'video/mp4' }, { valid: false, rejectionCode: 'mime_extension_mismatch' }],
    [{ mediaUrl: 'https://cdn.example.com/clip.mov' }, { valid: true, classification: 'video' }],
    [{ mediaUrl: 'https://cdn.example.com/media' }, { valid: false, rejectionCode: 'unsupported_url' }],
    [{ mediaUrl: 'http://cdn.example.com/clip.mp4' }, { valid: false, rejectionCode: 'not_https_url' }],
    [{ mediaUrl: 'https://cdn.example.com/photo.jpg' }, { valid: false, rejectionCode: 'unsupported_url' }]
  ];
  for (const [body, expected] of mediaCases) {
    const response = await call('POST', '/api/runtime/media/validate', { body });
    assert.equal(response.status, 200, JSON.stringify(body));
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.valid, expected.valid, JSON.stringify(body));
    if (expected.classification) assert.equal(payload.classification, expected.classification);
    if (expected.rejectionCode) assert.equal(payload.rejectionCode, expected.rejectionCode, JSON.stringify(body));
    assert.equal(payload.policy.videoOnly, true);
  }
  const noInput = await call('POST', '/api/runtime/media/validate', { body: {} });
  assert.equal(noInput.status, 400);

  // ── Scheduling: one queue item, unapproved, truthful metadata ────────────
  const scheduledAt = futureIso();
  const schedule = await call('POST', '/api/runtime/schedule', {
    body: {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/new.mp4',
      caption: 'Launch teaser',
      scheduledAt,
      idempotencyKey: 'idem-100',
      requestedBy: 'mcp-client'
    }
  });
  assert.equal(schedule.status, 201);
  const scheduleBody = await schedule.json();
  assert.equal(scheduleBody.ok, true);
  assert.equal(scheduleBody.duplicate, false);
  assert.equal(scheduleBody.post.status, 'scheduled');
  assert.equal(scheduleBody.post.provider, 'tiktok', 'runtime-created items carry canonical provider identity');
  assert.equal(scheduleBody.post.approved, false, 'runtime scheduling never grants approval');
  assert.equal(scheduleBody.post.scheduledAt, new Date(scheduledAt).toISOString());
  assert.equal(state.addUploadedPostsCalls.length, 1, 'exactly one queue item created');
  assert.equal(state.updatePostCalls.length, 0, 'explicit schedule is persisted in the initial create-only write');
  assert.equal(state.addUploadedPostsCalls[0].defaults.runtimeIdempotencyKey, 'idem-100');
  assert.equal(state.addUploadedPostsCalls[0].defaults.scheduledAt, new Date(scheduledAt).toISOString());
  assert.equal(state.addUploadedPostsCalls[0].defaults.createOnly, true);
  assert.match(state.addUploadedPostsCalls[0].defaults.scheduleHistory.detail, /awaits human approval/);

  // ── Idempotency: the same key returns the existing item, creates nothing ─
  const duplicate = await call('POST', '/api/runtime/schedule', {
    body: {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/new.mp4',
      scheduledAt: futureIso(120),
      idempotencyKey: 'idem-100'
    }
  });
  assert.equal(duplicate.status, 200);
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.ok, true);
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.post.id, scheduleBody.post.id);
  assert.equal(state.addUploadedPostsCalls.length, 1, 'no second queue item for a duplicate key');

  // ── Scheduling refusals: timestamps, scope, connectivity, media, key ─────
  const refusals = [
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: 'not-a-date', idempotencyKey: 'k1' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2026-07-11T09:00:00', idempotencyKey: 'k2' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: '2020-01-01T00:00:00Z', idempotencyKey: 'k3' }, 400],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: '' }, 400],
    [{ accountId: 'account-nope', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k4' }, 404],
    [{ accountId: 'account-cold', mediaUrl: 'https://cdn.example.com/a.mp4', scheduledAt: futureIso(), idempotencyKey: 'k5' }, 409],
    [{ accountId: 'account-a', mediaUrl: 'https://cdn.example.com/photo.jpg', scheduledAt: futureIso(), idempotencyKey: 'k6' }, 400]
  ];
  const createsBefore = state.addUploadedPostsCalls.length;
  for (const [body, expectedStatus] of refusals) {
    const refused = await call('POST', '/api/runtime/schedule', { body });
    assert.equal(refused.status, expectedStatus, JSON.stringify(body));
    assert.equal((await refused.json()).ok, false);
  }
  // Shared application validation refuses every bad request before creation;
  // storage still retains its defense-in-depth policy for direct callers.
  assert.equal(state.addUploadedPostsCalls.length - createsBefore, 0);
  assert.equal(state.updatePostCalls.length, 0, 'no refused request applied a schedule');

  // ── No publishing: TikTok module was never touched ───────────────────────
  assert.deepEqual(state.tiktokTouched, [], 'runtime control surface must never call TikTok code');
});

test('runtime control routes: no responses ever contain the service token', async () => {
  // Static guarantee alongside the behavioral ones above: the module never
  // interpolates the token into a response and never requires publish code.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtimeControlRoutes.js'), 'utf8');
  for (const forbidden of ['tiktok', 'instagram', 'scheduler', 'cloudinary']) {
    assert.equal(source.includes(`require('./${forbidden}')`), false, `must not require ${forbidden}`);
  }
  assert.equal(/\bfetch\s*\(/.test(source), false, 'must not call fetch()');
});

test('runtime routes propagate verified workspace context and preserve structured commercial denial', async (t) => {
  const originals = {
    listQueue: applicationService.listQueue,
    getPostStatus: applicationService.getPostStatus,
    schedulePost: applicationService.schedulePost
  };
  t.after(() => Object.assign(applicationService, originals));

  const calls = [];
  applicationService.listQueue = async (context) => {
    calls.push({ operation: 'list', context });
    if (context.workspaceId === 'workspace-b-00000001') {
      throw new applicationService.AutoPosterApplicationError(
        'Workspace not found.',
        { status: 404, code: 'not_found' }
      );
    }
    return {
      items: [],
      totalInScope: 0,
      scope: { workspaceId: context.workspaceId, accountId: 'all' }
    };
  };
  applicationService.getPostStatus = async (context) => {
    calls.push({ operation: 'status', context });
    throw new applicationService.AutoPosterApplicationError(
      'Post not found for this tenant/account scope.',
      { status: 404, code: 'not_found' }
    );
  };
  applicationService.schedulePost = async (context, input) => {
    calls.push({ operation: 'schedule', context, input });
    throw new applicationService.AutoPosterApplicationError(
      'Runtime scheduling is not available on Starter.',
      {
        status: 403,
        code: 'runtime_scheduling_not_allowed',
        details: {
          reasonCode: 'runtime_scheduling_not_allowed',
          current: 0,
          limit: 0,
          remaining: 0,
          planId: 'starter',
          workspaceId: context.workspaceId
        }
      }
    );
  };

  const app = express();
  app.use('/api/runtime', runtimeControlRoutes);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = { 'x-chanter-runtime-token': TOKEN, Accept: 'application/json' };

  const deniedWorkspace = await fetch(
    `${baseUrl}/api/runtime/queue?workspaceId=workspace-b-00000001`,
    { headers }
  );
  assert.equal(deniedWorkspace.status, 404);
  assert.equal((await deniedWorkspace.json()).code, 'not_found');

  const status = await fetch(
    `${baseUrl}/api/runtime/posts/post-b/status?workspaceId=workspace-a-00000001`,
    { headers }
  );
  assert.equal(status.status, 404);

  const schedule = await fetch(`${baseUrl}/api/runtime/schedule`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspaceId: 'workspace-a-00000001',
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/runtime.mp4',
      scheduledAt: futureIso(),
      idempotencyKey: 'workspace-denial-1',
      planId: 'studio',
      entitlementOverrides: { runtimeScheduling: true },
      scheduledPostsPerCycle: 999999
    })
  });
  assert.equal(schedule.status, 403);
  assert.deepEqual(await schedule.json(), {
    ok: false,
    code: 'runtime_scheduling_not_allowed',
    reason: 'Runtime scheduling is not available on Starter.',
    reasonCode: 'runtime_scheduling_not_allowed',
    current: 0,
    limit: 0,
    remaining: 0,
    planId: 'starter',
    workspaceId: 'workspace-a-00000001'
  });

  const scheduleCall = calls.find((call) => call.operation === 'schedule');
  assert.equal(scheduleCall.context.workspaceId, 'workspace-a-00000001');
  assert.equal('planId' in scheduleCall.input, false);
  assert.equal('entitlementOverrides' in scheduleCall.input, false);
  assert.equal('scheduledPostsPerCycle' in scheduleCall.input, false);
  assert.equal(state.addUploadedPostsCalls.length, 1, 'structured denial creates no additional queue item');
});
