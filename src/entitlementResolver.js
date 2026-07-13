'use strict';

const {
  PLAN_IDS,
  PlanCatalogError,
  resolvePlanEntitlements
} = require('./planCatalog');

const ENTITLEMENT_ACTIONS = Object.freeze({
  CONNECT_ACCOUNT: 'connect_account',
  ENABLE_PROVIDER: 'enable_provider',
  SCHEDULE_POST: 'schedule_post',
  SCHEDULE_BATCH: 'schedule_batch',
  CREATE_WORKSPACE: 'create_workspace',
  USE_RUNTIME_SCHEDULING: 'use_runtime_scheduling',
  USE_ADVANCED_EVIDENCE: 'use_advanced_evidence'
});

const REASON_CODES = Object.freeze({
  ALLOWED: 'allowed',
  WORKSPACE_INACTIVE: 'workspace_inactive',
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
  PLAN_NOT_FOUND: 'plan_not_found',
  ENTITLEMENT_CONFIGURATION_INVALID: 'entitlement_configuration_invalid',
  COMMERCIAL_TRUTH_UNVERIFIED: 'commercial_truth_unverified',
  FEATURE_NOT_AVAILABLE: 'feature_not_available',
  WORKSPACE_LIMIT_REACHED: 'workspace_limit_reached',
  PROVIDER_LIMIT_REACHED: 'provider_limit_reached',
  CONNECTED_ACCOUNT_LIMIT_REACHED: 'connected_account_limit_reached',
  MONTHLY_POST_LIMIT_REACHED: 'monthly_post_limit_reached',
  ACTIVE_QUEUE_LIMIT_REACHED: 'active_queue_limit_reached',
  BATCH_SIZE_LIMIT_EXCEEDED: 'batch_size_limit_exceeded',
  SCHEDULING_HORIZON_EXCEEDED: 'scheduling_horizon_exceeded',
  RUNTIME_SCHEDULING_NOT_ALLOWED: 'runtime_scheduling_not_allowed'
});

const ALLOWED_SUBSCRIPTION_STATUSES = new Set(['trialing', 'active', 'internal']);
const RUNTIME_SOURCES = new Set(['runtime', 'mcp', 'agent_runtime']);
const DAY_MS = 24 * 60 * 60 * 1000;

const SAFE_REASONS = Object.freeze({
  [REASON_CODES.ALLOWED]: 'Allowed by the current workspace plan.',
  [REASON_CODES.WORKSPACE_INACTIVE]: 'The active workspace is unavailable for this action.',
  [REASON_CODES.SUBSCRIPTION_INACTIVE]: 'The workspace subscription does not allow this action.',
  [REASON_CODES.PLAN_NOT_FOUND]: 'The workspace plan could not be verified.',
  [REASON_CODES.ENTITLEMENT_CONFIGURATION_INVALID]: 'The workspace entitlements could not be verified.',
  [REASON_CODES.COMMERCIAL_TRUTH_UNVERIFIED]: 'Current workspace usage could not be verified.',
  [REASON_CODES.FEATURE_NOT_AVAILABLE]: 'This capability is not available for the workspace.',
  [REASON_CODES.WORKSPACE_LIMIT_REACHED]: 'The current plan has reached its workspace limit.',
  [REASON_CODES.PROVIDER_LIMIT_REACHED]: 'The current plan has reached its active provider limit.',
  [REASON_CODES.CONNECTED_ACCOUNT_LIMIT_REACHED]: 'The current plan has reached its connected account limit.',
  [REASON_CODES.MONTHLY_POST_LIMIT_REACHED]: 'The current plan has reached its scheduled post limit for this usage cycle.',
  [REASON_CODES.ACTIVE_QUEUE_LIMIT_REACHED]: 'The current plan has reached its active queue limit.',
  [REASON_CODES.BATCH_SIZE_LIMIT_EXCEEDED]: 'This batch is larger than the current plan allows.',
  [REASON_CODES.SCHEDULING_HORIZON_EXCEEDED]: 'The schedule time is outside the current plan horizon.',
  [REASON_CODES.RUNTIME_SCHEDULING_NOT_ALLOWED]: 'Runtime scheduling is not available on the current plan.'
});

function normalizedId(value) {
  return String(value || '').trim();
}

function normalizeProviderId(value) {
  return normalizedId(value).toLowerCase();
}

function workspaceIdOf(workspace) {
  return normalizedId(workspace && (workspace.workspaceId || workspace.id));
}

function toEvaluationTimestamp(value) {
  const candidate = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  if (Number.isFinite(candidate)) return new Date(candidate).toISOString();
  return new Date().toISOString();
}

function remainingFor(limit, current) {
  if (limit === null || !Number.isFinite(limit) || !Number.isFinite(current)) return null;
  return Math.max(limit - current, 0);
}

function decision(context, {
  allowed,
  reasonCode,
  limit = null,
  current = null,
  remaining = remainingFor(limit, current)
}) {
  return Object.freeze({
    allowed: Boolean(allowed),
    reasonCode,
    reason: SAFE_REASONS[reasonCode] || SAFE_REASONS[REASON_CODES.FEATURE_NOT_AVAILABLE],
    limit,
    current,
    remaining,
    planId: context.planId || null,
    workspaceId: context.workspaceId || null,
    evaluationTimestamp: context.evaluationTimestamp
  });
}

function denied(context, reasonCode, values = {}) {
  return decision(context, { allowed: false, reasonCode, ...values });
}

function allowed(context, values = {}) {
  return decision(context, { allowed: true, reasonCode: REASON_CODES.ALLOWED, ...values });
}

function resolveEffectiveEntitlements(input = {}) {
  const evaluationTimestamp = toEvaluationTimestamp(
    input.evaluationTimestamp || input.now
  );
  const workspace = input.workspace;
  const workspaceId = workspaceIdOf(workspace);
  const baseContext = { workspaceId, planId: null, evaluationTimestamp };

  if (!workspaceId || normalizedId(workspace && workspace.status).toLowerCase() !== 'active') {
    return Object.freeze({
      resolved: false,
      decision: denied(baseContext, REASON_CODES.WORKSPACE_INACTIVE)
    });
  }

  const subscription = input.subscription;
  if (
    !subscription
    || normalizedId(subscription.workspaceId) !== workspaceId
    || !ALLOWED_SUBSCRIPTION_STATUSES.has(normalizedId(subscription.status).toLowerCase())
  ) {
    return Object.freeze({
      resolved: false,
      decision: denied(baseContext, REASON_CODES.SUBSCRIPTION_INACTIVE)
    });
  }

  const planId = normalizedId(subscription.planId).toLowerCase();
  const planContext = { ...baseContext, planId };
  let resolvedPlan;
  try {
    resolvedPlan = resolvePlanEntitlements(planId, subscription.entitlementOverrides);
  } catch (error) {
    if (!(error instanceof PlanCatalogError)) throw error;
    return Object.freeze({
      resolved: false,
      decision: denied(planContext, REASON_CODES.ENTITLEMENT_CONFIGURATION_INVALID)
    });
  }

  if (!resolvedPlan) {
    return Object.freeze({
      resolved: false,
      decision: denied(planContext, REASON_CODES.PLAN_NOT_FOUND)
    });
  }

  if (
    resolvedPlan.plan.id === PLAN_IDS.LEGACY_FULL_ACCESS
    && (
      normalizedId(subscription.status).toLowerCase() !== 'internal'
      || normalizedId(subscription.source).toLowerCase() !== 'internal'
    )
  ) {
    return Object.freeze({
      resolved: false,
      decision: denied(planContext, REASON_CODES.SUBSCRIPTION_INACTIVE)
    });
  }

  return Object.freeze({
    resolved: true,
    workspaceId,
    planId: resolvedPlan.plan.id,
    subscriptionStatus: normalizedId(subscription.status).toLowerCase(),
    plan: resolvedPlan.plan,
    entitlements: resolvedPlan.entitlements,
    evaluationTimestamp
  });
}

function contextFor(resolution) {
  return {
    workspaceId: resolution.workspaceId,
    planId: resolution.planId,
    evaluationTimestamp: resolution.evaluationTimestamp
  };
}

function readInput(input, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(input, name)) return input[name];
    if (input.usage && Object.prototype.hasOwnProperty.call(input.usage, name)) {
      return input.usage[name];
    }
  }
  return undefined;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function countOrDeny(input, names, context) {
  const value = readInput(input, names);
  if (!isCount(value)) {
    return { decision: denied(context, REASON_CODES.COMMERCIAL_TRUTH_UNVERIFIED) };
  }
  return { value };
}

function quantityOrDeny(input, names, defaultValue, context) {
  const raw = readInput(input, names);
  const value = raw === undefined ? defaultValue : raw;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { decision: denied(context, REASON_CODES.COMMERCIAL_TRUTH_UNVERIFIED) };
  }
  return { value };
}

function providerAvailabilityDecision(input, resolution) {
  const context = contextFor(resolution);
  const providerId = normalizeProviderId(input.providerId || input.provider);
  if (!providerId || !Array.isArray(input.implementedProviderIds)) {
    return denied(context, REASON_CODES.FEATURE_NOT_AVAILABLE);
  }

  const implementedProviders = new Set(
    input.implementedProviderIds.map(normalizeProviderId).filter(Boolean)
  );
  if (!implementedProviders.has(providerId)) {
    return denied(context, REASON_CODES.FEATURE_NOT_AVAILABLE);
  }
  return allowed(context);
}

function activeProviderFacts(input, providerId, context) {
  if (Array.isArray(input.activeProviderIds)) {
    const implemented = new Set(
      input.implementedProviderIds.map(normalizeProviderId).filter(Boolean)
    );
    const active = new Set(
      input.activeProviderIds
        .map(normalizeProviderId)
        .filter((activeProviderId) => implemented.has(activeProviderId))
    );
    return { current: active.size, alreadyActive: active.has(providerId) };
  }

  const count = readInput(input, ['activeProviderCount', 'providerCount']);
  if (!isCount(count) || typeof input.providerAlreadyActive !== 'boolean') {
    return { decision: denied(context, REASON_CODES.COMMERCIAL_TRUTH_UNVERIFIED) };
  }
  return { current: count, alreadyActive: input.providerAlreadyActive };
}

function evaluateProviderLimit(input, resolution) {
  const availability = providerAvailabilityDecision(input, resolution);
  if (!availability.allowed) return availability;

  const context = contextFor(resolution);
  const providerId = normalizeProviderId(input.providerId || input.provider);
  const limit = resolution.entitlements.providerLimit;
  if (limit === null) {
    const suppliedCount = readInput(input, ['activeProviderCount', 'providerCount']);
    const current = Array.isArray(input.activeProviderIds)
      ? new Set(
        input.activeProviderIds
          .map(normalizeProviderId)
          .filter((activeProviderId) => input.implementedProviderIds
            .map(normalizeProviderId)
            .includes(activeProviderId))
      ).size
      : (isCount(suppliedCount) ? suppliedCount : null);
    return allowed(context, { limit, current });
  }

  const facts = activeProviderFacts(input, providerId, context);
  if (facts.decision) return facts.decision;

  if (!facts.alreadyActive && facts.current >= limit) {
    return denied(context, REASON_CODES.PROVIDER_LIMIT_REACHED, {
      limit,
      current: facts.current
    });
  }
  return allowed(context, { limit, current: facts.current });
}

function evaluateConnectedAccountLimit(input, resolution) {
  const context = contextFor(resolution);
  const limit = resolution.entitlements.connectedAccountLimit;
  if (limit === null) {
    const suppliedCount = readInput(input, ['connectedAccountCount', 'connectedAccountsCurrent']);
    return allowed(context, { limit, current: isCount(suppliedCount) ? suppliedCount : null });
  }

  const count = countOrDeny(
    input,
    ['connectedAccountCount', 'connectedAccountsCurrent'],
    context
  );
  if (count.decision) return count.decision;

  if (count.value >= limit) {
    return denied(context, REASON_CODES.CONNECTED_ACCOUNT_LIMIT_REACHED, {
      limit,
      current: count.value
    });
  }
  return allowed(context, { limit, current: count.value });
}

function evaluateBatchSize(input, resolution) {
  const context = contextFor(resolution);
  const quantity = quantityOrDeny(input, ['batchSize', 'quantity'], undefined, context);
  if (quantity.decision) return quantity.decision;

  const limit = resolution.entitlements.batchSizeLimit;
  if (limit !== null && quantity.value > limit) {
    return denied(context, REASON_CODES.BATCH_SIZE_LIMIT_EXCEEDED, {
      limit,
      current: quantity.value,
      remaining: 0
    });
  }
  return allowed(context, {
    limit,
    current: quantity.value,
    remaining: limit === null ? null : Math.max(limit - quantity.value, 0)
  });
}

function evaluateSchedulingHorizon(input, resolution) {
  const context = contextFor(resolution);
  const scheduledMs = Date.parse(String(input.scheduledAt || ''));
  const evaluationMs = Date.parse(resolution.evaluationTimestamp);
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(evaluationMs)) {
    return denied(context, REASON_CODES.SCHEDULING_HORIZON_EXCEEDED);
  }

  const limit = resolution.entitlements.schedulingHorizonDays;
  const current = Math.max((scheduledMs - evaluationMs) / DAY_MS, 0);
  if (limit !== null && current > limit) {
    return denied(context, REASON_CODES.SCHEDULING_HORIZON_EXCEEDED, {
      limit,
      current,
      remaining: 0
    });
  }
  return allowed(context, {
    limit,
    current,
    remaining: limit === null ? null : Math.max(limit - current, 0)
  });
}

function evaluateScheduledPostLimit(input, resolution, quantity) {
  const context = contextFor(resolution);
  const limit = resolution.entitlements.scheduledPostsPerCycle;
  if (limit === null) {
    const suppliedCount = readInput(input, ['scheduledPostsCurrent', 'scheduledPostsUsed', 'scheduled_posts']);
    return allowed(context, { limit, current: isCount(suppliedCount) ? suppliedCount : null });
  }

  const count = countOrDeny(
    input,
    ['scheduledPostsCurrent', 'scheduledPostsUsed', 'scheduled_posts'],
    context
  );
  if (count.decision) return count.decision;

  if (count.value + quantity > limit) {
    return denied(context, REASON_CODES.MONTHLY_POST_LIMIT_REACHED, {
      limit,
      current: count.value
    });
  }
  return allowed(context, { limit, current: count.value });
}

function evaluateActiveQueueLimit(input, resolution, quantity) {
  const context = contextFor(resolution);
  const limit = resolution.entitlements.activeQueueLimit;
  if (limit === null) {
    const suppliedCount = readInput(input, ['activeQueueCount', 'activeQueueCurrent']);
    return allowed(context, { limit, current: isCount(suppliedCount) ? suppliedCount : null });
  }

  const count = countOrDeny(
    input,
    ['activeQueueCount', 'activeQueueCurrent'],
    context
  );
  if (count.decision) return count.decision;

  if (count.value + quantity > limit) {
    return denied(context, REASON_CODES.ACTIVE_QUEUE_LIMIT_REACHED, {
      limit,
      current: count.value
    });
  }
  return allowed(context, { limit, current: count.value });
}

function evaluateWorkspaceLimit(input, resolution) {
  const context = contextFor(resolution);
  const limit = resolution.entitlements.workspaceLimit;
  if (limit === null) {
    const suppliedCount = readInput(input, ['workspaceCount', 'workspacesCurrent']);
    return allowed(context, { limit, current: isCount(suppliedCount) ? suppliedCount : null });
  }

  const count = countOrDeny(input, ['workspaceCount', 'workspacesCurrent'], context);
  if (count.decision) return count.decision;

  if (count.value >= limit) {
    return denied(context, REASON_CODES.WORKSPACE_LIMIT_REACHED, {
      limit,
      current: count.value
    });
  }
  return allowed(context, { limit, current: count.value });
}

function evaluateRuntimeScheduling(resolution) {
  const context = contextFor(resolution);
  if (!resolution.entitlements.runtimeScheduling) {
    return denied(context, REASON_CODES.RUNTIME_SCHEDULING_NOT_ALLOWED);
  }
  return allowed(context);
}

function evaluateAdvancedEvidence(resolution) {
  const context = contextFor(resolution);
  if (!resolution.entitlements.advancedEvidence) {
    return denied(context, REASON_CODES.FEATURE_NOT_AVAILABLE);
  }
  return allowed(context);
}

function evaluateSchedule(input, resolution, { batch }) {
  if (RUNTIME_SOURCES.has(normalizedId(input.source).toLowerCase())) {
    const runtime = evaluateRuntimeScheduling(resolution);
    if (!runtime.allowed) return runtime;
  }

  const provider = providerAvailabilityDecision(input, resolution);
  if (!provider.allowed) return provider;

  let quantity = 1;
  if (batch) {
    const batchDecision = evaluateBatchSize(input, resolution);
    if (!batchDecision.allowed) return batchDecision;
    quantity = readInput(input, ['batchSize', 'quantity']);
  }

  if (Object.prototype.hasOwnProperty.call(input, 'scheduledAt')) {
    const horizon = evaluateSchedulingHorizon(input, resolution);
    if (!horizon.allowed) return horizon;
  }

  const monthly = evaluateScheduledPostLimit(input, resolution, quantity);
  if (!monthly.allowed) return monthly;

  const queue = evaluateActiveQueueLimit(input, resolution, quantity);
  if (!queue.allowed) return queue;

  return monthly;
}

function evaluateEntitlement(input = {}) {
  const resolution = resolveEffectiveEntitlements(input);
  if (!resolution.resolved) return resolution.decision;

  switch (normalizedId(input.action).toLowerCase()) {
    case ENTITLEMENT_ACTIONS.CONNECT_ACCOUNT: {
      const provider = evaluateProviderLimit(input, resolution);
      if (!provider.allowed) return provider;
      return evaluateConnectedAccountLimit(input, resolution);
    }
    case ENTITLEMENT_ACTIONS.ENABLE_PROVIDER:
      return evaluateProviderLimit(input, resolution);
    case ENTITLEMENT_ACTIONS.SCHEDULE_POST:
      return evaluateSchedule(input, resolution, { batch: false });
    case ENTITLEMENT_ACTIONS.SCHEDULE_BATCH:
      return evaluateSchedule(input, resolution, { batch: true });
    case ENTITLEMENT_ACTIONS.CREATE_WORKSPACE:
      return evaluateWorkspaceLimit(input, resolution);
    case ENTITLEMENT_ACTIONS.USE_RUNTIME_SCHEDULING:
      return evaluateRuntimeScheduling(resolution);
    case ENTITLEMENT_ACTIONS.USE_ADVANCED_EVIDENCE:
      return evaluateAdvancedEvidence(resolution);
    default:
      return denied(contextFor(resolution), REASON_CODES.FEATURE_NOT_AVAILABLE);
  }
}

module.exports = {
  ENTITLEMENT_ACTIONS,
  REASON_CODES,
  SAFE_REASONS,
  resolveEffectiveEntitlements,
  evaluateEntitlement
};
