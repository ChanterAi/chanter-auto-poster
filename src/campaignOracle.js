'use strict';

// Campaign Oracle: a deterministic, local-only review of one campaign built
// exclusively from already-redacted stored fields (statuses, timestamps,
// publish ids, safe error reasons). It never reads lastResult.response, auth
// fields, or any provider payload, never calls external services, and never
// mutates anything — it turns evidence the dashboard already has into an
// operator verdict.

const { campaignJobStatus } = require('./campaigns');

const VERDICTS = Object.freeze({
  SUCCESS: 'SUCCESS',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS',
  FAILED: 'FAILED',
  WAITING: 'WAITING',
  UNKNOWN: 'UNKNOWN'
});

function safeReason(job) {
  const evidence = job.errorEvidence && typeof job.errorEvidence === 'object' ? job.errorEvidence : {};
  return String(job.errorMessage || evidence.reason || '').trim();
}

function isRetryableEvidence(job) {
  const evidence = job.errorEvidence && typeof job.errorEvidence === 'object' ? job.errorEvidence : {};
  return evidence.retryable === true;
}

function heartbeatStatus(schedulerEvidence) {
  if (!schedulerEvidence || !schedulerEvidence.durableHeartbeat) return 'unavailable';
  return String(schedulerEvidence.durableHeartbeat.status || 'missing');
}

function reviewCampaign(campaign = {}, { schedulerEvidence = null, now = new Date() } = {}) {
  const jobs = Array.isArray(campaign.childJobs) ? campaign.childJobs : [];
  const statuses = jobs.map((job) => campaignJobStatus(job));
  const count = (status) => statuses.filter((entry) => entry === status).length;

  const postedCount = count('posted');
  const acceptedCount = count('accepted');
  const failedCount = count('failed');
  const retryRequiredCount = count('retry_required');
  const unknownCount = count('unknown');
  const cancelledCount = count('cancelled');
  const pendingCount = count('queued') + count('posting');

  const failures = failedCount + retryRequiredCount;
  const provisionalOrFinal = postedCount + acceptedCount;
  const heartbeat = heartbeatStatus(schedulerEvidence);
  const nowMillis = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const overdueCount = jobs.filter((job, index) => {
    if (!['queued', 'posting'].includes(statuses[index])) return false;
    const scheduledMillis = Date.parse(job.scheduledAt || '');
    return Number.isFinite(scheduledMillis) && scheduledMillis < nowMillis;
  }).length;

  // Verdict: ordered, deterministic rules.
  let verdict;
  if (jobs.length === 0) {
    verdict = VERDICTS.UNKNOWN;
  } else if (unknownCount > 0) {
    verdict = VERDICTS.UNKNOWN;
  } else if (failures === 0 && pendingCount === 0 && acceptedCount === 0 && postedCount > 0) {
    verdict = VERDICTS.SUCCESS;
  } else if (provisionalOrFinal > 0 && failures > 0) {
    verdict = VERDICTS.PARTIAL_SUCCESS;
  } else if (failures > 0 && provisionalOrFinal === 0 && pendingCount === 0) {
    verdict = VERDICTS.FAILED;
  } else {
    verdict = VERDICTS.WAITING;
  }

  // Blocked reason: only when the stored evidence makes it obvious.
  let blockedReason = '';
  const failureReasons = jobs
    .filter((job, index) => ['failed', 'retry_required'].includes(statuses[index]))
    .map(safeReason)
    .filter(Boolean);
  if (unknownCount > 0) {
    blockedReason = 'A child job has an unverified remote outcome; automatic requeue is blocked to prevent duplicates.';
  } else if (failures > 0 && retryRequiredCount === failures) {
    blockedReason = failureReasons[0]
      ? `Transient provider rejection: ${failureReasons[0]}`
      : 'Transient provider rejection.';
  } else if (failures > 0 && failureReasons.length > 0) {
    blockedReason = failureReasons[0];
  } else if (verdict === VERDICTS.WAITING && overdueCount > 0 && ['missing', 'stale', 'unavailable'].includes(heartbeat)) {
    blockedReason = 'Jobs are overdue and the scheduler heartbeat is not fresh; the external cron may not be running.';
  }

  // Recommended next action. Never recommends re-posting anything that
  // already posted or was accepted.
  let recommendedNextAction;
  if (verdict === VERDICTS.SUCCESS) {
    recommendedNextAction = 'No action needed. Copy the evidence summary for your records.';
  } else if (verdict === VERDICTS.PARTIAL_SUCCESS) {
    recommendedNextAction = retryRequiredCount > 0
      ? 'Requeue only the retry-safe child jobs; leave the posted and accepted jobs untouched.'
      : 'Investigate the failed child job; leave the posted and accepted jobs untouched.';
  } else if (verdict === VERDICTS.FAILED) {
    recommendedNextAction = retryRequiredCount === failures && failures > 0
      ? 'Wait for the transient condition to clear, then requeue the child jobs.'
      : 'Fix the underlying account or media problem before recreating the campaign.';
  } else if (verdict === VERDICTS.UNKNOWN) {
    recommendedNextAction = jobs.length === 0
      ? 'No child jobs found for this campaign; verify it was created correctly.'
      : 'Verify the TikTok outcome manually before any requeue to avoid a duplicate post.';
  } else if (overdueCount > 0) {
    recommendedNextAction = 'Jobs are overdue: confirm the external cron is hitting /api/cron/tick.';
  } else {
    recommendedNextAction = 'Wait for the scheduler to process the jobs at their scheduled times.';
  }

  // Risk notes: short, factual, founder-readable.
  const riskNotes = [];
  if (unknownCount > 0) {
    riskNotes.push('Duplicate-post risk: at least one child outcome is unverified. Do not requeue blindly.');
  }
  if (acceptedCount > 0) {
    riskNotes.push('TikTok accepted the publish request but the final post is not confirmed yet.');
  }
  if (retryRequiredCount > 0) {
    riskNotes.push('Some failures are classified retry-safe (definitive transient rejections).');
  }
  if (overdueCount > 0) {
    riskNotes.push(`${overdueCount} child job(s) are past their scheduled time and still unprocessed.`);
  }
  if (['missing', 'stale', 'unavailable'].includes(heartbeat)) {
    riskNotes.push('Scheduler heartbeat is not fresh; cron execution cannot be confirmed from evidence.');
  }
  if (cancelledCount > 0) {
    riskNotes.push(`${cancelledCount} child job(s) were cancelled and are excluded from the verdict.`);
  }

  // Evidence confidence: HIGH needs corroborated terminal states plus a
  // healthy heartbeat; gaps degrade to MEDIUM; unverified outcomes or an
  // absent heartbeat with nothing corroborated degrade to LOW.
  const successEvidenceGaps = jobs.filter((job, index) => (
    (statuses[index] === 'posted' && !job.publishId && !job.postedAt)
    || (statuses[index] === 'accepted' && !job.publishId && !job.acceptedAt)
  )).length;
  const failureEvidenceGaps = jobs.filter((job, index) => (
    ['failed', 'retry_required'].includes(statuses[index]) && !safeReason(job)
  )).length;
  const anyPublishId = jobs.some((job) => Boolean(job.publishId));

  let evidenceConfidence = 'HIGH';
  if (heartbeat !== 'healthy' || successEvidenceGaps > 0 || failureEvidenceGaps > 0) {
    evidenceConfidence = 'MEDIUM';
  }
  if (
    jobs.length === 0
    || unknownCount > 0
    || (['missing', 'unavailable'].includes(heartbeat) && !anyPublishId && provisionalOrFinal + failures === 0)
  ) {
    evidenceConfidence = 'LOW';
  }

  // One founder-readable sentence.
  const total = jobs.length;
  let summary;
  if (total === 0) {
    summary = 'This campaign has no child jobs to review.';
  } else if (verdict === VERDICTS.SUCCESS) {
    summary = `All ${total} child job(s) posted.${anyPublishId ? ' TikTok publish ids are stored as proof.' : ''}`;
  } else if (verdict === VERDICTS.PARTIAL_SUCCESS) {
    summary = `${postedCount + acceptedCount} of ${total} child job(s) posted or accepted; ${failures} blocked (${retryRequiredCount} retry-safe, ${failedCount} terminal).`;
  } else if (verdict === VERDICTS.FAILED) {
    summary = `All ${total} child job(s) failed (${retryRequiredCount} retry-safe, ${failedCount} terminal).`;
  } else if (verdict === VERDICTS.UNKNOWN) {
    summary = `${unknownCount} of ${total} child job(s) have unverified outcomes; manual verification is required.`;
  } else {
    summary = `${pendingCount + acceptedCount} of ${total} child job(s) are still waiting or in flight; no failures recorded.`;
  }

  return {
    verdict,
    summary,
    postedCount,
    acceptedCount,
    failedCount,
    retryRequiredCount,
    blockedReason,
    recommendedNextAction,
    riskNotes,
    evidenceConfidence
  };
}

// ── P1.3 Operator Review contract ────────────────────────────────────────────
// Frontend-ready, read-only JSON built by whitelisting safe fields only.
// Reuses reviewCampaign for every verdict decision; adds advisory (never
// wired, never destructive) safe actions.

const SAFE_ACTION_TYPES = Object.freeze([
  'MANUAL_REVIEW',
  'RECONNECT_ACCOUNT',
  'WAIT_FOR_PROCESSING',
  'NO_ACTION',
  'CHECK_SCHEDULER'
]);

function contractHeartbeatStatus(schedulerEvidence) {
  const raw = heartbeatStatus(schedulerEvidence);
  if (raw === 'healthy') return 'healthy';
  if (raw === 'stale' || raw === 'failed') return 'degraded';
  if (raw === 'missing') return 'missing';
  return 'unknown';
}

function advisoryAction(type, label, description) {
  // Advisory only: nothing in the backend executes these, so they ship
  // disabled and non-destructive by contract.
  return { type, label, description, destructive: false, enabled: false };
}

function deriveSafeActions(review, contractHeartbeat) {
  const actions = [];
  const accountIssueImplied = /token|reconnect|disconnect|expired|authoriz/i.test(String(review.blockedReason || ''));

  if (review.verdict === VERDICTS.SUCCESS) {
    actions.push(advisoryAction(
      'NO_ACTION',
      'No action needed',
      'All child jobs posted. Keep the evidence summary for your records.'
    ));
  }
  if (review.verdict === VERDICTS.UNKNOWN) {
    actions.push(advisoryAction(
      'MANUAL_REVIEW',
      'Verify outcome manually',
      'Confirm the TikTok result manually first; acting on unverified state risks a duplicate post.'
    ));
  }
  if (accountIssueImplied) {
    actions.push(advisoryAction(
      'RECONNECT_ACCOUNT',
      'Reconnect the TikTok account',
      'The stored failure evidence points at a token or connection problem.'
    ));
  }
  if (['PARTIAL_SUCCESS', 'FAILED'].includes(review.verdict) && !accountIssueImplied) {
    actions.push(advisoryAction(
      'MANUAL_REVIEW',
      'Review the failed child jobs',
      'Read the per-child evidence before deciding anything. Jobs that already posted need no further action.'
    ));
  }
  if (['missing', 'degraded', 'unknown'].includes(contractHeartbeat)) {
    actions.push(advisoryAction(
      'CHECK_SCHEDULER',
      'Check the scheduler cron',
      'The durable heartbeat is not fresh; confirm the external cron is hitting /api/cron/tick.'
    ));
  }
  if (review.verdict === VERDICTS.WAITING) {
    actions.push(advisoryAction(
      'WAIT_FOR_PROCESSING',
      'Wait for processing',
      'Jobs are queued or in flight with no failures recorded.'
    ));
  }
  if (actions.length === 0) {
    actions.push(advisoryAction(
      'MANUAL_REVIEW',
      'Review campaign evidence',
      'No specific action could be derived; read the evidence summary.'
    ));
  }
  return actions;
}

function splitHashtags(value) {
  return String(value || '').split(/\s+/).map((tag) => tag.trim()).filter(Boolean);
}

function buildOperatorReview(campaign = {}, { schedulerEvidence = null, now = new Date() } = {}) {
  const review = reviewCampaign(campaign, { schedulerEvidence, now });
  const jobs = Array.isArray(campaign.childJobs) ? campaign.childJobs : [];
  const firstChild = jobs[0] || {};
  const contractHeartbeat = contractHeartbeatStatus(schedulerEvidence);
  const heartbeat = schedulerEvidence && schedulerEvidence.durableHeartbeat
    ? schedulerEvidence.durableHeartbeat
    : null;

  return {
    ok: true,
    campaignId: String(campaign.campaignId || campaign.id || ''),
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    campaign: {
      status: String(campaign.campaignStatus || 'unknown'),
      // Campaign Mode stores per-account copy variants; the contract exposes
      // the first child's variant as the representative campaign copy.
      caption: String(firstChild.caption || ''),
      hashtags: splitHashtags(firstChild.hashtags),
      scheduledAt: campaign.scheduleBaseTime || null,
      createdAt: campaign.createdAt || null
    },
    evidence: {
      childrenTotal: jobs.length,
      postedCount: review.postedCount,
      acceptedCount: review.acceptedCount,
      failedCount: review.failedCount,
      retryRequiredCount: review.retryRequiredCount,
      lastTickAt: heartbeat ? (heartbeat.lastTickAt || null) : null,
      heartbeatStatus: contractHeartbeat
    },
    oracle: {
      verdict: review.verdict,
      summary: review.summary,
      blockedReason: review.blockedReason,
      recommendedNextAction: review.recommendedNextAction,
      riskNotes: review.riskNotes,
      evidenceConfidence: review.evidenceConfidence
    },
    safeActions: deriveSafeActions(review, contractHeartbeat)
  };
}

module.exports = {
  VERDICTS,
  SAFE_ACTION_TYPES,
  reviewCampaign,
  buildOperatorReview
};
