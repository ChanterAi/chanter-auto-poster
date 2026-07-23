'use strict';

// V1.1 destination override + per-item YouTube title + mixed-destination
// acceptance. Two layers:
//   1. REAL storage.changePostDestination over an in-memory Firestore fake
//      (transactional gates, field writes, metadata retention, patch strip).
//   2. REAL application service + batch service over in-memory storage
//      fakes (account validation, title contract, mixed acceptance).
// No provider endpoint is ever called; scheduling state is the proof.

// A configured YouTube provider is required, so env is set BEFORE any
// module loads (mirrors youtube-application-service.test.js).
process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.TOKEN_ENCRYPTION_KEY = require('node:crypto').randomBytes(32).toString('base64');
process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.YOUTUBE_CLIENT_SECRET = 'test-client-secret';
process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  createAutoPosterApplicationService,
  createExecutionContext,
  AutoPosterApplicationError
} = require('../src/autoposterApplicationService');
const { createBatchService, BatchServiceError } = require('../src/batchService');

const BASE_NOW = Date.parse('2026-07-10T10:00:00.000Z');
const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

const TEST_BATCH_CONFIG = {
  batchIntake: {
    maxItems: 10,
    prepareConcurrency: 2,
    prepareMaxAttempts: 3,
    prepareLeaseMinutes: 10,
    staggerDefaultMinutes: 30,
    staggerMinMinutes: 5,
    staggerMaxMinutes: 24 * 60,
    safetyBufferMinutes: 10,
    downloadTimeoutMs: 5_000,
    maxDownloadBytes: 250 * 1024 * 1024
  }
};

// ─────────────────────────────────────────────────────────────────────────
// Layer 1: real storage.changePostDestination over a Firestore fake.
// ─────────────────────────────────────────────────────────────────────────

function makeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  return { toDate: () => date };
}

function makeFirestoreFake() {
  const stores = new Map([['posts', new Map()], ['postBatches', new Map()]]);

  function makeRef(storeName, id) {
    const store = stores.get(storeName);
    return {
      id,
      async get() { return makeSnap(storeName, id); },
      async create(data) {
        if (store.has(id)) { const error = new Error('already exists'); error.code = 6; throw error; }
        store.set(id, { ...data });
      },
      async update(patch) {
        if (!store.has(id)) throw new Error(`update on missing doc ${id}`);
        store.set(id, { ...store.get(id), ...patch });
      },
      _apply(method, data) {
        if (method === 'set' || method === 'create') store.set(id, { ...data });
        else store.set(id, { ...(store.get(id) || {}), ...data });
      }
    };
  }

  function makeSnap(storeName, id) {
    const store = stores.get(storeName);
    const raw = store.get(id);
    return { id, exists: store.has(id), data: () => (raw ? { ...raw } : undefined) };
  }

  function makeQuery(storeName, filters) {
    return {
      where(field, op, value) { return makeQuery(storeName, [...filters, [field, value]]); },
      select() { return this; },
      async get() {
        const docs = [];
        for (const id of stores.get(storeName).keys()) {
          const data = stores.get(storeName).get(id);
          if (filters.every(([field, value]) => (data[field] === undefined ? '' : data[field]) === value)) {
            docs.push(makeSnap(storeName, id));
          }
        }
        return { docs };
      }
    };
  }

  function collection(storeName) {
    let autoId = 0;
    return {
      doc(id) { return makeRef(storeName, id || `auto-${++autoId}`); },
      where(field, op, value) { return makeQuery(storeName, [[field, value]]); }
    };
  }

  const db = {
    batch() {
      const operations = [];
      return {
        set(ref, data) { operations.push([ref, 'set', data]); },
        create(ref, data) { operations.push([ref, 'create', data]); },
        update(ref, data) { operations.push([ref, 'update', data]); },
        async commit() { for (const [ref, method, data] of operations) ref._apply(method, data); }
      };
    },
    async runTransaction(fn) {
      return fn({
        get: (ref) => ref.get(),
        update: (ref, patch) => { ref._apply('update', patch); }
      });
    }
  };

  return {
    stores,
    exports: {
      postsCollection: () => collection('posts'),
      postBatchesCollection: () => collection('postBatches'),
      tiktokAccountsCollection: () => collection('tiktokAccounts'),
      youtubeAccountsCollection: () => collection('youtubeAccounts'),
      connectedAccountCapacityCollection: () => collection('connectedAccountCapacity'),
      configDoc: () => ({ get: async () => ({ exists: false, data: () => undefined }), set: async () => {} }),
      getFirestore: () => db,
      Timestamp: { now: () => makeTimestamp(new Date()), fromDate: (date) => makeTimestamp(date) },
      FieldValue: { serverTimestamp: () => makeTimestamp(new Date()), increment: () => 1 }
    }
  };
}

function loadStorageWithFakes(t) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const fake = makeFirestoreFake();
  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true, exports: fake.exports
  };
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath, filename: cloudinaryPath, loaded: true,
    exports: {
      uploadMediaFile: async (file) => ({
        mediaUrl: `https://res.cloudinary.com/test/video/upload/${file.originalname}`,
        publicId: `uploads/${file.originalname}`,
        resourceType: 'video'
      }),
      destroyMediaAsset: async () => {},
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  const storage = require('../src/storage');
  t.after(() => {
    delete require.cache[storagePath];
    delete require.cache[mapperPath];
    delete require.cache[firestorePath];
    delete require.cache[cloudinaryPath];
  });
  return { storage, fake };
}

function tempVideos(t, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-destination-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return names.map((name) => {
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, Buffer.from(`video:${name}`));
    return {
      path: filePath,
      originalname: name,
      filename: name,
      mimetype: 'video/mp4',
      size: fs.statSync(filePath).size
    };
  });
}

const ACCOUNT_DEFAULTS = { accountId: 'account-a', tiktokOpenId: 'open-a', username: 'creator_a' };

test('storage.changePostDestination moves an unapproved draft to YouTube with the full canonical identity', async (t) => {
  const { storage } = loadStorageWithFakes(t);
  const [post] = await storage.addUploadedPosts('owner', tempVideos(t, ['clip.mp4']), {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-dest-1'
  });

  const result = await storage.changePostDestination('owner', post.id, {
    provider: 'youtube',
    accountId: 'UC-chanter',
    tiktokOpenId: '',
    username: 'chanterCy',
    youtube: { title: 'Το βίντεό μου', description: 'Περιγραφή' }
  });

  assert.equal(result.outcome, 'changed');
  assert.equal(result.identityChanged, true);
  const updated = result.post;
  assert.equal(updated.provider, 'youtube');
  assert.equal(updated.platform, 'youtube');
  assert.equal(updated.accountId, 'UC-chanter');
  assert.equal(updated.connectedAccountId, 'youtube:UC-chanter');
  assert.equal(updated.tiktokOpenId, '');
  assert.equal(updated.username, 'chanterCy');
  assert.equal(updated.providerMetadata.youtube.title, 'Το βίντεό μου');
  assert.equal(updated.providerMetadata.youtube.privacyStatus, 'private');
  assert.equal(updated.providerMetadata.youtube.notifySubscribers, false);
  assert.equal(updated.approved, false, 'destination change never approves');
  assert.ok(updated.history.some((entry) => entry.event === 'destination_changed'));
});

test('storage.changePostDestination retains a human YouTube title across a provider round trip', async (t) => {
  const { storage, fake } = loadStorageWithFakes(t);
  const [post] = await storage.addUploadedPosts('owner', tempVideos(t, ['clip.mp4']), {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-dest-2'
  });

  await storage.changePostDestination('owner', post.id, {
    provider: 'youtube', accountId: 'UC-chanter', username: 'chanterCy',
    youtube: { title: 'Κρατήστε αυτόν τον τίτλο', description: '' }
  });
  // Switch AWAY: identity becomes TikTok, but the stored human title stays.
  const back = await storage.changePostDestination('owner', post.id, {
    provider: 'tiktok', accountId: 'account-a', tiktokOpenId: 'open-a', username: 'creator_a'
  });
  assert.equal(back.outcome, 'changed');
  assert.equal(back.post.provider, 'tiktok');
  assert.equal(back.post.tiktokOpenId, 'open-a');
  assert.equal(back.post.providerMetadata.youtube.title, 'Κρατήστε αυτόν τον τίτλο', 'title survives switch-away');

  const raw = fake.stores.get('posts').get(post.id);
  assert.equal(raw.publishAttemptBudget, null, 'TikTok uses the scheduler default budget');

  // Title-only update on an unchanged identity records an edit, not a move.
  const backToYoutube = await storage.changePostDestination('owner', post.id, {
    provider: 'youtube', accountId: 'UC-chanter', username: 'chanterCy',
    youtube: { title: 'Κρατήστε αυτόν τον τίτλο', description: '' }
  });
  assert.equal(backToYoutube.identityChanged, true);
  assert.equal(fake.stores.get('posts').get(post.id).publishAttemptBudget, 0, 'YouTube draft budget stays closed until approval');
  const titleOnly = await storage.changePostDestination('owner', post.id, {
    provider: 'youtube', accountId: 'UC-chanter', username: 'chanterCy',
    youtube: { title: 'Νέος τίτλος', description: '' }
  });
  assert.equal(titleOnly.identityChanged, false);
  assert.equal(titleOnly.post.providerMetadata.youtube.title, 'Νέος τίτλος');
  const editEvents = titleOnly.post.history.filter((entry) => entry.event === 'edited');
  assert.ok(editEvents.length >= 1, 'title-only change records an edit event');
});

test('storage.changePostDestination fails closed: approved, terminal, missing, foreign posts', async (t) => {
  const { storage, fake } = loadStorageWithFakes(t);
  const [post] = await storage.addUploadedPosts('owner', tempVideos(t, ['clip.mp4']), {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-dest-3'
  });

  await storage.approvePost('owner', post.id, { approvedBy: 'admin' });
  const locked = await storage.changePostDestination('owner', post.id, {
    provider: 'youtube', accountId: 'UC-chanter', youtube: { title: 'x' }
  });
  assert.equal(locked.outcome, 'approval_locked');
  assert.equal(fake.stores.get('posts').get(post.id).provider, 'tiktok', 'no field changed');

  const raw = fake.stores.get('posts').get(post.id);
  fake.stores.get('posts').set(post.id, { ...raw, approvedAt: null, status: 'posted' });
  const terminal = await storage.changePostDestination('owner', post.id, {
    provider: 'youtube', accountId: 'UC-chanter', youtube: { title: 'x' }
  });
  assert.equal(terminal.outcome, 'queue_transition_blocked');

  assert.deepEqual(
    await storage.changePostDestination('intruder', post.id, { provider: 'tiktok', accountId: 'a' }),
    { outcome: 'not_found' }
  );
  assert.deepEqual(
    await storage.changePostDestination('owner', 'missing-post', { provider: 'tiktok', accountId: 'a' }),
    { outcome: 'not_found' }
  );
});

test('generic updatePost patches cannot smuggle destination identity, metadata, or attempt budget', async (t) => {
  const { storage, fake } = loadStorageWithFakes(t);
  const [post] = await storage.addUploadedPosts('owner', tempVideos(t, ['clip.mp4']), {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-dest-4'
  });

  const updated = await storage.updatePost('owner', post.id, {
    caption: 'Legitimate edit',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-hijack',
    connectedAccountId: 'youtube:UC-hijack',
    tiktokOpenId: 'stolen',
    username: 'hijacker',
    providerMetadata: { youtube: { title: 'smuggled', privacyStatus: 'public', notifySubscribers: true } },
    publishAttemptBudget: 99
  });

  assert.equal(updated.caption, 'Legitimate edit', 'allowed field applied');
  const raw = fake.stores.get('posts').get(post.id);
  assert.equal(raw.provider, 'tiktok');
  assert.equal(raw.platform, 'tiktok');
  assert.equal(raw.accountId, 'account-a');
  assert.equal(raw.connectedAccountId, 'tiktok:account-a');
  assert.equal(raw.username, 'creator_a');
  assert.equal(raw.providerMetadata, null);
  assert.equal(raw.publishAttemptBudget, null);
});

// ─────────────────────────────────────────────────────────────────────────
// Layer 2: application service + batch service over in-memory fakes.
// ─────────────────────────────────────────────────────────────────────────

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
  const youtubeAccounts = [
    {
      accountId: 'UC-chanter', id: 'UC-chanter', userId: 'owner', provider: 'youtube', platform: 'youtube',
      channelId: 'UC-chanter', username: 'chanterCy', displayName: 'chanterCy', connected: true,
      tokenPresent: true, refreshTokenPresent: true,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      grantedScopes: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
      scope: `${UPLOAD_SCOPE} ${READONLY_SCOPE}`,
      reauthorizationRequired: false,
      connectedAt: '2026-07-01T00:00:00.000Z'
    }
  ];
  const posts = [];
  const batchRecords = new Map();
  const calls = { approve: [], destination: [] };
  let sequence = 0;
  let now = nowMs;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return tiktokAccounts.find((account) => account.accountId === accountId) || null;
    },
    async getCanonicalTikTokAccounts(userId) {
      return userId === 'owner' ? tiktokAccounts : [];
    },
    async getTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return tiktokAccounts.find((account) => account.accountId === accountId) || null;
    },
    async getYouTubeAccounts(userId) {
      return userId === 'owner' ? youtubeAccounts : [];
    },
    async getYouTubeAccount(userId, channelId) {
      if (userId !== 'owner') return null;
      return youtubeAccounts.find((account) => account.accountId === channelId) || null;
    },
    async getPosts(userId, accountId) {
      if (userId !== 'owner') return [];
      return posts.filter((post) => !accountId || post.accountId === accountId);
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      return sources.map((file, index) => {
        const post = postFromDoc({
          id: `post-${++sequence}`,
          data: () => ({
            userId,
            workspaceId: defaults.workspaceId,
            platform: defaults.provider,
            provider: defaults.provider,
            accountId: defaults.accountId,
            tiktokOpenId: defaults.tiktokOpenId,
            username: defaults.username,
            originalName: file ? file.originalname : '',
            fileName: file ? file.originalname : '',
            mediaType: 'video',
            mediaUrl: `https://cdn.example.com/${file ? file.originalname : 'url'}`,
            caption: defaults.caption,
            hashtags: defaults.hashtags,
            scheduledAt: null,
            status: 'pending',
            approvedAt: null,
            approvedBy: null,
            createdAt: { toDate: () => new Date(now) },
            updatedAt: { toDate: () => new Date(now) },
            batchId: defaults.batchId || '',
            batchOrder: defaults.batchId ? index : null,
            sourceIndex: defaults.batchId ? index : null,
            preparation: defaults.batchId
              ? { status: 'pending', attempts: 0, leaseAt: null, finishedAt: null, provider: '', fallbackUsed: false, error: '' }
              : null
          })
        });
        posts.push(post);
        return post;
      });
    },
    async applyStaggeredSchedule(userId, created, plan) {
      created.forEach((created_post, index) => {
        const slot = plan.slots[index];
        const stored = posts.find((post) => post.id === created_post.id);
        stored.scheduledAt = slot.scheduledAt;
        stored.status = 'scheduled';
      });
      return created.length;
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
    async updatePost(userId, id, patch, accountId, historyEvent) {
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      // Mirror the real strip: generic patches cannot carry destination
      // identity or provider metadata.
      const {
        provider, platform, accountId: _a, connectedAccountId, tiktokOpenId, username,
        providerMetadata, publishAttemptBudget, ...allowed
      } = patch;
      Object.assign(post, allowed);
      if ('scheduledAt' in allowed) post.status = allowed.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      calls.approve.push({ userId, id, approvedBy, accountId });
      const post = posts.find((item) => item.id === id && (!accountId || item.accountId === accountId));
      if (!post) return null;
      if (!['pending', 'scheduled', 'failed', 'ready'].includes(post.status)) return null;
      post.approved = true;
      post.approvalState = 'approved';
      post.approvedAt = new Date(now).toISOString();
      post.approvedBy = approvedBy;
      return post;
    },
    // In-memory mirror of storage.changePostDestination's semantics.
    async changePostDestination(userId, postId, destination, workspaceScope) {
      calls.destination.push({ userId, postId, destination });
      const post = posts.find((item) => item.id === postId && item.userId === userId);
      if (!post) return { outcome: 'not_found' };
      if (!['pending', 'scheduled'].includes(post.status)) return { outcome: 'queue_transition_blocked', post };
      if (post.approved) return { outcome: 'approval_locked', post };
      const identityChanged = post.provider !== destination.provider || post.accountId !== destination.accountId;
      post.provider = destination.provider;
      post.platform = destination.provider;
      post.accountId = destination.accountId;
      post.connectedAccountId = `${destination.provider}:${destination.accountId}`;
      post.tiktokOpenId = destination.provider === 'tiktok' ? String(destination.tiktokOpenId || destination.accountId) : '';
      post.username = String(destination.username || '');
      if (destination.provider === 'youtube') {
        post.providerMetadata = {
          youtube: {
            title: String((destination.youtube && destination.youtube.title) || ''),
            description: String((destination.youtube && destination.youtube.description) || ''),
            privacyStatus: 'private',
            notifySubscribers: false
          }
        };
      }
      post.history = [...(post.history || []), {
        at: new Date(now).toISOString(),
        event: identityChanged ? 'destination_changed' : 'edited'
      }];
      return { outcome: 'changed', identityChanged, post };
    },

    async createBatchRecord(record) {
      const stored = {
        ...record, preparedCount: 0, failedCount: 0, acceptedCount: 0,
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
      record.updatedAt = new Date(now).toISOString();
      return { ...record };
    },
    async deleteBatchRecord(userId, batchId) {
      const record = batchRecords.get(batchId);
      if (!record || record.userId !== userId) return false;
      batchRecords.delete(batchId);
      return true;
    },
    async getBatchPosts(userId, batchId) {
      return posts
        .filter((post) => post.userId === userId && post.batchId === batchId)
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
        if (result.hashtags && !String(post.hashtags || '').trim()) post.hashtags = result.hashtags;
        post.preparation = { ...post.preparation, status: 'succeeded', leaseAt: null, provider: result.provider || '', fallbackUsed: Boolean(result.fallbackUsed), error: '' };
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
    config: TEST_BATCH_CONFIG,
    storage,
    autoCaption,
    applicationService,
    downloadMedia: async () => ({ bytes: 1 }),
    now: () => now,
    logger: { warn() {} }
  });

  return {
    posts, calls, tiktokAccounts, youtubeAccounts, batchRecords,
    applicationService, batchService,
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
  intakeKey: 'intake-dest-1'
};

async function makePreparedBatch(world, fileNames = ['a.mp4', 'b.mp4', 'c.mp4']) {
  const result = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE,
    files: fileNames.map(uploadFile)
  });
  await world.batchService.startPreparation(websiteContext(), result.batch.batchId);
  return result.batch.batchId;
}

test('app service: destination change validates the target account and provider contract', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world, ['a.mp4']);
  const [item] = (await world.batchService.getBatchView(websiteContext(), batchId)).items;

  // Unknown account fails closed.
  await assert.rejects(
    world.applicationService.changePostDestination(websiteContext(), {
      postId: item.id, provider: 'youtube', accountId: 'UC-unknown', youtube: { title: 'x' }
    }),
    AutoPosterApplicationError
  );

  // YouTube without a title violates the provider contract.
  await assert.rejects(
    world.applicationService.changePostDestination(websiteContext(), {
      postId: item.id, provider: 'youtube', accountId: 'UC-chanter'
    }),
    /non-empty title/
  );

  // Non-website sources are forbidden.
  await assert.rejects(
    world.applicationService.changePostDestination(
      createExecutionContext({ userId: 'owner', source: 'runtime' }),
      { postId: item.id, provider: 'tiktok', accountId: 'account-a' }
    ),
    /website workflow/
  );

  // Valid switch works and carries the validated canonical identity.
  const changed = await world.applicationService.changePostDestination(websiteContext(), {
    postId: item.id, provider: 'youtube', accountId: 'UC-chanter', youtube: { title: 'Σωστός τίτλος' }
  });
  assert.equal(changed.ok, true);
  assert.equal(changed.post.provider, 'youtube');
  assert.equal(changed.post.username, 'chanterCy');
  assert.equal(changed.post.providerMetadata.youtube.title, 'Σωστός τίτλος');
});

test('batch service: per-item destination override changes one item and never its siblings', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world);
  const view = await world.batchService.getBatchView(websiteContext(), batchId);

  const changed = await world.batchService.changeItemDestination(websiteContext(), batchId, view.items[1].id, {
    provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'Δεύτερο βίντεο'
  });
  assert.equal(changed.identityChanged, true);
  assert.equal(changed.item.provider, 'youtube');

  const after = await world.batchService.getBatchView(websiteContext(), batchId);
  assert.deepEqual(after.items.map((item) => item.provider), ['tiktok', 'youtube', 'tiktok']);
  assert.equal(after.items[1].providerMetadata.youtube.title, 'Δεύτερο βίντεο');

  // A non-member post is refused.
  await assert.rejects(
    world.batchService.changeItemDestination(websiteContext(), batchId, 'missing', { provider: 'tiktok', accountId: 'account-a' }),
    /does not belong/
  );
});

test('batch service: switching before preparation completes keeps preparation intact; caption fills, title survives', async () => {
  const world = makeWorld();
  const created = await world.batchService.createBatch(websiteContext(), {
    ...INTAKE, files: [uploadFile('early.mp4')]
  });
  const batchId = created.batch.batchId;
  const itemId = created.items[0].id;

  // TikTok -> YouTube while preparation is still pending.
  await world.batchService.changeItemDestination(websiteContext(), batchId, itemId, {
    provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'Πρώιμος τίτλος'
  });
  await world.batchService.startPreparation(websiteContext(), batchId);

  const view = await world.batchService.getBatchView(websiteContext(), batchId, { autoResume: false });
  assert.equal(view.items[0].preparation.status, 'succeeded');
  assert.match(view.items[0].caption, /^Generated for/);
  assert.equal(view.items[0].providerMetadata.youtube.title, 'Πρώιμος τίτλος', 'preparation never touches the human title');
});

test('batch service: title edits go through updateItem, human edits win, and TikTok items refuse titles', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world, ['a.mp4', 'b.mp4']);
  const view = await world.batchService.getBatchView(websiteContext(), batchId);

  await world.batchService.changeItemDestination(websiteContext(), batchId, view.items[0].id, {
    provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'Αρχικός τίτλος'
  });
  const edited = await world.batchService.updateItem(websiteContext(), batchId, view.items[0].id, {
    youtubeTitle: 'Τελικός τίτλος από άνθρωπο'
  });
  assert.equal(edited.item.providerMetadata.youtube.title, 'Τελικός τίτλος από άνθρωπο');

  await assert.rejects(
    world.batchService.updateItem(websiteContext(), batchId, view.items[1].id, { youtubeTitle: 'άκυρο' }),
    /destination is YouTube/
  );

  // Oversized titles are rejected by the provider contract.
  await assert.rejects(
    world.batchService.updateItem(websiteContext(), batchId, view.items[0].id, { youtubeTitle: 'χ'.repeat(101) }),
    /at most 100 characters/
  );
});

test('mixed-destination Accept All approves every valid item with deterministic stagger and full evidence', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world);
  const view = await world.batchService.getBatchView(websiteContext(), batchId);

  await world.batchService.changeItemDestination(websiteContext(), batchId, view.items[1].id, {
    provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'Μικτή παρτίδα'
  });

  world.setNow('2026-07-11T12:00:00.000Z'); // original slots now in the past
  const outcome = await world.batchService.acceptItems(approverContext(), batchId, { postIds: 'all' });
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.accepted.length, 3);

  const times = outcome.accepted.map((item) => Date.parse(item.scheduledAt));
  for (const timeMs of times) assert.ok(timeMs >= world.nowMs + 10 * 60_000, 'safety buffer enforced');
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= 30 * 60_000, 'stagger spacing enforced across providers');
  }

  const after = await world.batchService.getBatchView(websiteContext(), batchId);
  assert.equal(after.batch.status, 'completed');
  assert.deepEqual(after.items.map((item) => item.approved), [true, true, true]);
  assert.equal(world.posts.filter((post) => post.provider === 'youtube' && post.approved).length, 1);
  assert.ok(world.posts.every((post) => post.status === 'scheduled'), 'nothing processing/posted — zero publish activity');

  // Repeated Accept All is a no-op, never a double approval.
  const again = await world.batchService.acceptItems(approverContext(), batchId, { postIds: 'all' });
  assert.equal(again.accepted.length, 0);
  assert.equal(world.calls.approve.length, 3);
});

test('a disconnected destination blocks ONLY its own item at acceptance; siblings accept; summary stays honest', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world);
  const view = await world.batchService.getBatchView(websiteContext(), batchId);

  await world.batchService.changeItemDestination(websiteContext(), batchId, view.items[1].id, {
    provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'Θα αποσυνδεθεί'
  });
  // The channel disconnects AFTER review rendered but BEFORE acceptance.
  world.youtubeAccounts[0].connected = false;

  const outcome = await world.batchService.acceptItems(approverContext(), batchId, { postIds: 'all' });
  assert.equal(outcome.accepted.length, 2);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].reason, /no longer available/);

  const after = await world.batchService.getBatchView(websiteContext(), batchId);
  assert.notEqual(after.batch.status, 'completed', 'a partially accepted batch is never completed');
  assert.equal(after.batch.counts.accepted, 2);
  assert.equal(after.batch.counts.total, 3);

  // Reconnect and repeat: only the remaining item is approved.
  world.youtubeAccounts[0].connected = true;
  const retry = await world.batchService.acceptItems(approverContext(), batchId, { postIds: 'all' });
  assert.equal(retry.accepted.length, 1);
  assert.deepEqual(retry.failed, []);
  assert.equal((await world.batchService.getBatchView(websiteContext(), batchId)).batch.status, 'completed');
  assert.equal(world.calls.approve.length, 3);
});

test('stale review writes cannot move an accepted item; destination change refuses after approval', async () => {
  const world = makeWorld();
  const batchId = await makePreparedBatch(world, ['a.mp4']);
  const view = await world.batchService.getBatchView(websiteContext(), batchId);

  await world.batchService.acceptItems(approverContext(), batchId, { postIds: [view.items[0].id] });
  await assert.rejects(
    world.batchService.changeItemDestination(websiteContext(), batchId, view.items[0].id, {
      provider: 'youtube', accountId: 'UC-chanter', youtubeTitle: 'πολύ αργά'
    }),
    /Revoke approval/
  );
});
