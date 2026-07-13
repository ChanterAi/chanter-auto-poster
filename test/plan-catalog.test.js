'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PLAN_IDS,
  PUBLIC_PLAN_IDS,
  PLAN_CATALOG,
  PlanCatalogError,
  getPlan,
  serializePublicPlan,
  listPublicPlans,
  applyEntitlementOverrides,
  resolvePlanEntitlements
} = require('../src/planCatalog');

test('public plans expose the one canonical provisional entitlement matrix', () => {
  assert.deepEqual(getPlan(PLAN_IDS.STARTER).entitlements, {
    workspaceLimit: 1,
    providerLimit: 1,
    connectedAccountLimit: 2,
    scheduledPostsPerCycle: 30,
    activeQueueLimit: 20,
    batchSizeLimit: 5,
    schedulingHorizonDays: 7,
    runtimeScheduling: false,
    advancedEvidence: false
  });
  assert.deepEqual(getPlan(PLAN_IDS.CREATOR).entitlements, {
    workspaceLimit: 1,
    providerLimit: 2,
    connectedAccountLimit: 5,
    scheduledPostsPerCycle: 150,
    activeQueueLimit: 100,
    batchSizeLimit: 25,
    schedulingHorizonDays: 30,
    runtimeScheduling: true,
    advancedEvidence: true
  });
  assert.deepEqual(getPlan(PLAN_IDS.STUDIO).entitlements, {
    workspaceLimit: 3,
    providerLimit: 4,
    connectedAccountLimit: 20,
    scheduledPostsPerCycle: 1000,
    activeQueueLimit: 500,
    batchSizeLimit: 100,
    schedulingHorizonDays: 90,
    runtimeScheduling: true,
    advancedEvidence: true
  });
});

test('legacy full access is internal, unmetered, and never public', () => {
  const legacy = getPlan(PLAN_IDS.LEGACY_FULL_ACCESS);
  assert.equal(legacy.displayName, 'Legacy Full Access');
  assert.equal(legacy.internalOnly, true);
  assert.deepEqual(legacy.entitlements, {
    workspaceLimit: null,
    providerLimit: null,
    connectedAccountLimit: null,
    scheduledPostsPerCycle: null,
    activeQueueLimit: null,
    batchSizeLimit: null,
    schedulingHorizonDays: null,
    runtimeScheduling: true,
    advancedEvidence: true
  });
  assert.equal(serializePublicPlan(legacy), null);
  assert.equal(PUBLIC_PLAN_IDS.includes(legacy.id), false);
});

test('public serialization returns only public plans with unconfigured billing fields', () => {
  const plans = listPublicPlans();
  assert.deepEqual(plans.map((plan) => plan.id), ['starter', 'creator', 'studio']);
  for (const plan of plans) {
    assert.equal(plan.monthlyPrice, null);
    assert.equal(plan.currency, null);
    assert.equal(plan.billingInterval, null);
    assert.equal(plan.externalPriceId, null);
    assert.equal(Object.prototype.hasOwnProperty.call(plan, 'internalOnly'), false);
  }
  assert.equal(plans.some((plan) => plan.id === 'legacy_full_access'), false);

  const callerSupplied = serializePublicPlan({
    id: 'starter',
    displayName: 'Injected',
    entitlements: { providerLimit: 999 }
  });
  assert.equal(callerSupplied.displayName, 'Starter');
  assert.equal(callerSupplied.entitlements.providerLimit, 1);
});

test('missing plans fail safely and catalog records cannot be mutated', () => {
  assert.equal(getPlan('missing'), null);
  assert.equal(resolvePlanEntitlements('missing'), null);
  assert.equal(Object.isFrozen(PLAN_CATALOG), true);
  assert.equal(Object.isFrozen(getPlan('starter').entitlements), true);
  assert.throws(() => {
    getPlan('starter').entitlements.providerLimit = 99;
  }, TypeError);
  assert.equal(getPlan('starter').entitlements.providerLimit, 1);
});

test('bounded overrides apply only known numeric and feature fields', () => {
  const base = getPlan('starter').entitlements;
  const effective = applyEntitlementOverrides(base, {
    connectedAccountLimit: 4,
    scheduledPostsPerCycle: 60,
    runtimeScheduling: true
  });
  assert.equal(effective.connectedAccountLimit, 4);
  assert.equal(effective.scheduledPostsPerCycle, 60);
  assert.equal(effective.runtimeScheduling, true);
  assert.equal(effective.providerLimit, 1);
  assert.equal(Object.isFrozen(effective), true);
  assert.equal(base.connectedAccountLimit, 2, 'catalog truth must not be mutated');
});

test('invalid or capability-shaped overrides are rejected instead of broadening access', () => {
  const base = getPlan('studio').entitlements;
  for (const overrides of [
    { providerIds: ['linkedin'] },
    { connectedAccountLimit: -1 },
    { scheduledPostsPerCycle: 1.5 },
    { runtimeScheduling: 'yes' },
    { providerLimit: null }
  ]) {
    assert.throws(
      () => applyEntitlementOverrides(base, overrides),
      (error) => error instanceof PlanCatalogError
        && error.code === 'invalid_entitlement_overrides'
    );
  }
});

test('legacy unmetered fields can be narrowed but public plans cannot become unlimited', () => {
  const legacy = resolvePlanEntitlements('legacy_full_access', {
    scheduledPostsPerCycle: 1000,
    runtimeScheduling: false
  });
  assert.equal(legacy.entitlements.scheduledPostsPerCycle, 1000);
  assert.equal(legacy.entitlements.runtimeScheduling, false);
  assert.equal(legacy.plan.entitlements.scheduledPostsPerCycle, null);
});
