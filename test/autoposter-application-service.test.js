'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createCommercialFixture } = require('./helpers/commercial-fixture');
const { defaultWorkspaceId } = require('../src/workspaceService');
const mediaPolicy = require('../src/mediaPolicy');
const { postFromDoc } = require('../src/postsMapper');
const {
  AutoPosterApplicationError,
  createAutoPosterApplicationService,
  createExecutionContext,
  deterministicPostId,
  targetScopedIdempotencyKey
} = require('../src/autoposterApplicationService');

function makeHarness({ planId = 'legacy_full_access' } = {}) {
  const accounts = [
    { accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok', username: 'creator_a', connected: true },
    { accountId: 'account-b', open_id: 'open-b', userId: 'owner', platform: 'tiktok', username: 'creator_b', connected: true },
    { accountId: 'account-cold', open_id: 'open-cold', userId: 'owner', platform: 'tiktok', username: 'creator_cold', connected: false }
  ];
  const posts = [];
  const calls = {
    add: [],
    update: [],
    auto: [],
    explicit: [],
    delete: [],
    approve: [],
    revoke: [],
    authorizeSchedule: []
  };
  let sequence = 0;
  let nowMs = Date.parse('2026-07-10T10:00:00.000Z');
  let failNextGetPost = false;

  const storage = {
    async getCanonicalTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getCanonicalTikTokAccounts(userId) {
      return userId === 'owner' ? accounts : [];
    },
    async getTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getPosts(userId, accountId) {
      if (userId !== 'owner') return [];
      return posts.filter((post) => !accountId || post.accountId === accountId);
    },
    async getPost(userId, id, accountId) {
      if (failNextGetPost) {
        failNextGetPost = false;
        throw new Error('Firestore confirmation unavailable');
      }
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      calls.add.push({ userId, files, defaults });
      if (defaults.documentId && posts.some((post) => post.id === defaults.documentId)) {
        const error = new Error('already exists');
        error.code = 6;
        throw error;
      }
      const scheduleEntries = Array.isArray(defaults.scheduleEntries) && defaults.scheduleEntries.length > 0
        ? defaults.scheduleEntries
        : defaults.accounts.map((account) => ({
            accountId: account.accountId,
            scheduledAt: defaults.scheduledAt || null,
            occurrenceIndex: null,
            occurrenceDate: ''
          }));
      const sources = Array.isArray(files) && files.length > 0 ? files : [null];
      const created = sources.flatMap((source) => scheduleEntries.map((entry) => {
        const account = defaults.accounts.find((candidate) => candidate.accountId === entry.accountId);
        const now = '2026-07-10T10:00:00.000Z';
        const scheduledAt = entry.scheduledAt || defaults.scheduledAt || null;
        const post = postFromDoc({
          id: defaults.documentId || `post-${++sequence}`,
          data: () => ({
            userId,
            workspaceId: defaults.workspaceId,
            platform: defaults.provider,
            provider: defaults.provider,
            creationSource: defaults.creationSource,
            createdBy: defaults.createdBy,
            correlationId: defaults.correlationId,
            idempotencyKey: defaults.idempotencyKey,
            runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
            runtimeScheduledBy: defaults.runtimeScheduledBy,
            runtimeMissionId: defaults.runtimeMissionId,
            runtimeAction: defaults.runtimeAction,
            runtimePayloadHash: defaults.runtimePayloadHash,
            accountId: account.accountId,
            tiktokOpenId: account.tiktokOpenId,
            username: account.username,
            campaignId: defaults.scheduleSeries ? 'series-1' : '',
            seriesId: defaults.scheduleSeries ? 'series-1' : '',
            seriesFrequency: defaults.scheduleSeries ? defaults.scheduleSeries.frequency : '',
            seriesStartDate: defaults.scheduleSeries ? defaults.scheduleSeries.startDate : '',
            seriesEndDate: defaults.scheduleSeries ? defaults.scheduleSeries.endDate : '',
            seriesOccurrenceIndex: entry.occurrenceIndex,
            seriesOccurrenceCount: defaults.scheduleSeries ? defaults.scheduleSeries.occurrenceCount : 0,
            seriesSourceCount: defaults.scheduleSeries ? defaults.scheduleSeries.sourceCount : 0,
            seriesTimezone: defaults.scheduleSeries ? defaults.scheduleSeries.timezone : '',
            seriesOccurrenceDate: entry.occurrenceDate || '',
            mediaType: 'video',
            mediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            publicMediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            caption: defaults.caption,
            hashtags: defaults.hashtags,
            scheduledAt: scheduledAt ? { toDate: () => new Date(scheduledAt) } : null,
            status: scheduledAt ? 'scheduled' : 'pending',
            approvedAt: defaults.selfApprove ? { toDate: () => new Date(now) } : null,
            approvedBy: defaults.selfApprove ? defaults.selfApprove.approvedBy : null,
            createdAt: { toDate: () => new Date(now) },
            updatedAt: { toDate: () => new Date(now) }
          })
        });
        posts.push(post);
        return post;
      }));
      return created;
    },
    async updatePost(userId, id, patch, accountId, historyEvent) {
      calls.update.push({ userId, id, patch, accountId, historyEvent });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      Object.assign(post, patch);
      if ('scheduledAt' in patch) post.status = patch.scheduledAt ? 'scheduled' : 'pending';
      return post;
    },
    async autoSchedulePosts(userId, ids, accountId) {
      calls.auto.push({ userId, ids, accountId });
      for (const id of ids) {
        const index = posts.findIndex((item) => item.id === id);
        if (index >= 0) posts[index] = {
          ...posts[index],
          scheduledAt: '2026-07-12T09:00:00.000Z',
          status: 'scheduled'
        };
      }
      return ids.length;
    },
    async applyExplicitSchedule(userId, created, plan) {
      calls.explicit.push({ userId, created, plan });
      for (const post of created) {
        const channel = plan.channels.find((item) => item.accountId === post.accountId);
        const index = posts.findIndex((item) => item.id === post.id);
        if (index >= 0) posts[index] = { ...posts[index], scheduledAt: channel.scheduledAt, status: 'scheduled' };
      }
      return created.length;
    },
    async approvePost(userId, id, { approvedBy }, accountId) {
      calls.approve.push({ userId, id, approvedBy, accountId });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      post.approved = true;
      post.approvalState = 'approved';
      post.approvedBy = approvedBy;
      return post;
    },
    async revokePostApproval(userId, id, accountId) {
      calls.revoke.push({ userId, id, accountId });
      const post = posts.find((item) => item.id === id && item.accountId === accountId);
      if (!post) return null;
      post.approved = false;
      post.approvalState = 'unapproved';
      post.approvedBy = '';
      return post;
    },
    async deletePost(userId, id, accountId) {
      calls.delete.push({ userId, id, accountId });
      const index = posts.findIndex((post) => post.id === id && (!accountId || post.accountId === accountId));
      if (index < 0) return false;
      posts.splice(index, 1);
      return true;
    },
    async reschedulePendingQueue(userId, accountId) {
      return posts.filter((post) => post.accountId === accountId).length;
    }
  };

  const commercial = createCommercialFixture(storage, { planId });
  const authorizeSchedule = commercial.authorizeSchedule.bind(commercial);
  commercial.authorizeSchedule = async (input) => {
    calls.authorizeSchedule.push(input);
    return authorizeSchedule(input);
  };

  return {
    accounts,
    calls,
    posts,
    service: createAutoPosterApplicationService({
      storage,
      mediaPolicy,
      commercialService: commercial,
      now: () => nowMs
    }),
    setNow(value) { nowMs = Date.parse(value); },
    failConfirmationOnce() { failNextGetPost = true; }
  };
}

function context(overrides = {}) {
  return createExecutionContext({ userId: 'owner', actorId: 'admin:owner', source: 'website', ...overrides });
}

test('execution context is explicit and does not invent a workspace', () => {
  const resolved = context({ accountId: 'account-a', correlationId: 'trace-1' });
  assert.equal(resolved.userId, 'owner');
  assert.equal(resolved.source, 'website');
  assert.equal(resolved.workspaceId, null);
  assert.equal(resolved.correlationId, 'trace-1');
  assert.throws(() => createExecutionContext({ source: 'website' }), AutoPosterApplicationError);
  assert.throws(() => createExecutionContext({ userId: 'owner', source: 'provider' }), /request source/);
});

test('website and Runtime schedules share one operation and canonical queue shape', async () => {
  const harness = makeHarness();
  const website = await harness.service.schedulePost(
    context({ accountId: 'account-a', approval: { approvedBy: 'client:@creator_a' } }),
    {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/site.mp4',
      caption: ' Website caption ',
      schedule: { mode: 'automatic' },
      requireSingle: true
    }
  );
  const runtime = await harness.service.schedulePost(
    context({
      source: 'runtime',
      actorId: 'mcp-client',
      accountId: 'account-b',
      idempotency: { key: 'runtime-key-1' }
    }),
    {
      accountId: 'account-b',
      mediaUrl: 'https://cdn.example.com/runtime.mp4',
      caption: ' Runtime caption ',
      requestedBy: 'mcp-client',
      requireSingle: true,
      schedule: {
        mode: 'explicit',
        scheduledAt: '2026-07-12T11:00:00+02:00',
        requireExplicitTimezone: true,
        requireFuture: true
      }
    }
  );

  assert.equal(harness.calls.add.length, 2);
  assert.equal(harness.calls.add[0].defaults.provider, 'tiktok');
  assert.equal(harness.calls.add[0].defaults.creationSource, 'website');
  assert.equal(harness.calls.add[0].defaults.selfApprove.approvedBy, 'client:@creator_a');
  assert.equal(harness.calls.add[1].defaults.creationSource, 'runtime');
  assert.equal(harness.calls.add[1].defaults.selfApprove, null, 'Runtime cannot self-approve');
  assert.equal(harness.calls.add[1].defaults.createOnly, true);
  assert.equal(harness.calls.add[1].defaults.idempotencyKey, 'runtime-key-1');
  assert.deepEqual(Object.keys(website.post).sort(), Object.keys(runtime.post).sort());
  assert.equal(website.post.provider, 'tiktok');
  assert.equal(runtime.post.provider, 'tiktok');
  assert.equal(runtime.post.status, 'scheduled');
  assert.equal(runtime.post.scheduledAt, '2026-07-12T09:00:00.000Z');
});

test('daily recurring website schedule creates one bounded series across every selected channel', async () => {
  const harness = makeHarness();
  const result = await harness.service.schedulePost(
    context({ accountId: 'account-a' }),
    {
      accountIds: ['account-a', 'account-b'],
      mediaUrl: 'https://cdn.example.com/daily.mp4',
      caption: 'Daily campaign',
      schedule: {
        mode: 'recurring_daily',
        startDate: '2026-07-11',
        endDate: '2026-07-13',
        startTime: '09:00',
        timezoneOffsetMinutes: 0,
        offsetMinutes: 5
      }
    }
  );

  assert.equal(result.schedule.mode, 'recurring_daily');
  assert.equal(result.schedule.plan.occurrenceCount, 3);
  assert.equal(result.schedule.plan.jobCount, 6);
  assert.equal(result.posts.length, 6);
  assert.equal(result.scheduledCount, 6);

  const defaults = harness.calls.add[0].defaults;
  assert.equal(defaults.scheduleEntries.length, 6);
  assert.deepEqual(defaults.scheduleSeries, {
    frequency: 'daily',
    startDate: '2026-07-11',
    endDate: '2026-07-13',
    occurrenceCount: 3,
    sourceCount: 1,
    timezone: ''
  });
  assert.deepEqual(defaults.scheduleEntries.map((entry) => entry.scheduledAt), [
    '2026-07-11T09:00:00.000Z',
    '2026-07-11T09:05:00.000Z',
    '2026-07-12T09:00:00.000Z',
    '2026-07-12T09:05:00.000Z',
    '2026-07-13T09:00:00.000Z',
    '2026-07-13T09:05:00.000Z'
  ]);
  assert.equal(harness.calls.authorizeSchedule[0].quantity, 6);
  assert.equal(harness.calls.authorizeSchedule[0].scheduledAt, '2026-07-13T09:05:00.000Z');
  assert.equal(result.posts[0].seriesFrequency, 'daily');
  assert.equal(result.posts[5].seriesOccurrenceIndex, 2);
});

test('daily recurring schedule coexists with a one-off post at the same account and time', async () => {
  const harness = makeHarness();
  await harness.service.schedulePost(
    context({ accountId: 'account-a' }),
    {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/one-off.mp4',
      schedule: {
        mode: 'max',
        startDate: '2026-07-11',
        startTime: '09:00',
        timezoneOffsetMinutes: 0
      }
    }
  );

  const recurring = await harness.service.schedulePost(
    context({ accountId: 'account-a' }),
    {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/daily.mp4',
      schedule: {
        mode: 'recurring_daily',
        startDate: '2026-07-11',
        endDate: '2026-07-12',
        startTime: '09:00',
        timezoneOffsetMinutes: 0
      }
    }
  );

  assert.equal(recurring.scheduledCount, 2);
  assert.equal(harness.posts.length, 3, 'the one-off job and both daily occurrences remain queued');
  assert.equal(harness.posts.filter((post) => post.scheduledAt === '2026-07-11T09:00:00.000Z').length, 2);
});

test('daily recurring schedule counts all uploaded videos before commercial authorization', async () => {
  const harness = makeHarness();
  const result = await harness.service.schedulePost(
    context({ accountId: 'account-a' }),
    {
      accountIds: ['account-a', 'account-b'],
      files: [
        { originalname: 'one.mp4', mimetype: 'video/mp4', size: 10 },
        { originalname: 'two.mp4', mimetype: 'video/mp4', size: 10 }
      ],
      schedule: {
        mode: 'recurring_daily',
        startDate: '2026-07-11',
        endDate: '2026-07-13',
        startTime: '09:00',
        timezoneOffsetMinutes: 0
      }
    }
  );
  assert.equal(result.schedule.plan.jobCount, 12);
  assert.equal(harness.calls.authorizeSchedule[0].quantity, 12);
  assert.equal(harness.calls.add[0].defaults.scheduleSeries.sourceCount, 2);
});

test('daily recurring schedule rejects a first release that is not in the future', async () => {
  const harness = makeHarness();
  await assert.rejects(
    () => harness.service.schedulePost(
      context({ accountId: 'account-a' }),
      {
        accountId: 'account-a',
        mediaUrl: 'https://cdn.example.com/daily.mp4',
        schedule: {
          mode: 'recurring_daily',
          startDate: '2026-07-10',
          endDate: '2026-07-12',
          startTime: '09:00',
          timezoneOffsetMinutes: 0
        }
      }
    ),
    /first daily release must be scheduled in the future/i
  );
  assert.equal(harness.calls.add.length, 0);
});

test('daily recurring schedule rejects an end date before the start date before queue creation', async () => {
  const harness = makeHarness();
  await assert.rejects(
    () => harness.service.schedulePost(
      context({ accountId: 'account-a' }),
      {
        accountId: 'account-a',
        mediaUrl: 'https://cdn.example.com/daily.mp4',
        schedule: {
          mode: 'recurring_daily',
          startDate: '2026-07-13',
          endDate: '2026-07-12',
          startTime: '09:00',
          timezoneOffsetMinutes: 0
        }
      }
    ),
    /end date must be on or after/i
  );
  assert.equal(harness.calls.add.length, 0);
});

test('runtime idempotency uses one deterministic create-only queue document', async () => {
  const harness = makeHarness();
  const runtimeContext = context({
    source: 'runtime',
    actorId: 'mcp-client',
    accountId: 'account-a',
    idempotency: { key: 'same-key' }
  });
  const input = {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/runtime.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  };

  const first = await harness.service.schedulePost(runtimeContext, input);
  const second = await harness.service.schedulePost(runtimeContext, input);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(harness.calls.add.length, 1);
  assert.equal(
    harness.calls.add[0].defaults.usageReservation.idempotencyKey,
    targetScopedIdempotencyKey('tiktok', 'account-a', 'same-key')
  );
  assert.equal(
    first.post.id,
    deterministicPostId('owner', 'account-a', 'same-key', defaultWorkspaceId('owner'))
  );
  assert.equal(second.post.id, first.post.id);
  first.post.status = 'posted';
  harness.setNow('2026-07-13T09:00:00.000Z');
  const terminalDuplicate = await harness.service.schedulePost(runtimeContext, input);
  assert.equal(terminalDuplicate.duplicate, true, 'past-time replays and later lifecycle states return the original');
  assert.equal(terminalDuplicate.post.status, 'posted');
});

test('runtime reconciliation returns only exact unique durable truth and exposes conflicts', async () => {
  const harness = makeHarness();
  const workspaceId = defaultWorkspaceId('owner');
  const scheduledAt = '2026-07-12T09:00:00.000Z';
  const idempotencyKey = 'recovery-key';
  const metadata = {
    missionId: 'mission-recovery-1',
    action: 'autoposter.post.schedule',
    missionPayloadHash: 'a'.repeat(64)
  };
  const runtimeContext = context({
    source: 'runtime',
    actorId: 'chanter-agent-runtime',
    accountId: 'account-a',
    workspaceId,
    idempotency: { key: idempotencyKey }
  });
  const scheduleResult = await harness.service.schedulePost(runtimeContext, {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/recovery.mp4',
    runtimeMissionId: metadata.missionId,
    runtimeAction: metadata.action,
    runtimePayloadHash: metadata.missionPayloadHash,
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt,
      requireExplicitTimezone: true,
      requireFuture: true
    }
  });
  const reconcileInput = {
    provider: 'tiktok',
    accountId: 'account-a',
    scheduledAt,
    ...metadata
  };

  const unique = await harness.service.reconcileRuntimeSchedule(runtimeContext, reconcileInput);
  assert.equal(unique.outcome, 'unique');
  assert.equal(unique.safeToReuse, true);
  assert.equal(unique.post.id, scheduleResult.post.id);
  assert.equal(unique.approvalState, 'required');
  assert.equal(unique.publishingState, 'blocked_until_human_approval');

  const exactFailureCases = [
    [runtimeContext, { ...reconcileInput, action: 'autoposter.queue.list' }, 'scope_mismatch'],
    [context({ ...runtimeContext, workspaceId: 'workspace-other', rawWorkspaceId: 'workspace-other' }), reconcileInput, 'scope_mismatch'],
    [runtimeContext, { ...reconcileInput, provider: 'youtube' }, 'scope_mismatch'],
    [context({ ...runtimeContext, accountId: 'account-b' }), { ...reconcileInput, accountId: 'account-b' }, 'scope_mismatch'],
    [context({ ...runtimeContext, accountId: 'Account-A' }), { ...reconcileInput, accountId: 'Account-A' }, 'scope_mismatch'],
    [context({ ...runtimeContext, accountId: ' account-a' }), { ...reconcileInput, accountId: ' account-a' }, 'scope_mismatch'],
    [runtimeContext, { ...reconcileInput, missionPayloadHash: 'b'.repeat(64) }, 'payload_mismatch'],
    [context({ ...runtimeContext, idempotency: { key: 'different-key' } }), reconcileInput, 'idempotency_mismatch']
  ];
  for (const [mutatedContext, mutatedInput, expectedOutcome] of exactFailureCases) {
    const mismatch = await harness.service.reconcileRuntimeSchedule(mutatedContext, mutatedInput);
    assert.equal(mismatch.outcome, expectedOutcome);
    assert.equal(mismatch.safeToReuse, false);
    assert.equal(mismatch.post, undefined);
  }
  const missing = await harness.service.reconcileRuntimeSchedule(
    context({ ...runtimeContext, idempotency: { key: 'different-key' } }),
    { ...reconcileInput, missionId: 'mission-not-created' }
  );
  assert.equal(missing.outcome, 'not_found');
  assert.equal(missing.post, undefined);
  assert.equal(harness.calls.add.length, 1, 'reconciliation and scope refusal never create another queue job');

  harness.posts.push({ ...scheduleResult.post, id: 'conflicting-recovery-post' });
  const conflict = await harness.service.reconcileRuntimeSchedule(runtimeContext, reconcileInput);
  assert.equal(conflict.outcome, 'conflict');
  assert.equal(conflict.safeToReuse, false);
  assert.deepEqual(conflict.conflictingPostIds, [
    'conflicting-recovery-post',
    scheduleResult.post.id
  ].sort());
  assert.equal(conflict.post, undefined);
  assert.equal(harness.calls.add.length, 1);
});

test('runtime reconciliation refuses a unique queue record that is approved or no longer scheduled', async () => {
  const harness = makeHarness();
  const workspaceId = defaultWorkspaceId('owner');
  const scheduledAt = '2026-07-12T09:00:00.000Z';
  const runtimeContext = context({
    source: 'runtime',
    accountId: 'account-a',
    workspaceId,
    idempotency: { key: 'unsafe-recovery-key' }
  });
  const metadata = {
    missionId: 'mission-unsafe-recovery',
    action: 'autoposter.post.schedule',
    missionPayloadHash: 'c'.repeat(64)
  };
  const scheduled = await harness.service.schedulePost(runtimeContext, {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/unsafe-recovery.mp4',
    runtimeMissionId: metadata.missionId,
    runtimeAction: metadata.action,
    runtimePayloadHash: metadata.missionPayloadHash,
    requireSingle: true,
    schedule: { mode: 'explicit', scheduledAt, requireExplicitTimezone: true, requireFuture: true }
  });
  scheduled.post.approved = true;
  const result = await harness.service.reconcileRuntimeSchedule(runtimeContext, {
    provider: 'tiktok', accountId: 'account-a', scheduledAt, ...metadata
  });
  assert.equal(result.outcome, 'unique');
  assert.equal(result.safeToReuse, false);
  assert.equal(result.evidenceStatus, 'invalid');
  assert.equal(result.post, undefined);
  assert.equal(harness.calls.add.length, 1);
});

test('provider is part of durable document and usage idempotency scope', () => {
  const workspaceId = defaultWorkspaceId('owner');
  assert.notEqual(
    deterministicPostId('owner', 'shared-id', 'same-key', workspaceId, 'tiktok'),
    deterministicPostId('owner', 'shared-id', 'same-key', workspaceId, 'youtube')
  );
  assert.notEqual(
    targetScopedIdempotencyKey('tiktok', 'shared-id', 'same-key'),
    targetScopedIdempotencyKey('youtube', 'shared-id', 'same-key')
  );
});

test('a concurrent Firestore create race returns the already-created scheduled item', async () => {
  let existing = null;
  let addCalls = 0;
  const storage = {
    async getCanonicalTikTokAccount() {
      return {
        accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
        username: 'creator_a', connected: true
      };
    },
    async getTikTokAccount() {
      return {
        accountId: 'account-a', open_id: 'open-a', userId: 'owner', platform: 'tiktok',
        username: 'creator_a', connected: true
      };
    },
    async getPosts() { return []; },
    async getPost() { return existing; },
    async addUploadedPosts(userId, files, defaults) {
      addCalls += 1;
      existing = postFromDoc({
        id: defaults.documentId,
        data: () => ({
          userId,
          workspaceId: defaults.workspaceId,
          platform: 'tiktok',
          provider: 'tiktok',
          creationSource: 'runtime',
          idempotencyKey: defaults.idempotencyKey,
          runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
          runtimeMissionId: defaults.runtimeMissionId,
          runtimeAction: defaults.runtimeAction,
          runtimePayloadHash: defaults.runtimePayloadHash,
          accountId: 'account-a',
          tiktokOpenId: 'open-a',
          username: 'creator_a',
          mediaType: 'video',
          caption: '',
          scheduledAt: { toDate: () => new Date(defaults.scheduledAt) },
          status: 'scheduled',
          approvedAt: null
        })
      });
      const error = new Error('document already exists');
      error.code = 6;
      throw error;
    }
  };
  const service = createAutoPosterApplicationService({
    storage,
    mediaPolicy,
    commercialService: createCommercialFixture(storage),
    now: () => Date.parse('2026-07-10T10:00:00.000Z')
  });
  const result = await service.schedulePost(context({
    source: 'runtime',
    accountId: 'account-a',
    idempotency: { key: 'racing-key' }
  }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/race.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  });

  assert.equal(addCalls, 1);
  assert.equal(result.duplicate, true);
  assert.equal(result.post.status, 'scheduled');
  assert.equal(
    result.post.id,
    deterministicPostId('owner', 'account-a', 'racing-key', defaultWorkspaceId('owner'))
  );
});

test('an old incomplete idempotent draft fails truthfully instead of claiming scheduled success', async () => {
  const harness = makeHarness();
  harness.posts.push({
    id: 'old-partial',
    userId: 'owner',
    workspaceId: defaultWorkspaceId('owner'),
    accountId: 'account-a',
    status: 'pending',
    scheduledAt: null,
    idempotencyKey: 'old-key',
    runtimeIdempotencyKey: 'old-key'
  });

  await assert.rejects(
    harness.service.schedulePost(context({
      source: 'runtime',
      accountId: 'account-a',
      idempotency: { key: 'old-key' }
    }), {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/old.mp4',
      requireSingle: true,
      schedule: {
        mode: 'explicit',
        scheduledAt: '2026-07-12T09:00:00Z',
        requireExplicitTimezone: true,
        requireFuture: true
      }
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.details.createdPostId, 'old-partial');
      assert.match(error.message, /incomplete draft/);
      return true;
    }
  );
  assert.equal(harness.calls.add.length, 0);
});

test('explicit Runtime scheduling is complete in the initial deterministic write', async () => {
  const harness = makeHarness();
  const runtimeContext = context({
    source: 'runtime',
    accountId: 'account-a',
    idempotency: { key: 'atomic-key' }
  });
  const result = await harness.service.schedulePost(runtimeContext, {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/atomic.mp4',
    requireSingle: true,
    schedule: {
      mode: 'explicit',
      scheduledAt: '2026-07-12T09:00:00Z',
      requireExplicitTimezone: true,
      requireFuture: true
    }
  });
  assert.equal(result.post.status, 'scheduled');
  assert.equal(result.post.scheduledAt, '2026-07-12T09:00:00.000Z');
  assert.equal(result.post.idempotencyKey, 'atomic-key');
  assert.equal(result.post.runtimeIdempotencyKey, 'atomic-key');
  assert.equal(harness.calls.update.length, 0, 'no post-create schedule patch exists');
});

test('the existing controlled live-test plan also uses schedulePost', async () => {
  const harness = makeHarness();
  const result = await harness.service.schedulePost(context({
    source: 'internal_worker',
    actorId: 'controlled-live-publish-test'
  }), {
    accountIds: ['account-a', 'account-b'],
    mediaUrl: 'https://cdn.example.com/controlled.mp4',
    caption: 'Controlled test',
    schedule: {
      mode: 'explicit_plan',
      plan: {
        baseAt: '2026-07-12T09:00:00Z',
        offsetMinutes: 5,
        channels: [
          { accountId: 'account-a', scheduledAt: '2026-07-12T09:00:00Z', offsetMinutes: 0, order: 0 },
          { accountId: 'account-b', scheduledAt: '2026-07-12T09:05:00Z', offsetMinutes: 5, order: 1 }
        ]
      }
    }
  });
  assert.equal(result.scheduledCount, 2);
  assert.deepEqual(result.posts.map((post) => post.status), ['scheduled', 'scheduled']);
  assert.equal(harness.calls.explicit.length, 1);
});

test('the controlled live-test plan preserves zero-buffer due-now scheduling but rejects stale plans', async () => {
  const harness = makeHarness();
  const internalContext = context({
    source: 'internal_worker',
    actorId: 'controlled-live-publish-test'
  });
  const dueNow = {
    accountIds: ['account-a'],
    mediaUrl: 'https://cdn.example.com/due-now.mp4',
    caption: 'Due now controlled test',
    schedule: {
      mode: 'explicit_plan',
      plan: {
        baseAt: '2026-07-10T10:00:00Z',
        offsetMinutes: 0,
        channels: [
          { accountId: 'account-a', scheduledAt: '2026-07-10T10:00:00Z', offsetMinutes: 0, order: 0 }
        ]
      }
    }
  };

  const result = await harness.service.schedulePost(internalContext, dueNow);
  assert.equal(result.scheduledCount, 1);
  assert.equal(result.post.scheduledAt, '2026-07-10T10:00:00.000Z');

  const stale = structuredClone(dueNow);
  stale.mediaUrl = 'https://cdn.example.com/stale.mp4';
  stale.schedule.plan.baseAt = '2026-07-10T09:58:59Z';
  stale.schedule.plan.channels[0].scheduledAt = '2026-07-10T09:58:59Z';
  await assert.rejects(
    harness.service.schedulePost(internalContext, stale),
    /controlled schedule plan is stale/
  );
  assert.equal(harness.calls.add.length, 1, 'a stale controlled plan is rejected before queue creation');
});

test('a post-commit confirmation failure reports unknown scheduling truth', async () => {
  const harness = makeHarness();
  harness.failConfirmationOnce();
  await assert.rejects(
    harness.service.schedulePost(context({ accountId: 'account-a' }), {
      accountId: 'account-a',
      mediaUrl: 'https://cdn.example.com/unknown.mp4',
      schedule: { mode: 'automatic' },
      requireSingle: true
    }),
    (error) => {
      assert.equal(error.status, 500);
      assert.match(error.message, /could not be fully confirmed/);
      assert.equal(error.message.includes('unscheduled drafts'), false);
      assert.equal(error.details.createdPostIds.length, 1);
      return true;
    }
  );
});

test('queue, status, media, approval, retry, and delete operations preserve scope and truth', async () => {
  const harness = makeHarness();
  const created = await harness.service.schedulePost(context({ accountId: 'account-a' }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/a.mp4',
    schedule: { mode: 'automatic' },
    requireSingle: true
  });
  const postId = created.post.id;

  const queue = await harness.service.listQueue(context(), { accountId: 'account-a', limit: 10 });
  assert.equal(queue.count, 1);
  assert.equal(queue.counts.scheduled, 1);
  assert.equal((await harness.service.getPostStatus(context(), { postId, accountId: 'account-a' })).post.id, postId);
  await assert.rejects(
    harness.service.getPostStatus(context(), { postId, accountId: 'account-b' }),
    (error) => error.code === 'not_found'
  );

  assert.equal(harness.service.validateMedia(context(), { mediaUrl: 'https://cdn.example.com/a.mp4' }).valid, true);
  assert.equal(harness.service.validateMedia(context(), { mediaUrl: 'https://cdn.example.com/a.jpg' }).valid, false);
  assert.throws(() => harness.service.validateMedia(context(), {}), /Provide mediaUrl/);

  assert.equal((await harness.service.approvePost(context({
    accountId: 'account-a',
    approval: { approvedBy: 'admin:owner' }
  }), { postId })).ok, true);
  await assert.rejects(
    harness.service.approvePost(context({ source: 'runtime', accountId: 'account-a' }), { postId }),
    (error) => error.code === 'forbidden'
  );
  assert.equal((await harness.service.revokeApproval(context({ accountId: 'account-a' }), { postId })).ok, true);
  harness.posts.find((post) => post.id === postId).status = 'failed';
  assert.equal((await harness.service.retryPost(context({ accountId: 'account-a' }), { postId })).ok, true);
  const batch = await harness.service.deleteMarkedPosts(context(), { postIds: [postId, 'missing', postId] });
  assert.equal(batch.ok, false);
  assert.deepEqual(batch.deleted, [postId]);
  assert.deepEqual(batch.failed, [{ id: 'missing', reason: 'Post not found in your account.' }]);
  assert.equal(harness.calls.delete.length, 2, 'deduplicated batch reuses individual delete truth');
});

test('automatic horizon evaluation is account-local instead of compounding across channels', async () => {
  const harness = makeHarness();
  for (let index = 3; index <= 20; index += 1) {
    harness.accounts.push({
      accountId: `account-${index}`,
      open_id: `open-${index}`,
      userId: 'owner',
      platform: 'tiktok',
      username: `creator_${index}`,
      connected: true
    });
  }
  const accountIds = harness.accounts
    .filter((account) => account.connected)
    .map((account) => account.accountId);
  const files = Array.from({ length: 5 }, (_, index) => ({
    originalname: `clip-${index + 1}.mp4`,
    mimetype: 'video/mp4'
  }));

  await harness.service.schedulePost(context(), {
    accountIds,
    files,
    schedule: { mode: 'automatic' }
  });

  assert.equal(harness.calls.authorizeSchedule.length, 1);
  const authorization = harness.calls.authorizeSchedule[0];
  assert.equal(authorization.quantity, 100);
  assert.ok(
    Date.parse(authorization.scheduledAt) <= Date.parse('2026-07-17T10:00:00.000Z'),
    'five daily releases stay within one account-local horizon even across twenty channels'
  );
});

test('account activation context uses only server-resolved workspace limits', async () => {
  const commercialContext = {
    userId: 'owner',
    workspace: { workspaceId: 'workspace-server' },
    workspaceScope: { workspaceId: 'workspace-server', allowLegacyOwnerRecords: false },
    entitlements: { connectedAccountLimit: 2, providerLimit: 1 }
  };
  const service = createAutoPosterApplicationService({
    storage: {},
    commercialService: {
      resolveContext: async () => commercialContext,
      authorizeAccountConnection: async () => ({
        context: commercialContext,
        existing: false,
        decision: { allowed: true, reasonCode: 'allowed' }
      })
    }
  });

  const result = await service.authorizeAccountConnection(
    context({ workspaceId: 'workspace-server' }),
    {
      provider: 'tiktok',
      accountId: 'account-new',
      // Browser-like commercial claims are deliberately ignored.
      workspaceId: 'workspace-browser',
      connectedAccountLimit: 999,
      providerLimit: 999
    }
  );

  assert.deepEqual(result.activationContext, {
    ownerUserId: 'owner',
    workspaceId: 'workspace-server',
    provider: 'tiktok',
    connectedAccountLimit: 2,
    providerLimit: 1
  });
});

test('retry and edit fail closed for ambiguous or unsafe queue states while failed retry remains supported', async () => {
  const harness = makeHarness();
  const created = await harness.service.schedulePost(context({ accountId: 'account-a' }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/unknown.mp4',
    schedule: { mode: 'automatic' },
    requireSingle: true
  });
  const post = harness.posts.find((item) => item.id === created.post.id);
  post.status = 'outcome_unknown';
  const updateCount = harness.calls.update.length;

  await assert.rejects(
    harness.service.retryPost(context({ accountId: 'account-a' }), { postId: post.id }),
    (error) => error.code === 'queue_transition_blocked' && error.status === 409
  );
  await assert.rejects(
    harness.service.updatePost(context({ accountId: 'account-a' }), {
      postId: post.id,
      accountId: 'account-a',
      patch: { caption: 'must not change' }
    }),
    (error) => error.code === 'queue_transition_blocked' && error.status === 409
  );
  assert.equal(harness.calls.update.length, updateCount);

  for (const status of ['processing', 'posted']) {
    post.status = status;
    await assert.rejects(
      harness.service.updatePost(context({ accountId: 'account-a' }), {
        postId: post.id,
        accountId: 'account-a',
        patch: { caption: 'must still not change' }
      }),
      (error) => error.code === 'queue_transition_blocked'
    );
  }

  post.status = 'failed';
  assert.equal((await harness.service.retryPost(
    context({ accountId: 'account-a' }),
    { postId: post.id, accountId: 'account-a' }
  )).ok, true);
});

test('queue and status views sanitize raw legacy evidence returned by storage adapters', async () => {
  const harness = makeHarness();
  const created = await harness.service.schedulePost(context({ accountId: 'account-a' }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/evidence.mp4',
    schedule: { mode: 'automatic' },
    requireSingle: true
  });
  const post = harness.posts.find((item) => item.id === created.post.id);
  post.lastResult = {
    ok: false,
    reason: 'access_token=queue-result-canary',
    response: { video_id: 'video-safe', access_token: 'response-token-canary' }
  };
  post.lastInstagramResult = { ok: false, reason: 'client_secret=instagram-canary' };
  post.lastError = 'refresh_token=last-error-canary';
  post.history = [{ event: 'failed', detail: 'authorization=history-canary' }];
  post.logs = [{ event: 'raw', detail: 'credential=logs-canary' }];

  const queue = await harness.service.listQueue(context(), { accountId: 'account-a', limit: 10 });
  const status = await harness.service.getPostStatus(context(), {
    postId: post.id,
    accountId: 'account-a'
  });
  const json = JSON.stringify({ queue, status });
  for (const canary of [
    'queue-result-canary',
    'response-token-canary',
    'instagram-canary',
    'last-error-canary',
    'history-canary',
    'logs-canary'
  ]) assert.equal(json.includes(canary), false);
  assert.equal(status.post.lastResult.response.video_id, 'video-safe');
  assert.deepEqual(status.post.logs, status.post.history);
});

test('Starter keeps core outcome truth while withholding advanced provider evidence', async () => {
  const harness = makeHarness({ planId: 'starter' });
  const created = await harness.service.schedulePost(context({ accountId: 'account-a' }), {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/starter-evidence.mp4',
    schedule: { mode: 'automatic' },
    requireSingle: true
  });
  const post = harness.posts.find((item) => item.id === created.post.id);
  post.lastResult = {
    ok: false,
    reason: 'Provider declined the request.',
    response: { video_id: 'advanced-video-id' }
  };
  post.history = [{ event: 'provider_response', detail: 'Advanced diagnostic evidence.' }];

  const queue = await harness.service.listQueue(context(), { accountId: 'account-a', limit: 10 });
  const status = await harness.service.getPostStatus(context(), {
    postId: post.id,
    accountId: 'account-a'
  });
  for (const view of [queue.items[0], status.post]) {
    assert.equal(view.lastResult.reason, 'Provider declined the request.');
    assert.equal(Object.hasOwn(view.lastResult, 'response'), false);
    assert.deepEqual(view.history, []);
    assert.deepEqual(view.logs, []);
  }
});

test('controllers delegate queue creation to the application service', () => {
  const root = path.join(__dirname, '..', 'src');
  for (const file of ['routes.js', 'clientRoutes.js', 'runtimeControlRoutes.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(source.includes('storage.addUploadedPosts'), false, `${file} must not construct queue items`);
    assert.match(source, /autoposterApplicationService/, `${file} must use the shared service`);
  }
  const runtimeSource = fs.readFileSync(path.join(root, 'runtimeControlRoutes.js'), 'utf8');
  for (const forbidden of ['./storage', './mediaPolicy', './scheduler', './tiktok', './instagram']) {
    assert.equal(runtimeSource.includes(`require('${forbidden}')`), false, `runtime route must not require ${forbidden}`);
  }
  const storageSource = fs.readFileSync(path.join(root, 'storage.js'), 'utf8');
  assert.match(storageSource, /batch\.create\(ref, data\)/, 'deterministic idempotency must be create-only');
  const liveTestSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'live-publish-test.js'), 'utf8');
  assert.equal(liveTestSource.includes('storage.addUploadedPosts'), false, 'controlled CLI must not construct queue items');
  assert.match(liveTestSource, /applicationService\.schedulePost/);
});
