'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('cron tick atomically publishes a due scheduled Firestore job', async (t) => {
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
  const records = new Map([['due-job', {
    userId: 'owner',
    platform: 'tiktok',
    accountId: 'account-b',
    tiktokOpenId: 'account-b',
    username: 'account_b',
    originalName: 'scheduled.mp4',
    mediaType: 'video',
    mediaUrl: 'https://res.cloudinary.com/test/video/upload/scheduled.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:59:00.000Z'),
    createdAt: timestamp('2026-06-20T10:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T10:00:00.000Z'),
    claimAttempts: 0
  }], ['instagram-job', {
    userId: 'owner',
    platform: 'instagram',
    originalName: 'story.mp4',
    mediaType: 'video',
    mediaUrl: 'https://cdn.example.com/story.mp4',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:57:00.000Z'),
    createdAt: timestamp('2026-06-20T08:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T08:00:00.000Z'),
    claimAttempts: 0
  }], ['legacy-job', {
    userId: 'owner',
    platform: 'tiktok',
    originalName: 'legacy.jpg',
    mediaType: 'photo',
    mediaUrl: 'https://cdn.example.com/legacy.jpg',
    status: 'scheduled',
    scheduledAt: timestamp('2026-06-20T11:58:00.000Z'),
    createdAt: timestamp('2026-06-20T09:00:00.000Z'),
    updatedAt: timestamp('2026-06-20T09:00:00.000Z'),
    claimAttempts: 0
  }]]);
  const queries = [];
  const logs = [];
  const publishedJobs = [];
  let instagramHealthChecks = 0;
  let instagramPublishCalls = 0;

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
  const createQuery = (filters = [], orderField = null, queryLimit = null) => ({
    where(field, operator, value) {
      return createQuery([...filters, { field, operator, value }], orderField, queryLimit);
    },
    orderBy(field) { return createQuery(filters, field, queryLimit); },
    limit(value) { return createQuery(filters, orderField, value); },
    async get() {
      queries.push({ filters, orderField, limit: queryLimit });
      let docs = [...records.keys()].map(document);
      for (const filter of filters) {
        docs = docs.filter((doc) => {
          const value = doc.data()[filter.field];
          if (filter.operator === '==') return value === filter.value;
          if (filter.operator === '<=') return value && value.toMillis() <= filter.value.toMillis();
          return false;
        });
      }
      if (orderField) docs.sort((a, b) => a.data()[orderField].toMillis() - b.data()[orderField].toMillis());
      return { docs: queryLimit ? docs.slice(0, queryLimit) : docs };
    }
  });
  const collection = {
    where: (...args) => createQuery().where(...args),
    doc: (id) => ref(id)
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
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
  require.cache[tiktokPath] = {
    id: tiktokPath,
    filename: tiktokPath,
    loaded: true,
    exports: {
      publishPhotoPost: async (job) => {
        publishedJobs.push(job);
        return {
          ok: true,
          mode: 'api',
          response: { data: { publish_id: 'publish-123', status: 'PROCESSING_UPLOAD' } }
        };
      }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: {
      getInstagramHealth: async () => {
        instagramHealthChecks += 1;
        return {
          success: true,
          platform: 'instagram',
          configured: false,
          canPublish: false,
          mode: 'dry-run',
          missing: ['META_APP_ID']
        };
      },
      publishInstagramMedia: async () => {
        instagramPublishCalls += 1;
        throw new Error('Instagram Graph API must not be called when configuration is missing');
      }
    }
  };

  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.log = originalLog;
    for (const modulePath of [firestorePath, tiktokPath, instagramPath, mapperPath, schedulerPath]) {
      delete require.cache[modulePath];
    }
  });

  const scheduler = require('../src/scheduler');
  const result = await scheduler.runSchedulerTick({ now: fixedNow, batchSize: 10 });

  assert.deepEqual(result, {
    ok: true,
    now: fixedNow.toISOString(),
    checked: 3,
    due: 3,
    accepted: 1,
    posted: 0,
    failed: 2,
    errors: [
      {
        id: 'instagram-job',
        error: 'Instagram publishing is not configured.'
      },
      {
        id: 'legacy-job',
        error: 'TikTok account is unassigned for this job; publishing was blocked.'
      }
    ]
  });
  assert.equal(records.get('due-job').status, 'accepted');
  assert.equal(records.get('due-job').postedAt, null);
  assert.equal(records.get('due-job').lockedBy, null);
  assert.equal(records.get('due-job').claimAttempts, 1);
  assert.equal(records.get('legacy-job').status, 'failed');
  assert.match(records.get('legacy-job').errorMessage, /unassigned/i);
  assert.equal(records.get('instagram-job').status, 'failed');
  assert.equal(records.get('instagram-job').errorMessage, 'Instagram publishing is not configured.');
  assert.equal(instagramHealthChecks, 1);
  assert.equal(instagramPublishCalls, 0);
  assert.equal(publishedJobs.length, 1);
  assert.equal(publishedJobs[0].accountId, 'account-b');
  assert.equal(publishedJobs[0].tiktokOpenId, 'account-b');
  assert.ok(queries.some((query) =>
    query.filters.some((filter) => filter.field === 'status' && filter.value === 'scheduled') &&
    query.filters.some((filter) => filter.field === 'scheduledAt' && filter.operator === '<=') &&
    query.orderField === 'scheduledAt'
  ));
  for (const marker of ['[CRON_TICK]', '[CRON_QUERY]', '[JOB_FOUND]', '[JOB_DUE]', '[POST_START]', '[POST_ACCEPTED]']) {
    assert.ok(logs.some((line) => line.includes(marker)), `missing log marker ${marker}`);
  }
});

test('Firestore index failures expose the generated console link', () => {
  const scheduler = require('../src/scheduler');
  const url = 'https://console.firebase.google.com/v1/r/project/test/firestore/indexes?create_composite=abc';
  const described = scheduler._private.describeQueryError(new Error(`The query requires an index. ${url}`));
  assert.equal(described.indexUrl, url);
});
