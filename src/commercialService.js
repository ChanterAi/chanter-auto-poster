'use strict';

// One server-side commercial truth projection. Website, Runtime, and future
// controlled adapters resolve workspaces/plans/usage here; callers never send
// authoritative plan or entitlement fields.

const storage = require('./storage');
const config = require('./config');
const workspaceService = require('./workspaceService');
const subscriptionService = require('./subscriptionService');
const planCatalog = require('./planCatalog');
const entitlementResolver = require('./entitlementResolver');
const providers = require('./providers');
const { getFirestore } = require('./firestore');
const {
  USAGE_METRIC_SCHEDULED_POSTS,
  createUsageService
} = require('./usageService');

// Failed items remain operator-retryable in the existing workflow, so their
// reservation and active-queue slot stay held until deletion releases them.
const ACTIVE_QUEUE_STATUSES = new Set(['pending', 'scheduled', 'processing', 'ready', 'failed']);
const IMPLEMENTED_PROVIDER_IDS = Object.freeze([
  providers.PROVIDER_TIKTOK,
  providers.PROVIDER_YOUTUBE
]);

class CommercialServiceError extends Error {
  constructor(message, { code = 'commercial_truth_unverified', status = 503, details = {} } = {}) {
    super(message);
    this.name = 'CommercialServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function workspaceScopeFor(workspace) {
  const workspaceId = String((workspace && workspace.workspaceId) || '').trim();
  const ownerUserId = String((workspace && workspace.ownerUserId) || '').trim();
  const verifiedLegacyDefault = Boolean(
    workspaceId
    && ownerUserId
    && workspaceId === workspaceService.defaultWorkspaceId(ownerUserId)
  );
  return Object.freeze({
    workspaceId,
    allowLegacyOwnerRecords: Boolean(
      verifiedLegacyDefault
      && workspace
      && workspace.metadata
      && workspace.metadata.compatibility === 'legacy_default'
    )
  });
}

function usageCycleForMetering(cycle) {
  return {
    usageCycleId: String((cycle && cycle.usageCycleId) || '').trim(),
    startAt: cycle && cycle.start,
    endAt: cycle && cycle.end
  };
}

function publicPlanView(plan) {
  if (!plan) return null;
  return Object.freeze({
    id: plan.id,
    displayName: plan.displayName,
    internalOnly: Boolean(plan.internalOnly)
  });
}

function metricView(used, limit) {
  const safeUsed = Number.isSafeInteger(used) && used >= 0 ? used : 0;
  return Object.freeze({
    used: safeUsed,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - safeUsed)
  });
}

function createCommercialService(dependencies = {}) {
  const storageAdapter = dependencies.storage || storage;
  const workspaceAdapter = dependencies.workspaceService || workspaceService;
  const subscriptionAdapter = dependencies.subscriptionService || subscriptionService;
  const entitlementAdapter = dependencies.entitlementResolver || entitlementResolver;
  const catalog = dependencies.planCatalog || planCatalog;
  const now = dependencies.now || (() => new Date());
  let usageAdapter = dependencies.usageService || null;

  function getUsageAdapter() {
    usageAdapter ||= createUsageService({
      db: (dependencies.getFirestore || getFirestore)(),
      clock: { now: () => new Date(now()) }
    });
    return usageAdapter;
  }

  async function resolveContext(input = {}) {
    const userId = String(input.userId || '').trim();
    if (!userId) {
      throw new CommercialServiceError('An authenticated workspace owner is required.', {
        code: 'unauthorized',
        status: 401
      });
    }

    const resolvedWorkspace = await workspaceAdapter.resolveActiveWorkspace({
      userId,
      requestedWorkspaceId: String(input.workspaceId || input.requestedWorkspaceId || '').trim(),
      legacyEligible: typeof dependencies.isLegacyUser === 'function'
        ? Boolean(await dependencies.isLegacyUser(userId))
        : userId === config.defaultUserId
    });
    const workspace = resolvedWorkspace.workspace;
    const membership = resolvedWorkspace.membership;
    const scope = workspaceScopeFor(workspace);
    const resolvedSubscription = await subscriptionAdapter.resolveSubscription({ workspace });
    const subscription = resolvedSubscription.subscription;
    const plan = resolvedSubscription.plan;
    const entitlements = resolvedSubscription.entitlements;
    const cycle = resolvedSubscription.cycle;

    if (!plan || !entitlements || !cycle) {
      return Object.freeze({
        userId,
        workspace,
        membership,
        workspaceScope: scope,
        subscription,
        plan: null,
        entitlements: null,
        cycle,
        usage: null,
        accounts: Object.freeze([]),
        posts: Object.freeze([]),
        activeProviderIds: Object.freeze([]),
        connectedAccountCount: 0,
        activeQueueCount: 0
      });
    }

    const [tiktokAccounts, youtubeAccounts, posts, usage] = await Promise.all([
      storageAdapter.getTikTokAccounts(userId, scope),
      typeof storageAdapter.getYouTubeAccounts === 'function'
        ? storageAdapter.getYouTubeAccounts(userId, scope)
        : [],
      storageAdapter.getPosts(userId, undefined, scope),
      getUsageAdapter().getUsageSnapshot({
        workspaceId: workspace.workspaceId,
        metric: USAGE_METRIC_SCHEDULED_POSTS,
        usageCycle: usageCycleForMetering(cycle),
        limits: {
          scheduledPostsPerCycle: entitlements.scheduledPostsPerCycle,
          activeQueueLimit: entitlements.activeQueueLimit
        }
      })
    ]);

    const accounts = [...(tiktokAccounts || []), ...(youtubeAccounts || [])]
      .filter((account) => account && account.connected);
    const activeProviderIds = [...new Set(accounts
      .map((account) => String(account.provider || account.platform || 'tiktok').trim().toLowerCase())
      .filter(Boolean))];
    const activeQueueCount = (posts || []).filter((post) => ACTIVE_QUEUE_STATUSES.has(post.status)).length;

    return Object.freeze({
      userId,
      workspace,
      membership,
      workspaceScope: scope,
      subscription,
      plan,
      entitlements,
      cycle,
      usage,
      accounts: Object.freeze(accounts),
      posts: Object.freeze(posts || []),
      activeProviderIds: Object.freeze(activeProviderIds),
      connectedAccountCount: accounts.length,
      // Keep the counter authoritative for concurrency while failing closed
      // against any safely observed legacy queue items during transition.
      activeQueueCount: Math.max(activeQueueCount, Number(usage.activeQueue || 0))
    });
  }

  function evaluate(context, input) {
    return entitlementAdapter.evaluateEntitlement({
      ...input,
      workspace: context.workspace,
      subscription: context.subscription,
      implementedProviderIds: IMPLEMENTED_PROVIDER_IDS,
      activeProviderIds: context.activeProviderIds,
      connectedAccountCount: context.connectedAccountCount,
      scheduledPostsCurrent: context.usage ? context.usage.used : undefined,
      activeQueueCount: context.activeQueueCount,
      evaluationTimestamp: new Date(now()).toISOString()
    });
  }

  async function authorizeSchedule(input = {}) {
    const context = input.resolvedContext || await resolveContext(input);
    const quantity = Number(input.quantity || 1);
    const action = quantity > 1
      ? entitlementResolver.ENTITLEMENT_ACTIONS.SCHEDULE_BATCH
      : entitlementResolver.ENTITLEMENT_ACTIONS.SCHEDULE_POST;
    const decision = evaluate(context, {
      action,
      providerId: input.providerId,
      source: input.source,
      batchSize: quantity,
      quantity,
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {})
    });
    return Object.freeze({ context, decision });
  }

  async function authorizeAccountConnection(input = {}) {
    const context = input.resolvedContext || await resolveContext(input);
    const providerId = String(input.providerId || '').trim().toLowerCase();
    const accountId = String(input.accountId || '').trim();
    const existing = context.accounts.some((account) => (
      String(account.accountId || '') === accountId
      && String(account.provider || account.platform || 'tiktok').toLowerCase() === providerId
    ));
    const decision = evaluate(context, {
      action: existing
        ? entitlementResolver.ENTITLEMENT_ACTIONS.ENABLE_PROVIDER
        : entitlementResolver.ENTITLEMENT_ACTIONS.CONNECT_ACCOUNT,
      providerId
    });
    return Object.freeze({ context, decision, existing });
  }

  function safeView(context) {
    if (!context || !context.workspace || !context.plan || !context.entitlements || !context.usage) {
      return Object.freeze({
        available: false,
        reason: 'Plan and usage truth is unavailable. Commercial write actions are blocked.'
      });
    }
    const e = context.entitlements;
    return Object.freeze({
      available: true,
      workspace: Object.freeze({
        workspaceId: context.workspace.workspaceId,
        displayName: context.workspace.displayName,
        status: context.workspace.status
      }),
      plan: publicPlanView(context.plan),
      subscriptionStatus: context.subscription.status,
      cycle: Object.freeze({ start: context.cycle.start, end: context.cycle.end }),
      usage: Object.freeze({
        scheduledPosts: metricView(context.usage.used, e.scheduledPostsPerCycle),
        connectedAccounts: metricView(context.connectedAccountCount, e.connectedAccountLimit),
        activeProviders: metricView(context.activeProviderIds.length, e.providerLimit),
        activeQueue: metricView(context.activeQueueCount, e.activeQueueLimit)
      }),
      schedulingHorizonDays: e.schedulingHorizonDays,
      runtimeScheduling: Boolean(e.runtimeScheduling),
      advancedEvidence: Boolean(e.advancedEvidence),
      publicPlans: Object.freeze(catalog.listPublicPlans()),
      billing: Object.freeze({
        configured: false,
        message: 'Billing activation not yet available'
      })
    });
  }

  async function getPlanUsage(input = {}) {
    const context = input.resolvedContext || await resolveContext(input);
    return Object.freeze({ context, view: safeView(context) });
  }

  return Object.freeze({
    resolveContext,
    authorizeSchedule,
    authorizeAccountConnection,
    getPlanUsage,
    safeView,
    evaluate
  });
}

let defaultService = null;
function defaultOperation(name) {
  return (...args) => {
    defaultService ||= createCommercialService();
    return defaultService[name](...args);
  };
}

module.exports = {
  ACTIVE_QUEUE_STATUSES,
  IMPLEMENTED_PROVIDER_IDS,
  CommercialServiceError,
  workspaceScopeFor,
  usageCycleForMetering,
  createCommercialService,
  resolveContext: defaultOperation('resolveContext'),
  authorizeSchedule: defaultOperation('authorizeSchedule'),
  authorizeAccountConnection: defaultOperation('authorizeAccountConnection'),
  getPlanUsage: defaultOperation('getPlanUsage'),
  safeView: defaultOperation('safeView')
};
