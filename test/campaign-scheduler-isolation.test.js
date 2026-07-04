'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('API acceptance is not final posted state and a sibling failure remains isolated', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const mapperPath = require.resolve('../src/postsMapper');
  const tiktokPath = require.resolve('../src/tiktok');
  const instagramPath = require.resolve('../src/instagram');
  const schedulerPath = require.resolve('../src/scheduler');
  for (const modulePath of [firestorePath, mapperPath, tiktokPath, instagramPath, schedulerPath]) delete require.cache[modulePath];

  const now = new Date('2026-07-04T10:30:00.000Z');
  const timestamp = (value = now) => {
    const date = value instanceof Date ? new Date(value) : new Date(value);
    return { toDate: () => new Date(date), toMillis: () => date.getTime() };
  };
  const records = new Map([
    ['job-a', {
      userId: 'owner', platform: 'tiktok', campaignId: 'campaign-1', campaignJobStatus: 'queued',
      accountId: 'account-a', tiktokOpenId: 'account-a', status: 'scheduled',
      mediaType: 'video', mediaUrl: 'https://cdn.example.com/campaign.mp4',
      scheduledAt: timestamp('2026-07-04T10:00:00.000Z'), claimAttempts: 0
    }],
    ['job-b', {
      userId: 'owner', platform: 'tiktok', campaignId: 'campaign-1', campaignJobStatus: 'queued',
      accountId: 'account-b', tiktokOpenId: 'account-b', status: 'scheduled',
      mediaType: 'video', mediaUrl: 'https://cdn.example.com/campaign.mp4',
      scheduledAt: timestamp('2026-07-04T10:15:00.000Z'), claimAttempts: 0
    }]
  ]);
  const campaign = {
    campaignId: 'campaign-1', campaignStatus: 'queued', childJobIds: ['job-a', 'job-b']
  };
  const applyPatch = (target, patch) => {
    const next = { ...target };
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value && typeof value === 'object' && '__increment' in value
        ? Number(next[key] || 0) + value.__increment
        : value;
    }
    return next;
  };
  const postRef = (id) => ({
    id,
    get: async () => ({ id, exists: records.has(id), data: () => records.get(id) }),
    update: async (patch) => records.set(id, applyPatch(records.get(id), patch))
  });
  const campaignRef = {
    id: 'campaign-1',
    get: async () => ({ id: 'campaign-1', exists: true, data: () => campaign }),
    update: async (patch) => Object.assign(campaign, patch)
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({ doc: postRef }),
      campaignsCollection: () => ({ doc: () => campaignRef }),
      configDoc: () => ({}),
      getFirestore: () => ({
        runTransaction: async (work) => work({
          get: async (ref) => ref.get(),
          update: (ref, patch) => {
            if (ref === campaignRef) Object.assign(campaign, patch);
            else records.set(ref.id, applyPatch(records.get(ref.id), patch));
          }
        })
      }),
      Timestamp: { now: () => timestamp(now), fromDate: (date) => timestamp(date) },
      FieldValue: {
        serverTimestamp: () => timestamp(now),
        increment: (value) => ({ __increment: value })
      }
    }
  };
  require.cache[tiktokPath] = {
    id: tiktokPath,
    filename: tiktokPath,
    loaded: true,
    exports: {
      publishPhotoPost: async (post) => post.accountId === 'account-a'
        ? { ok: true, mode: 'api', response: { data: { publish_id: 'publish-a' } } }
        : { ok: false, mode: 'api', code: 'TOKEN_REVOKED', reason: 'TikTok rejected account B.' }
    }
  };
  require.cache[instagramPath] = {
    id: instagramPath,
    filename: instagramPath,
    loaded: true,
    exports: { getInstagramHealth: async () => ({ configured: false, canPublish: false }) }
  };

  t.after(() => {
    for (const modulePath of [firestorePath, mapperPath, tiktokPath, instagramPath, schedulerPath]) delete require.cache[modulePath];
  });

  const scheduler = require('../src/scheduler');
  const success = await scheduler.processPost('job-a', { force: true, workerId: 'worker-a', now });
  assert.equal(success.state, 'accepted');
  assert.equal(records.get('job-a').status, 'accepted');
  assert.equal(records.get('job-a').campaignJobStatus, 'accepted');
  assert.ok(records.get('job-a').acceptedAt);
  assert.equal(records.get('job-a').postedAt, null);
  assert.equal(campaign.campaignStatus, 'in_progress');

  const failure = await scheduler.processPost('job-b', { force: true, workerId: 'worker-b', now });

  assert.equal(success.ok, true);
  assert.equal(failure.ok, false);
  assert.equal(records.get('job-a').status, 'accepted');
  assert.equal(records.get('job-a').campaignJobStatus, 'accepted');
  assert.equal(records.get('job-b').status, 'failed');
  assert.equal(records.get('job-b').campaignJobStatus, 'failed');
  assert.match(records.get('job-b').errorMessage, /account B/i);
  assert.match(records.get('job-b').errorEvidence.reason, /account B/i);
  assert.equal(campaign.campaignStatus, 'partial_failure');
});
