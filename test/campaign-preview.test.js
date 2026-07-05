'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fixedNow = new Date('2026-07-04T09:00:00.000Z');

test('campaign dry-run preview validates drafts without writing jobs, media, or reservations', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const mapperPath = require.resolve('../src/postsMapper');
  const storagePath = require.resolve('../src/storage');
  for (const modulePath of [firestorePath, cloudinaryPath, mapperPath, storagePath]) delete require.cache[modulePath];

  const posts = new Map();
  const campaigns = new Map();
  const scheduleSlots = new Map();
  const accounts = new Map([
    ['account-a', { userId: 'owner', accountId: 'account-a', open_id: 'account-a', connected: true, access_token: 'token-a', username: 'alpha' }],
    ['account-b', { userId: 'owner', accountId: 'account-b', open_id: 'account-b', connected: true, access_token: 'token-b', username: 'beta' }]
  ]);
  let uploadCalls = 0;

  const timestamp = (value) => {
    const date = value instanceof Date ? new Date(value) : new Date(value || fixedNow);
    return { toDate: () => new Date(date), toMillis: () => date.getTime() };
  };
  const snapshot = (id, map) => ({
    id,
    get exists() { return map.has(id); },
    data: () => map.get(id)
  });
  const collection = (map, kind) => ({
    doc: (id) => ({
      id,
      kind,
      get: async () => snapshot(id, map),
      set: async (data, options = {}) => map.set(id, options.merge ? { ...(map.get(id) || {}), ...data } : data),
      update: async (data) => map.set(id, { ...(map.get(id) || {}), ...data }),
      delete: async () => map.delete(id)
    }),
    where: (field, operator, value) => ({
      get: async () => ({
        docs: [...map.keys()].map((id) => snapshot(id, map)).filter((doc) => doc.data()[field] === value)
      })
    })
  });
  const postsCollection = collection(posts, 'posts');
  const campaignsCollection = collection(campaigns, 'campaigns');
  const accountsCollection = collection(accounts, 'accounts');
  const scheduleSlotsCollection = collection(scheduleSlots, 'scheduleSlots');
  const mapForRef = (ref) => {
    if (ref.kind === 'campaigns') return campaigns;
    if (ref.kind === 'scheduleSlots') return scheduleSlots;
    return posts;
  };
  const applySet = (ref, data) => mapForRef(ref).set(ref.id, data);
  const db = {
    runTransaction: async (work) => work({
      get: (ref) => ref.get(),
      set: (ref, data) => applySet(ref, data),
      update: (ref, data) => applySet(ref, { ...(mapForRef(ref).get(ref.id) || {}), ...data }),
      delete: (ref) => mapForRef(ref).delete(ref.id)
    })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      tiktokAccountsCollection: () => accountsCollection,
      campaignsCollection: () => campaignsCollection,
      scheduleSlotsCollection: () => scheduleSlotsCollection,
      configDoc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
      getFirestore: () => db,
      Timestamp: { now: () => timestamp(fixedNow), fromDate: (date) => timestamp(date) },
      FieldValue: { serverTimestamp: () => timestamp(fixedNow), increment: (value) => value }
    }
  };
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => {
        uploadCalls += 1;
        return {
          mediaUrl: `https://cdn.example.com/campaign-${uploadCalls}.mp4`,
          publicId: `campaign-public-id-${uploadCalls}`,
          resourceType: 'video'
        };
      },
      destroyMediaAsset: async () => {},
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  t.after(() => {
    for (const modulePath of [firestorePath, cloudinaryPath, mapperPath, storagePath]) delete require.cache[modulePath];
  });

  const storage = require('../src/storage');
  const validDraft = {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-b', caption: 'Caption B', hashtags: '#beta' }
    ]
  };

  // A valid draft previews as safe and reports the exact planned children.
  const preview = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow });
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.safeToEnqueue, true);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.campaign.platform, 'tiktok');
  assert.equal(preview.campaign.baseScheduledAt, '2026-07-04T10:00:00.000Z');
  assert.equal(preview.campaign.staggerMinutes, 15);
  assert.deepEqual(preview.campaign.selectedAccountIds, ['account-a', 'account-b']);
  assert.equal(preview.childJobs.length, 2);
  assert.deepEqual(preview.childJobs.map((job) => job.accountLabel), ['alpha', 'beta']);
  assert.deepEqual(preview.childJobs.map((job) => job.caption), ['Caption A', 'Caption B']);
  assert.deepEqual(preview.childJobs.map((job) => job.hashtags), ['#alpha', '#beta']);
  assert.equal(
    Date.parse(preview.childJobs[1].scheduledAt) - Date.parse(preview.childJobs[0].scheduledAt),
    15 * 60 * 1000
  );
  assert.ok(preview.warnings.some((warning) => warning.code === 'CAMPAIGN_MEDIA_VALIDATED_AT_CREATE'));
  assert.deepEqual(preview.readiness, {
    selectedAccountCount: 2,
    maxAccounts: 2,
    accountSelectionMissing: false,
    duplicateAccountSelection: false,
    accountIssues: [],
    scheduleCollisions: [],
    blockedCodes: []
  }, 'a safe draft reports a fully green readiness checklist');

  // The preview is a pure dry run: nothing queued, uploaded, or reserved.
  assert.equal(posts.size, 0, 'preview must not create child jobs');
  assert.equal(campaigns.size, 0, 'preview must not create a parent campaign');
  assert.equal(scheduleSlots.size, 0, 'preview must not write schedule reservations');
  assert.equal(uploadCalls, 0, 'preview must not upload media');

  // Same-minute child schedules are rejected.
  const sameMinute = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow, staggerMinutes: 0 });
  assert.equal(sameMinute.safeToEnqueue, false);
  assert.ok(sameMinute.errors.some((issue) => issue.code === 'CAMPAIGN_SAME_MINUTE'));

  // Duplicate account selection is rejected.
  const duplicate = await storage.previewTikTokCampaign('owner', {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-a', caption: 'Caption B', hashtags: '#beta' }
    ]
  }, { now: fixedNow });
  assert.equal(duplicate.safeToEnqueue, false);
  assert.ok(duplicate.errors.some((issue) => issue.code === 'CAMPAIGN_ACCOUNT_DUPLICATE'));
  assert.equal(duplicate.readiness.duplicateAccountSelection, true);
  assert.ok(duplicate.readiness.blockedCodes.includes('CAMPAIGN_ACCOUNT_DUPLICATE'));

  // Empty selection reports missing accounts in the readiness checklist.
  const noAccounts = await storage.previewTikTokCampaign('owner', {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: []
  }, { now: fixedNow });
  assert.equal(noAccounts.safeToEnqueue, false);
  assert.equal(noAccounts.readiness.accountSelectionMissing, true);
  assert.equal(noAccounts.readiness.selectedAccountCount, 0);

  // Legacy/invalid account ids are rejected before any account lookup.
  const legacy = await storage.previewTikTokCampaign('owner', {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'legacy', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-b', caption: 'Caption B', hashtags: '#beta' }
    ]
  }, { now: fixedNow });
  assert.equal(legacy.safeToEnqueue, false);
  assert.ok(legacy.errors.some((issue) => issue.code === 'CAMPAIGN_ACCOUNT_INVALID'));

  // Unknown and disconnected accounts are flagged per child job.
  const missing = await storage.previewTikTokCampaign('owner', {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-ghost', caption: 'Caption B', hashtags: '#beta' }
    ]
  }, { now: fixedNow });
  assert.equal(missing.safeToEnqueue, false);
  assert.ok(missing.errors.some((issue) => issue.code === 'CAMPAIGN_ACCOUNT_TOKEN_INVALID'));
  assert.equal(missing.childJobs[0].issues.length, 0);
  assert.equal(missing.childJobs[1].issues[0].code, 'CAMPAIGN_ACCOUNT_TOKEN_INVALID');

  accounts.set('account-b', { ...accounts.get('account-b'), connected: false, access_token: '' });
  const disconnected = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow });
  assert.equal(disconnected.safeToEnqueue, false);
  assert.ok(disconnected.errors.some((issue) => issue.code === 'CAMPAIGN_ACCOUNT_TOKEN_INVALID'));
  assert.deepEqual(disconnected.readiness.accountIssues, ['account-b']);
  accounts.set('account-b', { ...accounts.get('account-b'), connected: true, access_token: 'token-b' });

  // Expired tokens are rejected; tokens expiring before the post only warn.
  accounts.set('account-b', { ...accounts.get('account-b'), expires_at: '2026-07-04T08:59:00.000Z' });
  const expired = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow });
  assert.equal(expired.safeToEnqueue, false);
  assert.ok(expired.errors.some((issue) => issue.code === 'CAMPAIGN_ACCOUNT_TOKEN_EXPIRED'));

  accounts.set('account-b', { ...accounts.get('account-b'), expires_at: '2026-07-04T10:05:00.000Z' });
  const expiringSoon = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow });
  assert.equal(expiringSoon.safeToEnqueue, true, 'a refreshable token is a warning, not a blocker');
  assert.ok(expiringSoon.warnings.some((warning) => warning.code === 'CAMPAIGN_TOKEN_EXPIRES_BEFORE_POST'));
  accounts.set('account-b', { ...accounts.get('account-b'), expires_at: undefined });

  // Past base times are rejected.
  const past = await storage.previewTikTokCampaign('owner', {
    ...validDraft, baseScheduledAt: '2026-07-04T08:00:00.000Z'
  }, { now: fixedNow });
  assert.equal(past.safeToEnqueue, false);
  assert.ok(past.errors.some((issue) => issue.code === 'CAMPAIGN_SCHEDULE_PAST'));

  // No preview path above wrote anything.
  assert.equal(posts.size, 0);
  assert.equal(campaigns.size, 0);
  assert.equal(scheduleSlots.size, 0);
  assert.equal(uploadCalls, 0);

  // Campaign creation still behaves exactly as before after a preview…
  const created = await storage.createTikTokCampaign('owner', {
    originalname: 'campaign.mp4', filename: 'campaign-local.mp4', mimetype: 'video/mp4', size: 1024
  }, validDraft, { now: fixedNow });
  assert.equal(created.childJobs.length, 2);
  assert.equal(uploadCalls, 1);
  assert.equal(posts.size, 2);
  assert.equal(campaigns.size, 1);
  assert.equal(scheduleSlots.size, 2);

  // …and the preview now reports the occupied minutes as collisions.
  const collision = await storage.previewTikTokCampaign('owner', validDraft, { now: fixedNow });
  assert.equal(collision.safeToEnqueue, false);
  assert.ok(collision.errors.some((issue) => issue.code === 'CAMPAIGN_SCHEDULE_COLLISION'));
  assert.deepEqual(collision.childJobs.map((job) => job.scheduleCollision), [true, true]);
  assert.deepEqual(collision.readiness.scheduleCollisions, ['account-a', 'account-b']);
  assert.ok(collision.readiness.blockedCodes.includes('CAMPAIGN_SCHEDULE_COLLISION'));
  assert.equal(posts.size, 2, 'collision preview must not add jobs');
  assert.equal(scheduleSlots.size, 2, 'collision preview must not add reservations');
  assert.equal(uploadCalls, 1, 'collision preview must not upload media');
});
