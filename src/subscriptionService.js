'use strict';

// Subscription persistence and billing-ready intent boundary. This module
// resolves product truth from the server-side plan catalog; it does not
// implement checkout, payment-provider calls, or customer-facing upgrades.

const { createHash } = require('crypto');

const SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze({
  SUBSCRIPTIONS: 'subscriptions',
  PLAN_CHANGE_INTENTS: 'subscriptionPlanChangeIntents',
  WORKSPACES: 'workspaces'
});
const SUBSCRIPTION_STATUS = Object.freeze({
  TRIALING: 'trialing',
  ACTIVE: 'active',
  PAST_DUE: 'past_due',
  CANCELED: 'canceled',
  INTERNAL: 'internal',
  NONE: 'none'
});
const SUBSCRIPTION_SOURCE = Object.freeze({
  INTERNAL: 'internal',
  TEST_FIXTURE: 'test_fixture',
  BILLING_PROVIDER: 'billing_provider'
});
const LEGACY_PLAN_ID = 'legacy_full_access';

class SubscriptionError extends Error {
  constructor(message, { code = 'subscription_error', status = 400 } = {}) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.status = status;
  }
}

function cleanRequiredId(value, fieldName) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > 256) {
    throw new SubscriptionError(`${fieldName} is required.`, {
      code: `invalid_${fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      status: 400
    });
  }
  return clean;
}

function digest(parts, length = 40) {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, length);
}

function subscriptionDocumentId(workspaceId) {
  return `subscription-${digest([cleanRequiredId(workspaceId, 'workspaceId')])}`;
}

function planChangeIntentDocumentId(workspaceId, idempotencyKey) {
  return `plan-change-${digest([
    cleanRequiredId(workspaceId, 'workspaceId'),
    cleanRequiredId(idempotencyKey, 'idempotencyKey')
  ])}`;
}

function safeIsoTimestamp(value) {
  if (value === null || value === undefined) return null;
  let date = value;
  if (value && typeof value.toDate === 'function') date = value.toDate();
  else if (value && typeof value.toMillis === 'function') date = new Date(value.toMillis());
  else if (!(value instanceof Date)) date = new Date(value);
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function calendarUtcCycle(now = new Date()) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (!Number.isFinite(date.getTime())) {
    throw new SubscriptionError('Subscription clock is invalid.', {
      code: 'subscription_clock_invalid',
      status: 503
    });
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return Object.freeze({
    usageCycleId: `${year}-${String(month + 1).padStart(2, '0')}`,
    start: start.toISOString(),
    end: end.toISOString(),
    startDate: start,
    endDate: end
  });
}

function explicitPeriodUsageCycle(startValue, endValue) {
  const start = safeIsoTimestamp(startValue);
  const end = safeIsoTimestamp(endValue);
  if (!start || !end || Date.parse(start) >= Date.parse(end)) {
    throw new SubscriptionError('Subscription usage period could not be verified.', {
      code: 'subscription_period_invalid',
      status: 503
    });
  }
  return Object.freeze({
    usageCycleId: `period-${digest([start, end])}`,
    start,
    end
  });
}

function buildLegacySubscriptionRecord({ workspaceId, now = new Date(), toTimestamp = (date) => date } = {}) {
  const cleanWorkspaceId = cleanRequiredId(workspaceId, 'workspaceId');
  const cycle = calendarUtcCycle(now);
  const timestamp = toTimestamp(now instanceof Date ? now : new Date(now));
  return {
    subscriptionId: subscriptionDocumentId(cleanWorkspaceId),
    workspaceId: cleanWorkspaceId,
    planId: LEGACY_PLAN_ID,
    status: SUBSCRIPTION_STATUS.INTERNAL,
    source: SUBSCRIPTION_SOURCE.INTERNAL,
    currentPeriodStart: toTimestamp(cycle.startDate),
    currentPeriodEnd: toTimestamp(cycle.endDate),
    cancelAtPeriodEnd: false,
    entitlementOverrides: {},
    externalCustomerId: null,
    externalSubscriptionId: null,
    billingProvider: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    schemaVersion: SCHEMA_VERSION
  };
}

function normalizeSubscriptionRecord(data, documentId) {
  const record = data || {};
  const workspaceId = String(record.workspaceId || '').trim();
  const expectedId = workspaceId ? subscriptionDocumentId(workspaceId) : '';
  if (
    !workspaceId
    || documentId !== expectedId
    || String(record.subscriptionId || '') !== expectedId
    || !Object.values(SUBSCRIPTION_STATUS).includes(record.status)
    || !Object.values(SUBSCRIPTION_SOURCE).includes(record.source)
  ) {
    throw new SubscriptionError('Subscription state could not be verified.', {
      code: 'subscription_state_invalid',
      status: 503
    });
  }
  const overrides = record.entitlementOverrides;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new SubscriptionError('Subscription overrides could not be verified.', {
      code: 'subscription_state_invalid',
      status: 503
    });
  }
  return Object.freeze({
    subscriptionId: expectedId,
    workspaceId,
    planId: String(record.planId || '').trim() || null,
    status: record.status,
    source: record.source,
    currentPeriodStart: safeIsoTimestamp(record.currentPeriodStart),
    currentPeriodEnd: safeIsoTimestamp(record.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean(record.cancelAtPeriodEnd),
    entitlementOverrides: Object.freeze({ ...overrides }),
    externalCustomerId: record.externalCustomerId === null
      ? null
      : (String(record.externalCustomerId || '').trim() || null),
    externalSubscriptionId: record.externalSubscriptionId === null
      ? null
      : (String(record.externalSubscriptionId || '').trim() || null),
    billingProvider: record.billingProvider === null
      ? null
      : (String(record.billingProvider || '').trim() || null),
    createdAt: safeIsoTimestamp(record.createdAt),
    updatedAt: safeIsoTimestamp(record.updatedAt),
    schemaVersion: Number(record.schemaVersion || 0)
  });
}

function noneSubscription(workspaceId) {
  return Object.freeze({
    subscriptionId: subscriptionDocumentId(workspaceId),
    workspaceId,
    planId: null,
    status: SUBSCRIPTION_STATUS.NONE,
    source: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    entitlementOverrides: Object.freeze({}),
    externalCustomerId: null,
    externalSubscriptionId: null,
    billingProvider: null,
    createdAt: null,
    updatedAt: null,
    schemaVersion: SCHEMA_VERSION
  });
}

function toPublicSubscription(subscription) {
  if (!subscription) return null;
  return Object.freeze({
    workspaceId: subscription.workspaceId,
    planId: subscription.planId,
    status: subscription.status,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: Boolean(subscription.cancelAtPeriodEnd)
  });
}

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stableObject(value[key]);
    return result;
  }, {});
}

function requestFingerprint(value) {
  return digest([JSON.stringify(stableObject(value))], 64);
}

function createSubscriptionService(dependencies = {}) {
  let defaultFirestore = null;
  let defaultCatalog = null;

  function runtime() {
    let db = dependencies.db;
    let Timestamp = dependencies.Timestamp;
    if (!db || !Timestamp) {
      defaultFirestore ||= require('./firestore');
      db ||= defaultFirestore.getFirestore();
      Timestamp ||= defaultFirestore.Timestamp;
    }
    return { db, Timestamp };
  }

  function catalog() {
    defaultCatalog ||= dependencies.planCatalog || require('./planCatalog');
    return defaultCatalog;
  }

  function clockDate() {
    const clock = dependencies.clock;
    const value = typeof clock === 'function'
      ? clock()
      : (clock && typeof clock.now === 'function' ? clock.now() : Date.now());
    const date = value && typeof value.toDate === 'function'
      ? value.toDate()
      : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new SubscriptionError('Subscription clock is invalid.', {
        code: 'subscription_clock_invalid',
        status: 503
      });
    }
    return date;
  }

  function toTimestamp(date, Timestamp) {
    if (Timestamp && typeof Timestamp.fromDate === 'function') return Timestamp.fromDate(date);
    if (Timestamp && typeof Timestamp.fromMillis === 'function') return Timestamp.fromMillis(date.getTime());
    return date;
  }

  function createInTransaction(transaction, ref, data) {
    if (typeof transaction.create === 'function') return transaction.create(ref, data);
    return transaction.set(ref, data);
  }

  function isVerifiedLegacyWorkspace(workspace) {
    if (!workspace || !workspace.workspaceId || !workspace.ownerUserId) return false;
    const { defaultWorkspaceId } = require('./workspaceService');
    return workspace.workspaceId === defaultWorkspaceId(workspace.ownerUserId)
      && workspace.metadata
      && workspace.metadata.compatibility === 'legacy_default';
  }

  function resolveCatalogPlan(planId, overrides) {
    const planCatalog = catalog();
    try {
      if (typeof planCatalog.resolvePlanEntitlements === 'function') {
        return planCatalog.resolvePlanEntitlements(planId, overrides);
      }
      const plan = typeof planCatalog.getPlan === 'function' ? planCatalog.getPlan(planId) : null;
      if (!plan) return null;
      const entitlements = typeof planCatalog.applyEntitlementOverrides === 'function'
        ? planCatalog.applyEntitlementOverrides(plan.entitlements, overrides)
        : null;
      return entitlements ? { plan, entitlements } : null;
    } catch (error) {
      throw new SubscriptionError('Subscription overrides could not be verified.', {
        code: 'subscription_overrides_invalid',
        status: 503
      });
    }
  }

  function workspaceInput(input) {
    const workspace = input && input.workspace ? input.workspace : input;
    if (!workspace || typeof workspace !== 'object') {
      throw new SubscriptionError('A verified workspace is required.', {
        code: 'workspace_required',
        status: 400
      });
    }
    return workspace;
  }

  async function resolveSubscription(input) {
    const workspace = workspaceInput(input);
    const workspaceId = cleanRequiredId(workspace.workspaceId, 'workspaceId');
    const { db, Timestamp } = runtime();
    const now = clockDate();
    const cycle = calendarUtcCycle(now);
    const subscriptionId = subscriptionDocumentId(workspaceId);
    const ref = db.collection(COLLECTIONS.SUBSCRIPTIONS).doc(subscriptionId);

    const raw = await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      if (!snapshot.exists) {
        if (!isVerifiedLegacyWorkspace(workspace)) return null;
        const record = buildLegacySubscriptionRecord({
          workspaceId,
          now,
          toTimestamp: (date) => toTimestamp(date, Timestamp)
        });
        createInTransaction(transaction, ref, record);
        return record;
      }

      const record = snapshot.data() || {};
      if (String(record.workspaceId || '') !== workspaceId) {
        throw new SubscriptionError('Subscription state could not be verified.', {
          code: 'subscription_state_invalid',
          status: 503
        });
      }

      if (
        record.source === SUBSCRIPTION_SOURCE.INTERNAL
        && (
          safeIsoTimestamp(record.currentPeriodStart) !== cycle.start
          || safeIsoTimestamp(record.currentPeriodEnd) !== cycle.end
        )
      ) {
        const patch = {
          currentPeriodStart: toTimestamp(cycle.startDate, Timestamp),
          currentPeriodEnd: toTimestamp(cycle.endDate, Timestamp),
          updatedAt: toTimestamp(now, Timestamp)
        };
        transaction.update(ref, patch);
        return { ...record, ...patch };
      }
      return record;
    });

    if (!raw) {
      return Object.freeze({
        subscription: noneSubscription(workspaceId),
        plan: null,
        entitlements: null,
        cycle: Object.freeze({ usageCycleId: cycle.usageCycleId, start: cycle.start, end: cycle.end })
      });
    }

    const subscription = normalizeSubscriptionRecord(raw, subscriptionId);
    const resolved = subscription.planId
      ? resolveCatalogPlan(subscription.planId, subscription.entitlementOverrides)
      : null;
    if (!resolved) {
      throw new SubscriptionError('Subscription plan could not be verified.', {
        code: 'subscription_plan_invalid',
        status: 503
      });
    }
    const usageCycle = subscription.source === SUBSCRIPTION_SOURCE.INTERNAL
      ? Object.freeze({ usageCycleId: cycle.usageCycleId, start: cycle.start, end: cycle.end })
      : explicitPeriodUsageCycle(subscription.currentPeriodStart, subscription.currentPeriodEnd);
    return Object.freeze({
      subscription,
      plan: resolved.plan,
      entitlements: resolved.entitlements,
      cycle: usageCycle
    });
  }

  async function updateInternalSubscription(input = {}) {
    const workspaceId = cleanRequiredId(input.workspaceId, 'workspaceId');
    const planId = cleanRequiredId(input.planId, 'planId');
    const actorId = cleanRequiredId(input.actorId, 'actorId');
    const idempotencyKey = cleanRequiredId(input.idempotencyKey, 'idempotencyKey');
    const status = String(
      input.status === undefined || input.status === null || input.status === ''
        ? (planId === LEGACY_PLAN_ID ? SUBSCRIPTION_STATUS.INTERNAL : SUBSCRIPTION_STATUS.ACTIVE)
        : input.status
    ).trim();
    if (![
      SUBSCRIPTION_STATUS.TRIALING,
      SUBSCRIPTION_STATUS.ACTIVE,
      SUBSCRIPTION_STATUS.PAST_DUE,
      SUBSCRIPTION_STATUS.CANCELED,
      SUBSCRIPTION_STATUS.INTERNAL
    ].includes(status)) {
      throw new SubscriptionError('Unsupported subscription status.', {
        code: 'invalid_subscription_status',
        status: 400
      });
    }
    if (planId === LEGACY_PLAN_ID && status !== SUBSCRIPTION_STATUS.INTERNAL) {
      throw new SubscriptionError('Legacy access requires internal subscription status.', {
        code: 'legacy_subscription_status_invalid',
        status: 400
      });
    }
    const overrides = input.entitlementOverrides === undefined ? {} : input.entitlementOverrides;
    const resolvedPlan = resolveCatalogPlan(planId, overrides);
    if (!resolvedPlan) {
      throw new SubscriptionError('Unknown subscription plan.', {
        code: 'subscription_plan_invalid',
        status: 400
      });
    }
    const safeOverrides = Object.freeze({ ...overrides });
    const fingerprint = requestFingerprint({ planId, status, entitlementOverrides: safeOverrides });
    const { db, Timestamp } = runtime();
    const now = clockDate();
    const nowTimestamp = toTimestamp(now, Timestamp);
    const cycle = calendarUtcCycle(now);
    const workspaceRef = db.collection(COLLECTIONS.WORKSPACES).doc(workspaceId);
    const subscriptionId = subscriptionDocumentId(workspaceId);
    const subscriptionRef = db.collection(COLLECTIONS.SUBSCRIPTIONS).doc(subscriptionId);

    const result = await db.runTransaction(async (transaction) => {
      const workspaceSnapshot = await transaction.get(workspaceRef);
      const subscriptionSnapshot = await transaction.get(subscriptionRef);
      if (!workspaceSnapshot.exists) {
        throw new SubscriptionError('Workspace not found.', {
          code: 'workspace_not_found',
          status: 404
        });
      }
      const workspace = workspaceSnapshot.data() || {};
      if (String(workspace.workspaceId || '') !== workspaceId) {
        throw new SubscriptionError('Workspace state could not be verified.', {
          code: 'workspace_state_invalid',
          status: 503
        });
      }
      if (planId === LEGACY_PLAN_ID && !isVerifiedLegacyWorkspace(workspace)) {
        throw new SubscriptionError('Legacy access cannot be assigned to this workspace.', {
          code: 'legacy_plan_not_allowed',
          status: 403
        });
      }

      const previous = subscriptionSnapshot.exists ? (subscriptionSnapshot.data() || {}) : null;
      if (previous && previous.source === SUBSCRIPTION_SOURCE.BILLING_PROVIDER) {
        throw new SubscriptionError('Billing-managed subscriptions cannot be changed internally.', {
          code: 'billing_subscription_managed_externally',
          status: 409
        });
      }
      if (previous && previous.lastInternalUpdateIdempotencyKey === idempotencyKey) {
        if (previous.lastInternalUpdateFingerprint !== fingerprint) {
          throw new SubscriptionError('Idempotency key was already used for a different subscription update.', {
            code: 'idempotency_conflict',
            status: 409
          });
        }
        return { record: previous, duplicate: true };
      }

      const record = {
        subscriptionId,
        workspaceId,
        planId,
        status,
        source: SUBSCRIPTION_SOURCE.INTERNAL,
        currentPeriodStart: toTimestamp(cycle.startDate, Timestamp),
        currentPeriodEnd: toTimestamp(cycle.endDate, Timestamp),
        cancelAtPeriodEnd: Boolean(input.cancelAtPeriodEnd),
        entitlementOverrides: { ...safeOverrides },
        externalCustomerId: null,
        externalSubscriptionId: null,
        billingProvider: null,
        createdAt: previous && previous.createdAt ? previous.createdAt : nowTimestamp,
        updatedAt: nowTimestamp,
        schemaVersion: SCHEMA_VERSION,
        lastInternalUpdateIdempotencyKey: idempotencyKey,
        lastInternalUpdateFingerprint: fingerprint,
        lastInternalUpdateActorId: actorId,
        lastInternalUpdateReason: String(input.reason || '').trim().slice(0, 240) || null
      };
      transaction.set(subscriptionRef, record);
      return { record, duplicate: false };
    });

    return Object.freeze({
      subscription: normalizeSubscriptionRecord(result.record, subscriptionId),
      plan: resolvedPlan.plan,
      entitlements: resolvedPlan.entitlements,
      duplicate: result.duplicate
    });
  }

  async function recordPlanChangeIntent(input = {}) {
    const workspaceId = cleanRequiredId(input.workspaceId, 'workspaceId');
    const targetPlanId = cleanRequiredId(input.targetPlanId || input.planId, 'planId');
    const requestedBy = cleanRequiredId(input.requestedBy || input.actorId, 'actorId');
    const idempotencyKey = cleanRequiredId(input.idempotencyKey, 'idempotencyKey');
    const planCatalog = catalog();
    const targetPlan = typeof planCatalog.getPlan === 'function' ? planCatalog.getPlan(targetPlanId) : null;
    if (!targetPlan || targetPlan.internalOnly === true || targetPlanId === LEGACY_PLAN_ID) {
      throw new SubscriptionError('Plan change target must be a public plan.', {
        code: 'plan_change_not_available',
        status: 400
      });
    }

    const intentId = planChangeIntentDocumentId(workspaceId, idempotencyKey);
    const fingerprint = requestFingerprint({ workspaceId, targetPlanId, requestedBy });
    const { db, Timestamp } = runtime();
    const nowTimestamp = toTimestamp(clockDate(), Timestamp);
    const workspaceRef = db.collection(COLLECTIONS.WORKSPACES).doc(workspaceId);
    const subscriptionRef = db.collection(COLLECTIONS.SUBSCRIPTIONS)
      .doc(subscriptionDocumentId(workspaceId));
    const intentRef = db.collection(COLLECTIONS.PLAN_CHANGE_INTENTS).doc(intentId);

    const result = await db.runTransaction(async (transaction) => {
      const workspaceSnapshot = await transaction.get(workspaceRef);
      const subscriptionSnapshot = await transaction.get(subscriptionRef);
      const intentSnapshot = await transaction.get(intentRef);
      if (!workspaceSnapshot.exists || String((workspaceSnapshot.data() || {}).workspaceId || '') !== workspaceId) {
        throw new SubscriptionError('Workspace not found.', {
          code: 'workspace_not_found',
          status: 404
        });
      }
      if (intentSnapshot.exists) {
        const previous = intentSnapshot.data() || {};
        if (previous.requestFingerprint !== fingerprint) {
          throw new SubscriptionError('Idempotency key was already used for a different plan change.', {
            code: 'idempotency_conflict',
            status: 409
          });
        }
        return { intent: previous, duplicate: true };
      }

      const previousSubscription = subscriptionSnapshot.exists ? (subscriptionSnapshot.data() || {}) : {};
      const intent = {
        planChangeIntentId: intentId,
        workspaceId,
        currentPlanId: String(previousSubscription.planId || '').trim() || null,
        targetPlanId,
        status: 'recorded',
        source: SUBSCRIPTION_SOURCE.INTERNAL,
        requestedBy,
        reason: String(input.reason || '').trim().slice(0, 240) || null,
        idempotencyKey,
        requestFingerprint: fingerprint,
        billingProvider: null,
        externalPriceId: null,
        createdAt: nowTimestamp,
        updatedAt: nowTimestamp,
        schemaVersion: SCHEMA_VERSION
      };
      createInTransaction(transaction, intentRef, intent);
      return { intent, duplicate: false };
    });

    const intent = result.intent;
    return Object.freeze({
      intent: Object.freeze({
        planChangeIntentId: intent.planChangeIntentId,
        workspaceId: intent.workspaceId,
        currentPlanId: intent.currentPlanId,
        targetPlanId: intent.targetPlanId,
        status: intent.status,
        requestedBy: intent.requestedBy,
        reason: intent.reason,
        createdAt: safeIsoTimestamp(intent.createdAt),
        updatedAt: safeIsoTimestamp(intent.updatedAt),
        schemaVersion: Number(intent.schemaVersion || 0)
      }),
      duplicate: result.duplicate
    });
  }

  return Object.freeze({ resolveSubscription, updateInternalSubscription, recordPlanChangeIntent });
}

let defaultService = null;
function defaultOperation(name) {
  return (...args) => {
    defaultService ||= createSubscriptionService();
    return defaultService[name](...args);
  };
}

module.exports = {
  SCHEMA_VERSION,
  COLLECTIONS,
  SUBSCRIPTION_STATUS,
  SUBSCRIPTION_SOURCE,
  LEGACY_PLAN_ID,
  SubscriptionError,
  subscriptionDocumentId,
  planChangeIntentDocumentId,
  calendarUtcCycle,
  explicitPeriodUsageCycle,
  buildLegacySubscriptionRecord,
  normalizeSubscriptionRecord,
  toPublicSubscription,
  createSubscriptionService,
  resolveSubscription: defaultOperation('resolveSubscription'),
  updateInternalSubscription: defaultOperation('updateInternalSubscription'),
  recordPlanChangeIntent: defaultOperation('recordPlanChangeIntent'),
  _private: Object.freeze({ safeIsoTimestamp, requestFingerprint, noneSubscription })
};
