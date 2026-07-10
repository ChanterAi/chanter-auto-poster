'use strict';

// storage.deletePost — the single Firestore delete path used by the admin
// queue (unscoped: any channel this user owns, including legacy jobs) and
// the client portal (channel-scoped). Covers the P0 regression set:
// missing posts, unauthorized posts, legacy ownership, channel scoping,
// and failed deletion.

const assert = require('node:assert/strict');
const test = require('node:test');

function installStorageMocks({ seededDocs = [], failDeleteIds = [] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const docs = new Map(seededDocs.map((docData) => [docData.id, { ...docData }]));
  const deletions = [];
  const destroyed = [];
  const failSet = new Set(failDeleteIds);
  const timestamp = () => ({
    toDate: () => new Date('2026-07-10T12:00:00.000Z'),
    toMillis: () => Date.parse('2026-07-10T12:00:00.000Z')
  });

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => ({ mediaUrl: '', publicId: '', resourceType: '' }),
      destroyMediaAsset: async (publicId, resourceType) => {
        if (publicId) destroyed.push({ publicId, resourceType });
      },
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  const postsCollection = {
    where: () => ({
      get: async () => ({ docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => data })) }),
      select: () => ({ get: async () => ({ docs: [] }) })
    }),
    doc: (id) => ({
      id,
      get: async () => ({ id, exists: docs.has(id), data: () => docs.get(id) }),
      update: async () => {},
      delete: async () => {
        deletions.push(id);
        if (failSet.has(id)) throw new Error('Firestore delete unavailable');
        docs.delete(id);
      }
    })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      configDoc: () => ({ get: async () => ({ exists: true, data: () => ({ dailyPostTime: '09:00' }) }) }),
      getFirestore: () => ({ batch: () => ({ set: () => {}, update: () => {}, commit: async () => {} }) }),
      Timestamp: { now: () => timestamp(), fromDate: () => timestamp() },
      FieldValue: { serverTimestamp: () => timestamp(), increment: () => 1 }
    }
  };

  const cleanup = () => {
    for (const modulePath of [storagePath, mapperPath, firestorePath, cloudinaryPath]) {
      delete require.cache[modulePath];
    }
  };

  return { storage: require('../src/storage'), docs, deletions, destroyed, cleanup };
}

test('deletePost removes an owned post on any channel and destroys its own media', async (t) => {
  const { storage, docs, deletions, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      {
        id: 'job-other-channel', userId: 'owner', accountId: 'account-b',
        cloudinaryPublicId: 'uploads/asset-b', cloudinaryResourceType: 'video', fileName: 'asset-b.mp4'
      }
    ]
  });
  t.after(cleanup);

  // Unscoped (admin) delete: the post lives on a channel other than the
  // "active" one — it must still be deleted because the same user owns it.
  assert.equal(await storage.deletePost('owner', 'job-other-channel'), true);
  assert.deepEqual(deletions, ['job-other-channel']);
  assert.equal(docs.has('job-other-channel'), false);
  assert.deepEqual(destroyed, [{ publicId: 'uploads/asset-b', resourceType: 'video' }]);
});

test('deletePost deletes legacy jobs that predate channel assignment', async (t) => {
  const { storage, docs, cleanup } = installStorageMocks({
    seededDocs: [
      // No accountId at all — postFromDoc maps this to accountId "legacy".
      { id: 'job-legacy', userId: 'owner', fileName: 'legacy.jpg', mediaType: 'photo' }
    ]
  });
  t.after(cleanup);

  // Historical image posts stay deletable: mediaType is irrelevant to delete.
  assert.equal(await storage.deletePost('owner', 'job-legacy'), true);
  assert.equal(docs.has('job-legacy'), false);
});

test('deletePost fails closed for missing and unauthorized posts', async (t) => {
  const { storage, docs, deletions, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-foreign', userId: 'someone-else', accountId: 'account-a', cloudinaryPublicId: 'uploads/foreign' }
    ]
  });
  t.after(cleanup);

  assert.equal(await storage.deletePost('owner', 'job-missing'), false);
  assert.equal(await storage.deletePost('owner', 'job-foreign'), false);
  assert.equal(await storage.deletePost('owner', ''), false);
  assert.deepEqual(deletions, [], 'no Firestore delete was attempted');
  assert.deepEqual(destroyed, [], 'no media was destroyed');
  assert.equal(docs.has('job-foreign'), true, 'the other user\'s post is untouched');
});

test('deletePost keeps the channel-scoped contract used by the client portal', async (t) => {
  const { storage, docs, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-a', userId: 'owner', accountId: 'account-a' },
      { id: 'job-b', userId: 'owner', accountId: 'account-b' }
    ]
  });
  t.after(cleanup);

  // A session scoped to account-a can never delete account-b's post…
  assert.equal(await storage.deletePost('owner', 'job-b', 'account-a'), false);
  assert.equal(docs.has('job-b'), true);
  // …but deletes its own.
  assert.equal(await storage.deletePost('owner', 'job-a', 'account-a'), true);
  assert.equal(docs.has('job-a'), false);
});

test('deletePost propagates a failed Firestore delete instead of claiming success', async (t) => {
  const { storage, docs, destroyed, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'job-flaky', userId: 'owner', accountId: 'account-a', cloudinaryPublicId: 'uploads/flaky' }
    ],
    failDeleteIds: ['job-flaky']
  });
  t.after(cleanup);

  await assert.rejects(storage.deletePost('owner', 'job-flaky'), /Firestore delete unavailable/);
  assert.equal(docs.has('job-flaky'), true, 'the post is still there after the failure');
  assert.deepEqual(destroyed, [], 'media is not destroyed when the document delete failed');
});
