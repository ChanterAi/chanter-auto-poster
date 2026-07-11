'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  AutoPosterApplicationError,
  createAutoPosterApplicationService,
  createExecutionContext,
  deterministicPostId
} = require('../src/autoposterApplicationService');

function makeHarness() {
  const accounts = [
    { accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok', username: 'creator_a', connected: true },
    { accountId: 'account-b', open_id: 'open-b', userId: 'owner', platform: 'tiktok', username: 'creator_b', connected: true },
    { accountId: 'account-cold', open_id: 'open-cold', userId: 'owner', platform: 'tiktok', username: 'creator_cold', connected: false }
  ];
  const posts = [];
  const calls = { add: [], update: [], auto: [], explicit: [], delete: [], approve: [], revoke: [] };
  let sequence = 0;
  let nowMs = Date.parse('2026-07-10T10:00:00.000Z');
  let failNextGetPost = false;

  const storage = {
    async getTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getPosts(userId, accountId) {
      if (userId !== 'owner') return [];
      return posts.filter((post) => !accountId || post.accountId === accountId);
    },
    async getPost(userId, id, accountId) {
      if (failNextGetPost) {
        failNextGetPost = false;
        throw new Error('Firestore confirmation unavailable');
      }
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      calls.add.push({ userId, files, defaults });
      if (defaults.documentId && posts.some((post) => post.id === defaults.documentId)) {
        const error = new Error('already exists');
        error.code = 6;
        throw error;
      }
      const created = defaults.accounts.map((account) => {
        const now = '2026-07-10T10:00:00.000Z';
        const post = postFromDoc({
          id: defaults.documentId || `post-${++sequence}`,
          data: () => ({
            userId,
            platform: defaults.provider,
            provider: defaults.provider,
            creationSource: defaults.creationSource,
            createdBy: defaults.createdBy,
            correlationId: defaults.correlationId,
            idempotencyKey: defaults.idempotencyKey,
            runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
            runtimeScheduledBy: defaults.runtimeScheduledBy,
            accountId: account.accountId,
            tiktokOpenId: account.tiktokOpenId,
            username: account.username,
            mediaType: 'video',
            mediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            publicMediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            caption: defaults.caption,
            hashtags: defaults.hashtags,
            scheduledAt: defaults.scheduledAt ? { toDate: () => new Date(defaults.scheduledAt) } : null,
            status: defaults.scheduledAt ? 'scheduled' : 'pending',
            approvedAt: defaults.selfApprove ? { toDate: () => new Date(now) } : null,
            approvedBy: defaults.selfApprove ? defaults.selfApprove.approvedBy : null,
            createdAt: { toDate: () => new Date(now) },
            updatedAt: { toDate: () => new Date(now) }
          })
        });
        posts.push(post);
        return post;
      });
      return created;
    },
    async updatePost(userId, id, patch, accountId, historyEvent) {
      calls.update.push({ userId, id, patch, accountId, historyEvent });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      Object.assign(post, patch);
      if ('scheduledAt' in patch) post.status = patch.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async autoSchedulePosts(userId, ids, accountId) {
      calls.auto.push({ userId, ids, accountId });
      for (const id of ids) {
        const index = posts.findIndex((item) => item.id === id);
        if (index >= 0) posts[index] = {
          ...posts[index],
          scheduledAt: '2026-07-12T09:00:00.000Z',
          status: 'scheduled'
        };
      }
      return ids.length;
    },
    async applyExplicitSchedule(userId, created, plan) {
      calls.explicit.push({ userId, created, plan });
      for (const post of created) {
        const channel = plan.channels.find((item) => item.accountId === post.accountId);
        const index = posts.findIndex((item) => item.id === post.id);
        if (index >= 0) posts[index] = { ...posts[index], scheduledAt: channel.scheduledAt, status: 'scheduled' };
      }
      return created.length;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      calls.approve.push({ userId, id, approvedBy, accountId });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      post.approved = true;
      post.approvalState = 'approved';
      post.approvedBy = approvedBy;
      return post;
    },
    async revokePostApproval(userId, id, accountId) {
      calls.revoke.push({ userId, id, accountId });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      post.approved = false;
      post.approvalState = 'unapproved';
      post.approvedBy = '';
      return post;
    },
    async deletePost(userId, id, accountId) {
      calls.delete.push({ userId, id, accountId });
      const index = posts.findIndex((post) => post.id === id && (!accountId || post.accountId === accountId));
      if (index < 0) return false;
      posts.splice(index, 1);
      return true;
    },
    async reschedulePendingQueue(userId, accountId) {
      return posts.filter((post) => post.accountId === accountId).length;
    }
  };

  return {
    accounts,
    calls,
    posts,
    service: createAutoPosterApplicationService({ storage, mediaPolicy, now: () => nowMs }),
    setNow(value) { nowMs = Date.parse(value); },
    failConfirmationOnce() { failNextGetPost = true; }
  };
}

function context(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}

test('execution context is explicit and does not invent a workspace', () => {
  const resolved = context({ accountId: 'account-a', correlationId: 'trace-1' });
  assert.equal(resolved.userId, 'owner');
  assert.equal(resolved.source, 'website');
  assert.equal(resolved.workspaceId, null);
  assert.equal(resolved.correlationId, 'trace-1');
  assert.throws(() => createExecutionContext({ source: 'website' }), AutoPosterApplicationError);
  assert.throws(() => createExecutionContext({ userId: 'owner', source: 'provider' }), /request source/);
});

test('website and Runtime schedules share one operation and canonical queue shape', async () => {
  const harness = makeHarness();
  const website = await harness.service.schedulePost(
    context({ accountId: 'account-a', approval: { approvedBy: 'client:@creator_a' } }),
    {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/site.mp4',
      caption: ' Website caption ',
      schedule: { mode: 'automatic' },
      requireSingle: true
    }
  );
  const runtime = await harness.service.schedulePost(
    context({
      source: 'runtime',
      actorId: 'mcp-client',
      accountId: 'account-b',
      idempotency: { key: 'runtime-key-1' }
    }),
    {
      accountId: 'account-b',
      mediaUrl: 'https://cdn.example.com/runtime.mp4',
      caption: ' Runtime caption ',
      requestedBy: 'mcp-client',
      requireSingle: true,
      schedule: {
        mode: 'explicit',
        scheduledAt: '2026-07-12T11:00:00+02:00',
        requireExplicitTimezone: true,
        requireFuture: true
      }
    }
  );

  assert.equal(harness.calls.add.length, 2);
  assert.equal(harness.calls.add[0].defaults.provider, 'tiktok');
  assert.equal(harness.calls.add[0].defaults.creationSource, 'website');
  assert.equal(harness.calls.add[0].defaults.selfApprove.approvedBy, 'client:@creator_a');
  assert.equal(harness.calls.add[1].defaults.creationSource, 'runtime');
  assert.equal(harness.calls.add[1].defaults.selfApprove, null, 'Runtime cannot self-approve');
  assert.equal(harness.calls.add[1].defaults.createOnly, true);
  assert.equal(harness.calls.add[1].defaults.idempotencyKey, 'runtime-key-1');
  assert.deepEqual(Object.keys(website.post).sort(), Object.keys(runtime.post).sort());
  assert.equal(website.post.provider, 'tiktok');
  assert.equal(runtime.post.provider, 'tiktok');
  assert.equal(runtime.post.status, 'scheduled');
  assert.equal(runtime.post.scheduledAt, '2026-07-12T09:00:00.000Z');
});

test('runtime idempotency uses one deterministic create-only queue document', async () => {
  const harness = makeHarness();
  const runtimeContext = context({
    source: 'runtime',
    actorId: 'mcp-client',
    accountId: 'account-a',
    idempotency: { key: 'same-key' }
  });
  const input = {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/runtime.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  };

  const first = await harness.service.schedulePost(runtimeContext, input);
  const second = await harness.service.schedulePost(runtimeContext, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(harness.calls.add.length, 1);
  assert.equal(first.post.id, deterministicPostId('owner', 'account-a', 'same-key'));
  assert.equal(second.post.id, first.post.id);
  first.post.status = 'posted';
  harness.setNow('2026-07-13T09:00:00.000Z');
  const terminalDuplicate = await harness.service.schedulePost(runtimeContext, input);
  assert.equal(terminalDuplicate.duplicate, true, 'past-time replays and later lifecycle states return the original');
  assert.equal(terminalDuplicate.post.status, 'posted');
});

test('a concurrent Firestore create race returns the already-created scheduled item', async () => {
  let existing = null;
  let addCalls = 0;
  const storage = {
    async getTikTokAccount() {
      return {
        accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
        username: 'creator_a', connected: true
      };
    },
    async getPosts() { return []; },
    async getPost() { return existing; },
    async addUploadedPosts(userId, files, defaults) {
      addCalls += 1;
      existing = postFromDoc({
        id: defaults.documentId,
        data: () => ({
          userId,
          platform: 'tiktok',
          provider: 'tiktok',
          creationSource: 'runtime',
          idempotencyKey: defaults.idempotencyKey,
          runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
          accountId: 'account-a',
          tiktokOpenId: 'open-a',
          username: 'creator_a',
          mediaType: 'video',
          caption: '',
          scheduledAt: { toDate: () => new Date(defaults.scheduledAt) },
          status: 'scheduled',
          approvedAt: null
        })
      });
      const error = new Error('document already exists');
      error.code = 6;
      throw error;
    }
  };
  const service = createAutoPosterApplicationService({
    storage,
    mediaPolicy,
    now: () => Date.parse('2026-07-10T10:00:00.000Z')
  });
  const result = await service.schedulePost(context({
    source: 'runtime',
    accountId: 'account-a',
    idempotency: { key: 'racing-key' }
  }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/race.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  });

  assert.equal(addCalls, 1);
  assert.equal(result.duplicate, true);
  assert.equal(result.post.status, 'scheduled');
  assert.equal(result.post.id, deterministicPostId('owner', 'account-a', 'racing-key'));
});

test('an old incomplete idempotent draft fails truthfully instead of claiming scheduled success', async () => {
  const harness = makeHarness();
  harness.posts.push({
    id: 'old-partial',
    userId: 'owner',
    accountId: 'account-a',
    status: 'pending',
    scheduledAt: null,
    idempotencyKey: 'old-key',
    runtimeIdempotencyKey: 'old-key'
  });

  await assert.rejects(
    harness.service.schedulePost(context({
      source: 'runtime',
      accountId: 'account-a',
      idempotency: { key: 'old-key' }
    }), {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/old.mp4',
      requireSingle: true,
      schedule: {
        mode: 'explicit',
        scheduledAt: '2026-07-12T09:00:00Z',
        requireExplicitTimezone: true,
        requireFuture: true
      }
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.details.createdPostId, 'old-partial');
      assert.match(error.message, /incomplete draft/);
      return true;
    }
  );
  assert.equal(harness.calls.add.length, 0);
});

test('explicit Runtime scheduling is complete in the initial deterministic write', async () => {
  const harness = makeHarness();
  const runtimeContext = context({
    source: 'runtime',
    accountId: 'account-a',
    idempotency: { key: 'atomic-key' }
  });
  const result = await harness.service.schedulePost(runtimeContext, {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/atomic.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  });
  assert.equal(result.post.status, 'scheduled');
  assert.equal(result.post.scheduledAt, '2026-07-12T09:00:00.000Z');
  assert.equal(result.post.idempotencyKey, 'atomic-key');
  assert.equal(result.post.runtimeIdempotencyKey, 'atomic-key');
  assert.equal(harness.calls.update.length, 0, 'no post-create schedule patch exists');
});

test('the existing controlled live-test plan also uses schedulePost', async () => {
  const harness = makeHarness();
  const result = await harness.service.schedulePost(context({
    source: 'internal_worker',
    actorId: 'controlled-live-publish-test'
  }), {
    accountIds: ['account-a', 'account-b'],
    mediaUrl: 'https://cdn.example.com/controlled.mp4',
    caption: 'Controlled test',
    schedule: {
      mode: 'explicit_plan',
      plan: {
        baseAt: '2026-07-12T09:00:00Z',
        offsetMinutes: 5,
        channels: [
          { accountId: 'account-a', scheduledAt: '2026-07-12T09:00:00Z', offsetMinutes: 0, order: 0 },
          { accountId: 'account-b', scheduledAt: '2026-07-12T09:05:00Z', offsetMinutes: 5, order: 1 }
        ]
      }
    }
  });
  assert.equal(result.scheduledCount, 2);
  assert.deepEqual(result.posts.map((post) => post.status), ['scheduled', 'scheduled']);
  assert.equal(harness.calls.explicit.length, 1);
});

test('the controlled live-test plan preserves zero-buffer due-now scheduling but rejects stale plans', async () => {
  const harness = makeHarness();
  const internalContext = context({
    source: 'internal_worker',
    actorId: 'controlled-live-publish-test'
  });
  const dueNow = {
    accountIds: ['account-a'],
    mediaUrl: 'https://cdn.example.com/due-now.mp4',
    caption: 'Due now controlled test',
    schedule: {
      mode: 'explicit_plan',
      plan: {
        baseAt: '2026-07-10T10:00:00Z',
        offsetMinutes: 0,
        channels: [
          { accountId: 'account-a', scheduledAt: '2026-07-10T10:00:00Z', offsetMinutes: 0, order: 0 }
        ]
      }
    }
  };

  const result = await harness.service.schedulePost(internalContext, dueNow);
  assert.equal(result.scheduledCount, 1);
  assert.equal(result.post.scheduledAt, '2026-07-10T10:00:00.000Z');

  const stale = structuredClone(dueNow);
  stale.mediaUrl = 'https://cdn.example.com/stale.mp4';
  stale.schedule.plan.baseAt = '2026-07-10T09:58:59Z';
  stale.schedule.plan.channels[0].scheduledAt = '2026-07-10T09:58:59Z';
  await assert.rejects(
    harness.service.schedulePost(internalContext, stale),
    /controlled schedule plan is stale/
  );
  assert.equal(harness.calls.add.length, 1, 'a stale controlled plan is rejected before queue creation');
});

test('a post-commit confirmation failure reports unknown scheduling truth', async () => {
  const harness = makeHarness();
  harness.failConfirmationOnce();
  await assert.rejects(
    harness.service.schedulePost(context({ accountId: 'account-a' }), {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/unknown.mp4',
      schedule: { mode: 'automatic' },
      requireSingle: true
    }),
    (error) => {
      assert.equal(error.status, 500);
      assert.match(error.message, /could not be fully confirmed/);
      assert.equal(error.message.includes('unscheduled drafts'), false);
      assert.equal(error.details.createdPostIds.length, 1);
      return true;
    }
  );
});

test('queue, status, media, approval, retry, and delete operations preserve scope and truth', async () => {
  const harness = makeHarness();
  const created = await harness.service.schedulePost(context({ accountId: 'account-a' }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/a.mp4',
    schedule: { mode: 'automatic' },
    requireSingle: true
  });
  const postId = created.post.id;

  const queue = await harness.service.listQueue(context(), { accountId: 'account-a', limit: 10 });
  assert.equal(queue.count, 1);
  assert.equal(queue.counts.scheduled, 1);
  assert.equal((await harness.service.getPostStatus(context(), { postId, accountId: 'account-a' })).post.id, postId);
  await assert.rejects(
    harness.service.getPostStatus(context(), { postId, accountId: 'account-b' }),
    (error) => error.code === 'not_found'
  );

  assert.equal(harness.service.validateMedia(context(), { mediaUrl: 'https://cdn.example.com/a.mp4' }).valid, true);
  assert.equal(harness.service.validateMedia(context(), { mediaUrl: 'https://cdn.example.com/a.jpg' }).valid, false);
  assert.throws(() => harness.service.validateMedia(context(), {}), /Provide mediaUrl/);

  assert.equal((await harness.service.approvePost(context({
    accountId: 'account-a',
    approval: { approvedBy: 'admin:owner' }
  }), { postId })).ok, true);
  await assert.rejects(
    harness.service.approvePost(context({ source: 'runtime', accountId: 'account-a' }), { postId }),
    (error) => error.code === 'forbidden'
  );
  assert.equal((await harness.service.revokeApproval(context({ accountId: 'account-a' }), { postId })).ok, true);
  assert.equal((await harness.service.retryPost(context({ accountId: 'account-a' }), { postId })).ok, true);
  const batch = await harness.service.deleteMarkedPosts(context(), { postIds: [postId, 'missing', postId] });
  assert.equal(batch.ok, false);
  assert.deepEqual(batch.deleted, [postId]);
  assert.deepEqual(batch.failed, [{ id: 'missing', reason: 'Post not found in your account.' }]);
  assert.equal(harness.calls.delete.length, 2, 'deduplicated batch reuses individual delete truth');
});

test('controllers delegate queue creation to the application service', () => {
  const root = path.join(__dirname, '..', 'src');
  for (const file of ['routes.js', 'clientRoutes.js', 'runtimeControlRoutes.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.includes('storage.addUploadedPosts'), false, `${file} must not construct queue items`);
    assert.match(source, /autoposterApplicationService/, `${file} must use the shared service`);
  }
  const runtimeSource = fs.readFileSync(path.join(root, 'runtimeControlRoutes.js'), 'utf8');
  for (const forbidden of ['./storage', './mediaPolicy', './scheduler', './tiktok', './instagram']) {
    assert.equal(runtimeSource.includes(`require('${forbidden}')`), false, `runtime route must not require ${forbidden}`);
  }
  const storageSource = fs.readFileSync(path.join(root, 'storage.js'), 'utf8');
  assert.match(storageSource, /batch\.create\(ref, data\)/, 'deterministic idempotency must be create-only');
  const liveTestSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-publish-test.js'), 'utf8');
  assert.equal(liveTestSource.includes('storage.addUploadedPosts'), false, 'controlled CLI must not construct queue items');
  assert.match(liveTestSource, /applicationService\.schedulePost/);
});
