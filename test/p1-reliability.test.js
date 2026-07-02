'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * Tests for scheduler reliability: stale lock recovery, health endpoint
 * safety, and missed job handling. Uses mocked Firestore and TikTok.
 */

function setupMocks({ records = new Map(), failQueries = [] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const mapperPath = require.resolve('../src/postsMapper');
  const schedulerPath = require.resolve('../src/scheduler');
  for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
    delete require.cache[modulePath];
  }

  const fixedNow = new Date('2026-06-20T12:00:00.000Z');
  const timestamp = (value) => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  const serverTimestamp = timestamp(fixedNow);
  const failedQueryNames = new Set(failQueries);

  const document = (id) => ({
    id,
    get exists() { return records.has(id); },
    data: () => records.get(id),
    ref: { id }
  });
  const ref = (id) => ({ id });
  const applyUpdate = (id, patch) => {
    const current = records.get(id);
    const next = { ...current };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && value.__increment ? Number(next[key] || 0) + value.__increment : value;
    }
    records.set(id, next);
  };
  const createQuery = (filters = []) => ({
    where(field, operator, value) { return createQuery([...filters, { field, operator, value }]); },
    orderBy() { return createQuery(filters); },
    limit(value) { return createQuery(filters); },
    async get() {
      const queryName = getQueryName(filters);
      if (failedQueryNames.has(queryName)) {
        const error = new Error('Simulated Firestore health query failure');
        error.code = 'unavailable';
        throw error;
      }
      let docs = [...records.keys()].map(document);
      for (const filter of filters) {
        docs = docs.filter((doc) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') {
            if (!value) return false;
            return typeof value.toMillis === 'function'
              ? value.toMillis() <= (typeof filter.value.toMillis === 'function' ? filter.value.toMillis() : filter.value)
              : value <= filter.value;
          }
          return false;
        });
      }
      return { docs, size: docs.length };
    }
  });
  const collection = {
    where: (...args) => createQuery().where(...args),
    doc: (id) => ref(id)
  };

  require.cache[firestorePath] = {
    id: firestorePath, filename: firestorePath, loaded: true,
    exports: {
      postsCollection: () => collection,
      getFirestore: () => ({
        runTransaction: async (callback) => callback({
          get: async (documentRef) => document(documentRef.id),
          update: (documentRef, patch) => applyUpdate(documentRef.id, patch)
        })
      }),
      Timestamp: {
        now: () => serverTimestamp,
        fromDate: timestamp,
        fromMillis: (value) => timestamp(new Date(value))
      },
      FieldValue: {
        serverTimestamp: () => serverTimestamp,
        increment: (value) => ({ __increment: value })
      }
    }
  };

  require.cache[tiktokPath] = {
    id: tiktokPath, filename: tiktokPath, loaded: true,
    exports: {
      publishPhotoPost: async () => ({
        ok: true, mode: 'api',
        response: { data: { publish_id: 'pub_test_123', status: 'PROCESSING_UPLOAD' } }
      })
    }
  };

  require.cache[instagramPath] = {
    id: instagramPath, filename: instagramPath, loaded: true,
    exports: {
      getInstagramHealth: async () => ({ configured: false, canPublish: false }),
      publishInstagramMedia: async () => { throw new Error('Not configured'); }
    }
  };

  return {
    fixedNow,
    timestamp,
    records,
    cleanup: () => {
      for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
        delete require.cache[modulePath];
      }
    }
  };
}

function getQueryName(filters) {
  const status = filters.find((filter) => filter.field === 'status' && filter.operator === '==')?.value;
  if (status === 'scheduled' && filters.some((filter) => filter.field === 'scheduledAt')) {
    return 'canonicalScheduledOverdue';
  }
  if (status === 'pending' && filters.some((filter) => filter.field === 'scheduledTimeUTC')) {
    return 'legacyPendingOverdue';
  }
  if (status === 'processing' && !filters.some((filter) => filter.field === 'lockedAt')) {
    return 'processingLocks';
  }
  return 'other';
}

test('stale locked job is recovered to scheduled status on next tick', async () => {
  const staleTime = new Date('2026-06-20T11:30:00.000Z'); // 30 min before fixedNow
  const records = new Map([['stale-job', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'processing',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    lockedAt: { toDate: () => staleTime, toMillis: () => staleTime.getTime() },
    lockedBy: 'old-worker-123',
    claimAttempts: 1,
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() }
  }]]);

  const { fixedNow, cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');
  await scheduler.runSchedulerTick({ now: fixedNow });

  const stored = records.get('stale-job');
  // The stale lock should have been recovered: the job transitioned from
  // 'processing' (stale) back to 'scheduled', then was picked up and
  // published successfully. The key assertion is that it didn't stay
  // stuck in 'processing' with the old lock.
  assert.notEqual(stored.status, 'processing',
    'stale processing job should not remain in processing');
  assert.equal(stored.lockedBy, null, 'old lock should be cleared');
  // The job should have been successfully republished (mock returns ok)
  assert.equal(stored.status, 'posted',
    'recovered job should be successfully published after recovery');
  assert.ok(stored.publishId, 'recovered job should have a publishId');

  cleanup();
});

test('stale locked job that exceeded maxClaimAttempts is marked failed', async () => {
  const staleTime = new Date('2026-06-20T11:30:00.000Z');
  const records = new Map([['poison-job', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'processing',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    lockedAt: { toDate: () => staleTime, toMillis: () => staleTime.getTime() },
    lockedBy: 'old-worker-456',
    claimAttempts: 5, // at max
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() }
  }]]);

  const { fixedNow, cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');
  await scheduler.runSchedulerTick({ now: fixedNow });

  const stored = records.get('poison-job');
  assert.equal(stored.status, 'failed',
    'job exceeding maxClaimAttempts should be marked failed');
  assert.equal(stored.lockedAt, null);
  assert.equal(stored.lockedBy, null);
  assert.ok(stored.errorMessage, 'errorMessage should be set');

  cleanup();
});

test('active processing job is not recovered or republished', async () => {
  const records = new Map([['active-job', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'processing',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    lockedAt: { toDate: () => new Date('2026-06-20T11:55:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:55:00.000Z') },
    lockedBy: 'active-worker',
    claimAttempts: 1
  }]]);

  let publishCalled = false;
  const { fixedNow, cleanup } = setupMocks({ records });
  require.cache[require.resolve('../src/tiktok')].exports.publishPhotoPost = async () => {
    publishCalled = true;
    return { ok: true };
  };
  const scheduler = require('../src/scheduler');

  await scheduler.runSchedulerTick({ now: fixedNow });
  const stored = records.get('active-job');

  assert.equal(publishCalled, false);
  assert.equal(stored.status, 'processing');
  assert.equal(stored.lockedBy, 'active-worker');
  assert.equal(stored.claimAttempts, 1);

  cleanup();
});

test('processing job with missing lock metadata fails closed without publishing', async () => {
  const records = new Map([['missing-lock-job', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'processing',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    lockedBy: 'unknown-worker',
    claimAttempts: 1
  }]]);

  let publishCalled = false;
  const { fixedNow, cleanup } = setupMocks({ records });
  require.cache[require.resolve('../src/tiktok')].exports.publishPhotoPost = async () => {
    publishCalled = true;
    return { ok: true };
  };
  const scheduler = require('../src/scheduler');

  const result = await scheduler.runSchedulerTick({ now: fixedNow });
  const stored = records.get('missing-lock-job');

  assert.equal(result.ok, true);
  assert.equal(publishCalled, false);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.lockedAt, null);
  assert.equal(stored.lockedBy, null);
  assert.equal(stored.lastResult.code, 'RECOVERY_LOCK_INVALID');
  assert.match(stored.errorMessage, /automatic retry was blocked/i);

  cleanup();
});

test('stale processing job with a publishId is not resubmitted', async () => {
  const staleTime = new Date('2026-06-20T11:30:00.000Z');
  const records = new Map([['accepted-before-crash', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'processing',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    lockedAt: { toDate: () => staleTime, toMillis: () => staleTime.getTime() },
    lockedBy: 'old-worker',
    claimAttempts: 1,
    publishId: 'remote-publish-123'
  }]]);

  let publishCalled = false;
  const { fixedNow, cleanup } = setupMocks({ records });
  require.cache[require.resolve('../src/tiktok')].exports.publishPhotoPost = async () => {
    publishCalled = true;
    return { ok: true };
  };
  const scheduler = require('../src/scheduler');

  await scheduler.runSchedulerTick({ now: fixedNow });
  const stored = records.get('accepted-before-crash');

  assert.equal(publishCalled, false);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.publishId, 'remote-publish-123');
  assert.equal(stored.lastResult.code, 'RECOVERY_REMOTE_STATE_UNKNOWN');
  assert.match(stored.errorMessage, /verify the provider result/i);

  cleanup();
});

test('stale lock recovery query failure makes the tick non-successful', async () => {
  const { fixedNow, cleanup } = setupMocks({ failQueries: ['processingLocks'] });
  const scheduler = require('../src/scheduler');

  const result = await scheduler.runSchedulerTick({ now: fixedNow });

  assert.equal(result.ok, false);
  assert.equal(result.checked, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /stale lock recovery failed/i);

  cleanup();
});

test('getSchedulerHealth returns safe fields without secrets', async () => {
  const records = new Map();
  const { cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');

  const health = await scheduler.getSchedulerHealth();

  // Must include operational fields
  assert.ok('staleProcessingCount' in health, 'should report staleProcessingCount');
  assert.ok('stuckPendingCount' in health, 'should report stuckPendingCount');
  assert.equal(health.lastTickScope, 'process-local');
  assert.equal(health.lastTickDurable, false);
  assert.equal(health.degraded, false);
  assert.equal(health.firestoreHealthError, false);
  assert.ok('staleLockMinutes' in health, 'should report staleLockMinutes');
  assert.ok('maxClaimAttempts' in health, 'should report maxClaimAttempts');

  // Must NOT include any secret-like values
  const healthStr = JSON.stringify(health);
  assert.ok(!healthStr.includes('token'), 'health must not contain "token"');
  assert.ok(!healthStr.includes('secret'), 'health must not contain "secret"');
  assert.ok(!healthStr.includes('password'), 'health must not contain "password"');
  assert.ok(!healthStr.includes('api_key'), 'health must not contain "api_key"');

  cleanup();
});

test('scheduler health counts overdue canonical jobs and excludes future scheduled jobs', async () => {
  const records = new Map();
  const { fixedNow, timestamp, cleanup } = setupMocks({ records });
  records.set('overdue-canonical', {
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:59:00.000Z')
  });
  records.set('future-canonical', {
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T12:05:00.000Z')
  });

  const scheduler = require('../src/scheduler');
  const health = await scheduler.getSchedulerHealth({ now: fixedNow });

  assert.equal(health.overdueScheduledCount, 1);
  assert.equal(health.overdueLegacyPendingCount, 0);
  assert.equal(health.overdueTotalCount, 1);
  assert.equal(health.degraded, true);
  assert.ok(health.degradedReasons.some((reason) => reason.code === 'overdue_scheduled_jobs'));

  cleanup();
});

test('scheduler health separates active processing jobs from stale processing jobs', async () => {
  const records = new Map();
  const { fixedNow, timestamp, cleanup } = setupMocks({ records });
  records.set('active-processing', {
    status: 'processing',
    lockedAt: timestamp(fixedNow)
  });
  records.set('stale-processing', {
    status: 'processing',
    lockedAt: timestamp('2026-06-19T12:00:00.000Z')
  });

  const scheduler = require('../src/scheduler');
  const health = await scheduler.getSchedulerHealth({ now: fixedNow });

  assert.equal(health.activeProcessingCount, 1);
  assert.equal(health.staleProcessingCount, 1);
  assert.equal(health.processingMissingLockCount, 0);
  assert.ok(health.degradedReasons.some((reason) => reason.code === 'stale_processing_jobs'));

  cleanup();
});

test('scheduler health reports processing jobs with missing or invalid lock metadata', async () => {
  const records = new Map([
    ['missing-lock', { status: 'processing' }],
    ['invalid-lock', { status: 'processing', lockedAt: 'not-a-firestore-timestamp' }]
  ]);
  const { fixedNow, cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');

  const health = await scheduler.getSchedulerHealth({ now: fixedNow });

  assert.equal(health.processingMissingLockCount, 2);
  assert.equal(health.activeProcessingCount, 0);
  assert.equal(health.staleProcessingCount, 0);
  assert.equal(health.degraded, true);
  assert.ok(health.degradedReasons.some((reason) => reason.code === 'processing_missing_lock'));

  cleanup();
});

test('scheduler health reports Firestore query failures as degraded instead of false green', async () => {
  const { fixedNow, cleanup } = setupMocks({ failQueries: ['canonicalScheduledOverdue'] });
  const scheduler = require('../src/scheduler');

  const health = await scheduler.getSchedulerHealth({ now: fixedNow });

  assert.equal(health.degraded, true);
  assert.equal(health.firestoreHealthError, true);
  assert.deepEqual(health.firestoreHealthFailedQueries, ['canonicalScheduledOverdue']);
  assert.equal(health.overdueScheduledCount, null);
  assert.equal(health.overdueTotalCount, null);
  assert.ok(health.degradedReasons.some((reason) => reason.code === 'firestore_health_query_failed'));
  assert.doesNotMatch(JSON.stringify(health), /Simulated Firestore health query failure/);

  cleanup();
});

test('scheduler health preserves legacy pending scheduledTimeUTC compatibility', async () => {
  const records = new Map();
  const { fixedNow, timestamp, cleanup } = setupMocks({ records });
  records.set('overdue-legacy', {
    status: 'pending',
    scheduledTimeUTC: timestamp('2026-06-20T11:59:00.000Z')
  });
  records.set('future-legacy', {
    status: 'pending',
    scheduledTimeUTC: timestamp('2026-06-20T12:05:00.000Z')
  });

  const scheduler = require('../src/scheduler');
  const health = await scheduler.getSchedulerHealth({ now: fixedNow });

  assert.equal(health.overdueScheduledCount, 0);
  assert.equal(health.overdueLegacyPendingCount, 1);
  assert.equal(health.stuckPendingCount, 1);
  assert.equal(health.overdueTotalCount, 1);
  assert.ok(health.degradedReasons.some((reason) => reason.code === 'overdue_legacy_pending_jobs'));

  cleanup();
});

test('completed job with publishId cannot be claimed even with force', async () => {
  const records = new Map([['completed-job', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'posted',
    publishId: 'tiktok_pub_existing_789',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    claimAttempts: 1
  }]]);

  let publishCalled = false;
  const { fixedNow, cleanup } = setupMocks({ records });

  // Override mock to detect if publish is called
  const tiktokModule = require.cache[require.resolve('../src/tiktok')].exports;
  tiktokModule.publishPhotoPost = async () => { publishCalled = true; return { ok: true }; };

  const scheduler = require('../src/scheduler');
  const result = await scheduler.processPost('completed-job', { force: true, now: fixedNow });

  assert.equal(publishCalled, false, 'must not publish a completed job with publishId');
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'skipped');

  cleanup();
});

test('runSchedulerTick records lastTickAt for health monitoring', async () => {
  const records = new Map();
  const { fixedNow, cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');

  // Before tick: lastTickAt should be null
  const stateBefore = scheduler.getSchedulerState();
  assert.equal(stateBefore.lastTickAt, null, 'lastTickAt should be null before first tick');

  // Run a tick
  await scheduler.runSchedulerTick({ now: fixedNow });

  // After tick: lastTickAt should be set
  const stateAfter = scheduler.getSchedulerState();
  assert.ok(stateAfter.lastTickAt, 'lastTickAt should be set after tick');
  assert.equal(stateAfter.lastTickOk, true, 'lastTickOk should be true after successful tick');
  assert.equal(stateAfter.lastTickScope, 'process-local');
  assert.equal(stateAfter.lastTickDurable, false);

  cleanup();
});
