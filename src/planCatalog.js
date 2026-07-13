'use strict';

// Product configuration only. Billing values deliberately remain
// unconfigured until a real billing milestone supplies authoritative values.

const PLAN_IDS = Object.freeze({
  STARTER: 'starter',
  CREATOR: 'creator',
  STUDIO: 'studio',
  LEGACY_FULL_ACCESS: 'legacy_full_access'
});

const PUBLIC_PLAN_IDS = Object.freeze([
  PLAN_IDS.STARTER,
  PLAN_IDS.CREATOR,
  PLAN_IDS.STUDIO
]);

const NUMERIC_ENTITLEMENTS = Object.freeze([
  'workspaceLimit',
  'providerLimit',
  'connectedAccountLimit',
  'scheduledPostsPerCycle',
  'activeQueueLimit',
  'batchSizeLimit',
  'schedulingHorizonDays'
]);

const BOOLEAN_ENTITLEMENTS = Object.freeze([
  'runtimeScheduling',
  'advancedEvidence'
]);

const ENTITLEMENT_KEYS = Object.freeze([
  ...NUMERIC_ENTITLEMENTS,
  ...BOOLEAN_ENTITLEMENTS
]);

class PlanCatalogError extends Error {
  constructor(message, { code = 'invalid_plan_configuration', details = {} } = {}) {
    super(message);
    this.name = 'PlanCatalogError';
    this.code = code;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function plan(id, displayName, { internalOnly = false, entitlements }) {
  return {
    id,
    displayName,
    internalOnly,
    monthlyPrice: null,
    currency: null,
    billingInterval: null,
    externalPriceId: null,
    entitlements
  };
}

const PLAN_CATALOG = deepFreeze({
  [PLAN_IDS.STARTER]: plan(PLAN_IDS.STARTER, 'Starter', {
    entitlements: {
      workspaceLimit: 1,
      providerLimit: 1,
      connectedAccountLimit: 2,
      scheduledPostsPerCycle: 30,
      activeQueueLimit: 20,
      batchSizeLimit: 5,
      schedulingHorizonDays: 7,
      runtimeScheduling: false,
      advancedEvidence: false
    }
  }),
  [PLAN_IDS.CREATOR]: plan(PLAN_IDS.CREATOR, 'Creator', {
    entitlements: {
      workspaceLimit: 1,
      providerLimit: 2,
      connectedAccountLimit: 5,
      scheduledPostsPerCycle: 150,
      activeQueueLimit: 100,
      batchSizeLimit: 25,
      schedulingHorizonDays: 30,
      runtimeScheduling: true,
      advancedEvidence: true
    }
  }),
  [PLAN_IDS.STUDIO]: plan(PLAN_IDS.STUDIO, 'Studio', {
    entitlements: {
      workspaceLimit: 3,
      providerLimit: 4,
      connectedAccountLimit: 20,
      scheduledPostsPerCycle: 1000,
      activeQueueLimit: 500,
      batchSizeLimit: 100,
      schedulingHorizonDays: 90,
      runtimeScheduling: true,
      advancedEvidence: true
    }
  }),
  [PLAN_IDS.LEGACY_FULL_ACCESS]: plan(PLAN_IDS.LEGACY_FULL_ACCESS, 'Legacy Full Access', {
    internalOnly: true,
    // Null means unmetered for the transitional legacy plan only. Public
    // overrides cannot turn a finite entitlement into an unmetered one.
    entitlements: {
      workspaceLimit: null,
      providerLimit: null,
      connectedAccountLimit: null,
      scheduledPostsPerCycle: null,
      activeQueueLimit: null,
      batchSizeLimit: null,
      schedulingHorizonDays: null,
      runtimeScheduling: true,
      advancedEvidence: true
    }
  })
});

function normalizePlanId(planId) {
  return String(planId || '').trim().toLowerCase();
}

function getPlan(planId) {
  return PLAN_CATALOG[normalizePlanId(planId)] || null;
}

function cloneEntitlements(entitlements) {
  return Object.fromEntries(ENTITLEMENT_KEYS.map((key) => [key, entitlements[key]]));
}

function serializePublicPlan(planOrId) {
  // Resolve by canonical ID even when an internal caller passes a plan-like
  // object. Public output never trusts caller-supplied plan fields.
  const resolved = getPlan(
    typeof planOrId === 'string' ? planOrId : planOrId && planOrId.id
  );
  if (!resolved || resolved.internalOnly || !PUBLIC_PLAN_IDS.includes(resolved.id)) return null;

  return {
    id: resolved.id,
    displayName: resolved.displayName,
    monthlyPrice: resolved.monthlyPrice,
    currency: resolved.currency,
    billingInterval: resolved.billingInterval,
    externalPriceId: resolved.externalPriceId,
    entitlements: cloneEntitlements(resolved.entitlements)
  };
}

function listPublicPlans() {
  return PUBLIC_PLAN_IDS.map((planId) => serializePublicPlan(planId));
}

function invalidOverride(message, details) {
  throw new PlanCatalogError(message, {
    code: 'invalid_entitlement_overrides',
    details
  });
}

function applyEntitlementOverrides(baseEntitlements, overrides = null) {
  if (!baseEntitlements || typeof baseEntitlements !== 'object' || Array.isArray(baseEntitlements)) {
    throw new PlanCatalogError('Base entitlements are required.', {
      code: 'invalid_plan_configuration'
    });
  }

  const effective = cloneEntitlements(baseEntitlements);
  if (overrides === null || overrides === undefined) return deepFreeze(effective);
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    invalidOverride('Entitlement overrides must be an object.', { key: null });
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (!ENTITLEMENT_KEYS.includes(key)) {
      invalidOverride('Entitlement override contains an unsupported field.', { key });
    }

    if (NUMERIC_ENTITLEMENTS.includes(key)) {
      if (value === null) {
        if (baseEntitlements[key] !== null) {
          invalidOverride('A finite entitlement cannot be overridden to unlimited.', { key });
        }
      } else if (!Number.isSafeInteger(value) || value < 0) {
        invalidOverride('Numeric entitlement overrides must be non-negative safe integers.', { key });
      }
      effective[key] = value;
      continue;
    }

    if (typeof value !== 'boolean') {
      invalidOverride('Feature entitlement overrides must be boolean.', { key });
    }
    effective[key] = value;
  }

  return deepFreeze(effective);
}

function resolvePlanEntitlements(planId, overrides = null) {
  const resolvedPlan = getPlan(planId);
  if (!resolvedPlan) return null;
  return Object.freeze({
    plan: resolvedPlan,
    entitlements: applyEntitlementOverrides(resolvedPlan.entitlements, overrides)
  });
}

module.exports = {
  PLAN_IDS,
  PUBLIC_PLAN_IDS,
  NUMERIC_ENTITLEMENTS,
  BOOLEAN_ENTITLEMENTS,
  ENTITLEMENT_KEYS,
  PLAN_CATALOG,
  PlanCatalogError,
  getPlan,
  serializePublicPlan,
  listPublicPlans,
  applyEntitlementOverrides,
  resolvePlanEntitlements
};
