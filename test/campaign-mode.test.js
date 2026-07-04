'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildCampaignPlan,
  validateCampaignAccounts,
  deriveCampaignStatus
} = require('../src/campaigns');

const fixedNow = new Date('2026-07-04T09:00:00.000Z');

test('campaign plan creates two distinct jobs with a 15-minute stagger', () => {
  const plan = buildCampaignPlan({
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-b', caption: 'Caption B', hashtags: '#beta' }
    ]
  }, { now: fixedNow });

  assert.equal(plan.jobs.length, 2);
  assert.equal(plan.staggerMinutes, 15);
  assert.equal(Date.parse(plan.jobs[1].scheduledAt) - Date.parse(plan.jobs[0].scheduledAt), 15 * 60 * 1000);
  assert.notEqual(plan.jobs[0].caption, plan.jobs[1].caption);
  assert.notEqual(plan.jobs[0].hashtags, plan.jobs[1].hashtags);
});

test('campaign safety rules reject account overflow and duplicate copy', () => {
  assert.throws(() => buildCampaignPlan({
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'a', caption: 'A', hashtags: '#a' },
      { accountId: 'b', caption: 'B', hashtags: '#b' },
      { accountId: 'c', caption: 'C', hashtags: '#c' }
    ]
  }, { now: fixedNow }), /maximum of 2/i);

  assert.throws(() => buildCampaignPlan({
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'a', caption: 'Same caption', hashtags: '#a' },
      { accountId: 'b', caption: ' same   caption ', hashtags: '#b' }
    ]
  }, { now: fixedNow }), /different caption/i);

  assert.throws(() => buildCampaignPlan({
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'a', caption: 'A', hashtags: '#same' },
      { accountId: 'b', caption: 'B', hashtags: ' #SAME ' }
    ]
  }, { now: fixedNow }), /different hashtag/i);
});

test('campaign account validation rejects missing and expired tokens', () => {
  const jobs = [{ accountId: 'account-a' }, { accountId: 'account-b' }];
  assert.throws(() => validateCampaignAccounts(jobs, [
    { accountId: 'account-a', connected: true, access_token: 'token-a' },
    { accountId: 'account-b', connected: false, access_token: '' }
  ], { now: fixedNow }), /disconnected|usable token/i);

  assert.throws(() => validateCampaignAccounts(jobs, [
    { accountId: 'account-a', connected: true, access_token: 'token-a' },
    { accountId: 'account-b', connected: true, access_token: 'token-b', expires_at: '2026-07-04T08:59:00.000Z' }
  ], { now: fixedNow }), /expired token/i);
});

test('campaign status reports a partial failure without changing child states', () => {
  const jobs = [
    { status: 'posted', campaignJobStatus: 'posted' },
    { status: 'failed', campaignJobStatus: 'failed' }
  ];
  assert.equal(deriveCampaignStatus(jobs), 'partial_failure');
  assert.deepEqual(jobs.map((job) => job.status), ['posted', 'failed']);
  assert.equal(deriveCampaignStatus([
    { status: 'scheduled', campaignJobStatus: 'failed' },
    { status: 'posted', campaignJobStatus: 'posted' }
  ]), 'queued', 'canonical requeue state must supersede stale campaign metadata');
});

test('campaign storage uploads once and atomically creates one parent plus two child jobs', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const mapperPath = require.resolve('../src/postsMapper');
  const storagePath = require.resolve('../src/storage');
  for (const modulePath of [firestorePath, cloudinaryPath, mapperPath, storagePath]) delete require.cache[modulePath];

  const posts = new Map();
  const campaigns = new Map();
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
      update: async (data) => map.set(id, { ...(map.get(id) || {}), ...data })
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
  const db = {
    batch: () => {
      const writes = [];
      return {
        set: (ref, data) => writes.push({ ref, data }),
        commit: async () => {
          for (const { ref, data } of writes) {
            (ref.kind === 'campaigns' ? campaigns : posts).set(ref.id, data);
          }
        }
      };
    }
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => postsCollection,
      tiktokAccountsCollection: () => accountsCollection,
      campaignsCollection: () => campaignsCollection,
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
        return { mediaUrl: 'https://cdn.example.com/campaign.mp4', publicId: 'campaign-public-id', resourceType: 'video' };
      },
      destroyMediaAsset: async () => {},
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  t.after(() => {
    for (const modulePath of [firestorePath, cloudinaryPath, mapperPath, storagePath]) delete require.cache[modulePath];
  });

  const storage = require('../src/storage');
  const result = await storage.createTikTokCampaign('owner', {
    originalname: 'campaign.mp4', filename: 'campaign-local.mp4', mimetype: 'video/mp4', size: 1024
  }, {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Caption A', hashtags: '#alpha' },
      { accountId: 'account-b', caption: 'Caption B', hashtags: '#beta' }
    ]
  }, { now: fixedNow });

  assert.equal(uploadCalls, 1);
  assert.equal(campaigns.size, 1);
  assert.equal(posts.size, 2);
  assert.equal(result.childJobs.length, 2);
  const children = [...posts.values()];
  assert.equal(children[0].campaignId, children[1].campaignId);
  assert.equal(children[0].mediaUrl, children[1].mediaUrl);
  assert.equal(children[0].status, 'scheduled');
  assert.equal(children[0].campaignJobStatus, 'queued');
  assert.equal(children[1].scheduledAt.toMillis() - children[0].scheduledAt.toMillis(), 15 * 60 * 1000);
  assert.equal(Object.hasOwn(children[0], 'access_token'), false);
  const parent = [...campaigns.values()][0];
  assert.equal(parent.campaign_id, children[0].campaignId);
  assert.deepEqual(parent.selected_account_ids, ['account-a', 'account-b']);
  assert.deepEqual(parent.created_child_job_ids.sort(), [...posts.keys()].sort());

  accounts.set('account-b', { ...accounts.get('account-b'), connected: false, access_token: '' });
  await assert.rejects(() => storage.createTikTokCampaign('owner', {
    originalname: 'blocked.mp4', filename: 'blocked-local.mp4', mimetype: 'video/mp4', size: 1024
  }, {
    baseScheduledAt: '2026-07-04T11:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Another A', hashtags: '#anotherA' },
      { accountId: 'account-b', caption: 'Another B', hashtags: '#anotherB' }
    ]
  }, { now: fixedNow }), /disconnected|usable token/i);
  assert.equal(uploadCalls, 1, 'bad account must be blocked before durable media upload');

  accounts.set('account-b', { ...accounts.get('account-b'), connected: true, access_token: 'token-b' });
  await assert.rejects(() => storage.createTikTokCampaign('owner', {
    originalname: 'collision.mp4', filename: 'collision-local.mp4', mimetype: 'video/mp4', size: 1024
  }, {
    baseScheduledAt: '2026-07-04T10:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Collision A', hashtags: '#collisionA' },
      { accountId: 'account-b', caption: 'Collision B', hashtags: '#collisionB' }
    ]
  }, { now: fixedNow }), /already scheduled/i);
  assert.equal(uploadCalls, 1, 'same-minute collision must be blocked before durable media upload');
});
