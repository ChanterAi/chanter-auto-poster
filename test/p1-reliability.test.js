'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * Tests for scheduler reliability: stale lock recovery, health endpoint
 * safety, and missed job handling. Uses mocked Firestore and TikTok.
 */

function setupMocks({ records = new Map() } = {}) {
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
      return { docs };
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

test('getSchedulerHealth returns safe fields without secrets', async () => {
  const records = new Map();
  const { cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');

  const health = await scheduler.getSchedulerHealth();

  // Must include operational fields
  assert.ok('staleProcessingCount' in health, 'should report staleProcessingCount');
  assert.ok('stuckPendingCount' in health, 'should report stuckPendingCount');
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

  cleanup();
});
