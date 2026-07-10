'use strict';

// Provider + connected-account foundation: website and Agent Runtime must
// resolve the same connected account through the same application service,
// unknown/disabled providers must fail closed identically on both paths,
// and canonical provider identity must land on every new queue item.

const assert = require('node:assert/strict');
const test = require('node:test');
const { postFromDoc } = require('../src/postsMapper');
const {
  AutoPosterApplicationError,
  createAutoPosterApplicationService
} = require('../src/autoposterApplicationService');

const CANARY_ACCESS_TOKEN = 'CANARY-ACCESS-TOKEN-0f9e8d7c6b5a4321';
const CANARY_REFRESH_TOKEN = 'CANARY-REFRESH-TOKEN-1234a5b6c7d8e9f0';
const NOW_MS = Date.parse('2026-07-10T10:00:00.000Z');

function makeHarness() {
  const accounts = [
    {
      accountId: 'account-a', open_id: 'open-a', username: 'creator_a', connected: true,
      userId: 'owner', platform: 'tiktok',
      access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN,
      expires_at: '2026-07-20T00:00:00.000Z', scope: 'user.info.basic,video.publish',
      connectedAt: '2026-07-01T00:00:00.000Z'
    },
    {
      accountId: 'account-expired', open_id: 'open-expired', username: 'creator_expired', connected: true,
      userId: 'owner', platform: 'tiktok',
      access_token: CANARY_ACCESS_TOKEN, refresh_token: '',
      expires_at: '2026-07-01T00:00:00.000Z', scope: 'user.info.basic,video.publish'
    },
    {
      accountId: 'account-wrong-scope', open_id: 'open-ws', username: 'creator_ws', connected: true,
      userId: 'owner', platform: 'tiktok',
      access_token: CANARY_ACCESS_TOKEN, refresh_token: CANARY_REFRESH_TOKEN,
      expires_at: '2026-07-20T00:00:00.000Z', scope: 'user.info.basic'
    },
    { accountId: 'account-cold', open_id: 'open-cold', username: 'creator_cold', connected: false, userId: 'owner' }
  ];
  const posts = [];
  const calls = { add: [] };
  let sequence = 0;

  const storage = {
    async getTikTokAccount(userId, accountId) {
      if (userId !== 'owner') return null;
      return accounts.find((account) => account.accountId === accountId) || null;
    },
    async getTikTokAccounts(userId) {
      return userId === 'owner' ? accounts : [];
    },
    async getPosts(userId, accountId) {
      if (userId !== 'owner') return [];
      return posts.filter((post) => !accountId || post.accountId === accountId);
    },
    async getPost(userId, id, accountId) {
      if (userId !== 'owner') return null;
      return posts.find((post) => post.id === id && (!accountId || post.accountId === accountId)) || null;
    },
    async addUploadedPosts(userId, files, defaults) {
      calls.add.push({ userId, files, defaults });
      const created = defaults.accounts.map((account) => {
        const post = postFromDoc({
          id: defaults.documentId || `post-${++sequence}`,
          data: () => ({
            userId,
            platform: defaults.provider,
            provider: defaults.provider,
            connectedAccountId: `${defaults.provider}:${account.accountId}`,
            creationSource: defaults.creationSource,
            createdBy: defaults.createdBy,
            idempotencyKey: defaults.idempotencyKey,
            runtimeIdempotencyKey: defaults.runtimeIdempotencyKey,
            accountId: account.accountId,
            tiktokOpenId: account.tiktokOpenId,
            username: account.username,
            mediaType: 'video',
            mediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            publicMediaUrl: defaults.publicMediaUrl || 'https://cdn.example.com/upload.mp4',
            caption: defaults.caption,
            scheduledAt: defaults.scheduledAt ? { toDate: () => new Date(defaults.scheduledAt) } : null,
            status: defaults.scheduledAt ? 'scheduled' : 'pending',
            createdAt: { toDate: () => new Date(NOW_MS) },
            updatedAt: { toDate: () => new Date(NOW_MS) }
          })
        });
        posts.push(post);
        return post;
      });
      return created;
    }
  };

  const service = createAutoPosterApplicationService({ storage, now: () => NOW_MS });
  return { service, calls, posts };
}

function websiteContext(overrides = {}) {
  return { userId: 'owner', source: 'website', accountId: 'account-a', ...overrides };
}

function runtimeContext(overrides = {}) {
  return {
    userId: 'owner',
    source: 'runtime',
    accountId: 'account-a',
    actorId: 'agent-runtime',
    idempotency: { key: overrides.idempotencyKey || 'runtime-key-1' },
    ...overrides
  };
}

function scheduleInput(overrides = {}) {
  return {
    accountId: 'account-a',
    mediaUrl: 'https://cdn.example.com/clip.mp4',
    caption: 'Test clip',
    schedule: { mode: 'explicit', scheduledAt: '2026-07-11T09:00:00.000Z' },
    ...overrides
  };
}

test('website and Runtime resolve the identical connected account and provider', async () => {
  const { service } = makeHarness();
  const website = await service.getConnectedAccount(websiteContext(), { accountId: 'account-a' });
  const runtime = await service.getConnectedAccount(runtimeContext(), { accountId: 'account-a' });

  assert.deepEqual(website.account, runtime.account, 'both surfaces must see one connected-account truth');
  assert.deepEqual(website.provider, runtime.provider, 'both surfaces must see one provider definition');
  assert.equal(website.account.connectionId, 'tiktok:account-a');
  assert.equal(website.provider.id, 'tiktok');
  assert.equal(website.provider.implementationStatus, 'active');

  const serialized = JSON.stringify({ website, runtime });
  assert.equal(serialized.includes(CANARY_ACCESS_TOKEN), false, 'tokens must never serialize');
  assert.equal(serialized.includes(CANARY_REFRESH_TOKEN), false, 'tokens must never serialize');
});

test('website- and Runtime-created queue items both carry canonical provider identity', async () => {
  const { service, calls } = makeHarness();

  const website = await service.schedulePost(websiteContext(), scheduleInput());
  const runtime = await service.schedulePost(
    runtimeContext(),
    scheduleInput({ requireSingle: true })
  );

  assert.equal(website.post.provider, 'tiktok');
  assert.equal(website.post.connectedAccountId, 'tiktok:account-a');
  assert.equal(runtime.post.provider, 'tiktok');
  assert.equal(runtime.post.connectedAccountId, 'tiktok:account-a');
  for (const call of calls.add) {
    assert.equal(call.defaults.provider, 'tiktok', 'creation defaults must store explicit provider identity');
  }
});

test('unknown and non-active providers are rejected identically on both paths', async () => {
  const { service, calls } = makeHarness();

  for (const provider of ['mastodon', 'youtube', 'linkedin', 'instagram']) {
    const failures = [];
    for (const context of [websiteContext(), runtimeContext()]) {
      await assert.rejects(
        () => service.schedulePost(context, scheduleInput({ provider })),
        (error) => {
          assert.ok(error instanceof AutoPosterApplicationError);
          assert.ok(['unknown_provider', 'provider_not_schedulable'].includes(error.code));
          failures.push({ code: error.code, message: error.message });
          return true;
        }
      );
    }
    assert.deepEqual(failures[0], failures[1], `${provider} must fail the same way on both paths`);
  }
  assert.equal(calls.add.length, 0, 'no queue item may be created for a rejected provider');
});

test('ownership isolation: another tenant cannot resolve or schedule against the account', async () => {
  const { service } = makeHarness();
  await assert.rejects(
    () => service.getConnectedAccount({ userId: 'intruder', source: 'website' }, { accountId: 'account-a' }),
    (error) => error.status === 404
  );
  await assert.rejects(
    () => service.schedulePost({ userId: 'intruder', source: 'website' }, scheduleInput()),
    (error) => error.status === 404
  );
});

test('connection status and publishing readiness gate scheduling separately', async () => {
  const { service, calls } = makeHarness();

  // Disconnected: existing behavior preserved.
  await assert.rejects(
    () => service.schedulePost(websiteContext({ accountId: 'account-cold' }), scheduleInput({ accountId: 'account-cold' })),
    /needs to be reconnected/
  );
  // Connected but expired without a refresh token: blocked as not ready.
  await assert.rejects(
    () => service.schedulePost(websiteContext({ accountId: 'account-expired' }), scheduleInput({ accountId: 'account-expired' })),
    (error) => error.code === 'account_not_ready'
      && error.details.blockers.includes('reauthorization_required')
  );
  // Connected but recorded scope excludes video.publish: blocked as not ready.
  await assert.rejects(
    () => service.schedulePost(websiteContext({ accountId: 'account-wrong-scope' }), scheduleInput({ accountId: 'account-wrong-scope' })),
    (error) => error.code === 'account_not_ready'
      && error.details.blockers.includes('missing_video_publish_scope')
  );
  assert.equal(calls.add.length, 0);

  // A ready account schedules.
  const ready = await service.schedulePost(websiteContext(), scheduleInput());
  assert.equal(ready.post.status, 'scheduled');
});

test('listConnectedAccounts returns only safe views for every owned channel', async () => {
  const { service } = makeHarness();
  const result = await service.listConnectedAccounts(websiteContext());
  assert.equal(result.count, 4);
  assert.equal(result.provider.id, 'tiktok');
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(CANARY_ACCESS_TOKEN), false);
  assert.equal(serialized.includes(CANARY_REFRESH_TOKEN), false);
  const cold = result.accounts.find((account) => account.accountId === 'account-cold');
  assert.equal(cold.connectionStatus, 'disconnected');
  assert.equal(cold.publishingReady, false);
});

test('legacy queue reads normalize a missing provider to TikTok without touching explicit values', () => {
  const legacy = postFromDoc({
    id: 'legacy-1',
    data: () => ({ userId: 'owner', accountId: 'account-a', status: 'scheduled' })
  });
  assert.equal(legacy.provider, 'tiktok');
  assert.equal(legacy.providerSource, 'legacy_default');
  assert.equal(legacy.connectedAccountId, 'tiktok:account-a');

  const explicitUnknown = postFromDoc({
    id: 'explicit-1',
    data: () => ({ userId: 'owner', accountId: 'account-a', platform: 'mastodon', status: 'scheduled' })
  });
  assert.equal(explicitUnknown.provider, 'mastodon', 'explicit unknown provider must never normalize to TikTok');
  assert.equal(explicitUnknown.providerSource, 'explicit');

  const unassigned = postFromDoc({
    id: 'legacy-2',
    data: () => ({ userId: 'owner', status: 'pending' })
  });
  assert.equal(unassigned.connectedAccountId, '', 'unassigned legacy jobs get no invented connection identity');
});
