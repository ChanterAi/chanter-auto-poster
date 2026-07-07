'use strict';

// AutoPoster Runtime Adapter (P1A).
//
// Maps existing AutoPoster concepts — campaigns, scheduled/queued jobs,
// post-now requests, cron ticks, publish attempts/results, account
// selection, media/caption payloads — into runtime-style tasks that
// mirror the chanter-agent-runtime P1 task contract closely enough for a
// future package-link loop to replace this local compatibility layer.
//
// This module is pure: every mapping function takes plain data already
// produced elsewhere in the app (postsMapper output, campaignAccounting
// summaries, scheduler tick summaries, TikTok account records) and returns
// a plain object. Nothing here calls Firestore, TikTok, Instagram, or the
// scheduler — it cannot publish, schedule, delete, or make a network call,
// by construction, not just by policy.

const { randomUUID } = require('crypto');
const { redactRuntimeValue } = require('./runtimeRedaction');
const { evaluatePolicy, EXECUTION_POLICY_PUBLISH_GUARDED, EXECUTION_POLICY_STANDARD } = require('./runtimePolicy');
const evidence = require('./runtimeEvidence');
const { getAdapterReadiness } = require('./runtimeReadiness');

const PRODUCT = 'auto_poster';
const DEFAULT_VALIDATION_COMMANDS = ['npm run build', 'npm test'];
const NOT_EXECUTED_RESULT = Object.freeze({
  status: 'not_executed',
  note: 'Runtime adapter is decision-only; no execution occurs.'
});

function buildTaskId(taskType, seed) {
  return `autoposter:${taskType}:${seed || randomUUID()}`;
}

function accountLabelFromPost(post = {}) {
  return post.username || post.accountId || post.tiktokOpenId || 'unknown-account';
}

function accountLabelFromAccount(account = {}) {
  return account.displayName || account.username || account.accountId || account.id || 'unknown-account';
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Assembles the common runtime-task envelope shared by every mapping
 * function below. `inputs` is redacted before being attached so a caller
 * can pass through raw-ish upstream data without re-checking it here.
 */
function createRuntimeTask({
  taskType,
  taskId,
  objective,
  riskLevel,
  executionPolicy,
  primaryAction,
  status,
  inputs,
  createdAt,
  updatedAt,
  recommendation,
  validationCommands
}) {
  return {
    product: PRODUCT,
    taskId,
    taskType,
    objective,
    riskLevel,
    executionPolicy,
    primaryAction,
    status: status || 'pending',
    inputs: redactRuntimeValue(inputs || {}),
    evidence: null,
    validationCommands: validationCommands || DEFAULT_VALIDATION_COMMANDS,
    result: NOT_EXECUTED_RESULT,
    recommendation,
    createdAt: createdAt || nowIso(),
    updatedAt: updatedAt || createdAt || nowIso()
  };
}

// --- 1. Campaign creation -------------------------------------------------

function mapCampaignCreationTask(campaign = {}) {
  const accountLabels = Array.isArray(campaign.accountIds) ? campaign.accountIds : [];
  const jobCount = Number(campaign.jobCount || accountLabels.length || 0);

  const task = createRuntimeTask({
    taskType: 'campaign_creation',
    taskId: buildTaskId('campaign_creation', campaign.campaignId),
    objective: `Create a ${jobCount}-channel AutoPoster campaign${campaign.campaignId ? ` (${campaign.campaignId})` : ''}.`,
    riskLevel: 'medium',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'write',
    status: campaign.status || 'pending',
    inputs: { campaignId: campaign.campaignId || null, accountIds: accountLabels, jobCount, caption: campaign.caption || '' },
    createdAt: campaign.createdAt,
    updatedAt: campaign.updatedAt,
    recommendation: 'Safe to create; no external call is made until each channel job is individually scheduled and later published through the guarded cron tick path.'
  });

  task.evidence = evidence.campaignQueuedEvidence(task, {
    accountLabels,
    scheduledAt: campaign.scheduledRange ? campaign.scheduledRange.start : null,
    caption: campaign.caption
  });

  return task;
}

// --- 2. Scheduled post -----------------------------------------------------

function mapScheduledPostTask(post = {}) {
  const accountLabel = accountLabelFromPost(post);

  const task = createRuntimeTask({
    taskType: 'scheduled_post',
    taskId: buildTaskId('scheduled_post', post.id),
    objective: `Schedule ${post.platform || 'tiktok'} post ${post.id || '(new)'} for ${accountLabel} at ${post.scheduledAt || 'an unset time'}.`,
    riskLevel: 'medium',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'schedule',
    status: post.status || 'pending',
    inputs: {
      postId: post.id || null,
      platform: post.platform || 'tiktok',
      accountId: post.accountId || null,
      scheduledAt: post.scheduledAt || null,
      mediaType: post.mediaType || null,
      caption: post.caption || ''
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: 'Job is stored as scheduled; the guarded cron tick path is the only route that can publish it.'
  });

  task.evidence = evidence.scheduleCreatedEvidence(task, {
    accountLabel,
    scheduledAt: post.scheduledAt,
    caption: post.caption,
    mediaReference: post.mediaUrl || post.publicMediaUrl || null
  });

  return task;
}

// --- 3. Queued job ----------------------------------------------------------

function mapQueuedJobTask(post = {}) {
  const accountLabel = accountLabelFromPost(post);

  const task = createRuntimeTask({
    taskType: 'queued_job',
    taskId: buildTaskId('queued_job', post.id),
    objective: `Queue job ${post.id || '(new)'} for ${accountLabel} pending scheduler processing.`,
    riskLevel: 'medium',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'write',
    status: post.status || 'pending',
    inputs: {
      postId: post.id || null,
      accountId: post.accountId || null,
      order: Number(post.order || 0),
      caption: post.caption || ''
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: 'Queued for the scheduler; no publish call occurs while status stays pending/scheduled.'
  });

  task.evidence = evidence.scheduleCreatedEvidence(task, {
    accountLabel,
    scheduledAt: post.scheduledAt,
    caption: post.caption,
    mediaReference: post.mediaUrl || post.publicMediaUrl || null,
    recommendation: task.recommendation
  });

  return task;
}

// --- 4. Post-now request -----------------------------------------------------

function mapPostNowRequestTask(post = {}) {
  const accountLabel = accountLabelFromPost(post);

  const task = createRuntimeTask({
    taskType: 'post_now_request',
    taskId: buildTaskId('post_now_request', post.id),
    objective: `Post-now request for job ${post.id || '(new)'} on ${accountLabel}.`,
    riskLevel: 'high',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'publish',
    status: post.status || 'pending',
    inputs: {
      postId: post.id || null,
      accountId: post.accountId || null,
      caption: post.caption || ''
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: 'Post-now is publish_guarded: this adapter can only preview the decision, never execute the publish.'
  });

  const policyDecision = evaluatePolicy({ task, action: 'publish' });
  task.evidence = evidence.postNowRequestedEvidence(task, {
    accountLabel,
    caption: post.caption,
    mediaReference: post.mediaUrl || post.publicMediaUrl || null,
    policyDecision
  });

  return task;
}

// --- 5. Cron/tick processing -------------------------------------------------

function mapCronTickTask(tickSummary = {}) {
  const seed = tickSummary.now || nowIso();

  const task = createRuntimeTask({
    taskType: 'cron_tick',
    taskId: buildTaskId('cron_tick', seed),
    objective: `Inspect scheduler tick at ${seed} (checked=${Number(tickSummary.checked || 0)}, posted=${Number(tickSummary.posted || 0)}).`,
    riskLevel: 'high',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'read',
    status: 'inspected',
    inputs: {
      checked: Number(tickSummary.checked || 0),
      due: Number(tickSummary.due || 0),
      posted: Number(tickSummary.posted || 0),
      failed: Number(tickSummary.failed || 0)
    },
    createdAt: tickSummary.now,
    recommendation: 'This task only inspects an already-completed tick summary; it never triggers a tick itself.'
  });

  task.evidence = evidence.cronTickEvidence(task, { tickSummary });

  return task;
}

// --- 6. Publish attempt -------------------------------------------------------

function mapPublishAttemptTask(post = {}) {
  const accountLabel = accountLabelFromPost(post);

  const task = createRuntimeTask({
    taskType: 'publish_attempt',
    taskId: buildTaskId('publish_attempt', post.id),
    objective: `Represent the in-flight publish attempt for job ${post.id || '(new)'} on ${accountLabel}.`,
    riskLevel: 'critical',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'publish',
    status: post.status || 'processing',
    inputs: {
      postId: post.id || null,
      accountId: post.accountId || null,
      claimAttempts: Number(post.claimAttempts || 0)
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: 'The upstream scheduler owns the real attempt; this task is an evidence-only representation of it.'
  });

  const policyDecision = evaluatePolicy({ task, action: 'publish' });
  task.evidence = evidence.publishDecisionEvidence(task, {
    accountLabel,
    caption: post.caption,
    mediaReference: post.mediaUrl || post.publicMediaUrl || null,
    policyDecision
  });

  return task;
}

// --- 7. Publish result ---------------------------------------------------------

function mapPublishResultTask(post = {}, result = {}) {
  const accountLabel = accountLabelFromPost(post);
  const ok = Boolean(result.ok);

  const task = createRuntimeTask({
    taskType: 'publish_result',
    taskId: buildTaskId('publish_result', post.id),
    objective: `Record the publish result for job ${post.id || '(new)'} on ${accountLabel} (${ok ? 'success' : 'failure'}).`,
    riskLevel: ok ? 'medium' : 'high',
    executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED,
    primaryAction: 'read',
    status: post.status || (ok ? 'posted' : 'failed'),
    inputs: {
      postId: post.id || null,
      accountId: post.accountId || null,
      ok,
      mode: result.mode || 'api'
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: ok
      ? 'Publish already completed upstream; nothing further to approve here.'
      : 'Publish failed upstream; review reason before any retry is scheduled.'
  });

  task.evidence = evidence.publishResultEvidence(task, {
    accountLabel,
    ok,
    mode: result.mode,
    reason: result.reason,
    publishId: result.publishId || post.publishId || null
  });

  return task;
}

// --- 8. Account/channel selection -------------------------------------------

function mapAccountSelectionTask(account = {}) {
  const accountLabel = accountLabelFromAccount(account);

  const task = createRuntimeTask({
    taskType: 'account_selection',
    taskId: buildTaskId('account_selection', account.accountId || account.id),
    objective: `Select ${accountLabel} as the active posting account.`,
    riskLevel: 'low',
    executionPolicy: EXECUTION_POLICY_STANDARD,
    primaryAction: 'write',
    status: account.connected ? 'ready' : 'pending',
    inputs: {
      accountId: account.accountId || account.id || null,
      username: account.username || null,
      connected: Boolean(account.connected)
    },
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    recommendation: 'Selecting an account is local bookkeeping only; it never calls TikTok/Instagram itself.'
  });

  task.evidence = evidence.baseEvidence(task, {
    actionType: 'account_selection_recorded',
    accountLabel,
    decisionResult: 'recorded',
    recommendation: task.recommendation
  });

  return task;
}

// --- 9. Media/caption payload -------------------------------------------------

function mapMediaCaptionPayloadTask(post = {}) {
  const accountLabel = accountLabelFromPost(post);

  const task = createRuntimeTask({
    taskType: 'media_caption_payload',
    taskId: buildTaskId('media_caption_payload', post.id),
    objective: `Record the media/caption payload attached to job ${post.id || '(new)'}.`,
    riskLevel: 'low',
    executionPolicy: EXECUTION_POLICY_STANDARD,
    primaryAction: 'write',
    status: post.status || 'pending',
    inputs: {
      postId: post.id || null,
      mediaType: post.mediaType || null,
      hasCaption: Boolean(post.caption),
      caption: post.caption || ''
    },
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    recommendation: 'Payload metadata only; no upload or publish call is made by this task.'
  });

  task.evidence = evidence.baseEvidence(task, {
    actionType: 'media_caption_payload_recorded',
    accountLabel,
    caption: post.caption,
    mediaReference: post.mediaUrl || post.publicMediaUrl || null,
    decisionResult: 'recorded',
    recommendation: task.recommendation
  });

  return task;
}

/**
 * Convenience wrapper around runtimePolicy.evaluatePolicy for callers that
 * only have a mapped task in hand. Still decision-only.
 */
function evaluateAction(task, action, options = {}) {
  return evaluatePolicy({ task, action, dryRun: options.dryRun });
}

module.exports = {
  DEFAULT_VALIDATION_COMMANDS,
  mapCampaignCreationTask,
  mapScheduledPostTask,
  mapQueuedJobTask,
  mapPostNowRequestTask,
  mapCronTickTask,
  mapPublishAttemptTask,
  mapPublishResultTask,
  mapAccountSelectionTask,
  mapMediaCaptionPayloadTask,
  evaluateAction,
  getAdapterReadiness
};
