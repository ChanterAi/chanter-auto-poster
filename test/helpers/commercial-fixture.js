'use strict';

const { defaultWorkspaceId } = require('../../src/workspaceService');
const { getPlan, listPublicPlans } = require('../../src/planCatalog');

function cycle(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    usageCycleId: `calendar-${year}-${String(month + 1).padStart(2, '0')}`,
    start: new Date(Date.UTC(year, month, 1)).toISOString(),
    end: new Date(Date.UTC(year, month + 1, 1)).toISOString()
  };
}

function createCommercialFixture(storage, options = {}) {
  const plan = getPlan(options.planId || 'legacy_full_access');

  async function resolveContext(input = {}) {
    const userId = String(input.userId || 'owner');
    const workspaceId = String(input.workspaceId || defaultWorkspaceId(userId));
    const workspace = {
      workspaceId,
      displayName: options.displayName || 'CHANTER Workspace',
      ownerUserId: userId,
      status: 'active',
      metadata: { compatibility: 'legacy_default' },
      schemaVersion: 1
    };
    const workspaceScope = { workspaceId, allowLegacyOwnerRecords: true };
    // Existing route/application tests stub only the storage methods relevant
    // to their scenario. Keep this fixture hermetic: callers may provide
    // explicit commercial facts, but it never falls through to real
    // Firestore methods merely to build an unmetered compatibility context.
    const accounts = (Array.isArray(options.accounts) ? options.accounts : [])
      .filter((account) => account && account.connected !== false);
    const posts = Array.isArray(options.posts) ? options.posts : [];
    const activeProviderIds = [...new Set(accounts.map((account) => account.provider || account.platform || 'tiktok'))];
    const currentCycle = cycle(options.now ? new Date(options.now) : new Date());
    return {
      userId,
      workspace,
      membership: { workspaceId, userId, role: 'owner', status: 'active' },
      workspaceScope,
      subscription: {
        workspaceId,
        planId: plan.id,
        status: plan.internalOnly ? 'internal' : 'active',
        source: plan.internalOnly ? 'internal' : 'test',
        entitlementOverrides: null
      },
      plan,
      entitlements: plan.entitlements,
      cycle: currentCycle,
      usage: {
        used: 0,
        activeQueue: (posts || []).filter((post) => ['pending', 'scheduled', 'processing', 'ready', 'failed'].includes(post.status)).length
      },
      accounts,
      posts,
      activeProviderIds,
      connectedAccountCount: accounts.length,
      activeQueueCount: posts.filter((post) => ['pending', 'scheduled', 'processing', 'ready', 'failed'].includes(post.status)).length
    };
  }

  async function authorizeSchedule(input = {}) {
    return { context: input.resolvedContext || await resolveContext(input), decision: allowedDecision(input) };
  }

  async function authorizeAccountConnection(input = {}) {
    return {
      context: input.resolvedContext || await resolveContext(input),
      decision: allowedDecision(input),
      existing: false
    };
  }

  function safeView(context) {
    return {
      available: true,
      workspace: {
        workspaceId: context.workspace.workspaceId,
        displayName: context.workspace.displayName,
        status: 'active'
      },
      plan: { id: plan.id, displayName: plan.displayName, internalOnly: plan.internalOnly },
      subscriptionStatus: context.subscription.status,
      cycle: { start: context.cycle.start, end: context.cycle.end },
      usage: {
        scheduledPosts: { used: 0, remaining: null, limit: null },
        connectedAccounts: { used: context.connectedAccountCount, limit: plan.entitlements.connectedAccountLimit },
        activeProviders: { used: context.activeProviderIds.length, limit: plan.entitlements.providerLimit },
        activeQueue: { used: context.activeQueueCount, limit: plan.entitlements.activeQueueLimit }
      },
      schedulingHorizonDays: plan.entitlements.schedulingHorizonDays,
      runtimeScheduling: plan.entitlements.runtimeScheduling,
      advancedEvidence: plan.entitlements.advancedEvidence,
      publicPlans: listPublicPlans(),
      billing: { configured: false, message: 'Billing activation not yet available' }
    };
  }

  async function getPlanUsage(input = {}) {
    const context = input.resolvedContext || await resolveContext(input);
    return { context, view: safeView(context) };
  }

  return { resolveContext, authorizeSchedule, authorizeAccountConnection, safeView, getPlanUsage };
}

function allowedDecision(input = {}) {
  const context = input.resolvedContext || {};
  return {
    allowed: true,
    reasonCode: 'allowed',
    reason: 'Allowed by the current workspace plan.',
    limit: null,
    current: null,
    remaining: null,
    planId: context.plan ? context.plan.id : 'legacy_full_access',
    workspaceId: context.workspace ? context.workspace.workspaceId : null,
    evaluationTimestamp: new Date().toISOString()
  };
}

function installCommercialFixture(commercialService, storage, options) {
  const fixture = createCommercialFixture(storage, options);
  Object.assign(commercialService, fixture);
  return fixture;
}

module.exports = { createCommercialFixture, installCommercialFixture };
