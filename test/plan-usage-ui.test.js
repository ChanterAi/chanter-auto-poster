'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const ejsPath = path.join(root, 'src', 'views', 'index.ejs');
const dashboardPath = path.join(root, 'src', 'pages', 'AutoPosterDashboard.jsx');
const dashboardCssPath = path.join(root, 'src', 'pages', 'AutoPosterDashboard.css');

function planUsageTemplate() {
  const source = fs.readFileSync(ejsPath, 'utf8');
  const startMarker = '<!-- PLAN_USAGE_REGION_START -->';
  const endMarker = '<!-- PLAN_USAGE_REGION_END -->';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.ok(start >= 0 && end > start, 'Plan & Usage region markers must remain available for focused rendering');
  return source.slice(start, end + endMarker.length);
}

function publicPlan(id, displayName, entitlements) {
  return { id, displayName, entitlements };
}

function commercialFixture() {
  return {
    available: true,
    workspace: {
      workspaceId: 'workspace-legacy-safe',
      displayName: 'CHANTER Workspace',
      status: 'active'
    },
    plan: { id: 'legacy_full_access', displayName: 'Unexpected raw label', internalOnly: true },
    subscriptionStatus: 'internal',
    cycle: { start: '2026-07-01T00:00:00.000Z', end: '2026-08-01T00:00:00.000Z' },
    usage: {
      scheduledPosts: { used: 7, remaining: null, limit: null },
      connectedAccounts: { used: 2, limit: null },
      activeProviders: { used: 2, limit: null },
      activeQueue: { used: 4, limit: null }
    },
    schedulingHorizonDays: null,
    runtimeScheduling: true,
    advancedEvidence: true,
    publicPlans: [
      publicPlan('starter', 'Starter', {
        workspaceLimit: 1,
        scheduledPostsPerCycle: 30,
        connectedAccountLimit: 2,
        providerLimit: 1,
        activeQueueLimit: 20,
        batchSizeLimit: 5,
        schedulingHorizonDays: 7,
        runtimeScheduling: false,
        advancedEvidence: false
      }),
      publicPlan('creator', 'Creator', {
        workspaceLimit: 1,
        scheduledPostsPerCycle: 150,
        connectedAccountLimit: 5,
        providerLimit: 2,
        activeQueueLimit: 100,
        batchSizeLimit: 25,
        schedulingHorizonDays: 30,
        runtimeScheduling: true,
        advancedEvidence: true
      }),
      publicPlan('studio', 'Studio', {
        workspaceLimit: 3,
        scheduledPostsPerCycle: 1000,
        connectedAccountLimit: 20,
        providerLimit: 4,
        activeQueueLimit: 500,
        batchSizeLimit: 100,
        schedulingHorizonDays: 90,
        runtimeScheduling: true,
        advancedEvidence: true
      })
    ],
    billing: {
      configured: false,
      message: 'Billing activation not yet available',
      externalCustomerId: 'customer-secret-canary',
      externalSubscriptionId: 'subscription-secret-canary'
    },
    entitlementOverrides: { audit: 'override-secret-canary' }
  };
}

test('Plan & Usage renders legacy truth, usage, public catalog limits, and no fake commerce', () => {
  const html = ejs.render(planUsageTemplate(), { commercialView: commercialFixture() });

  assert.match(html, /data-plan-usage-region/);
  assert.match(html, /Plan &amp; Usage/);
  assert.match(html, /CHANTER Workspace/);
  assert.match(html, /Legacy Full Access/);
  assert.match(html, /Scheduled posts/);
  assert.match(html, />7 \/ Unlimited</);
  assert.match(html, /Connected accounts/);
  assert.match(html, /Active providers/);
  assert.match(html, /Active queue/);
  assert.match(html, /2026-07-01/);
  assert.match(html, /Runtime scheduling/);
  assert.match(html, /Compare Starter, Creator, and Studio/);
  assert.match(html, /Workspaces/);
  assert.match(html, /Batch size/);
  assert.match(html, /Advanced evidence/);
  assert.match(html, />Starter</);
  assert.match(html, />Creator</);
  assert.match(html, />Studio</);
  assert.match(html, /Billing activation not yet available/);

  assert.doesNotMatch(html, /checkout|buy now|purchase|upgrade|monthlyPrice|externalPriceId/i);
  assert.doesNotMatch(html, /customer-secret-canary|subscription-secret-canary|override-secret-canary/);
  assert.doesNotMatch(html, /[$€£]/);
});

test('Plan & Usage region remains inert and render-safe when commercial data is absent', () => {
  const html = ejs.render(planUsageTemplate(), {});
  assert.match(html, /data-plan-usage-region/);
  assert.doesNotMatch(html, /id="plan-usage-heading"/);
  assert.doesNotMatch(html, /Billing activation/);
});

test('queue refresh replaces Plan & Usage from the same authoritative HTML response', () => {
  const source = fs.readFileSync(ejsPath, 'utf8');
  assert.match(source, /nextDocument\.querySelector\('\[data-plan-usage-region\]'\)/);
  assert.match(source, /livePlanUsageRegion\.replaceWith\(nextPlanUsageRegion\)/);
  assert.match(source, /currentPlanUsageRegion\?\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(source, /querySelector\('\[data-plan-usage-region\]'\)\?\.removeAttribute\('aria-busy'\)/);
});

test('Command Center consumes only the safe commercial payload in a compact header summary', () => {
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  const css = fs.readFileSync(dashboardCssPath, 'utf8');
  const intake = fs.readFileSync(ejsPath, 'utf8');

  assert.match(dashboard, /commercial: payload\.commercial && typeof payload\.commercial === 'object'/);
  assert.match(dashboard, /function PlanUsageHeader/);
  assert.match(dashboard, /data-plan-usage-summary/);
  assert.match(dashboard, /advancedEvidence=\{data\.commercial\?\.advancedEvidence === true\}/);
  assert.match(dashboard, /\{advancedEvidence && \(/);
  assert.match(dashboard, /Legacy Full Access/);
  assert.match(dashboard, /<dt>Scheduled<\/dt>/);
  assert.match(dashboard, /<dt>Accounts<\/dt>/);
  assert.match(dashboard, /<dt>Providers<\/dt>/);
  assert.match(dashboard, /<dt>Queue<\/dt>/);
  assert.doesNotMatch(dashboard, /externalCustomerId|externalSubscriptionId|externalPriceId|checkout|buy now|purchase/i);
  assert.match(css, /\.plan-usage-summary/);
  assert.match(css, /\.plan-summary-metrics/);
  assert.match(intake, /advancedEvidenceEnabled && result\.hasDebug/);
});

test('provider filters and YouTube Uploaded Private truth remain intact', () => {
  const dashboard = fs.readFileSync(dashboardPath, 'utf8');
  const intake = fs.readFileSync(ejsPath, 'utf8');
  assert.match(dashboard, /uploaded_private: 'Uploaded Private'/);
  assert.match(dashboard, /dashboardProviderOptions/);
  assert.match(dashboard, /All providers/);
  assert.match(intake, /YouTube · Private/);
  assert.match(intake, /displayResultLabel/);
});
