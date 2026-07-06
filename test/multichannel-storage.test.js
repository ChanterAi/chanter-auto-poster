'use strict';

// Multi-channel scheduling: storage-level behavior.
// Verifies that one prepare action fans out into one child publish job per
// target channel, each carrying its own channel identity and its own media
// asset, linked by a shared parent campaignId.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function installMocks({ seededDocs = [] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const committed = [];
  const updated = [];
  const uploadCalls = [];
  const timestamp = { toDate: () => new Date('2026-07-06T12:00:00.000Z') };
  let uploadCounter = 0;

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async (file) => {
        uploadCalls.push(file);
        uploadCounter += 1;
        return {
          mediaUrl: `https://res.cloudinary.com/test/upload/asset-${uploadCounter}.jpg`,
          publicId: `uploads/asset-${uploadCounter}`,
          resourceType: 'image'
        };
      },
      destroyMediaAsset: async () => {},
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  const postsCollection = {
    where: () => ({
      get: async () => ({
        docs: seededDocs.map((docData, index) => ({
          id: docData.id || `seeded-${index}`,
          data: () => docData
        }))
      }),
      select: () => ({ get: async () => ({ docs: [] }) })
    }),
    doc: (id) => ({ id })
  };
  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      configDoc: () => ({
        get: async () => ({ exists: true, data: () => ({ dailyPostTime: '18:00' }) })
      }),
      getFirestore: () => ({
        batch: () => ({
          set: (ref, data) => committed.push({ ref, data }),
          update: (ref, data) => updated.push({ ref, data }),
          commit: async () => {}
        })
      }),
      Timestamp: { now: () => timestamp, fromDate: () => timestamp },
      FieldValue: { serverTimestamp: () => timestamp, increment: () => 1 }
    }
  };

  const cleanup = () => {
    delete require.cache[storagePath];
    delete require.cache[mapperPath];
    delete require.cache[firestorePath];
    delete require.cache[cloudinaryPath];
  };

  return { storage: require('../src/storage'), committed, updated, uploadCalls, cleanup };
}

function makeTempFile(dir, name) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(`content-${name}`));
  return {
    path: filePath,
    size: fs.statSync(filePath).size,
    filename: name,
    originalname: name,
    mimetype: 'image/jpeg'
  };
}

test('two-channel campaign creates one child job per channel with shared campaignId', async (t) => {
  const { storage, committed, uploadCalls, cleanup } = installMocks();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-multichannel-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    cleanup();
  });

  const created = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'campaign.jpg')], {
    caption: 'Two channel drop',
    hashtags: '#chanter',
    accounts: [
      { accountId: 'chanter-open-id', tiktokOpenId: 'chanter-open-id', username: '__chanter' },
      { accountId: 'cdwarrior-open-id', tiktokOpenId: 'cdwarrior-open-id', username: '_cdwarrior' }
    ],
    // Legacy single-account fields are also present, as routes.js sends them;
    // the accounts array must win.
    accountId: 'chanter-open-id',
    tiktokOpenId: 'chanter-open-id',
    username: '__chanter'
  });

  assert.equal(created.length, 2);
  assert.equal(committed.length, 2);

  const [jobA, jobB] = created;
  // Child jobs store the correct channel identity.
  assert.equal(jobA.accountId, 'chanter-open-id');
  assert.equal(jobA.tiktokOpenId, 'chanter-open-id');
  assert.equal(jobA.username, '__chanter');
  assert.equal(jobB.accountId, 'cdwarrior-open-id');
  assert.equal(jobB.tiktokOpenId, 'cdwarrior-open-id');
  assert.equal(jobB.username, '_cdwarrior');

  // Shared parent campaign link.
  assert.ok(jobA.campaignId);
  assert.equal(jobA.campaignId, jobB.campaignId);

  // Each child job owns its own media asset so deleting one job can never
  // destroy the other channel's media.
  assert.equal(uploadCalls.length, 2);
  assert.notEqual(committed[0].data.cloudinaryPublicId, committed[1].data.cloudinaryPublicId);

  // Both start as unscheduled child jobs in their own channel queue.
  assert.equal(jobA.status, 'pending');
  assert.equal(jobB.status, 'pending');
  assert.equal(committed[0].data.campaignId, jobA.campaignId);
  assert.equal(committed[1].data.campaignId, jobA.campaignId);
});

test('single-channel campaign keeps the legacy defaults contract and gains a campaignId', async (t) => {
  const { storage, committed, cleanup } = installMocks();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-singlechannel-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    cleanup();
  });

  const created = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'solo.jpg')], {
    caption: 'Single channel',
    accountId: 'chanter-open-id',
    tiktokOpenId: 'chanter-open-id',
    username: '__chanter'
  });

  assert.equal(created.length, 1);
  assert.equal(committed.length, 1);
  assert.equal(created[0].accountId, 'chanter-open-id');
  assert.equal(created[0].username, '__chanter');
  assert.equal(created[0].status, 'pending');
  assert.ok(created[0].campaignId, 'single-channel jobs also carry a campaignId');
});

test('duplicate and invalid channel entries are dropped; zero valid channels throws', async (t) => {
  const { storage, committed, cleanup } = installMocks();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-dedupe-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    cleanup();
  });

  const created = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'dedupe.jpg')], {
    accounts: [
      { accountId: 'chanter-open-id', username: '__chanter' },
      { accountId: 'chanter-open-id', username: '__chanter' },
      { accountId: '', username: 'nobody' },
      { accountId: 'legacy', username: 'legacy' }
    ]
  });
  assert.equal(created.length, 1);
  assert.equal(committed.length, 1);

  await assert.rejects(
    storage.addUploadedPosts('owner', [], {
      accounts: [{ accountId: 'legacy' }],
      publicMediaUrl: 'https://cdn.example.com/asset.jpg'
    }),
    /Select a connected TikTok account/
  );
});

test('queue rebuild only reschedules the given channel and never rewrites job channel identity', async (t) => {
  const seededDocs = [
    {
      id: 'job-a', userId: 'owner', accountId: 'chanter-open-id', tiktokOpenId: 'chanter-open-id',
      username: '__chanter', status: 'scheduled', order: 1, campaignId: 'cmp-1'
    },
    {
      id: 'job-b', userId: 'owner', accountId: 'cdwarrior-open-id', tiktokOpenId: 'cdwarrior-open-id',
      username: '_cdwarrior', status: 'scheduled', order: 1, campaignId: 'cmp-1'
    }
  ];
  const { storage, updated, cleanup } = installMocks({ seededDocs });
  t.after(cleanup);

  const count = await storage.reschedulePendingQueue('owner', 'chanter-open-id');

  assert.equal(count, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].ref.id, 'job-a');
  // The rebuild patch touches scheduling fields only — the assigned channel
  // identity is never part of the update.
  assert.equal('accountId' in updated[0].data, false);
  assert.equal('tiktokOpenId' in updated[0].data, false);
  assert.equal('username' in updated[0].data, false);
});

test('postFromDoc maps campaignId and keeps legacy documents without one rendering safely', () => {
  const { postFromDoc } = require('../src/postsMapper');

  const withCampaign = postFromDoc({
    id: 'job-1',
    data: () => ({ accountId: 'chanter-open-id', username: '__chanter', campaignId: 'cmp-77' })
  });
  assert.equal(withCampaign.campaignId, 'cmp-77');

  const legacyDoc = postFromDoc({
    id: 'job-legacy',
    data: () => ({ accountId: 'chanter-open-id', username: '__chanter' })
  });
  assert.equal(legacyDoc.campaignId, '');
  assert.equal(legacyDoc.accountId, 'chanter-open-id');
});
