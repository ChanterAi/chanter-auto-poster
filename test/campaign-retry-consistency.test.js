'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('transient campaign child rejection is marked retry_required while standalone jobs stay plain failed', async (t) => {
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
    ['campaign-child', {
      userId: 'owner', platform: 'tiktok', campaignId: 'campaign-1', campaignJobStatus: 'queued',
      accountId: 'account-a', tiktokOpenId: 'account-a', status: 'scheduled',
      mediaType: 'video', mediaUrl: 'https://cdn.example.com/campaign.mp4',
      scheduledAt: timestamp('2026-07-04T10:00:00.000Z'), claimAttempts: 0
    }],
    ['campaign-child-terminal', {
      userId: 'owner', platform: 'tiktok', campaignId: 'campaign-1', campaignJobStatus: 'queued',
      accountId: 'account-b', tiktokOpenId: 'account-b', status: 'scheduled',
      mediaType: 'video', mediaUrl: 'https://cdn.example.com/campaign.mp4',
      scheduledAt: timestamp('2026-07-04T10:15:00.000Z'), claimAttempts: 0
    }],
    ['standalone-job', {
      userId: 'owner', platform: 'tiktok',
      accountId: 'account-c', tiktokOpenId: 'account-c', status: 'scheduled',
      mediaType: 'video', mediaUrl: 'https://cdn.example.com/solo.mp4',
      scheduledAt: timestamp('2026-07-04T10:00:00.000Z'), claimAttempts: 0
    }]
  ]);
  const campaign = {
    campaignId: 'campaign-1', campaignStatus: 'queued',
    childJobIds: ['campaign-child', 'campaign-child-terminal']
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
      publishPhotoPost: async (post) => (post.accountId === 'account-b'
        ? { ok: false, mode: 'api', code: 'TOKEN_REVOKED', reason: 'TikTok rejected the token.' }
        : {
          ok: false,
          mode: 'api',
          reason: 'Rate limit exceeded',
          response: { error: { code: 'rate_limit_exceeded', message: 'Rate limit exceeded' } }
        })
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

  const transient = await scheduler.processPost('campaign-child', { force: true, workerId: 'worker-a', now });
  assert.equal(transient.ok, false);
  const transientChild = records.get('campaign-child');
  assert.equal(transientChild.status, 'failed', 'canonical status stays failed — no automatic retry');
  assert.equal(transientChild.campaignJobStatus, 'retry_required');
  assert.equal(transientChild.campaign_job_status, 'retry_required');
  assert.equal(transientChild.errorEvidence.retryable, true);
  assert.equal(transientChild.lastResult.retryable, true);
  assert.equal(campaign.campaignStatus, 'retry_required');

  const terminal = await scheduler.processPost('campaign-child-terminal', { force: true, workerId: 'worker-b', now });
  assert.equal(terminal.ok, false);
  const terminalChild = records.get('campaign-child-terminal');
  assert.equal(terminalChild.status, 'failed');
  assert.equal(terminalChild.campaignJobStatus, 'failed');
  assert.equal(terminalChild.errorEvidence.retryable, false);
  // A retryable sibling still surfaces at the campaign level.
  assert.equal(campaign.campaignStatus, 'retry_required');

  const standalone = await scheduler.processPost('standalone-job', { force: true, workerId: 'worker-c', now });
  assert.equal(standalone.ok, false);
  const standaloneJob = records.get('standalone-job');
  assert.equal(standaloneJob.status, 'failed');
  assert.equal('campaignJobStatus' in standaloneJob, false, 'non-campaign jobs must not gain campaign fields');
  assert.equal('errorEvidence' in standaloneJob, false);
  assert.equal('retryable' in standaloneJob.lastResult, false, 'retry classification is campaign-scoped');
});
