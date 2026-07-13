'use strict';

// Cross-boundary usage truth. These tests run the real usage service through
// the real storage delete and scheduler finalize paths while replacing only
// Firestore and provider I/O with deterministic in-memory fakes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  USAGE_METRIC_SCHEDULED_POSTS,
  USAGE_STATES,
  calendarMonthUsageCycle,
  createUsageService
} = require('../src/usageService');

const FIXED_NOW = new Date('2026-07-12T10:00:00.000Z');

test('metered queue commit is recorded before post-commit confirmation reads', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'storage.js'), 'utf8');
  const committedAt = source.indexOf('committed = Number(metered.reservedCount || 0) > 0;');
  const readbackAt = source.indexOf('const persisted = await Promise.all(created.map');
  assert.ok(committedAt >= 0 && readbackAt > committedAt);
});

class MemoryTimestamp {
  constructor(value) {
    this.millis = value instanceof Date ? value.getTime() : Number(value);
  }

  toDate() {
    return new Date(this.millis);
  }

  toMillis() {
    return this.millis;
  }
}

function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof MemoryTimestamp) return new MemoryTimestamp(value.millis);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, clone(child)]));
  }
  return value;
}

class TransactionConflict extends Error {}

class MemorySnapshot {
  constructor(ref, record) {
    this.id = ref.id;
    this.ref = ref;
    this.exists = Boolean(record);
    this._data = record ? clone(record.data) : undefined;
  }

  data() {
    return clone(this._data);
  }
}

class MemoryDocumentReference {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    return new MemorySnapshot(this, this.db.records.get(this.path));
  }

  async set(data, options = {}) {
    const previous = this.db.document(this.collectionName, this.id);
    this.db.setDocument(
      this.collectionName,
      this.id,
      options.merge && previous ? { ...previous, ...clone(data) } : data
    );
  }

  async update(patch) {
    this.db.patchDocument(this.collectionName, this.id, patch);
  }

  async delete() {
    this.db.deleteDocument(this.collectionName, this.id);
  }
}

class MemoryTransaction {
  constructor(db, attempt) {
    this.db = db;
    this.attempt = attempt;
    this.readVersions = new Map();
    this.writes = [];
  }

  async get(ref) {
    if (this.writes.length > 0) throw new Error('transaction attempted a read after a write');
    const record = this.db.records.get(ref.path);
    this.readVersions.set(ref.path, record ? record.version : 0);
    const snapshot = new MemorySnapshot(ref, record);
    if (this.db.transactionReadHook) {
      await this.db.transactionReadHook({ db: this.db, ref, snapshot, attempt: this.attempt });
    }
    return snapshot;
  }

  create(ref, data) {
    this.writes.push({ operation: 'create', ref, data: clone(data) });
  }

  update(ref, data) {
    this.writes.push({ operation: 'update', ref, data: clone(data) });
  }

  delete(ref) {
    this.writes.push({ operation: 'delete', ref });
  }
}

class MemoryFirestore {
  constructor() {
    this.records = new Map();
    this.version = 0;
    this.transactionRetries = 0;
    this.transactionReadHook = null;
    this.failWritePaths = new Set();
  }

  collection(name) {
    return {
      doc: (id) => new MemoryDocumentReference(this, name, id)
    };
  }

  async runTransaction(callback) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const tx = new MemoryTransaction(this, attempt);
      const result = await callback(tx);
      try {
        this.commit(tx);
        return result;
      } catch (error) {
        if (!(error instanceof TransactionConflict)) throw error;
        this.transactionRetries += 1;
      }
    }
    throw new Error('transaction retry limit exceeded');
  }

  commit(tx) {
    for (const [path, version] of tx.readVersions.entries()) {
      const current = this.records.get(path);
      if ((current ? current.version : 0) !== version) throw new TransactionConflict();
    }

    for (const write of tx.writes) {
      const current = this.records.get(write.ref.path);
      if (write.operation === 'create' && current) throw new TransactionConflict();
      if (write.operation === 'update' && !current) throw new TransactionConflict();
      if (this.failWritePaths.has(write.ref.path)) {
        this.failWritePaths.delete(write.ref.path);
        throw new Error(`injected atomic write failure: ${write.ref.path}`);
      }
    }

    // Apply only after every operation passes preflight. A failed queue delete
    // therefore cannot partially release its ledger/counters.
    for (const write of tx.writes) {
      if (write.operation === 'delete') {
        this.version += 1;
        this.records.delete(write.ref.path);
        continue;
      }
      const current = this.records.get(write.ref.path);
      const next = write.operation === 'update'
        ? applyPatch(current.data, write.data)
        : clone(write.data);
      this.version += 1;
      this.records.set(write.ref.path, { data: next, version: this.version });
    }
  }

  setDocument(collectionName, id, data) {
    this.version += 1;
    this.records.set(`${collectionName}/${id}`, { data: clone(data), version: this.version });
  }

  patchDocument(collectionName, id, patch) {
    const path = `${collectionName}/${id}`;
    const current = this.records.get(path);
    if (!current) throw new Error(`missing update target: ${path}`);
    this.version += 1;
    this.records.set(path, { data: applyPatch(current.data, patch), version: this.version });
  }

  deleteDocument(collectionName, id) {
    this.version += 1;
    this.records.delete(`${collectionName}/${id}`);
  }

  failNextWrite(collectionName, id) {
    this.failWritePaths.add(`${collectionName}/${id}`);
  }

  document(collectionName, id) {
    const record = this.records.get(`${collectionName}/${id}`);
    return record ? clone(record.data) : null;
  }
}

function applyPatch(current, patch) {
  const next = clone(current || {});
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && value.__memoryOperation === 'increment') {
      next[key] = Number(next[key] || 0) + value.amount;
    } else {
      next[key] = clone(value);
    }
  }
  return next;
}

function timestamp(value = FIXED_NOW) {
  return new MemoryTimestamp(value instanceof Date ? value : new Date(value));
}

function installHarness() {
  const paths = {
    firestore: require.resolve('../src/firestore'),
    cloudinary: require.resolve('../src/cloudinary'),
    tiktok: require.resolve('../src/tiktok'),
    instagram: require.resolve('../src/instagram'),
    youtube: require.resolve('../src/youtube'),
    mapper: require.resolve('../src/postsMapper'),
    storage: require.resolve('../src/storage'),
    scheduler: require.resolve('../src/scheduler')
  };
  for (const modulePath of Object.values(paths)) delete require.cache[modulePath];

  const db = new MemoryFirestore();
  const providerResults = new Map();
  const providerCalls = [];
  const destroyedAssets = [];
  const Timestamp = {
    now: () => timestamp(),
    fromDate: (value) => timestamp(value),
    fromMillis: (value) => new MemoryTimestamp(value)
  };
  const collection = (name) => ({ doc: (id) => new MemoryDocumentReference(db, name, id) });

  require.cache[paths.firestore] = {
    id: paths.firestore,
    filename: paths.firestore,
    loaded: true,
    exports: {
      postsCollection: () => collection('posts'),
      tiktokAccountsCollection: () => collection('tiktokAccounts'),
      youtubeAccountsCollection: () => collection('youtubeAccounts'),
      configDoc: (id) => new MemoryDocumentReference(db, 'config', id),
      getFirestore: () => db,
      Timestamp,
      FieldValue: {
        serverTimestamp: () => timestamp(),
        increment: (amount) => ({ __memoryOperation: 'increment', amount })
      }
    }
  };
  require.cache[paths.cloudinary] = {
    id: paths.cloudinary,
    filename: paths.cloudinary,
    loaded: true,
    exports: {
      uploadMediaFile: async () => ({ mediaUrl: '', publicId: '', resourceType: '' }),
      destroyMediaAsset: async (publicId, resourceType) => {
        if (publicId) destroyedAssets.push({ publicId, resourceType });
      },
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };
  require.cache[paths.tiktok] = {
    id: paths.tiktok,
    filename: paths.tiktok,
    loaded: true,
    exports: {
      publishPhotoPost: async (post) => {
        providerCalls.push({ provider: 'tiktok', postId: post.id });
        return providerResults.get(post.id);
      }
    }
  };
  require.cache[paths.instagram] = {
    id: paths.instagram,
    filename: paths.instagram,
    loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => ({ ok: false, reason: 'disabled in test' })
    }
  };
  require.cache[paths.youtube] = {
    id: paths.youtube,
    filename: paths.youtube,
    loaded: true,
    exports: {
      publishScheduledYouTubePost: async (post) => {
        providerCalls.push({ provider: 'youtube', postId: post.id });
        return providerResults.get(post.id);
      }
    }
  };

  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  const usage = createUsageService({
    db,
    clock: { now: () => new Date(FIXED_NOW.getTime()) }
  });
  const storage = require('../src/storage');
  const scheduler = require('../src/scheduler');

  return {
    db,
    usage,
    storage,
    scheduler,
    providerResults,
    providerCalls,
    destroyedAssets,
    cleanup() {
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
      console.error = originalConsole.error;
      for (const modulePath of Object.values(paths)) delete require.cache[modulePath];
    }
  };
}

async function reserveJob(harness, id, overrides = {}) {
  const provider = overrides.provider || 'tiktok';
  const accountId = overrides.accountId || (provider === 'youtube' ? 'UC-chanter' : 'tiktok-account');
  return harness.usage.reserveAndCreateQueueItem({
    workspaceId: 'workspace-a',
    metric: USAGE_METRIC_SCHEDULED_POSTS,
    usageCycle: calendarMonthUsageCycle(FIXED_NOW),
    idempotencyKey: `schedule:${id}`,
    source: 'website',
    limits: { scheduledPostsPerCycle: 30, activeQueueLimit: 20 },
    queue: {
      documentId: id,
      data: {
        userId: 'owner',
        accountId,
        connectedAccountId: `${provider}:${accountId}`,
        tiktokOpenId: provider === 'tiktok' ? accountId : '',
        username: 'chanter',
        platform: provider,
        provider,
        originalName: 'clip.mp4',
        fileName: 'clip.mp4',
        mediaType: 'video',
        mediaUrl: 'https://cdn.example.test/clip.mp4',
        status: 'pending',
        approvedAt: timestamp('2026-07-12T09:00:00.000Z'),
        approvedBy: 'admin:owner',
        history: [],
        claimAttempts: 0,
        createdAt: timestamp('2026-07-12T08:00:00.000Z'),
        updatedAt: timestamp('2026-07-12T08:00:00.000Z'),
        ...clone(overrides)
      }
    }
  });
}

function usageTruth(harness, reservation) {
  return {
    post: harness.db.document('posts', reservation.queueDocumentId),
    ledger: harness.db.document('usageLedger', reservation.ledgerId),
    counter: harness.db.document('usageCounters', reservation.counterId),
    active: harness.db.document('usageActiveQueueCounters', reservation.activeQueueCounterId)
  };
}

function assertReserved(truth, { activeQueue = 1, outcomeUnknown = false } = {}) {
  assert.equal(truth.ledger.state, USAGE_STATES.RESERVED);
  assert.equal(truth.ledger.outcomeUnknown, outcomeUnknown);
  assert.equal(truth.counter.reservedQuantity, 1);
  assert.equal(truth.counter.consumedQuantity, 0);
  assert.equal(truth.counter.releasedQuantity, 0);
  assert.equal(truth.active.activeQueue, activeQueue);
}

test('storage and scheduler preserve transactional usage truth across queue lifecycle boundaries', async (t) => {
  await t.test('metered pending delete releases usage and deletes the queue item atomically', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const reservation = await reserveJob(harness, 'pending-delete');

    harness.db.failNextWrite('posts', reservation.queueDocumentId);
    await assert.rejects(
      harness.storage.deletePost(
        'owner',
        reservation.queueDocumentId,
        undefined,
        { workspaceId: 'workspace-a' }
      ),
      /injected atomic write failure/
    );
    const afterFailedCommit = usageTruth(harness, reservation);
    assert.ok(afterFailedCommit.post, 'the failed transaction keeps the queue item');
    assertReserved(afterFailedCommit);

    assert.equal(await harness.storage.deletePost(
      'owner',
      reservation.queueDocumentId,
      undefined,
      { workspaceId: 'workspace-a' }
    ), true);
    const afterDelete = usageTruth(harness, reservation);
    assert.equal(afterDelete.post, null);
    assert.equal(afterDelete.ledger.state, USAGE_STATES.RELEASED);
    assert.equal(afterDelete.ledger.activeQueueCounted, false);
    assert.equal(afterDelete.counter.reservedQuantity, 0);
    assert.equal(afterDelete.counter.releasedQuantity, 1);
    assert.equal(afterDelete.active.activeQueue, 0);
  });

  await t.test('a pending-to-processing race retries and then rejects without releasing or deleting', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const reservation = await reserveJob(harness, 'delete-race');
    let raceInjected = false;
    harness.db.transactionReadHook = async ({ db, ref }) => {
      if (!raceInjected && ref.path === `posts/${reservation.queueDocumentId}`) {
        raceInjected = true;
        db.patchDocument('posts', reservation.queueDocumentId, {
          status: 'processing',
          lockedBy: 'external-worker'
        });
      }
    };

    await assert.rejects(
      harness.storage.deletePost(
        'owner',
        reservation.queueDocumentId,
        undefined,
        { workspaceId: 'workspace-a' }
      ),
      (error) => error && error.code === 'queue_transition_blocked'
    );
    const truth = usageTruth(harness, reservation);
    assert.equal(harness.db.transactionRetries, 1, 'the optimistic transaction observed and retried the race');
    assert.equal(truth.post.status, 'processing');
    assert.equal(truth.post.lockedBy, 'external-worker');
    assertReserved(truth);
  });

  await t.test('outcome_unknown deletion is blocked and preserves the held reservation', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const reservation = await reserveJob(harness, 'unknown-delete');
    await harness.usage.markOutcomeUnknown({
      workspaceId: 'workspace-a',
      usageCycleId: reservation.usageCycleId,
      metric: USAGE_METRIC_SCHEDULED_POSTS,
      ledgerId: reservation.ledgerId,
      relatedResourceId: reservation.queueDocumentId,
      reason: 'provider_reconciliation_required'
    });
    harness.db.patchDocument('posts', reservation.queueDocumentId, {
      status: 'outcome_unknown',
      usageState: 'reserved'
    });

    await assert.rejects(
      harness.storage.deletePost(
        'owner',
        reservation.queueDocumentId,
        undefined,
        { workspaceId: 'workspace-a' }
      ),
      (error) => error && error.code === 'queue_transition_blocked' && /reconcile/i.test(error.message)
    );
    const truth = usageTruth(harness, reservation);
    assert.equal(truth.post.status, 'outcome_unknown');
    assertReserved(truth, { activeQueue: 0, outcomeUnknown: true });
    assert.equal(truth.ledger.activeQueueCounted, false);
  });

  await t.test('TikTok and uploaded-private YouTube success each consume once', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const tiktokReservation = await reserveJob(harness, 'tiktok-success');
    const youtubeReservation = await reserveJob(harness, 'youtube-success', {
      provider: 'youtube',
      platform: 'youtube',
      accountId: 'UC-chanter',
      connectedAccountId: 'youtube:UC-chanter',
      providerMetadata: {
        youtube: { title: 'Private upload', description: '', privacyStatus: 'private', notifySubscribers: false }
      }
    });
    const tiktokResult = {
      ok: true,
      mode: 'api',
      response: { data: { publish_id: 'tt-publish-1' } }
    };
    const youtubeResult = {
      ok: true,
      mode: 'api',
      providerStatus: 'uploaded_private',
      response: {
        video_id: 'yt-video-1',
        privacy_status: 'private',
        upload_status: 'uploaded',
        channel_id: 'UC-chanter'
      }
    };
    harness.providerResults.set('tiktok-success', tiktokResult);
    harness.providerResults.set('youtube-success', youtubeResult);

    assert.equal((await harness.scheduler.processPost('tiktok-success', {
      force: true,
      workerId: 'worker-tiktok',
      now: FIXED_NOW
    })).ok, true);
    assert.equal((await harness.scheduler.processPost('youtube-success', {
      force: true,
      workerId: 'worker-youtube',
      now: FIXED_NOW
    })).ok, true);

    const tiktokTruth = usageTruth(harness, tiktokReservation);
    const youtubeTruth = usageTruth(harness, youtubeReservation);
    assert.equal(tiktokTruth.post.status, 'posted');
    assert.equal(tiktokTruth.post.publishId, 'tt-publish-1');
    assert.equal(tiktokTruth.ledger.state, USAGE_STATES.CONSUMED);
    assert.equal(youtubeTruth.post.status, 'posted');
    assert.equal(youtubeTruth.post.providerStatus, 'uploaded_private');
    assert.equal(youtubeTruth.post.publishId, 'yt-video-1');
    assert.equal(youtubeTruth.ledger.state, USAGE_STATES.CONSUMED);
    assert.equal(youtubeTruth.counter.reservedQuantity, 0);
    assert.equal(youtubeTruth.counter.consumedQuantity, 2);
    assert.equal(youtubeTruth.active.activeQueue, 0);
    assert.deepEqual(harness.providerCalls, [
      { provider: 'tiktok', postId: 'tiktok-success' },
      { provider: 'youtube', postId: 'youtube-success' }
    ]);

    const replay = await harness.scheduler._private.finalize(
      'youtube-success',
      'worker-youtube',
      youtubeResult
    );
    assert.equal(replay.mode, 'skipped');
    const afterReplay = usageTruth(harness, youtubeReservation);
    assert.equal(afterReplay.counter.consumedQuantity, 2, 'repeated finalization cannot double-consume');
    assert.equal(afterReplay.active.activeQueue, 0);
  });

  await t.test('outcome_unknown holds quota but leaves the active queue exactly once', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const reservation = await reserveJob(harness, 'unknown-worker', {
      provider: 'youtube',
      platform: 'youtube',
      accountId: 'UC-chanter',
      connectedAccountId: 'youtube:UC-chanter'
    });
    const unknownResult = {
      ok: false,
      mode: 'api',
      outcomeUnknown: true,
      code: 'PROVIDER_RECONCILIATION_REQUIRED',
      reason: 'The upload may exist; reconcile before retrying.'
    };
    harness.providerResults.set('unknown-worker', unknownResult);

    const result = await harness.scheduler.processPost('unknown-worker', {
      force: true,
      workerId: 'worker-unknown',
      now: FIXED_NOW
    });
    assert.equal(result.outcomeUnknown, true);
    let truth = usageTruth(harness, reservation);
    assert.equal(truth.post.status, 'outcome_unknown');
    assertReserved(truth, { activeQueue: 0, outcomeUnknown: true });
    assert.equal(truth.ledger.activeQueueCounted, false);

    const replay = await harness.scheduler._private.finalize(
      'unknown-worker',
      'worker-unknown',
      unknownResult
    );
    assert.equal(replay.mode, 'skipped');
    truth = usageTruth(harness, reservation);
    assertReserved(truth, { activeQueue: 0, outcomeUnknown: true });
  });

  await t.test('retryable provider failure preserves reserved usage and active queue truth', async (t) => {
    const harness = installHarness();
    t.after(harness.cleanup);
    const reservation = await reserveJob(harness, 'retryable-failure');
    harness.providerResults.set('retryable-failure', {
      ok: false,
      mode: 'api',
      code: 'ETIMEDOUT',
      reason: 'Provider request timed out.'
    });

    const result = await harness.scheduler.processPost('retryable-failure', {
      force: true,
      workerId: 'worker-retry',
      now: FIXED_NOW
    });
    assert.equal(result.ok, false);
    assert.equal(result.retryScheduled, true);
    const truth = usageTruth(harness, reservation);
    assert.equal(truth.post.status, 'scheduled');
    assert.equal(truth.post.lastResult.willRetry, true);
    assertReserved(truth);
  });
});
