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
  ]), 'in_progress', 'canonical child states must supersede stale campaign metadata');
});

test('campaign storage uploads once and atomically creates one parent plus two child jobs', async (t) => {
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
  const destroyedAssets = [];

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
  let transactionQueue = Promise.resolve();
  const db = {
    batch: () => {
      const writes = [];
      return {
        set: (ref, data) => writes.push({ ref, data }),
        update: (ref, data) => writes.push({ ref, data: { ...(mapForRef(ref).get(ref.id) || {}), ...data } }),
        commit: async () => {
          for (const { ref, data } of writes) {
            applySet(ref, data);
          }
        }
      };
    },
    runTransaction: async (work) => {
      const execute = () => work({
        get: (ref) => ref.get(),
        set: (ref, data) => applySet(ref, data),
        update: (ref, data) => applySet(ref, { ...(mapForRef(ref).get(ref.id) || {}), ...data }),
        delete: (ref) => mapForRef(ref).delete(ref.id)
      });
      const result = transactionQueue.then(execute, execute);
      transactionQueue = result.then(() => undefined, () => undefined);
      return result;
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
      destroyMediaAsset: async (publicId) => destroyedAssets.push(publicId),
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
  assert.equal(scheduleSlots.size, 2);
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

  const firstChild = result.childJobs[0];
  const secondChild = result.childJobs[1];
  await assert.rejects(() => storage.updatePost('owner', firstChild.id, {
    scheduledAt: '2026-07-04T10:05:00.000Z'
  }, firstChild.accountId), /schedule times are fixed/i);
  assert.equal(await storage.reschedulePendingQueue('owner', firstChild.accountId), 0);
  assert.equal(posts.get(firstChild.id).scheduledAt.toMillis(), Date.parse('2026-07-04T10:00:00.000Z'));

  posts.set('single-post', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  const crossAccountSchedule = await storage.updatePost('owner', 'single-post', {
    scheduledAt: '2026-07-04T10:15:00.000Z'
  }, 'account-a');
  assert.equal(crossAccountSchedule.status, 'scheduled', 'different accounts may use the same minute');
  assert.equal(scheduleSlots.size, 3);
  assert.equal(await storage.deletePost('owner', 'single-post', 'account-a'), true);

  posts.set('same-account-collision', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  await assert.rejects(() => storage.updatePost('owner', 'same-account-collision', {
    scheduledAt: '2026-07-04T10:00:00.000Z'
  }, 'account-a'), /already scheduled/i);
  assert.equal(await storage.deletePost('owner', 'same-account-collision', 'account-a'), true);

  assert.equal(await storage.deletePost('owner', firstChild.id, firstChild.accountId), true);
  assert.equal(posts.has(secondChild.id), true);
  assert.equal(destroyedAssets.length, 0, 'shared media must remain while a sibling references it');
  assert.equal(scheduleSlots.size, 1);
  assert.deepEqual([...campaigns.values()][0].childJobIds, [secondChild.id]);
  assert.equal([...campaigns.values()][0].scheduleSlotIds.length, 1);

  await storage.updatePost('owner', secondChild.id, { status: 'failed' }, secondChild.accountId);
  assert.equal([...campaigns.values()][0].campaignStatus, 'failed');
  await storage.updatePost('owner', secondChild.id, { status: 'posted' }, secondChild.accountId);
  assert.equal([...campaigns.values()][0].campaignStatus, 'posted');
  [...campaigns.values()][0].campaignStatus = 'queued';
  [...campaigns.values()][0].campaign_status = 'queued';
  const reconciledCampaigns = await storage.getCampaigns('owner');
  assert.equal(reconciledCampaigns[0].campaignStatus, 'posted');
  assert.equal([...campaigns.values()][0].campaignStatus, 'posted', 'campaign reads repair stale parent state');

  assert.equal(await storage.deletePost('owner', secondChild.id, secondChild.accountId), true);
  assert.deepEqual(destroyedAssets, ['campaign-public-id-1']);
  assert.equal([...campaigns.values()][0].campaignStatus, 'cancelled');
  assert.deepEqual([...campaigns.values()][0].scheduleSlotIds, []);
  assert.deepEqual([...campaigns.values()][0].mediaReference, {});
  assert.equal(scheduleSlots.size, 0);

  posts.set('single-schedule', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    order: 1, createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  assert.equal(await storage.autoSchedulePosts('owner', ['single-schedule'], 'account-a'), 1);
  assert.equal(posts.get('single-schedule').status, 'scheduled');
  assert.ok(posts.get('single-schedule').scheduleSlotId);
  assert.equal(scheduleSlots.size, 1);
  assert.equal(await storage.reschedulePendingQueue('owner', 'account-a'), 1);
  assert.equal(scheduleSlots.size, 1, 'single-post rescheduling must keep exactly one reservation');
  assert.equal(await storage.deletePost('owner', 'single-schedule', 'account-a'), true);
  assert.equal(scheduleSlots.size, 0);

  posts.set('auto-schedule-a', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    order: 1, createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  posts.set('auto-schedule-b', {
    userId: 'owner', accountId: 'account-b', tiktokOpenId: 'account-b', status: 'pending',
    order: 1, createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  assert.equal(await storage.autoSchedulePosts('owner', ['auto-schedule-a'], 'account-a'), 1);
  assert.equal(await storage.autoSchedulePosts('owner', ['auto-schedule-b'], 'account-b'), 1);
  assert.equal(
    posts.get('auto-schedule-a').scheduledAt.toMillis(),
    posts.get('auto-schedule-b').scheduledAt.toMillis(),
    'independent account auto-scheduling keeps the existing account-local daily time'
  );
  assert.equal(scheduleSlots.size, 2);
  assert.equal(await storage.deletePost('owner', 'auto-schedule-a', 'account-a'), true);
  assert.equal(await storage.deletePost('owner', 'auto-schedule-b', 'account-b'), true);
  assert.equal(scheduleSlots.size, 0);

  posts.set('independent-a', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  posts.set('independent-b', {
    userId: 'owner', accountId: 'account-b', tiktokOpenId: 'account-b', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  posts.set('independent-a-collision', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  await storage.updatePost('owner', 'independent-a', { scheduledAt: '2026-07-04T13:00:00.000Z' }, 'account-a');
  await storage.updatePost('owner', 'independent-b', { scheduledAt: '2026-07-04T13:00:00.000Z' }, 'account-b');
  assert.equal(scheduleSlots.size, 2, 'independent accounts receive distinct reservations for one minute');
  await assert.rejects(() => storage.updatePost('owner', 'independent-a-collision', {
    scheduledAt: '2026-07-04T13:00:00.000Z'
  }, 'account-a'), /already scheduled/i);
  for (const [id, accountId] of [
    ['independent-a', 'account-a'],
    ['independent-b', 'account-b'],
    ['independent-a-collision', 'account-a']
  ]) {
    assert.equal(await storage.deletePost('owner', id, accountId), true);
  }
  assert.equal(scheduleSlots.size, 0);

  posts.set('legacy-scheduled', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'scheduled',
    scheduledAt: timestamp('2026-07-04T14:00:00.000Z'), createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  posts.set('legacy-collision', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'pending',
    createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  await assert.rejects(() => storage.updatePost('owner', 'legacy-collision', {
    scheduledAt: '2026-07-04T14:00:00.000Z'
  }, 'account-a'), /already scheduled/i);
  assert.ok(posts.get('legacy-scheduled').scheduleSlotId, 'legacy scheduled jobs are backfilled before collision checks');
  assert.equal(scheduleSlots.size, 1);
  assert.equal(await storage.deletePost('owner', 'legacy-collision', 'account-a'), true);
  assert.equal(await storage.deletePost('owner', 'legacy-scheduled', 'account-a'), true);
  assert.equal(scheduleSlots.size, 0);

  posts.set('legacy-campaign-blocker', {
    userId: 'owner', accountId: 'account-a', tiktokOpenId: 'account-a', status: 'scheduled',
    scheduledAt: timestamp('2026-07-04T15:00:00.000Z'), createdAt: timestamp(fixedNow), updatedAt: timestamp(fixedNow)
  });
  await assert.rejects(() => storage.createTikTokCampaign('owner', {
    originalname: 'legacy-collision.mp4', filename: 'legacy-collision.mp4', mimetype: 'video/mp4', size: 1024
  }, {
    baseScheduledAt: '2026-07-04T15:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Legacy collision A', hashtags: '#legacyA' },
      { accountId: 'account-b', caption: 'Legacy collision B', hashtags: '#legacyB' }
    ]
  }, { now: fixedNow }), /already scheduled/i);
  assert.equal(uploadCalls, 1, 'legacy collisions must be blocked before uploading campaign media');
  assert.ok(posts.get('legacy-campaign-blocker').scheduleSlotId);
  assert.equal(await storage.deletePost('owner', 'legacy-campaign-blocker', 'account-a'), true);
  assert.equal(scheduleSlots.size, 0);

  const concurrentDraft = {
    baseScheduledAt: '2026-07-04T12:00:00.000Z',
    jobs: [
      { accountId: 'account-a', caption: 'Concurrent A', hashtags: '#concurrentA' },
      { accountId: 'account-b', caption: 'Concurrent B', hashtags: '#concurrentB' }
    ]
  };
  const concurrentResults = await Promise.allSettled([
    storage.createTikTokCampaign('owner', {
      originalname: 'concurrent-a.mp4', filename: 'concurrent-a.mp4', mimetype: 'video/mp4', size: 1024
    }, concurrentDraft, { now: fixedNow }),
    storage.createTikTokCampaign('owner', {
      originalname: 'concurrent-b.mp4', filename: 'concurrent-b.mp4', mimetype: 'video/mp4', size: 1024
    }, concurrentDraft, { now: fixedNow })
  ]);
  assert.deepEqual(concurrentResults.map((entry) => entry.status).sort(), ['fulfilled', 'rejected']);
  assert.match(concurrentResults.find((entry) => entry.status === 'rejected').reason.message, /already scheduled/i);
  assert.equal(posts.size, 2);
  assert.equal(scheduleSlots.size, 2);
  assert.equal(campaigns.size, 2);
  assert.equal(destroyedAssets.length, 2, 'the losing concurrent upload must be cleaned up');
});
