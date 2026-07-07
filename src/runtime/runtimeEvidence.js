'use strict';

// Redacted, JSON-safe evidence bundles for AutoPoster runtime tasks.
// Every bundle is passed through runtimeRedaction before it leaves this
// module, so nothing here needs to (or should) reason about which fields
// are "safe" — that boundary lives in one place only.

const { redactRuntimeValue } = require('./runtimeRedaction');

const CAPTION_SUMMARY_MAX_CHARS = 140;

function summarizeCaption(caption) {
  const text = String(caption || '').trim();
  if (!text) return null;
  if (text.length <= CAPTION_SUMMARY_MAX_CHARS) return text;
  return `${text.slice(0, CAPTION_SUMMARY_MAX_CHARS)}…`;
}

/**
 * Shared shape for every evidence bundle: task id/type, account label,
 * schedule time, a caption summary (never the raw payload), a redacted
 * media reference, the decision result that produced this evidence, a
 * human-readable recommendation, and timestamps for audit trails.
 */
function baseEvidence(task = {}, fields = {}) {
  const generatedAt = new Date().toISOString();
  const bundle = {
    product: 'auto_poster',
    taskId: task.taskId || null,
    taskType: task.taskType || null,
    actionType: fields.actionType || null,
    accountLabel: fields.accountLabel || task.accountLabel || null,
    scheduledAt: fields.scheduledAt || task.scheduledAt || null,
    captionSummary: summarizeCaption(fields.caption),
    mediaReference: fields.mediaReference || null,
    decisionResult: fields.decisionResult || null,
    recommendation: fields.recommendation || null,
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    generatedAt
  };
  return redactRuntimeValue(bundle);
}

function campaignQueuedEvidence(task, { accountLabels = [], scheduledAt, caption, recommendation } = {}) {
  return baseEvidence(task, {
    actionType: 'campaign_queued',
    accountLabel: Array.isArray(accountLabels) ? accountLabels.join(', ') : accountLabels,
    scheduledAt,
    caption,
    decisionResult: 'queued',
    recommendation: recommendation || 'Campaign queued for scheduling review; no publish occurred.'
  });
}

function scheduleCreatedEvidence(task, { accountLabel, scheduledAt, caption, mediaReference, recommendation } = {}) {
  return baseEvidence(task, {
    actionType: 'schedule_created',
    accountLabel,
    scheduledAt,
    caption,
    mediaReference,
    decisionResult: 'scheduled',
    recommendation: recommendation || 'Job scheduled; publish will only occur through the guarded cron tick path.'
  });
}

function postNowRequestedEvidence(task, { accountLabel, caption, mediaReference, policyDecision, recommendation } = {}) {
  return baseEvidence(task, {
    actionType: 'post_now_requested',
    accountLabel,
    caption,
    mediaReference,
    decisionResult: policyDecision ? policyDecision.decision : 'requires_approval',
    recommendation: recommendation || 'Post-now requires publish_guarded approval before any external call is made.'
  });
}

function cronTickEvidence(task, { tickSummary = {}, recommendation } = {}) {
  const safeSummary = {
    checked: Number(tickSummary.checked || 0),
    due: Number(tickSummary.due || 0),
    posted: Number(tickSummary.posted || 0),
    failed: Number(tickSummary.failed || 0),
    ok: Boolean(tickSummary.ok)
  };
  const bundle = baseEvidence(task, {
    actionType: 'cron_tick_inspected',
    decisionResult: safeSummary.ok ? 'inspected' : 'inspected_with_errors',
    recommendation: recommendation || 'Tick summary inspected for evidence only; the adapter did not trigger this run.'
  });
  return { ...bundle, tickSummary: safeSummary };
}

function publishDecisionEvidence(task, { accountLabel, caption, mediaReference, policyDecision, recommendation } = {}) {
  return baseEvidence(task, {
    actionType: 'publish_decision_preview',
    accountLabel,
    caption,
    mediaReference,
    decisionResult: policyDecision ? policyDecision.decision : null,
    recommendation: recommendation || 'Publish decision is a preview only; approval must happen outside this adapter.'
  });
}

function publishResultEvidence(task, { accountLabel, ok, mode, reason, publishId, recommendation } = {}) {
  const bundle = baseEvidence(task, {
    actionType: 'publish_result_summary',
    accountLabel,
    decisionResult: ok ? 'succeeded' : 'failed',
    recommendation: recommendation || (ok
      ? 'Publish already completed upstream; this bundle only records the outcome.'
      : 'Publish failed upstream; review reason before retrying.')
  });
  return {
    ...bundle,
    resultSummary: redactRuntimeValue({
      ok: Boolean(ok),
      mode: mode || 'api',
      reason: reason || null,
      publishId: publishId || null
    })
  };
}

function validationResultEvidence(task, { commands = [], passed, notes, recommendation } = {}) {
  const bundle = baseEvidence(task, {
    actionType: 'validation_result',
    decisionResult: passed ? 'passed' : 'failed',
    recommendation: recommendation || 'Validation evidence only; re-run the listed commands to confirm current state.'
  });
  return {
    ...bundle,
    validation: redactRuntimeValue({
      commands: Array.isArray(commands) ? commands : [],
      passed: Boolean(passed),
      notes: notes || null
    })
  };
}

module.exports = {
  summarizeCaption,
  baseEvidence,
  campaignQueuedEvidence,
  scheduleCreatedEvidence,
  postNowRequestedEvidence,
  cronTickEvidence,
  publishDecisionEvidence,
  publishResultEvidence,
  validationResultEvidence
};
