'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ENTITLEMENT_ACTIONS,
  REASON_CODES,
  resolveEffectiveEntitlements,
  evaluateEntitlement
} = require('../src/entitlementResolver');

const NOW = '2026-07-11T10:00:00.000Z';

function activeSubscription(planId = 'starter', overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    planId,
    status: 'active',
    source: 'internal',
    entitlementOverrides: null,
    ...overrides
  };
}

function baseInput(overrides = {}) {
  return {
    action: ENTITLEMENT_ACTIONS.SCHEDULE_POST,
    workspace: { workspaceId: 'workspace-a', status: 'active' },
    subscription: activeSubscription(),
    evaluationTimestamp: NOW,
    providerId: 'tiktok',
    implementedProviderIds: ['tiktok', 'youtube'],
    scheduledAt: '2026-07-12T10:00:00.000Z',
    scheduledPostsCurrent: 4,
    activeQueueCount: 3,
    source: 'website',
    ...overrides
  };
}

test('an allowed decision has the complete safe structured contract', () => {
  const result = evaluateEntitlement(baseInput());
  assert.deepEqual(result, {
    allowed: true,
    reasonCode: 'allowed',
    reason: 'Allowed by the current workspace plan.',
    limit: 30,
    current: 4,
    remaining: 26,
    planId: 'starter',
    workspaceId: 'workspace-a',
    evaluationTimestamp: NOW
  });
});

test('workspace and subscription truth fail closed before commercial evaluation', () => {
  const inactiveWorkspace = evaluateEntitlement(baseInput({
    workspace: { workspaceId: 'workspace-a', status: 'suspended' }
  }));
  assert.equal(inactiveWorkspace.allowed, false);
  assert.equal(inactiveWorkspace.reasonCode, REASON_CODES.WORKSPACE_INACTIVE);
  assert.equal(inactiveWorkspace.planId, null);

  const missingWorkspace = evaluateEntitlement(baseInput({ workspace: null }));
  assert.equal(missingWorkspace.reasonCode, REASON_CODES.WORKSPACE_INACTIVE);

  for (const subscription of [
    null,
    activeSubscription('starter', { workspaceId: 'workspace-b' }),
    activeSubscription('starter', { status: 'canceled' }),
    activeSubscription('starter', { status: 'past_due' }),
    activeSubscription('starter', { status: 'none' })
  ]) {
    const result = evaluateEntitlement(baseInput({ subscription }));
    assert.equal(result.allowed, false);
    assert.equal(result.reasonCode, REASON_CODES.SUBSCRIPTION_INACTIVE);
  }
});

test('missing plans and invalid bounded overrides deny safely', () => {
  const missingPlan = evaluateEntitlement(baseInput({
    subscription: activeSubscription('not-a-plan')
  }));
  assert.equal(missingPlan.reasonCode, REASON_CODES.PLAN_NOT_FOUND);

  const invalidOverride = evaluateEntitlement(baseInput({
    subscription: activeSubscription('starter', {
      entitlementOverrides: { providerIds: ['linkedin'] }
    })
  }));
  assert.equal(invalidOverride.reasonCode, REASON_CODES.ENTITLEMENT_CONFIGURATION_INVALID);
});

test('provider limits count only new implemented providers', () => {
  const blocked = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.ENABLE_PROVIDER,
    providerId: 'youtube',
    activeProviderIds: ['tiktok']
  }));
  assert.equal(blocked.reasonCode, REASON_CODES.PROVIDER_LIMIT_REACHED);
  assert.equal(blocked.limit, 1);
  assert.equal(blocked.current, 1);
  assert.equal(blocked.remaining, 0);

  const existing = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.ENABLE_PROVIDER,
    providerId: 'tiktok',
    activeProviderIds: ['tiktok']
  }));
  assert.equal(existing.allowed, true, 'an already-active provider does not consume another slot');

  const unsupportedStoredProvider = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.ENABLE_PROVIDER,
    providerId: 'tiktok',
    activeProviderIds: ['linkedin']
  }));
  assert.equal(unsupportedStoredProvider.allowed, true);
  assert.equal(unsupportedStoredProvider.current, 0, 'unsupported providers do not consume a provider slot');
});

test('unsupported providers remain disabled regardless of plan limit or overrides', () => {
  const result = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.ENABLE_PROVIDER,
    subscription: activeSubscription('studio', {
      entitlementOverrides: { providerLimit: 20 }
    }),
    providerId: 'linkedin',
    activeProviderIds: []
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, REASON_CODES.FEATURE_NOT_AVAILABLE);
  assert.equal(result.planId, 'studio');
});

test('connected account limit is enforced after provider eligibility', () => {
  const result = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.CONNECT_ACCOUNT,
    activeProviderIds: ['tiktok'],
    connectedAccountCount: 2
  }));
  assert.equal(result.reasonCode, REASON_CODES.CONNECTED_ACCOUNT_LIMIT_REACHED);
  assert.equal(result.limit, 2);
  assert.equal(result.current, 2);
});

test('scheduled-post and active-queue limits include the requested quantity', () => {
  const monthly = evaluateEntitlement(baseInput({ scheduledPostsCurrent: 30 }));
  assert.equal(monthly.reasonCode, REASON_CODES.MONTHLY_POST_LIMIT_REACHED);
  assert.equal(monthly.limit, 30);
  assert.equal(monthly.current, 30);

  const queue = evaluateEntitlement(baseInput({
    scheduledPostsCurrent: 0,
    activeQueueCount: 20
  }));
  assert.equal(queue.reasonCode, REASON_CODES.ACTIVE_QUEUE_LIMIT_REACHED);
  assert.equal(queue.limit, 20);
  assert.equal(queue.current, 20);
});

test('batch size is rejected before quota and queue checks', () => {
  const result = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.SCHEDULE_BATCH,
    batchSize: 6,
    scheduledPostsCurrent: 0,
    activeQueueCount: 0
  }));
  assert.equal(result.reasonCode, REASON_CODES.BATCH_SIZE_LIMIT_EXCEEDED);
  assert.equal(result.limit, 5);
  assert.equal(result.current, 6);
  assert.equal(result.remaining, 0);
});

test('scheduling horizon uses the deterministic evaluation timestamp', () => {
  const outside = evaluateEntitlement(baseInput({
    scheduledAt: '2026-07-19T10:00:00.000Z'
  }));
  assert.equal(outside.reasonCode, REASON_CODES.SCHEDULING_HORIZON_EXCEEDED);
  assert.equal(outside.limit, 7);
  assert.equal(outside.current, 8);

  const boundary = evaluateEntitlement(baseInput({
    scheduledAt: '2026-07-18T10:00:00.000Z'
  }));
  assert.equal(boundary.allowed, true);
});

test('runtime scheduling is denied for Starter and allowed for Creator and Studio', () => {
  const starter = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.USE_RUNTIME_SCHEDULING
  }));
  assert.equal(starter.reasonCode, REASON_CODES.RUNTIME_SCHEDULING_NOT_ALLOWED);

  for (const planId of ['creator', 'studio']) {
    const result = evaluateEntitlement(baseInput({
      action: ENTITLEMENT_ACTIONS.USE_RUNTIME_SCHEDULING,
      subscription: activeSubscription(planId)
    }));
    assert.equal(result.allowed, true, `${planId} must allow Runtime scheduling`);
  }

  const runtimeSchedule = evaluateEntitlement(baseInput({ source: 'runtime' }));
  assert.equal(runtimeSchedule.reasonCode, REASON_CODES.RUNTIME_SCHEDULING_NOT_ALLOWED);
});

test('workspace limit and uncertain usage truth fail closed', () => {
  const workspaceLimit = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.CREATE_WORKSPACE,
    workspaceCount: 1
  }));
  assert.equal(workspaceLimit.reasonCode, REASON_CODES.WORKSPACE_LIMIT_REACHED);

  const missingUsage = evaluateEntitlement(baseInput({
    scheduledPostsCurrent: undefined
  }));
  assert.equal(missingUsage.reasonCode, REASON_CODES.COMMERCIAL_TRUTH_UNVERIFIED);
});

test('server subscription plan wins over a browser-supplied plan claim', () => {
  const result = evaluateEntitlement(baseInput({
    action: ENTITLEMENT_ACTIONS.USE_RUNTIME_SCHEDULING,
    planId: 'studio',
    subscription: activeSubscription('starter')
  }));
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, REASON_CODES.RUNTIME_SCHEDULING_NOT_ALLOWED);
  assert.equal(result.planId, 'starter');
});

test('bounded overrides apply only through the workspace subscription', () => {
  const raised = evaluateEntitlement(baseInput({
    subscription: activeSubscription('starter', {
      entitlementOverrides: { scheduledPostsPerCycle: 31 }
    }),
    scheduledPostsCurrent: 30
  }));
  assert.equal(raised.allowed, true);
  assert.equal(raised.limit, 31);
  assert.equal(raised.remaining, 1);

  const wrongWorkspace = evaluateEntitlement(baseInput({
    subscription: activeSubscription('starter', {
      workspaceId: 'workspace-b',
      entitlementOverrides: { runtimeScheduling: true }
    }),
    action: ENTITLEMENT_ACTIONS.USE_RUNTIME_SCHEDULING
  }));
  assert.equal(wrongWorkspace.reasonCode, REASON_CODES.SUBSCRIPTION_INACTIVE);
});

test('legacy full access requires an internal subscription and remains unmetered', () => {
  const legacySubscription = activeSubscription('legacy_full_access', {
    status: 'internal',
    source: 'internal'
  });
  const resolution = resolveEffectiveEntitlements(baseInput({
    subscription: legacySubscription
  }));
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.entitlements.scheduledPostsPerCycle, null);

  const scheduled = evaluateEntitlement(baseInput({
    subscription: legacySubscription,
    scheduledPostsCurrent: undefined,
    activeQueueCount: undefined
  }));
  assert.equal(scheduled.allowed, true);
  assert.equal(scheduled.limit, null);
  assert.equal(scheduled.remaining, null);

  const misassigned = evaluateEntitlement(baseInput({
    subscription: activeSubscription('legacy_full_access', {
      status: 'active',
      source: 'manual'
    })
  }));
  assert.equal(misassigned.reasonCode, REASON_CODES.SUBSCRIPTION_INACTIVE);
});
