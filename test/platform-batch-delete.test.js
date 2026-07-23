'use strict';

// V1.2 Phase A: safe per-item and whole-batch delete. Batch items ARE
// ordinary posts, so the canonical delete authority is applicationService
// .deletePost -> storage.deletePost's own state-gated transaction; this
// layer (batchService.deleteItem/deleteBatch) adds batch membership, the
// approval lock, and batch-record bookkeeping. Only storage is faked.

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  createAutoPosterApplicationService,
  createExecutionContext
} = require('../src/autoposterApplicationService');
const { createBatchService } = require('../src/batchService');

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');
const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 10, prepareConcurrency: 2, prepareMaxAttempts: 3, prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30, staggerMinMinutes: 5, staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10, downloadTimeoutMs: 5_000, maxDownloadBytes: 250 * 1024 * 1024
  }
};

function uploadFile(name) {
  return { path: `/tmp/${name}`, originalname: name, filename: name, mimetype: 'video/mp4', size: 1024 };
}

function makeWorld({ nowMs = BASE_NOW } = {}) {
  const tiktokAccounts = [
    {
      accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
      username: 'creator_a', connected: true,
      access_token: 'tt-access', refresh_token: 'tt-refresh', scope: 'user.info.basic,video.publish'
    }
  ];
  const posts = [];
  const batchRecords = new Map();
  const calls = { deletePost: [] };
  let sequence = 0;
  let now = nowMs;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getCanonicalTikTokAccounts(userId) { return userId === 'owner' ? tiktokAccounts : []; },
    async getTikTokAccount(userId, accountId) {
      return userId === 'owner' ? (tiktokAccounts.find((a) => a.accountId === accountId) || null) : null;
    },
    async getPosts(userId, accountId) {
      return userId === 'owner' ? posts.filter((post) => !accountId || post.accountId === accountId) : [];
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      const targets = Array.isArray(defaults.accounts) && defaults.accounts.length > 0
        ? defaults.accounts
        : [{ accountId: defaults.accountId, tiktokOpenId: defaults.tiktokOpenId, username: defaults.username }];
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = [];
      for (const target of targets) {
        for (let sourceIdx = 0; sourceIdx < sources.length; sourceIdx += 1) {
          const file = sources[sourceIdx];
          const post = postFromDoc({
            id: `post-${++sequence}`,
            data: () => ({
              userId, workspaceId: defaults.workspaceId, platform: defaults.provider, provider: defaults.provider,
              accountId: target.accountId, tiktokOpenId: target.tiktokOpenId, username: target.username,
              originalName: file ? file.originalname : '', fileName: file ? file.originalname : '',
              mediaType: 'video', mediaUrl: `https://cdn.example.com/${target.accountId}/${file ? file.originalname : 'url'}`,
              cloudinaryPublicId: `cld-${target.accountId}-${file ? file.originalname : 'url'}`,
              caption: defaults.caption, hashtags: defaults.hashtags, scheduledAt: null, status: 'pending',
              approvedAt: null, approvedBy: null,
              createdAt: { toDate: () => new Date(now) }, updatedAt: { toDate: () => new Date(now) },
              batchId: defaults.batchId || '',
              batchOrder: defaults.batchId ? created.length : null,
              sourceIndex: defaults.batchId ? sourceIdx : null,
              preparation: defaults.batchId
                ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
                : null
            })
          });
          posts.push(post);
          created.push(post);
        }
      }
      return created;
    },
    async applyBatchSourceSchedule(userId, created, plan) {
      const slotsByIndex = new Map((plan.slots || []).map((slot) => [slot.index, slot]));
      let count = 0;
      created.forEach((created_post) => {
        const stored = posts.find((post) => post.id === created_post.id);
        const slot = slotsByIndex.get(stored.sourceIndex);
        if (!slot) throw new Error(`No schedule slot found for source video index ${stored.sourceIndex}.`);
        stored.scheduledAt = slot.scheduledAt;
        stored.status = 'scheduled';
        stored.channelOffsetMinutes = 0;
        stored.campaignStartAt = plan.baseAt || slot.scheduledAt;
        count += 1;
      });
      return count;
    },
    async updatePost(userId, id, patch, accountId) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      Object.assign(post, patch);
      return post;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      if (!['pending', 'scheduled', 'failed', 'ready'].includes(post.status)) return null;
      post.approved = true;
      post.approvalState = 'approved';
      post.approvedAt = new Date(now).toISOString();
      post.approvedBy = approvedBy;
      return post;
    },
    // Mirrors the real storage.deletePost state-gate contract (minus
    // Cloudinary/usage side effects, which live entirely inside storage.js
    // and are unchanged by V1.2 — covered by live verification instead).
    async deletePost(userId, id, accountId) {
      calls.deletePost.push({ userId, id, accountId });
      const post = posts.find((item) => item.id === id && item.userId === userId && (!accountId || item.accountId === accountId));
      if (!post) return false;
      if (!['pending', 'scheduled', 'ready', 'failed'].includes(post.status)) {
        const error = new Error('This queue state cannot be deleted safely.');
        error.status = 409;
        error.code = 'queue_transition_blocked';
        throw error;
      }
      posts.splice(posts.indexOf(post), 1);
      return true;
    },
    async createBatchRecord(record) {
      if (batchRecords.has(record.batchId)) {
        const error = new Error('already exists');
        error.code = 6;
        throw error;
      }
      const stored = {
        ...record, preparedCount: 0, failedCount: 0, acceptedCount: 0, deletedCount: 0,
        createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
      };
      batchRecords.set(record.batchId, stored);
      return { ...stored };
    },
    async getBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      return record && record.userId === userId ? { ...record } : null;
    },
    async listBatchRecords(userId) {
      return [...batchRecords.values()].filter((record) => record.userId === userId).map((record) => ({ ...record }));
    },
    async updateBatchRecord(userId, batchId, patch) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return null;
      Object.assign(record, patch, { updatedAt: new Date(now).toISOString() });
      return { ...record };
    },
    async incrementBatchDeletedCount(userId, batchId, delta) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId || !Number.isInteger(delta) || delta <= 0) return record ? { ...record } : null;
      record.deletedCount = Number(record.deletedCount || 0) + delta;
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return false;
      batchRecords.delete(batchId);
      return true;
    },
    async getBatchPosts(userId, batchId) {
      return posts.filter((post) => post.userId === userId && post.batchId === batchId)
        .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));
    },
    async claimBatchItemPreparation(userId, postId, options) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return { outcome: 'not_found' };
      const preparation = post.preparation || {};
      if (preparation.status === 'succeeded') return { outcome: 'already_succeeded', post };
      if (Number(preparation.attempts || 0) >= options.maxAttempts) return { outcome: 'attempts_exhausted', post };
      post.preparation = { ...preparation, status: 'running', attempts: Number(preparation.attempts || 0) + 1, leaseAt: new Date(now).toISOString() };
      return { outcome: 'claimed', post: { ...post } };
    },
    async recordBatchItemPreparationResult(userId, postId, result) {
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post || !post.preparation || post.preparation.status !== 'running') return null;
      if (result.ok) {
        if (result.caption && !String(post.caption || '').trim()) post.caption = result.caption;
        post.preparation = { ...post.preparation, status: 'succeeded', leaseAt: null, provider: result.provider || '', fallbackUsed: false, error: '' };
      } else {
        post.preparation = { ...post.preparation, status: 'failed', leaseAt: null, error: String(result.error || '') };
      }
      return { ok: Boolean(result.ok) };
    }
  };

  const commercial = createCommercialFixture(storage, { planId: 'legacy_full_access' });
  const applicationService = createAutoPosterApplicationService({
    storage, mediaPolicy, commercialService: commercial, now: () => now
  });
  const autoCaption = {
    async analyzeVideoForCaption(videoPath, draft, options) {
      return { caption: `Generated for ${options.filename}`, hashtags: '#auto', provider: 'fake-ai', fallbackUsed: false };
    }
  };
  const batchService = createBatchService({
    config: TEST_BATCH_CONFIG, storage, autoCaption, applicationService,
    downloadMedia: async () => ({ bytes: 1 }), now: () => now, logger: { warn() {} }
  });

  return {
    posts, calls, batchRecords, applicationService, batchService,
    setNow(value) { now = Date.parse(value); },
    get nowMs() { return now; }
  };
}

function websiteContext(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}
function approverContext() {
  return websiteContext({ approval: { approvedBy: 'admin:owner' } });
}

const INTAKE = {
  destinations: [{ provider: 'tiktok', accountId: 'account-a' }],
  scheduleMode: 'interval',
  startDate: '2026-07-11',
  startTime: '09:00',
  timezoneOffsetMinutes: 0,
  staggerMinutes: 30,
  intakeKey: 'delete-intake-1'
};

async function makeBatch(world, fileNames) {
  return world.batchService.createBatch(websiteContext(), {
    ...INTAKE,
    files: fileNames.map(uploadFile)
  });
}

test('deleting an eligible unapproved item removes it and updates the batch summary honestly', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4', 'b.mp4', 'c.mp4']);
  const target = created.items[1];

  const result = await world.batchService.deleteItem(websiteContext(), created.batch.batchId, target.id);
  assert.equal(result.deleted, true);

  const view = await world.batchService.getBatchView(websiteContext(), created.batch.batchId, { autoResume: false });
  assert.equal(view.items.length, 2);
  assert.ok(!view.items.some((item) => item.id === target.id));
  assert.equal(view.batch.itemCount, 2);
  assert.equal(view.batch.deletedCount, 1);
  // Every sibling stays exactly as it was.
  assert.equal(view.items.every((item) => item.id !== target.id), true);
});

test('repeated delete of the same item is idempotent-safe: the second call reports not_found, never a crash', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4']);
  const target = created.items[0];

  await world.batchService.deleteItem(websiteContext(), created.batch.batchId, target.id);
  // Once gone, the item no longer belongs to the batch — a stale repeat
  // delete fails closed with a clear 404, never a crash or a silent no-op.
  await assert.rejects(
    world.batchService.deleteItem(websiteContext(), created.batch.batchId, target.id),
    /does not belong/
  );
});

test('a stale delete request for an item that no longer belongs to the batch is rejected', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4']);
  await assert.rejects(
    world.batchService.deleteItem(websiteContext(), created.batch.batchId, 'never-existed'),
    /does not belong/
  );
});

test('an approved item cannot be silently deleted — approval must be revoked first', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4', 'b.mp4']);
  await world.batchService.startPreparation(websiteContext(), created.batch.batchId);
  await world.batchService.acceptItems(approverContext(), created.batch.batchId, { postIds: [created.items[0].id] });

  await assert.rejects(
    world.batchService.deleteItem(websiteContext(), created.batch.batchId, created.items[0].id),
    /already approved/
  );
  // The unapproved sibling remains freely deletable.
  const result = await world.batchService.deleteItem(websiteContext(), created.batch.batchId, created.items[1].id);
  assert.equal(result.deleted, true);
});

test('whole-batch delete: full cleanup when every item is eligible closes the batch record with zero residue', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4', 'b.mp4', 'c.mp4']);

  const result = await world.batchService.deleteBatch(websiteContext(), created.batch.batchId);
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.deleted.length, 3);
  assert.equal(result.batchClosed, true);

  assert.equal(world.batchRecords.has(created.batch.batchId), false, 'zero postBatches residue');
  assert.equal(world.posts.filter((post) => post.batchId === created.batch.batchId).length, 0, 'zero post residue');
});

test('whole-batch delete: one accepted sibling among unapproved siblings blocks only itself and reports honestly', async () => {
  const world = makeWorld();
  const created = await makeBatch(world, ['a.mp4', 'b.mp4', 'c.mp4']);
  await world.batchService.startPreparation(websiteContext(), created.batch.batchId);
  await world.batchService.acceptItems(approverContext(), created.batch.batchId, { postIds: [created.items[0].id] });

  const result = await world.batchService.deleteBatch(websiteContext(), created.batch.batchId);
  assert.equal(result.deleted.length, 2);
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].id, created.items[0].id);
  assert.equal(result.failed.length, 0);
  assert.equal(result.batchClosed, false, 'the batch record must survive while the approved item remains');

  // Never report full success while residue exists.
  const view = await world.batchService.getBatchView(websiteContext(), created.batch.batchId, { autoResume: false });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].id, created.items[0].id);
  assert.equal(view.batch.deletedCount, 2);

  // Zero provider publish calls anywhere in this flow.
  assert.ok(world.posts.every((post) => !['processing', 'posted'].includes(post.status)));
});
