'use strict';

// Authorization-preserving retry seal. These synthetic durable fixtures load
// the real storage transaction, application service, and scheduler claim gate;
// provider adapters are counters only and never reach an external service.

const assert = require('node:assert/strict');
const test = require('node:test');
const config = require('../src/config');

function timestamp(value) {
  return {
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  };
}

function durableSnapshot(value) {
  if (Array.isArray(value)) return value.map(durableSnapshot);
  if (value && typeof value === 'object') {
    if (typeof value.toMillis === 'function') {
      return { timestampMillis: value.toMillis() };
    }
    return Object.fromEntries(Object.entries(value)
      .filter(([, nested]) => typeof nested !== 'function')
      .map(([key, nested]) => [key, durableSnapshot(nested)]));
  }
  return value;
}

function youtubeJob(overrides = {}) {
  return {
    userId: 'owner',
    workspaceId: 'workspace-owner',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    connectedAccountId: 'youtube:UC-chanter',
    status: 'failed',
    scheduledAt: timestamp('2026-07-18T11:05:00.000Z'),
    approvedAt: timestamp('2026-07-18T11:01:40.847Z'),
    approvedBy: 'admin:owner',
    claimAttempts: 1,
    publishAttemptBudget: 1,
    errorMessage: 'Synthetic pre-provider failure.',
    providerStatus: 'attempt_budget_exhausted',
    lastResult: {
      ok: false,
      code: 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED',
      reason: 'Synthetic pre-provider failure.',
      providerMutationStarted: false
    },
    history: [{
      at: '2026-07-18T11:05:01.000Z',
      event: 'attempt_budget_exhausted',
      detail: 'One authorized claim was consumed.'
    }],
    evidence: { durableMarker: 'must-survive-retry-rejection' },
    createdAt: timestamp('2026-07-18T10:59:00.000Z'),
    updatedAt: timestamp('2026-07-18T11:05:01.000Z'),
    ...overrides
  };
}

function installHarness(t, seededRecords) {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const youtubePath = require.resolve('../src/youtube');
  const mapperPath = require.resolve('../src/postsMapper');
  const storagePath = require.resolve('../src/storage');
  const applicationServicePath = require.resolve('../src/autoposterApplicationService');
  const schedulerPath = require.resolve('../src/scheduler');
  const modulePaths = [
    firestorePath,
    tiktokPath,
    instagramPath,
    youtubePath,
    mapperPath,
    storagePath,
    applicationServicePath,
    schedulerPath
  ];
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const records = new Map(Object.entries(seededRecords));
  const serverTimestamp = timestamp('2026-07-18T12:29:08.352Z');
  const transactionPatches = [];
  let schedulerClaims = 0;
  let retryWrites = 0;
  let youtubeAdapterCalls = 0;
  let providerMutationCalls = 0;
  let transactionTail = Promise.resolve();

  const document = (id) => ({
    id,
    get exists() { return records.has(id); },
    data: () => records.get(id)
  });
  const applyUpdate = (id, patch) => {
    const next = { ...records.get(id) };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment
        ? Number(next[key] || 0) + value.__increment
        : value;
    }
    records.set(id, next);
    transactionPatches.push({ id, patch });
    if (patch.status === 'processing') schedulerClaims += 1;
    if (Array.isArray(patch.history) && patch.history.at(-1)?.event === 'retry_requested') {
      retryWrites += 1;
    }
  };
  const runTransaction = async (callback) => {
    const previous = transactionTail;
    let release;
    transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      const pending = [];
      const result = await callback({
        get: async (ref) => document(ref.id),
        update: (ref, patch) => pending.push({ id: ref.id, patch })
      });
      for (const update of pending) applyUpdate(update.id, update.patch);
      return result;
    } finally {
      release();
    }
  };
  const postRef = (id) => ({
    id,
    get: async () => document(id),
    update: async (patch) => applyUpdate(id, patch)
  });

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({ doc: postRef }),
      getFirestore: () => ({ runTransaction }),
      Timestamp: {
        now: () => serverTimestamp,
        fromDate: (date) => timestamp(date.toISOString()),
        fromMillis: (value) => timestamp(new Date(value).toISOString())
      },
      FieldValue: {
        serverTimestamp: () => serverTimestamp,
        increment: (value) => ({ __increment: value })
      }
    }
  };
  require.cache[tiktokPath] = {
    id: tiktokPath,
    filename: tiktokPath,
    loaded: true,
    exports: {
      publishPhotoPost: async () => {
        providerMutationCalls += 1;
        throw new Error('TikTok provider must not be called');
      }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => {
        providerMutationCalls += 1;
        throw new Error('Instagram provider must not be called');
      }
    }
  };
  require.cache[youtubePath] = {
    id: youtubePath,
    filename: youtubePath,
    loaded: true,
    exports: {
      validateYouTubeMetadata: () => ({ title: 'Synthetic title' }),
      publishScheduledYouTubePost: async () => {
        youtubeAdapterCalls += 1;
        throw new Error('YouTube adapter must not be called');
      },
      uploadVideo: async () => {
        providerMutationCalls += 1;
        throw new Error('YouTube provider must not be called');
      }
    }
  };

  let storage = require('../src/storage');
  const commercialContext = Object.freeze({
    userId: 'owner',
    workspace: Object.freeze({ workspaceId: 'workspace-owner' }),
    workspaceScope: Object.freeze({
      workspaceId: 'workspace-owner',
      allowLegacyOwnerRecords: false
    }),
    entitlements: Object.freeze({ advancedEvidence: true })
  });
  const context = (accountId) => ({
    userId: 'owner',
    actorId: 'admin:owner',
    accountId,
    workspaceId: 'workspace-owner',
    source: 'website',
    commercialContext
  });
  const loadService = ({ cold = false } = {}) => {
    if (cold) {
      delete require.cache[storagePath];
      delete require.cache[mapperPath];
      storage = require('../src/storage');
    }
    delete require.cache[applicationServicePath];
    const { createAutoPosterApplicationService } = require('../src/autoposterApplicationService');
    return createAutoPosterApplicationService({
      storage,
      commercialService: {
        resolveContext: async () => commercialContext
      }
    });
  };
  const loadScheduler = () => {
    delete require.cache[schedulerPath];
    return require('../src/scheduler');
  };

  t.after(() => {
    for (const modulePath of modulePaths) delete require.cache[modulePath];
  });

  return {
    records,
    context,
    loadService,
    loadScheduler,
    transactionPatches,
    schedulerClaims: () => schedulerClaims,
    retryWrites: () => retryWrites,
    youtubeAdapterCalls: () => youtubeAdapterCalls,
    providerMutationCalls: () => providerMutationCalls,
    replaceRecord: (id, patch) => records.set(id, { ...records.get(id), ...patch })
  };
}

async function assertAttemptBudgetConflict(operation, expectedAttempts, expectedBudget) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'attempt_budget_exhausted');
    assert.deepEqual(error.details, {
      claimAttempts: expectedAttempts,
      effectiveAttemptBudget: expectedBudget
    });
    return true;
  });
}

test('exhausted approved YouTube retry is immutable across duplicates, restart, and scheduler replay', async (t) => {
  const durable = youtubeJob();
  const legacy = youtubeJob({ claimAttempts: 1 });
  delete legacy.publishAttemptBudget;
  const durableBefore = durableSnapshot(durable);
  const legacyBefore = durableSnapshot(legacy);
  const harness = installHarness(t, { exhausted: durable, legacy });
  const input = { postId: 'exhausted', accountId: 'UC-chanter' };

  let service = harness.loadService();
  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('UC-chanter'), input),
    1,
    1
  );
  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('UC-chanter'), input),
    1,
    1
  );

  service = harness.loadService({ cold: true }); // mapper + storage + application process restart
  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('UC-chanter'), input),
    1,
    1
  );
  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('UC-chanter'), {
      postId: 'legacy',
      accountId: 'UC-chanter'
    }),
    1,
    1
  );

  assert.strictEqual(harness.records.get('exhausted'), durable);
  assert.deepEqual(durableSnapshot(harness.records.get('exhausted')), durableBefore);
  assert.deepEqual(durableSnapshot(harness.records.get('legacy')), legacyBefore);
  assert.equal(durable.status, 'failed');
  assert.equal(durable.claimAttempts, 1);
  assert.equal(durable.publishAttemptBudget, 1);
  assert.equal(durable.approvedBy, 'admin:owner');
  assert.equal(durable.history.at(-1).event, 'attempt_budget_exhausted');
  assert.equal(durable.evidence.durableMarker, 'must-survive-retry-rejection');
  assert.equal(harness.transactionPatches.length, 0);
  assert.equal(harness.retryWrites(), 0);

  const scheduler = harness.loadScheduler();
  const replay = await scheduler.processPost('exhausted', { force: true });
  assert.equal(replay.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  assert.strictEqual(harness.records.get('exhausted'), durable);
  assert.deepEqual(durableSnapshot(harness.records.get('exhausted')), durableBefore);
  assert.equal(harness.schedulerClaims(), 0);
  assert.equal(harness.youtubeAdapterCalls(), 0);
  assert.equal(harness.providerMutationCalls(), 0);

  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('UC-chanter'), input),
    1,
    1
  );
  assert.strictEqual(harness.records.get('exhausted'), durable);
});

test('non-exhausted failed item returns to schedule without decrementing authorization state', async (t) => {
  const approvedAt = timestamp('2026-07-18T11:01:40.847Z');
  const scheduledAt = timestamp('2026-07-18T14:00:00.000Z');
  const harness = installHarness(t, {
    retryable: youtubeJob({
      scheduledAt,
      approvedAt,
      claimAttempts: 1,
      publishAttemptBudget: 2,
      failedAt: timestamp('2026-07-18T11:05:01.000Z'),
      providerStatus: 'attempt_budget_exhausted'
    })
  });
  const service = harness.loadService();
  const input = { postId: 'retryable', accountId: 'UC-chanter' };
  const concurrent = await Promise.allSettled([
    service.retryPost(harness.context('UC-chanter'), input),
    service.retryPost(harness.context('UC-chanter'), input)
  ]);
  const fulfilled = concurrent.filter((entry) => entry.status === 'fulfilled');
  const rejected = concurrent.filter((entry) => entry.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'queue_transition_blocked');
  const result = fulfilled[0].value;

  assert.equal(result.ok, true);
  const durable = harness.records.get('retryable');
  assert.equal(durable.status, 'scheduled');
  assert.equal(durable.claimAttempts, 1);
  assert.equal(durable.publishAttemptBudget, 2);
  assert.strictEqual(durable.approvedAt, approvedAt);
  assert.equal(durable.approvedBy, 'admin:owner');
  assert.strictEqual(durable.scheduledAt, scheduledAt);
  assert.equal(durable.failedAt, null);
  assert.equal(durable.providerStatus, null);
  assert.equal(durable.history.at(-1).event, 'retry_requested');
  assert.doesNotMatch(durable.history.at(-1).detail, /clear|reset/i);
  assert.equal(harness.retryWrites(), 1);
  assert.equal(harness.schedulerClaims(), 0);
  assert.equal(harness.youtubeAdapterCalls(), 0);
  assert.equal(harness.providerMutationCalls(), 0);

  const retryPatch = harness.transactionPatches.at(-1).patch;
  for (const authorityField of [
    'claimAttempts',
    'publishAttemptBudget',
    'approvedAt',
    'approvedBy',
    'scheduledAt',
    'scheduledTimeUTC'
  ]) assert.equal(Object.hasOwn(retryPatch, authorityField), false);

  const afterFirstRetry = harness.records.get('retryable');
  await assert.rejects(
    harness.loadService({ cold: true }).retryPost(harness.context('UC-chanter'), input),
    (error) => error.status === 409 && error.code === 'queue_transition_blocked'
  );
  assert.strictEqual(harness.records.get('retryable'), afterFirstRetry);
  assert.equal(harness.retryWrites(), 1, 'duplicate retry does not append evidence');
});

test('legacy scheduledTimeUTC retry stays pending and remains scheduler-eligible', async (t) => {
  const legacySchedule = timestamp('2026-07-18T11:30:00.000Z');
  const legacy = youtubeJob({
    scheduledTimeUTC: legacySchedule,
    claimAttempts: 1,
    publishAttemptBudget: 2
  });
  delete legacy.scheduledAt;
  const harness = installHarness(t, { legacy });
  const service = harness.loadService();

  const retried = await service.retryPost(harness.context('UC-chanter'), {
    postId: 'legacy',
    accountId: 'UC-chanter'
  });
  const durable = harness.records.get('legacy');

  assert.equal(retried.post.status, 'pending');
  assert.equal(durable.status, 'pending');
  assert.equal(Object.hasOwn(durable, 'scheduledAt'), false);
  assert.strictEqual(durable.scheduledTimeUTC, legacySchedule);
  assert.equal(durable.claimAttempts, 1);
  assert.equal(durable.publishAttemptBudget, 2);
  assert.equal(harness.schedulerClaims(), 0);

  const scheduler = harness.loadScheduler();
  const claimed = await scheduler._private.claimPost('legacy', {
    force: false,
    workerId: 'synthetic-legacy-worker',
    now: new Date('2026-07-18T12:00:00.000Z')
  });
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.claimAttempts, 2);
  assert.equal(harness.records.get('legacy').claimAttempts, 2);
  assert.equal(harness.schedulerClaims(), 1);
  assert.equal(harness.youtubeAdapterCalls(), 0);
  assert.equal(harness.providerMutationCalls(), 0);
});

test('stale duplicate retry cannot overwrite a claimed processing state or lock', async (t) => {
  const harness = installHarness(t, {
    racing: youtubeJob({ claimAttempts: 0, publishAttemptBudget: 1 })
  });
  const service = harness.loadService();
  const input = { postId: 'racing', accountId: 'UC-chanter' };
  await service.retryPost(harness.context('UC-chanter'), input);

  const lockedAt = timestamp('2026-07-18T12:30:00.000Z');
  harness.replaceRecord('racing', {
    status: 'processing',
    claimAttempts: 1,
    lockedAt,
    lockedBy: 'synthetic-worker'
  });
  const claimed = harness.records.get('racing');

  await assert.rejects(
    harness.loadService().retryPost(harness.context('UC-chanter'), input),
    (error) => error.status === 409 && error.code === 'queue_transition_blocked'
  );
  assert.strictEqual(harness.records.get('racing'), claimed);
  assert.equal(claimed.status, 'processing');
  assert.equal(claimed.claimAttempts, 1);
  assert.strictEqual(claimed.lockedAt, lockedAt);
  assert.equal(claimed.lockedBy, 'synthetic-worker');
  assert.equal(harness.retryWrites(), 1);
  assert.equal(harness.youtubeAdapterCalls(), 0);
  assert.equal(harness.providerMutationCalls(), 0);
});

test('non-YouTube retry remains compatible below budget and is sealed at the same budget', async (t) => {
  const approvedAt = timestamp('2026-07-18T11:01:40.847Z');
  const effectiveAttemptBudget = Math.max(1, Number(config.scheduler.maxClaimAttempts) || 1);
  const remainingAttempts = Math.max(0, effectiveAttemptBudget - 1);
  const retryable = youtubeJob({
    provider: 'tiktok',
    platform: 'tiktok',
    accountId: 'tiktok-open-id',
    connectedAccountId: 'tiktok:tiktok-open-id',
    scheduledAt: null,
    approvedAt,
    claimAttempts: remainingAttempts,
    publishAttemptBudget: null
  });
  const exhausted = youtubeJob({
    provider: 'tiktok',
    platform: 'tiktok',
    accountId: 'tiktok-open-id',
    connectedAccountId: 'tiktok:tiktok-open-id',
    claimAttempts: effectiveAttemptBudget,
    publishAttemptBudget: null
  });
  const harness = installHarness(t, { retryable, exhausted });
  const service = harness.loadService();

  const allowed = await service.retryPost(harness.context('tiktok-open-id'), {
    postId: 'retryable',
    accountId: 'tiktok-open-id'
  });
  assert.equal(allowed.post.status, 'pending');
  assert.equal(harness.records.get('retryable').claimAttempts, remainingAttempts);
  assert.equal(harness.records.get('retryable').publishAttemptBudget, null);
  assert.strictEqual(harness.records.get('retryable').approvedAt, approvedAt);

  await assertAttemptBudgetConflict(
    service.retryPost(harness.context('tiktok-open-id'), {
      postId: 'exhausted',
      accountId: 'tiktok-open-id'
    }),
    effectiveAttemptBudget,
    effectiveAttemptBudget
  );
  assert.strictEqual(harness.records.get('exhausted'), exhausted);
  assert.equal(harness.youtubeAdapterCalls(), 0);
  assert.equal(harness.providerMutationCalls(), 0);
});
