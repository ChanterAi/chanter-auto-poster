'use strict';

const MAX_CAMPAIGN_ACCOUNTS = 2;
const CAMPAIGN_STAGGER_MINUTES = 15;
const CAMPAIGN_JOB_STATUSES = new Set([
  'queued',
  'posting',
  'accepted',
  'posted',
  'failed',
  'unknown',
  'cancelled',
  'retry_required'
]);

function campaignValidationError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function normalizedCopy(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function minuteKey(value) {
  const date = value && typeof value.toDate === 'function'
    ? value.toDate()
    : (value instanceof Date ? new Date(value) : new Date(value));
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCSeconds(0, 0);
  return date.toISOString();
}

function buildCampaignPlan({ baseScheduledAt, jobs }, {
  now = new Date(),
  staggerMinutes = CAMPAIGN_STAGGER_MINUTES
} = {}) {
  const selectedJobs = Array.isArray(jobs) ? jobs : [];
  if (selectedJobs.length === 0) {
    throw campaignValidationError('Select at least one TikTok account.', 'CAMPAIGN_ACCOUNT_REQUIRED');
  }
  if (selectedJobs.length > MAX_CAMPAIGN_ACCOUNTS) {
    throw campaignValidationError(
      `Campaign Mode v0.1 supports a maximum of ${MAX_CAMPAIGN_ACCOUNTS} TikTok accounts.`,
      'CAMPAIGN_ACCOUNT_LIMIT'
    );
  }

  const baseDate = baseScheduledAt instanceof Date ? new Date(baseScheduledAt) : new Date(baseScheduledAt);
  baseDate.setSeconds(0, 0);
  if (Number.isNaN(baseDate.getTime())) {
    throw campaignValidationError('Choose a valid base schedule time.', 'CAMPAIGN_SCHEDULE_INVALID');
  }
  if (baseDate.getTime() <= now.getTime()) {
    throw campaignValidationError('Campaign schedule time must be in the future.', 'CAMPAIGN_SCHEDULE_PAST');
  }

  const accountIds = selectedJobs.map((job) => String(job.accountId || '').trim());
  if (accountIds.some((accountId) => !accountId || accountId === 'legacy')) {
    throw campaignValidationError('Select connected TikTok accounts for every campaign job.', 'CAMPAIGN_ACCOUNT_INVALID');
  }
  if (new Set(accountIds).size !== accountIds.length) {
    throw campaignValidationError('Select each TikTok account only once.', 'CAMPAIGN_ACCOUNT_DUPLICATE');
  }

  const plannedJobs = selectedJobs.map((job, index) => {
    const caption = String(job.caption || '').trim();
    const hashtags = String(job.hashtags || '').trim();
    if (!caption) {
      throw campaignValidationError(`Add a caption for campaign account ${index + 1}.`, 'CAMPAIGN_CAPTION_REQUIRED');
    }
    if (!hashtags) {
      throw campaignValidationError(`Add hashtags for campaign account ${index + 1}.`, 'CAMPAIGN_HASHTAGS_REQUIRED');
    }

    const scheduledAt = new Date(baseDate.getTime() + index * staggerMinutes * 60 * 1000);
    return {
      accountId: accountIds[index],
      caption,
      hashtags,
      scheduledAt: scheduledAt.toISOString()
    };
  });

  if (plannedJobs.length === 2) {
    if (normalizedCopy(plannedJobs[0].caption) === normalizedCopy(plannedJobs[1].caption)) {
      throw campaignValidationError(
        'Use a different caption for each TikTok account.',
        'CAMPAIGN_CAPTIONS_MUST_DIFFER'
      );
    }
    if (normalizedCopy(plannedJobs[0].hashtags) === normalizedCopy(plannedJobs[1].hashtags)) {
      throw campaignValidationError(
        'Use a different hashtag set for each TikTok account.',
        'CAMPAIGN_HASHTAGS_MUST_DIFFER'
      );
    }
  }

  const scheduledMinutes = plannedJobs.map((job) => minuteKey(job.scheduledAt));
  if (new Set(scheduledMinutes).size !== scheduledMinutes.length) {
    throw campaignValidationError(
      'Campaign jobs cannot be scheduled in the same minute.',
      'CAMPAIGN_SAME_MINUTE'
    );
  }

  return {
    baseScheduledAt: baseDate.toISOString(),
    staggerMinutes,
    jobs: plannedJobs
  };
}

function validateCampaignAccounts(plannedJobs, accounts, { now = new Date() } = {}) {
  const accountsById = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [
    String(account && account.accountId || '').trim(),
    account
  ]));

  return plannedJobs.map((job) => {
    const account = accountsById.get(job.accountId);
    if (!account || !account.connected || !String(account.access_token || '').trim()) {
      throw campaignValidationError(
        `TikTok account ${job.accountId} is disconnected or has no usable token. Reconnect it before creating the campaign.`,
        'CAMPAIGN_ACCOUNT_TOKEN_INVALID'
      );
    }

    const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : NaN;
    if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
      throw campaignValidationError(
        `TikTok account ${job.accountId} has an expired token. Reconnect it before creating the campaign.`,
        'CAMPAIGN_ACCOUNT_TOKEN_EXPIRED'
      );
    }
    return account;
  });
}

// Only failures where TikTok definitively rejected the request for a
// transient reason are safe to advertise as retryable. Ambiguous outcomes
// (timeouts, dropped connections) stay terminal 'failed' because the post
// may still exist remotely and a retry could duplicate it.
const RETRYABLE_TIKTOK_ERROR_CODES = new Set([
  'rate_limit_exceeded',
  'spam_risk_too_many_posts'
]);

const RETRYABLE_FAILURE_REASONS = [
  /returned http (429|5\d\d)\b/i,
  /rate limit/i,
  /too many requests/i
];

function collectFailureCodes(value, found = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return found;
  if (['string', 'number'].includes(typeof value.code)) {
    found.push(String(value.code).toLowerCase());
  }
  for (const child of Object.values(value)) collectFailureCodes(child, found, depth + 1);
  return found;
}

function classifyCampaignChildFailure(result = {}) {
  const codes = collectFailureCodes({ code: result.code, response: result.response });
  if (codes.some((code) => RETRYABLE_TIKTOK_ERROR_CODES.has(code))) return 'retry_required';
  if (RETRYABLE_FAILURE_REASONS.some((pattern) => pattern.test(String(result.reason || '')))) {
    return 'retry_required';
  }
  return 'failed';
}

function campaignJobStatus(job) {
  const canonicalStatus = String(job && job.status || '').toLowerCase();
  const storedCampaignStatus = String(
    job && (job.campaignJobStatus || job.campaign_job_status) || ''
  ).toLowerCase();

  if (canonicalStatus === 'posted') return 'posted';
  if (canonicalStatus === 'accepted') return 'accepted';
  if (canonicalStatus === 'unknown') return 'unknown';
  if (canonicalStatus === 'processing') return 'posting';
  if (['scheduled', 'pending', 'ready'].includes(canonicalStatus)) return 'queued';
  if (canonicalStatus === 'failed') {
    return storedCampaignStatus === 'retry_required' ? 'retry_required' : 'failed';
  }
  if (CAMPAIGN_JOB_STATUSES.has(storedCampaignStatus)) return storedCampaignStatus;
  return 'queued';
}

function deriveCampaignStatus(jobs) {
  const statuses = (Array.isArray(jobs) ? jobs : []).map(campaignJobStatus);
  if (statuses.length === 0) return 'cancelled';
  if (statuses.every((status) => status === 'posted')) return 'posted';
  if (statuses.some((status) => status === 'posting')) return 'posting';
  if (statuses.some((status) => status === 'retry_required')) return 'retry_required';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  if (statuses.every((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'failed')) return 'partial_failure';
  if (
    statuses.some((status) => status === 'accepted')
    && statuses.every((status) => ['accepted', 'posted'].includes(status))
  ) return 'accepted';
  if (statuses.some((status) => ['accepted', 'posted'].includes(status))) return 'in_progress';
  return 'queued';
}

// Compact operator-facing evidence text for one campaign. Built only from
// the stored job records the dashboard already renders — statuses, ids,
// times, and redacted error reasons. Never tokens, auth fields, or payloads.
function buildCampaignEvidenceSummary(campaign = {}) {
  const jobs = Array.isArray(campaign.childJobs) ? campaign.childJobs : [];
  const lines = [
    `CAMPAIGN EVIDENCE ${String(campaign.campaignId || campaign.id || 'unknown')}`,
    `status: ${String(campaign.campaignStatus || 'unknown')}`,
    `base time: ${campaign.scheduleBaseTime || 'unknown'} / stagger: ${Number(campaign.staggerMinutes || 0)}m / child jobs: ${jobs.length}`
  ];

  jobs.forEach((job, index) => {
    const accountId = String(job.accountId || 'unassigned');
    const label = job.username ? `@${job.username}` : accountId;
    lines.push(`[${index + 1}] ${label} (${accountId})`);
    lines.push(`    job id: ${job.id || 'unknown'}`);
    lines.push(`    scheduled: ${job.scheduledAt || 'not scheduled'}`);
    lines.push(`    status: ${campaignJobStatus(job)}`);
    if (Number(job.claimAttempts || 0) > 0) lines.push(`    attempts: ${Number(job.claimAttempts)}`);
    // Execution evidence uses only safe scalar fields; lastResult.response
    // (raw provider body) is deliberately never read here.
    const lastResult = job.lastResult && typeof job.lastResult === 'object' ? job.lastResult : null;
    if (lastResult && lastResult.completedAt) {
      lines.push(`    last attempt: ${lastResult.completedAt} (${lastResult.mode || 'api'})`);
    }
    if (job.acceptedAt) lines.push(`    accepted at: ${job.acceptedAt}`);
    if (job.postedAt) lines.push(`    posted at: ${job.postedAt}`);
    if (job.publishId) lines.push(`    publish id: ${job.publishId}`);
    const evidence = job.errorEvidence && typeof job.errorEvidence === 'object' ? job.errorEvidence : {};
    const reason = job.errorMessage || evidence.reason || '';
    if (reason) lines.push(`    error: ${reason}${evidence.retryable ? ' (safe to requeue)' : ''}`);
    if (evidence.code) lines.push(`    error code: ${evidence.code}`);
  });

  lines.push('generated from stored job records - contains no tokens or raw payloads');
  return lines.join('\n');
}

module.exports = {
  MAX_CAMPAIGN_ACCOUNTS,
  CAMPAIGN_STAGGER_MINUTES,
  buildCampaignPlan,
  validateCampaignAccounts,
  campaignJobStatus,
  classifyCampaignChildFailure,
  deriveCampaignStatus,
  buildCampaignEvidenceSummary,
  minuteKey
};
