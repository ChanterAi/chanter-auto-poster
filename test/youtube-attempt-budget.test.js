'use strict';

// Bounded exact-once closeout: one YouTube approval grants one durable claim.
// Exhaustion is terminal across automatic delivery, force replay, and module
// restart, and a pre-provider failure never reaches a provider upload call.

const assert = require('node:assert/strict');
const test = require('node:test');

function installHarness(t, seededRecords) {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  const youtubePath = require.resolve('../src/youtube');
  const modulePaths = [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath, youtubePath];
  for (const modulePath of modulePaths) delete require.cache[modulePath];

  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp('2026-07-18T12:29:08.352Z');
  const records = new Map(Object.entries(seededRecords));
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
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({ doc: (id) => ({ id }) }),
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (ref) => document(ref.id),
          update: (ref, patch) => applyUpdate(ref.id, patch)
        })
      }),
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
    exports: { publishPhotoPost: async () => { throw new Error('TikTok must not be called'); } }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => { throw new Error('Instagram must not be called'); }
    }
  };

  let adapterCalls = 0;
  let providerUploadCalls = 0;
  require.cache[youtubePath] = {
    id: youtubePath,
    filename: youtubePath,
    loaded: true,
    exports: {
      publishScheduledYouTubePost: async () => {
        adapterCalls += 1;
        return {
          ok: false,
          mode: 'api',
          providerMutationStarted: false,
          failureBoundary: 'before_provider_upload_session',
          reason: 'Could not load video media: fetch failed'
        };
      },
      // Deliberately never invoked: the adapter result above represents a
      // failure before its provider upload-session boundary.
      uploadVideo: async () => {
        providerUploadCalls += 1;
        throw new Error('provider upload must not be called');
      }
    }
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
    loadScheduler,
    adapterCalls: () => adapterCalls,
    providerUploadCalls: () => providerUploadCalls
  };
}

function youtubeJob(overrides = {}) {
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  return {
    userId: 'owner',
    workspaceId: 'workspace-owner',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    connectedAccountId: 'youtube:UC-chanter',
    username: 'chantercy',
    mediaType: 'video',
    mediaUrl: 'https://media.example.test/proof.mp4',
    providerMetadata: {
      youtube: {
        title: 'Exact proof title',
        description: '',
        privacyStatus: 'private',
        notifySubscribers: false
      }
    },
    status: 'scheduled',
    scheduledAt: timestamp('2026-07-18T11:05:00.000Z'),
    approvedAt: timestamp('2026-07-18T11:01:40.847Z'),
    approvedBy: 'admin:owner',
    claimAttempts: 0,
    publishAttemptBudget: 1,
    history: [],
    createdAt: timestamp('2026-07-18T10:59:00.000Z'),
    updatedAt: timestamp('2026-07-18T10:59:00.000Z'),
    ...overrides
  };
}

test('automatic pre-provider failure consumes the one approval budget and becomes terminal', async (t) => {
  const harness = installHarness(t, { proof: youtubeJob() });
  const scheduler = harness.loadScheduler();
  const result = await scheduler.processPost('proof', {
    workerId: 'guarded-worker',
    now: new Date('2026-07-18T11:05:04.892Z')
  });

  assert.equal(result.ok, false);
  assert.equal(result.retryScheduled, undefined, 'automatic retry must not exceed authorization');
  assert.equal(harness.adapterCalls(), 1);
  assert.equal(harness.providerUploadCalls(), 0);

  const record = harness.records.get('proof');
  assert.equal(record.status, 'failed');
  assert.equal(record.claimAttempts, 1);
  assert.equal(record.publishAttemptBudget, 1);
  assert.equal(record.providerStatus, 'attempt_budget_exhausted');
  assert.equal(record.lastResult.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(record.lastResult.providerMutationStarted, false);
  assert.equal(record.lastResult.failureBoundary, 'before_provider_upload_session');
  assert.equal(record.lastResult.willRetry, false);
  assert.equal(record.history.at(-1).event, 'attempt_budget_exhausted');
});

test('restart, force replay, and duplicate delivery cannot reopen an exhausted approval', async (t) => {
  const harness = installHarness(t, {
    proof: youtubeJob({
      status: 'failed',
      claimAttempts: 1,
      publishAttemptBudget: 1,
      providerStatus: 'attempt_budget_exhausted'
    }),
    legacyScheduled: youtubeJob({
      claimAttempts: 4,
      publishAttemptBudget: undefined
    })
  });

  let scheduler = harness.loadScheduler();
  const forced = await scheduler.processPost('proof', { force: true });
  assert.equal(forced.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');

  scheduler = harness.loadScheduler(); // process restart / module replay
  const replayed = await scheduler.processPost('proof', { force: true });
  assert.equal(replayed.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  const duplicateDelivery = await scheduler.processPost('proof', {
    now: new Date('2026-07-18T13:00:00.000Z')
  });
  assert.equal(duplicateDelivery.mode, 'skipped');

  const legacy = await scheduler.processPost('legacyScheduled', {
    now: new Date('2026-07-18T13:00:00.000Z')
  });
  assert.equal(legacy.code, 'PUBLISH_ATTEMPT_BUDGET_EXHAUSTED');
  assert.equal(harness.records.get('legacyScheduled').status, 'failed');
  assert.equal(harness.records.get('legacyScheduled').claimAttempts, 4);
  assert.equal(harness.records.get('legacyScheduled').providerStatus, 'attempt_budget_exhausted');

  assert.equal(harness.records.get('proof').claimAttempts, 1);
  assert.equal(harness.adapterCalls(), 0);
  assert.equal(harness.providerUploadCalls(), 0);
});
