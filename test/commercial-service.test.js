'use strict';

process.env.APP_DEFAULT_USER_ID = 'owner';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getPlan } = require('../src/planCatalog');
const { createCommercialService } = require('../src/commercialService');
const { defaultWorkspaceId } = require('../src/workspaceService');

function harness({ planId = 'starter', usage = {}, accounts = [], posts = [] } = {}) {
  const plan = getPlan(planId);
  const workspaceCalls = [];
  const workspace = {
    workspaceId: 'workspace-1',
    displayName: 'CHANTER Workspace',
    ownerUserId: 'owner',
    status: 'active',
    metadata: { compatibility: 'legacy_default' }
  };
  const subscription = {
    subscriptionId: 'subscription-1',
    workspaceId: workspace.workspaceId,
    planId,
    status: plan.internalOnly ? 'internal' : 'active',
    source: plan.internalOnly ? 'internal' : 'test',
    entitlementOverrides: null,
    externalCustomerId: 'cus_CANARY_NEVER_SERIALIZE',
    externalSubscriptionId: 'sub_CANARY_NEVER_SERIALIZE'
  };
  const service = createCommercialService({
    workspaceService: {
      async resolveActiveWorkspace(input) {
        workspaceCalls.push(input);
        if (input.requestedWorkspaceId === 'workspace-unknown') {
          const error = new Error('not found');
          error.code = 'workspace_not_found';
          error.status = 404;
          throw error;
        }
        return {
          workspace: { ...workspace, workspaceId: input.requestedWorkspaceId || workspace.workspaceId },
          membership: { workspaceId: workspace.workspaceId, userId: input.userId, role: 'owner', status: 'active' },
          createdLegacy: !input.requestedWorkspaceId
        };
      }
    },
    subscriptionService: {
      async resolveSubscription({ workspace: resolved }) {
        return {
          subscription: { ...subscription, workspaceId: resolved.workspaceId },
          plan,
          entitlements: plan.entitlements,
          cycle: {
            usageCycleId: 'calendar-2026-07',
            start: '2026-07-01T00:00:00.000Z',
            end: '2026-08-01T00:00:00.000Z'
          }
        };
      }
    },
    usageService: {
      async getUsageSnapshot() {
        return {
          used: usage.used ?? 0,
          activeQueue: usage.activeQueue ?? 0,
          reserved: usage.reserved ?? 0,
          consumed: usage.consumed ?? 0
        };
      }
    },
    storage: {
      async getTikTokAccounts() { return accounts.filter((account) => account.provider !== 'youtube'); },
      async getYouTubeAccounts() { return accounts.filter((account) => account.provider === 'youtube'); },
      async getPosts() { return posts; }
    },
    now: () => new Date('2026-07-11T12:00:00.000Z')
  });
  return { service, workspaceCalls };
}

test('legacy eligibility is server-derived and explicit workspace context remains verified', async () => {
  const { service, workspaceCalls } = harness({ planId: 'legacy_full_access' });
  await service.resolveContext({ userId: 'owner' });
  await service.resolveContext({ userId: 'owner', workspaceId: 'workspace-2' });
  assert.equal(workspaceCalls[0].legacyEligible, true);
  assert.equal(workspaceCalls[1].requestedWorkspaceId, 'workspace-2');
  assert.equal(workspaceCalls[1].legacyEligible, true);

  const future = harness();
  await future.service.resolveContext({ userId: 'future-user', workspaceId: 'workspace-2' });
  assert.equal(future.workspaceCalls[0].legacyEligible, false);
});

test('legacy compatibility applies only to the deterministic default workspace', () => {
  const { workspaceScopeFor } = require('../src/commercialService');
  const ownerUserId = 'owner';
  assert.deepEqual(workspaceScopeFor({
    workspaceId: defaultWorkspaceId(ownerUserId),
    ownerUserId,
    metadata: { compatibility: 'legacy_default' }
  }), {
    workspaceId: defaultWorkspaceId(ownerUserId),
    allowLegacyOwnerRecords: true
  });
  assert.deepEqual(workspaceScopeFor({
    workspaceId: 'workspace-explicit-00000001',
    ownerUserId,
    metadata: { compatibility: 'legacy_default' }
  }), {
    workspaceId: 'workspace-explicit-00000001',
    allowLegacyOwnerRecords: false
  });
});

test('Starter denies Runtime scheduling and website quota with the same structured server truth', async () => {
  const { service } = harness({ usage: { used: 30, activeQueue: 20 } });
  const context = await service.resolveContext({ userId: 'owner' });
  const runtime = await service.authorizeSchedule({
    resolvedContext: context,
    providerId: 'tiktok',
    source: 'runtime',
    quantity: 1,
    scheduledAt: '2026-07-12T12:00:00.000Z'
  });
  assert.equal(runtime.decision.allowed, false);
  assert.equal(runtime.decision.reasonCode, 'runtime_scheduling_not_allowed');

  const website = await service.authorizeSchedule({
    resolvedContext: context,
    providerId: 'tiktok',
    source: 'website',
    quantity: 1,
    scheduledAt: '2026-07-12T12:00:00.000Z'
  });
  assert.equal(website.decision.allowed, false);
  assert.equal(website.decision.reasonCode, 'monthly_post_limit_reached');
  assert.equal(website.decision.current, 30);
  assert.equal(website.decision.limit, 30);
});

test('account/provider limits use only current workspace records', async () => {
  const { service } = harness({
    accounts: [
      { accountId: 'tt-1', provider: 'tiktok', connected: true },
      { accountId: 'tt-2', provider: 'tiktok', connected: true }
    ]
  });
  const context = await service.resolveContext({ userId: 'owner' });
  const result = await service.authorizeAccountConnection({
    resolvedContext: context,
    providerId: 'tiktok',
    accountId: 'tt-3'
  });
  assert.equal(result.decision.allowed, false);
  assert.equal(result.decision.reasonCode, 'connected_account_limit_reached');
  assert.equal(result.decision.current, 2);
});

test('safe Plan & Usage projection excludes overrides, credentials, and external billing IDs', async () => {
  const { service } = harness({
    planId: 'legacy_full_access',
    accounts: [
      {
        accountId: 'yt-1',
        provider: 'youtube',
        connected: true,
        credential: 'CREDENTIAL_CANARY',
        entitlementOverrides: { runtimeScheduling: false }
      }
    ],
    usage: { used: 7, activeQueue: 3 }
  });
  const { view } = await service.getPlanUsage({ userId: 'owner' });
  assert.equal(view.plan.displayName, 'Legacy Full Access');
  assert.equal(view.plan.internalOnly, true);
  assert.equal(view.billing.configured, false);
  assert.equal(view.billing.message, 'Billing activation not yet available');
  assert.equal(view.advancedEvidence, true);
  const serialized = JSON.stringify(view);
  for (const canary of [
    'CREDENTIAL_CANARY',
    'cus_CANARY_NEVER_SERIALIZE',
    'sub_CANARY_NEVER_SERIALIZE',
    'entitlementOverrides',
    'externalCustomerId',
    'externalSubscriptionId'
  ]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});
