'use strict';

// Approval gate: storage-level behavior.
// Admin batch intake creates unapproved drafts with an evidence history and
// duplicate warnings; approvePost/revokePostApproval are the only writes
// that open or close the gate, and both fail closed on non-reviewable
// states. The worker-side enforcement lives in test/scheduler.test.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function installStorageMocks({ seededDocs = [] } = {}) {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  delete require.cache[storagePath];
  delete require.cache[mapperPath];

  const docs = new Map(seededDocs.map((docData) => [docData.id, { ...docData }]));
  const updates = [];
  const timestamp = (value = '2026-07-10T12:00:00.000Z') => ({
    toDate: () => new Date(value),
    toMillis: () => new Date(value).getTime()
  });
  let uploadCounter = 0;

  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => {
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
      get: async () => ({ docs: [...docs.entries()].map(([id, data]) => ({ id, data: () => data })) }),
      select: () => ({ get: async () => ({ docs: [] }) })
    }),
    doc: (id) => ({
      id,
      get: async () => ({ id, exists: docs.has(id), data: () => docs.get(id) }),
      update: async (patch) => {
        updates.push({ id, patch });
        docs.set(id, { ...docs.get(id), ...patch });
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
      getFirestore: () => ({
        batch: () => ({
          set: (ref, data) => { docs.set(ref.id, data); },
          update: () => {},
          commit: async () => {}
        })
      }),
      Timestamp: { now: () => timestamp(), fromDate: (date) => timestamp(date.toISOString()) },
      FieldValue: { serverTimestamp: () => timestamp(), increment: () => 1 }
    }
  };

  const cleanup = () => {
    for (const modulePath of [storagePath, mapperPath, firestorePath, cloudinaryPath]) {
      delete require.cache[modulePath];
    }
  };

  return { storage: require('../src/storage'), docs, updates, cleanup };
}

function makeTempFile(dir, name, content) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, Buffer.from(content));
  return {
    path: filePath,
    size: fs.statSync(filePath).size,
    filename: name,
    originalname: name,
    mimetype: 'video/mp4'
  };
}

const accountDefaults = { accountId: 'account-a', tiktokOpenId: 'account-a', username: 'account_a' };

test('admin intake creates unapproved drafts with an evidence history', async (t) => {
  const { storage, cleanup } = installStorageMocks();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-approval-'));
  t.after(() => { fs.rmSync(tempDir, { recursive: true, force: true }); cleanup(); });

  const [created] = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'draft.mp4', 'draft-media')], {
    caption: 'Draft post',
    ...accountDefaults
  });

  assert.equal(created.approved, false);
  assert.equal(created.approvedAt, null);
  assert.equal(created.approvedBy, '');
  assert.equal(created.duplicateWarning, '');
  assert.ok(created.fileSize > 0);
  const events = created.history.map((entry) => entry.event);
  assert.deepEqual(events, ['created', 'validated']);
});

test('client self-approval records approval and evidence at creation', async (t) => {
  const { storage, cleanup } = installStorageMocks();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-approval-'));
  t.after(() => { fs.rmSync(tempDir, { recursive: true, force: true }); cleanup(); });

  const [created] = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'client.mp4', 'client-media')], {
    ...accountDefaults,
    selfApprove: { approvedBy: 'client:@account_a' }
  });

  assert.equal(created.approved, true);
  assert.equal(created.approvedBy, 'client:@account_a');
  const events = created.history.map((entry) => entry.event);
  assert.deepEqual(events, ['created', 'validated', 'approved']);
});

test('duplicate media on the same channel is flagged for review, never blocked', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanter-approval-'));
  const file = makeTempFile(tempDir, 'repeat.mp4', 'repeat-media');
  const { storage, cleanup } = installStorageMocks({
    seededDocs: [{
      id: 'existing-job', userId: 'owner', accountId: 'account-a', originalName: 'repeat.mp4',
      fileSize: file.size, status: 'scheduled', order: 1, mediaSource: 'cloudinary'
    }]
  });
  t.after(() => { fs.rmSync(tempDir, { recursive: true, force: true }); cleanup(); });

  const [duplicate] = await storage.addUploadedPosts('owner', [file], { ...accountDefaults });
  assert.match(duplicate.duplicateWarning, /possible duplicate/i);
  const validated = duplicate.history.find((entry) => entry.event === 'validated');
  assert.match(validated.detail, /possible duplicate/i);

  // A different file on the same channel carries no warning.
  const [fresh] = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'unique.mp4', 'other-media-bytes')], {
    ...accountDefaults
  });
  assert.equal(fresh.duplicateWarning, '');

  // The same file on a different channel is intentional fan-out, not a duplicate.
  const [otherChannel] = await storage.addUploadedPosts('owner', [makeTempFile(tempDir, 'repeat2.mp4', 'repeat-media')], {
    accountId: 'account-b', tiktokOpenId: 'account-b', username: 'account_b'
  });
  assert.equal(otherChannel.duplicateWarning, '');
});

test('approvePost sets the approval record only for reviewable states', async (t) => {
  const { storage, docs, updates, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'draft-1', userId: 'owner', accountId: 'account-a', status: 'scheduled', history: [] },
      {
        id: 'youtube-failed', userId: 'owner', accountId: 'UC-chanter', provider: 'youtube',
        status: 'failed', claimAttempts: 4, history: []
      },
      { id: 'busy-1', userId: 'owner', accountId: 'account-a', status: 'processing', history: [] },
      { id: 'done-1', userId: 'owner', accountId: 'account-a', status: 'posted', history: [] },
      { id: 'other-owner', userId: 'someone-else', accountId: 'account-a', status: 'scheduled', history: [] }
    ]
  });
  t.after(cleanup);

  const approved = await storage.approvePost('owner', 'draft-1', { approvedBy: 'admin:owner' }, 'account-a');
  assert.equal(approved.approved, true);
  assert.equal(approved.approvedBy, 'admin:owner');
  assert.equal(docs.get('draft-1').approvedBy, 'admin:owner');
  assert.ok(docs.get('draft-1').approvedAt);
  assert.equal(docs.get('draft-1').history.at(-1).event, 'approved');

  const youtubeApproved = await storage.approvePost(
    'owner',
    'youtube-failed',
    { approvedBy: 'admin:owner' },
    'UC-chanter'
  );
  assert.equal(youtubeApproved.publishAttemptBudget, 5);
  assert.equal(docs.get('youtube-failed').publishAttemptBudget, 5);

  // Mid-publish, already-posted, cross-account, and cross-owner jobs all
  // refuse the approval write.
  assert.equal(await storage.approvePost('owner', 'busy-1', {}, 'account-a'), null);
  assert.equal(await storage.approvePost('owner', 'done-1', {}, 'account-a'), null);
  assert.equal(await storage.approvePost('owner', 'draft-1', {}, 'account-b'), null);
  assert.equal(await storage.approvePost('owner', 'other-owner', {}, 'account-a'), null);
  assert.equal(await storage.approvePost('owner', 'missing', {}, 'account-a'), null);
  assert.deepEqual(
    updates.map((update) => update.id).sort(),
    ['draft-1', 'youtube-failed']
  );
});

test('revokePostApproval clears the approval record and logs evidence', async (t) => {
  const timestampValue = { toDate: () => new Date('2026-07-10T08:00:00.000Z'), toMillis: () => Date.parse('2026-07-10T08:00:00.000Z') };
  const { storage, docs, cleanup } = installStorageMocks({
    seededDocs: [
      { id: 'approved-1', userId: 'owner', accountId: 'account-a', status: 'scheduled', approvedAt: timestampValue, approvedBy: 'admin:owner', history: [] },
      { id: 'busy-1', userId: 'owner', accountId: 'account-a', status: 'processing', approvedAt: timestampValue, approvedBy: 'admin:owner', history: [] }
    ]
  });
  t.after(cleanup);

  const revoked = await storage.revokePostApproval('owner', 'approved-1', 'account-a');
  assert.equal(revoked.approved, false);
  assert.equal(docs.get('approved-1').approvedAt, null);
  assert.equal(docs.get('approved-1').approvedBy, null);
  assert.equal(docs.get('approved-1').history.at(-1).event, 'approval_revoked');

  // A job already claimed by a worker cannot have its record rewritten.
  assert.equal(await storage.revokePostApproval('owner', 'busy-1', 'account-a'), null);
  assert.equal(docs.get('busy-1').approvedBy, 'admin:owner');
});
