'use strict';

// Real storage.js batch functions over an in-memory Firestore fake:
// batch stamping at creation, staggered schedule application, batch record
// CRUD, and — most important — the transactional preparation claim/record
// pair that makes interrupted batches resumable without double work.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
      _storeName: storeName,
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
      // Lease staleness in storage compares stored Timestamps against the
      // real clock, so the fake clock must be the real clock too.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-batch-storage-'));
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

const ACCOUNT_DEFAULTS = {
  accountId: 'account-a',
  tiktokOpenId: 'open-a',
  username: 'creator_a'
};

test('addUploadedPosts stamps batch identity and pending preparation on every item', async (t) => {
  const { storage } = loadStorageWithFakes(t);
  const files = tempVideos(t, ['one.mp4', 'two.mp4', 'three.mp4']);

  const created = await storage.addUploadedPosts('owner', files, {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-test-1'
  });

  assert.equal(created.length, 3);
  created.forEach((post, index) => {
    assert.equal(post.batchId, 'batch-test-1');
    assert.equal(post.batchOrder, index);
    assert.equal(post.preparation.status, 'pending');
    assert.equal(post.preparation.attempts, 0);
    assert.equal(post.approved, false, 'batch intake never approves');
    assert.equal(post.status, 'pending');
  });

  // Non-batch intake keeps the legacy shape.
  const legacy = await storage.addUploadedPosts('owner', tempVideos(t, ['plain.mp4']), { ...ACCOUNT_DEFAULTS });
  assert.equal(legacy[0].batchId, '');
  assert.equal(legacy[0].batchOrder, null);
  assert.equal(legacy[0].preparation, null);
});

test('applyStaggeredSchedule assigns slot times in order and rejects slot/item mismatch', async (t) => {
  const { storage } = loadStorageWithFakes(t);
  const files = tempVideos(t, ['one.mp4', 'two.mp4']);
  const created = await storage.addUploadedPosts('owner', files, {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-test-2'
  });

  const plan = {
    baseAt: '2026-07-11T09:00:00.000Z',
    slots: [
      { index: 0, offsetMinutes: 0, scheduledAt: '2026-07-11T09:00:00.000Z' },
      { index: 1, offsetMinutes: 45, scheduledAt: '2026-07-11T09:45:00.000Z' }
    ]
  };
  const count = await storage.applyStaggeredSchedule('owner', created, plan);
  assert.equal(count, 2);

  const posts = await storage.getBatchPosts('owner', 'batch-test-2');
  assert.deepEqual(posts.map((post) => post.scheduledAt), [
    '2026-07-11T09:00:00.000Z',
    '2026-07-11T09:45:00.000Z'
  ]);
  assert.deepEqual(posts.map((post) => post.status), ['scheduled', 'scheduled']);
  assert.deepEqual(posts.map((post) => post.approved), [false, false]);

  await assert.rejects(
    storage.applyStaggeredSchedule('owner', created, { baseAt: plan.baseAt, slots: plan.slots.slice(0, 1) }),
    /1 slots for 2 queue items/
  );
});

test('batch records: create, replay-safe duplicate refusal, scoped reads, bounded updates', async (t) => {
  const { storage } = loadStorageWithFakes(t);

  const record = await storage.createBatchRecord({
    batchId: 'batch-record-1',
    userId: 'owner',
    workspaceId: 'ws-1',
    provider: 'tiktok',
    accountId: 'account-a',
    accountLabel: '@creator_a',
    status: 'preparing',
    itemCount: 2,
    staggerMinutes: 30,
    baseAt: '2026-07-11T09:00:00.000Z',
    timezoneName: 'UTC',
    intakeKey: 'key-1'
  });
  assert.equal(record.batchId, 'batch-record-1');
  assert.equal(record.status, 'preparing');
  assert.equal(record.baseAt, '2026-07-11T09:00:00.000Z');

  await assert.rejects(
    storage.createBatchRecord({ batchId: 'batch-record-1', userId: 'owner' }),
    /already exists/
  );
  await assert.rejects(storage.createBatchRecord({ batchId: 'bad id!', userId: 'owner' }), /Invalid batch identifier/);

  assert.equal(await storage.getBatchRecord('someone-else', 'batch-record-1'), null, 'other owners cannot read');
  assert.equal(
    await storage.getBatchRecord('owner', 'batch-record-1', { workspaceId: 'ws-2', allowLegacyOwnerRecords: false }),
    null,
    'other workspaces cannot read'
  );
  const scoped = await storage.getBatchRecord('owner', 'batch-record-1', { workspaceId: 'ws-1' });
  assert.equal(scoped.batchId, 'batch-record-1');

  const updated = await storage.updateBatchRecord('owner', 'batch-record-1', {
    status: 'ready',
    preparedCount: 2,
    nonsense: 'must-not-land'
  });
  assert.equal(updated.status, 'ready');
  assert.equal(updated.preparedCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(updated, 'nonsense'), false);

  const listed = await storage.listBatchRecords('owner');
  assert.equal(listed.length, 1);
});

test('preparation claim lifecycle: claim, in-progress refusal, stale reclaim, terminal states', async (t) => {
  const { storage, fake } = loadStorageWithFakes(t);
  const files = tempVideos(t, ['clip.mp4']);
  const [post] = await storage.addUploadedPosts('owner', files, {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-claim-1'
  });

  // First claim wins.
  const claim = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 3 });
  assert.equal(claim.outcome, 'claimed');
  assert.equal(claim.attempt, 1);

  // A second runner sees a fresh lease and refuses.
  const concurrent = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 3 });
  assert.equal(concurrent.outcome, 'in_progress');

  // After the lease goes stale (crashed runner), the claim is reclaimable.
  const staleLease = makeTimestamp(new Date(Date.now() - 60 * 60_000));
  const raw = fake.stores.get('posts').get(post.id);
  fake.stores.get('posts').set(post.id, {
    ...raw,
    preparation: { ...raw.preparation, leaseAt: staleLease }
  });
  const reclaimed = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 3 });
  assert.equal(reclaimed.outcome, 'claimed');
  assert.equal(reclaimed.attempt, 2);

  // Success is terminal: further claims are refused.
  const recorded = await storage.recordBatchItemPreparationResult('owner', post.id, {
    ok: true,
    caption: 'Prepared caption',
    hashtags: '#a #b',
    provider: 'fake-ai',
    fallbackUsed: false
  });
  assert.deepEqual(recorded, { ok: true });
  const afterSuccess = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 3 });
  assert.equal(afterSuccess.outcome, 'already_succeeded');

  const persisted = await storage.getBatchPosts('owner', 'batch-claim-1');
  assert.equal(persisted[0].caption, 'Prepared caption');
  assert.equal(persisted[0].preparation.status, 'succeeded');
  assert.equal(persisted[0].preparation.provider, 'fake-ai');
  assert.ok(persisted[0].history.some((entry) => entry.event === 'prepared'), 'evidence history recorded');

  // Wrong owner can never claim.
  assert.deepEqual(await storage.claimBatchItemPreparation('intruder', post.id, {}), { outcome: 'not_found' });
});

test('preparation attempts are bounded and failures preserve operator-editable state', async (t) => {
  const { storage } = loadStorageWithFakes(t);
  const files = tempVideos(t, ['clip.mp4']);
  const [post] = await storage.addUploadedPosts('owner', files, {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-fail-1'
  });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const claim = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 2 });
    assert.equal(claim.outcome, 'claimed');
    await storage.recordBatchItemPreparationResult('owner', post.id, { ok: false, error: `boom ${attempt}` });
  }

  const exhausted = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 2 });
  assert.equal(exhausted.outcome, 'attempts_exhausted');

  const persisted = await storage.getBatchPosts('owner', 'batch-fail-1');
  assert.equal(persisted[0].preparation.status, 'failed');
  assert.equal(persisted[0].preparation.attempts, 2);
  assert.match(persisted[0].preparation.error, /boom 2/);
  assert.ok(persisted[0].history.some((entry) => entry.event === 'preparation_failed'));
  assert.equal(persisted[0].status, 'pending', 'queue lifecycle untouched by preparation failure');
});

test('preparation result never overwrites operator-written caption or hashtags', async (t) => {
  const { storage, fake } = loadStorageWithFakes(t);
  const files = tempVideos(t, ['clip.mp4']);
  const [post] = await storage.addUploadedPosts('owner', files, {
    ...ACCOUNT_DEFAULTS,
    batchId: 'batch-humans-win',
    caption: 'Operator caption',
    hashtags: '#operator'
  });

  const claim = await storage.claimBatchItemPreparation('owner', post.id, { leaseMs: 10 * 60_000, maxAttempts: 3 });
  assert.equal(claim.outcome, 'claimed');
  await storage.recordBatchItemPreparationResult('owner', post.id, {
    ok: true,
    caption: 'Machine caption',
    hashtags: '#machine',
    provider: 'fake-ai'
  });

  const persisted = await storage.getBatchPosts('owner', 'batch-humans-win');
  assert.equal(persisted[0].caption, 'Operator caption');
  assert.equal(persisted[0].hashtags, '#operator');
  assert.equal(persisted[0].preparation.status, 'succeeded');
});
