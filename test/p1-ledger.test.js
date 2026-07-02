'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

/**
 * Tests for publish result ledger and duplicate-post guard.
 * Uses mocked Firestore and TikTok modules — no real API calls.
 */

function setupMocks({ records = new Map(), tiktokResult = null } = {}) {
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
    data: () => records.get(id)
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
    limit() { return createQuery(filters); },
    async get() {
      let docs = [...records.keys()].map(document);
      for (const filter of filters) {
        docs = docs.filter((doc) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') return value && value.toMillis() <= filter.value.toMillis();
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
      configDoc: () => ({ set: async () => {} }),
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

  const defaultTiktokResult = tiktokResult || {
    ok: true,
    mode: 'api',
    response: { data: { publish_id: 'tiktok_pub_abc123', status: 'PROCESSING_UPLOAD' } }
  };

  require.cache[tiktokPath] = {
    id: tiktokPath, filename: tiktokPath, loaded: true,
    exports: {
      publishPhotoPost: async () => defaultTiktokResult
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

test('successful publish stores publishId as a durable top-level field', async () => {
  const records = new Map([['job-success', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'scheduled',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    claimAttempts: 0
  }]]);

  const { fixedNow, cleanup } = setupMocks({ records });
  const scheduler = require('../src/scheduler');
  const result = await scheduler.runSchedulerTick({ now: fixedNow });

  const stored = records.get('job-success');
  assert.equal(stored.status, 'posted');
  assert.equal(stored.publishId, 'tiktok_pub_abc123',
    'publishId should be stored as a top-level field on success');
  assert.ok(stored.postedAt, 'postedAt should be set');
  assert.ok(stored.lastResult, 'lastResult should be stored');
  assert.ok(stored.lastResult.completedAt, 'lastResult should have completedAt');

  cleanup();
});

test('failed publish stores redacted error metadata without raw response', async () => {
  const records = new Map([['job-fail', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'scheduled',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    claimAttempts: 0
  }]]);

  const { fixedNow, cleanup } = setupMocks({
    records,
    tiktokResult: {
      ok: false,
      mode: 'api',
      reason: 'TikTok API returned HTTP 403',
      code: 'TIKTOK_FORBIDDEN',
      response: { access_token: 'secret_tok_123', error: 'forbidden' }
    }
  });

  const scheduler = require('../src/scheduler');
  await scheduler.runSchedulerTick({ now: fixedNow });

  const stored = records.get('job-fail');
  assert.equal(stored.status, 'failed');
  assert.equal(stored.errorMessage, 'TikTok API returned HTTP 403');
  assert.ok(stored.lastResult, 'lastResult should be stored');
  assert.equal(stored.lastResult.ok, false);
  assert.equal(stored.lastResult.reason, 'TikTok API returned HTTP 403');
  assert.equal(stored.lastResult.code, 'TIKTOK_FORBIDDEN');
  assert.equal(stored.lastResult.response, undefined,
    'raw response with potential tokens should not be stored in lastResult for failures');
  assert.equal(stored.publishId, undefined,
    'publishId should not be set on failure');

  cleanup();
});

test('duplicate-post guard prevents re-publishing a job that already has publishId', async () => {
  const records = new Map([['job-already-published', {
    userId: 'owner', platform: 'tiktok', accountId: 'acc-1', tiktokOpenId: 'acc-1',
    status: 'posted',
    publishId: 'tiktok_pub_existing_456',
    scheduledAt: { toDate: () => new Date('2026-06-20T11:59:00.000Z'), toMillis: () => Date.parse('2026-06-20T11:59:00.000Z') },
    createdAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    updatedAt: { toDate: () => new Date(), toMillis: () => Date.now() },
    postedAt: { toDate: () => new Date('2026-06-20T12:00:00.000Z'), toMillis: () => Date.parse('2026-06-20T12:00:00.000Z') },
    claimAttempts: 1
  }]]);

  let publishCalled = false;
  const { fixedNow, cleanup } = setupMocks({
    records,
    tiktokResult: { ok: true, mode: 'api', response: { publish_id: 'should_not_be_called' } }
  });

  // Override the mock to track if publish is called
  const tiktokModule = require.cache[require.resolve('../src/tiktok')].exports;
  tiktokModule.publishPhotoPost = async () => { publishCalled = true; return { ok: true }; };

  const scheduler = require('../src/scheduler');

  // Try to force-process the already-published job
  const result = await scheduler.processPost('job-already-published', { force: true, now: fixedNow });

  assert.equal(publishCalled, false, 'publishPhotoPost must not be called for a job with existing publishId');
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'skipped');

  cleanup();
});

test('extractPublishId finds publish_id in nested TikTok response', () => {
  // Re-require scheduler to get the function
  const schedulerPath = require.resolve('../src/scheduler');
  delete require.cache[schedulerPath];

  // We need to set up minimal mocks to require scheduler
  const { cleanup } = setupMocks({ records: new Map() });
  const scheduler = require('../src/scheduler');

  assert.equal(scheduler._private.extractPublishId({ data: { publish_id: 'pub_123' } }), 'pub_123');
  assert.equal(scheduler._private.extractPublishId({ data: { post_id: 'post_456' } }), 'post_456');
  assert.equal(scheduler._private.extractPublishId({ data: { share_url: 'https://tiktok.com/share/abc' } }), 'https://tiktok.com/share/abc');
  assert.equal(scheduler._private.extractPublishId({}), null);
  assert.equal(scheduler._private.extractPublishId(null), null);
  assert.equal(scheduler._private.extractPublishId({ data: { status: 'PROCESSING' } }), null);

  cleanup();
});
