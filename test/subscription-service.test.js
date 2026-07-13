'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const planCatalog = require('../src/planCatalog');
const {
  COLLECTIONS,
  SubscriptionError,
  calendarUtcCycle,
  createSubscriptionService,
  normalizeSubscriptionRecord,
  planChangeIntentDocumentId,
  subscriptionDocumentId,
  toPublicSubscription
} = require('../src/subscriptionService');
const {
  COLLECTIONS: WORKSPACE_COLLECTIONS,
  createWorkspaceService
} = require('../src/workspaceService');

function timestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Object.freeze({
    toDate: () => new Date(date.getTime()),
    toMillis: () => date.getTime()
  });
}

const Timestamp = Object.freeze({
  fromDate: (date) => timestamp(date),
  fromMillis: (milliseconds) => timestamp(milliseconds)
});

function createFirestoreFake() {
  const stores = new Map();

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function reference(collectionName, id) {
    return Object.freeze({ collectionName, id, path: `${collectionName}/${id}` });
  }

  function snapshot(ref) {
    const records = store(ref.collectionName);
    return {
      id: ref.id,
      exists: records.has(ref.id),
      data: () => records.get(ref.id)
    };
  }

  const db = {
    collection(name) {
      return { doc: (id) => reference(name, id) };
    },
    async runTransaction(callback) {
      const pending = [];
      const result = await callback({
        get: async (ref) => snapshot(ref),
        create(ref, data) { pending.push({ type: 'create', ref, data }); },
        set(ref, data) { pending.push({ type: 'set', ref, data }); },
        update(ref, patch) { pending.push({ type: 'update', ref, data: patch }); }
      });
      for (const operation of pending) {
        const records = store(operation.ref.collectionName);
        if (operation.type === 'create' && records.has(operation.ref.id)) {
          const error = new Error('already exists');
          error.code = 6;
          throw error;
        }
        if (operation.type === 'update' && !records.has(operation.ref.id)) {
          throw new Error('missing update target');
        }
        const current = records.get(operation.ref.id) || {};
        records.set(operation.ref.id, operation.type === 'update'
          ? { ...current, ...operation.data }
          : operation.data);
      }
      return result;
    }
  };

  return {
    db,
    seed(collectionName, id, data) { store(collectionName).set(id, data); },
    get(collectionName, id) { return store(collectionName).get(id); },
    count(collectionName) { return store(collectionName).size; }
  };
}

function serviceHarness({ now = '2026-07-11T12:30:00.000Z' } = {}) {
  const fake = createFirestoreFake();
  let currentNow = new Date(now);
  const dependencies = {
    db: fake.db,
    Timestamp,
    clock: () => new Date(currentNow.getTime())
  };
  return {
    fake,
    subscriptions: createSubscriptionService({ ...dependencies, planCatalog }),
    workspaces: createWorkspaceService({
      ...dependencies,
      workspaceIdFactory: () => 'workspace-new-00000001'
    }),
    setNow(value) { currentNow = new Date(value); }
  };
}

test('legacy subscription resolves catalog entitlements and advances calendar UTC cycles', async () => {
  const harness = serviceHarness();
  const active = await harness.workspaces.resolveActiveWorkspace({ userId: 'owner', legacyEligible: true });
  const first = await harness.subscriptions.resolveSubscription(active.workspace);

  assert.equal(first.subscription.workspaceId, active.workspace.workspaceId);
  assert.equal(first.subscription.planId, 'legacy_full_access');
  assert.equal(first.subscription.status, 'internal');
  assert.equal(first.subscription.source, 'internal');
  assert.equal(first.plan.id, 'legacy_full_access');
  assert.equal(first.plan.internalOnly, true);
  assert.equal(first.entitlements.scheduledPostsPerCycle, null);
  assert.equal(first.entitlements.runtimeScheduling, true);
  assert.deepEqual(first.cycle, {
    usageCycleId: '2026-07',
    start: '2026-07-01T00:00:00.000Z',
    end: '2026-08-01T00:00:00.000Z'
  });

  harness.setNow('2026-08-04T09:00:00.000Z');
  const next = await harness.subscriptions.resolveSubscription(active.workspace);
  assert.equal(next.cycle.usageCycleId, '2026-08');
  assert.equal(next.subscription.currentPeriodStart, '2026-08-01T00:00:00.000Z');
  assert.equal(next.subscription.currentPeriodEnd, '2026-09-01T00:00:00.000Z');
  const stored = harness.fake.get(COLLECTIONS.SUBSCRIPTIONS, subscriptionDocumentId(active.workspace.workspaceId));
  assert.equal(stored.currentPeriodStart.toDate().toISOString(), '2026-08-01T00:00:00.000Z');
});

test('explicit subscription periods keep one deterministic usage cycle across a calendar boundary', async () => {
  const harness = serviceHarness({ now: '2026-07-31T23:00:00.000Z' });
  const created = await harness.workspaces.createWorkspace({ ownerUserId: 'billing-owner' });
  const workspaceId = created.workspace.workspaceId;
  const subscriptionId = subscriptionDocumentId(workspaceId);
  const seedPeriod = (start, end) => harness.fake.seed(COLLECTIONS.SUBSCRIPTIONS, subscriptionId, {
    subscriptionId,
    workspaceId,
    planId: 'creator',
    status: 'active',
    source: 'billing_provider',
    currentPeriodStart: timestamp(start),
    currentPeriodEnd: timestamp(end),
    cancelAtPeriodEnd: false,
    entitlementOverrides: {},
    externalCustomerId: null,
    externalSubscriptionId: null,
    billingProvider: null,
    createdAt: timestamp(start),
    updatedAt: timestamp(start),
    schemaVersion: 1
  });

  seedPeriod('2026-07-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
  const july = await harness.subscriptions.resolveSubscription(created.workspace);
  harness.setNow('2026-08-01T01:00:00.000Z');
  const august = await harness.subscriptions.resolveSubscription(created.workspace);

  assert.match(july.cycle.usageCycleId, /^period-[a-f0-9]{40}$/);
  assert.equal(august.cycle.usageCycleId, july.cycle.usageCycleId);
  assert.deepEqual(
    { start: august.cycle.start, end: august.cycle.end },
    { start: '2026-07-15T00:00:00.000Z', end: '2026-08-15T00:00:00.000Z' }
  );

  seedPeriod('2026-08-15T00:00:00.000Z', '2026-09-15T00:00:00.000Z');
  harness.setNow('2026-08-16T01:00:00.000Z');
  const next = await harness.subscriptions.resolveSubscription(created.workspace);
  assert.notEqual(next.cycle.usageCycleId, july.cycle.usageCycleId);
});

test('legacy internal update defaults to internal status and remains resolvable', async () => {
  const harness = serviceHarness();
  const active = await harness.workspaces.resolveActiveWorkspace({
    userId: 'owner',
    legacyEligible: true
  });
  const updated = await harness.subscriptions.updateInternalSubscription({
    workspaceId: active.workspace.workspaceId,
    planId: 'legacy_full_access',
    actorId: 'admin:owner',
    idempotencyKey: 'legacy-internal-refresh'
  });
  assert.equal(updated.subscription.status, 'internal');
  assert.equal(updated.subscription.source, 'internal');

  const resolved = await harness.subscriptions.resolveSubscription(active.workspace);
  assert.equal(resolved.subscription.status, 'internal');
  assert.equal(resolved.plan.id, 'legacy_full_access');

  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({
      workspaceId: active.workspace.workspaceId,
      planId: 'legacy_full_access',
      status: 'active',
      actorId: 'admin:owner',
      idempotencyKey: 'legacy-invalid-status'
    }),
    (error) => error.code === 'legacy_subscription_status_invalid' && error.status === 400
  );
});

test('a new explicit workspace resolves no subscription and cannot receive legacy access', async () => {
  const harness = serviceHarness();
  const created = await harness.workspaces.createWorkspace({
    ownerUserId: 'new-owner',
    displayName: 'New Studio'
  });
  const resolved = await harness.subscriptions.resolveSubscription(created.workspace);

  assert.equal(resolved.subscription.status, 'none');
  assert.equal(resolved.subscription.planId, null);
  assert.equal(resolved.plan, null);
  assert.equal(resolved.entitlements, null);
  assert.equal(harness.fake.count(COLLECTIONS.SUBSCRIPTIONS), 0);

  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({
      workspaceId: created.workspace.workspaceId,
      planId: 'legacy_full_access',
      status: 'internal',
      actorId: 'admin:owner',
      idempotencyKey: 'legacy-for-new-workspace'
    }),
    (error) => error instanceof SubscriptionError
      && error.code === 'legacy_plan_not_allowed'
      && error.status === 403
  );
  assert.equal(harness.fake.count(COLLECTIONS.SUBSCRIPTIONS), 0);
});

test('internal subscription updates are bounded, nullable-billing, workspace-scoped, and idempotent', async () => {
  const harness = serviceHarness();
  const created = await harness.workspaces.createWorkspace({ ownerUserId: 'owner' });
  const workspaceId = created.workspace.workspaceId;
  const request = {
    workspaceId,
    planId: 'starter',
    status: 'active',
    entitlementOverrides: { scheduledPostsPerCycle: 42, runtimeScheduling: true },
    actorId: 'admin:owner',
    reason: 'Temporary reviewed increase',
    idempotencyKey: 'subscription-update-1'
  };

  const first = await harness.subscriptions.updateInternalSubscription(request);
  const second = await harness.subscriptions.updateInternalSubscription(request);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.subscription.planId, 'starter');
  assert.equal(first.subscription.externalCustomerId, null);
  assert.equal(first.subscription.externalSubscriptionId, null);
  assert.equal(first.subscription.billingProvider, null);
  assert.equal(first.entitlements.scheduledPostsPerCycle, 42);
  assert.equal(first.entitlements.runtimeScheduling, true);
  assert.equal(harness.fake.count(COLLECTIONS.SUBSCRIPTIONS), 1);

  const effective = await harness.subscriptions.resolveSubscription(created.workspace);
  assert.equal(effective.plan.id, 'starter');
  assert.equal(effective.entitlements.scheduledPostsPerCycle, 42);
  assert.equal(effective.entitlements.connectedAccountLimit, 2);

  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({ ...request, planId: 'creator' }),
    (error) => error.code === 'idempotency_conflict' && error.status === 409
  );
  assert.equal(
    harness.fake.get(COLLECTIONS.SUBSCRIPTIONS, subscriptionDocumentId(workspaceId)).planId,
    'starter'
  );
});

test('invalid or unbounded entitlement overrides fail before subscription persistence', async () => {
  const harness = serviceHarness();
  const created = await harness.workspaces.createWorkspace({ ownerUserId: 'owner' });
  const base = {
    workspaceId: created.workspace.workspaceId,
    planId: 'starter',
    actorId: 'admin:owner',
    idempotencyKey: 'invalid-override'
  };

  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({
      ...base,
      entitlementOverrides: { enabledProviders: ['linkedin'] }
    }),
    (error) => error.code === 'subscription_overrides_invalid'
  );
  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({
      ...base,
      entitlementOverrides: { connectedAccountLimit: Number.MAX_SAFE_INTEGER + 1 }
    }),
    (error) => error.code === 'subscription_overrides_invalid'
  );
  await assert.rejects(
    harness.subscriptions.updateInternalSubscription({
      ...base,
      entitlementOverrides: { scheduledPostsPerCycle: null }
    }),
    (error) => error.code === 'subscription_overrides_invalid'
  );
  assert.equal(harness.fake.count(COLLECTIONS.SUBSCRIPTIONS), 0);
});

test('subscription status remains canonical for server-side entitlement denial', async () => {
  const harness = serviceHarness();
  const created = await harness.workspaces.createWorkspace({ ownerUserId: 'owner' });
  await harness.subscriptions.updateInternalSubscription({
    workspaceId: created.workspace.workspaceId,
    planId: 'creator',
    status: 'past_due',
    actorId: 'admin:owner',
    idempotencyKey: 'past-due-fixture'
  });
  const resolved = await harness.subscriptions.resolveSubscription(created.workspace);
  assert.equal(resolved.subscription.status, 'past_due');
  assert.equal(resolved.plan.id, 'creator');
  assert.equal(resolved.entitlements.runtimeScheduling, true);
  // The entitlement evaluator, not persistence, owns the fail-closed status
  // decision. The resolver preserves the truthful status without fabricating
  // payment state.
});

test('plan-change intents are structured and idempotent without checkout or billing state', async () => {
  const harness = serviceHarness();
  const created = await harness.workspaces.createWorkspace({ ownerUserId: 'owner' });
  const workspaceId = created.workspace.workspaceId;
  await harness.subscriptions.updateInternalSubscription({
    workspaceId,
    planId: 'starter',
    actorId: 'admin:owner',
    idempotencyKey: 'starter-assignment'
  });
  const request = {
    workspaceId,
    targetPlanId: 'creator',
    requestedBy: 'admin:owner',
    reason: 'Recorded for future billing handoff',
    idempotencyKey: 'plan-change-1'
  };
  const first = await harness.subscriptions.recordPlanChangeIntent(request);
  const duplicate = await harness.subscriptions.recordPlanChangeIntent(request);

  assert.equal(first.duplicate, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.intent.currentPlanId, 'starter');
  assert.equal(first.intent.targetPlanId, 'creator');
  assert.equal(first.intent.status, 'recorded');
  const stored = harness.fake.get(
    COLLECTIONS.PLAN_CHANGE_INTENTS,
    planChangeIntentDocumentId(workspaceId, request.idempotencyKey)
  );
  assert.equal(stored.billingProvider, null);
  assert.equal(stored.externalPriceId, null);
  assert.equal(harness.fake.count(COLLECTIONS.PLAN_CHANGE_INTENTS), 1);

  await assert.rejects(
    harness.subscriptions.recordPlanChangeIntent({ ...request, targetPlanId: 'studio' }),
    (error) => error.code === 'idempotency_conflict'
  );
  await assert.rejects(
    harness.subscriptions.recordPlanChangeIntent({
      ...request,
      idempotencyKey: 'internal-plan-change',
      targetPlanId: 'legacy_full_access'
    }),
    (error) => error.code === 'plan_change_not_available'
  );
});

test('public subscription serialization redacts overrides and all external billing identifiers', () => {
  const workspaceId = 'workspace-safe-00000001';
  const subscriptionId = subscriptionDocumentId(workspaceId);
  const normalized = normalizeSubscriptionRecord({
    subscriptionId,
    workspaceId,
    planId: 'creator',
    status: 'active',
    source: 'billing_provider',
    currentPeriodStart: timestamp('2026-07-01T00:00:00Z'),
    currentPeriodEnd: timestamp('2026-08-01T00:00:00Z'),
    cancelAtPeriodEnd: false,
    entitlementOverrides: { scheduledPostsPerCycle: 777, auditCanary: 'internal-override-canary' },
    externalCustomerId: 'customer-secret-canary',
    externalSubscriptionId: 'subscription-secret-canary',
    billingProvider: 'provider-canary',
    createdAt: timestamp('2026-07-01T00:00:00Z'),
    updatedAt: timestamp('2026-07-01T00:00:00Z'),
    schemaVersion: 1
  }, subscriptionId);
  const publicView = toPublicSubscription(normalized);
  const json = JSON.stringify(publicView);

  assert.deepEqual(Object.keys(publicView).sort(), [
    'cancelAtPeriodEnd',
    'currentPeriodEnd',
    'currentPeriodStart',
    'planId',
    'status',
    'workspaceId'
  ]);
  for (const canary of [
    'internal-override-canary',
    'customer-secret-canary',
    'subscription-secret-canary',
    'provider-canary'
  ]) assert.equal(json.includes(canary), false);
});

test('calendar cycle IDs and boundaries are UTC and end-exclusive', () => {
  const cycle = calendarUtcCycle(new Date('2026-12-31T23:59:59.999-08:00'));
  assert.equal(cycle.usageCycleId, '2027-01');
  assert.equal(cycle.start, '2027-01-01T00:00:00.000Z');
  assert.equal(cycle.end, '2027-02-01T00:00:00.000Z');
});
