'use strict';

const { randomUUID } = require('crypto');
const config = require('./config');
const { postsCollection, getFirestore, Timestamp, FieldValue } = require('./firestore');
const { postFromDoc, toTimestampOrNull } = require('./postsMapper');
const { publishPhotoPost } = require('./tiktok');
const instagram = require('./instagram');

const STALE_LOCK_MS = Math.max(1, config.scheduler.staleLockMinutes) * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = Math.max(1, config.scheduler.maxClaimAttempts);

// Deterministic, bounded backoff schedule (minutes) for transient publish
// failures. Indexed by claim attempt number; the last entry caps the delay.
const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60];

const NON_RETRYABLE_CODES = new Set([
  'INSTAGRAM_NOT_CONFIGURED',
  'INSTAGRAM_LIVE_DISABLED'
]);

const NON_RETRYABLE_REASON_PATTERNS = [
  /unassigned/i,
  /not configured/i,
  /disabled/i,
  /token/i,
  /authoriz/i,
  /authentication/i,
  /permission/i,
  /forbidden/i,
  /invalid/i,
  /missing/i,
  /must be/i,
  /bad request/i,
  /approval/i,
  /returned http 4(?!29)\d\d/i
];

const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
  'ABORT_ERR', 'TIMEOUT_ERR'
]);

const TRANSIENT_REASON_PATTERNS = [
  /returned http 5\d\d/i,
  /returned http 429/i,
  /\btimed? ?out\b/i,
  /timeout/i,
  /aborted/i,
  /fetch failed/i,
  /socket hang ?up/i,
  /network/i,
  /rate limit/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal server error/i,
  /try again/i,
  /econn/i,
  /eai_again/i,
  /enotfound/i,
  /etimedout/i
];

/**
 * Classifies a failed publish result. Only clearly transient failures
 * (network errors, timeouts, 5xx/429-style API responses) are retryable;
 * validation, auth, configuration, and other 4xx-style failures — and
 * anything ambiguous — are terminal.
 */
function isTransientPublishFailure(result) {
  if (!result || result.ok) return false;

  const code = String(result.code || '').toUpperCase();
  if (NON_RETRYABLE_CODES.has(code)) return false;

  const reason = String(result.reason || '');
  if (NON_RETRYABLE_REASON_PATTERNS.some((pattern) => pattern.test(reason))) return false;

  if (TRANSIENT_ERROR_CODES.has(code)) return true;
  return TRANSIENT_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

function retryBackoffMs(attempts) {
  const index = Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MINUTES.length) - 1;
  return RETRY_BACKOFF_MINUTES[index] * 60 * 1000;
}

// Track the last successful tick time for health monitoring.
// This is in-memory only — it resets on restart, which is exactly what
// we want: if the process just booted, we don't know when the last tick
// was, and the health endpoint should reflect that uncertainty.
let lastTickAt = null;
let lastTickSummary = null;

function getSchedulerState() {
  return {
    mode: 'external_cron',
    persistent: true,
    inMemoryTimer: false,
    schedule: 'every minute',
    endpoint: '/api/cron/tick',
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    lastTickOk: lastTickSummary ? lastTickSummary.ok : null
  };
}

/**
 * Returns safe health metadata for the /health endpoint.
 * No secrets, no tokens, no raw env values.
 */
async function getSchedulerHealth() {
  let staleProcessingCount = 0;
  let stuckPendingCount = 0;

  try {
    // Count jobs stuck in processing (potential crashed workers)
    const processingSnap = await postsCollection()
      .where('status', '==', 'processing')
      .get();
    staleProcessingCount = processingSnap.size;

    // Count jobs in 'pending' that have a scheduledAt in the past
    // (missed schedule — should have been picked up by a tick)
    const nowTs = Timestamp.now();
    const pendingSnap = await postsCollection()
      .where('status', '==', 'pending')
      .where('scheduledTimeUTC', '<=', nowTs)
      .get();
    stuckPendingCount = pendingSnap.size;
  } catch (error) {
    // Firestore might not be available during health check — don't crash
    console.warn('[scheduler] health check query failed:', error.message);
  }

  return {
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    lastTickOk: lastTickSummary ? lastTickSummary.ok : null,
    lastTickSummary: lastTickSummary ? {
      checked: lastTickSummary.checked,
      posted: lastTickSummary.posted,
      failed: lastTickSummary.failed
    } : null,
    staleProcessingCount,
    stuckPendingCount,
    staleLockMinutes: config.scheduler.staleLockMinutes,
    maxClaimAttempts: config.scheduler.maxClaimAttempts
  };
}

async function runSchedulerTick({ now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(nowDate.getTime())) throw new Error('Scheduler tick received an invalid time');

  const nowTimestamp = Timestamp.fromDate(nowDate);
  const workerId = `${process.env.RENDER_INSTANCE_ID || 'local'}-${randomUUID()}`;
  const summary = {
    ok: true,
    now: nowDate.toISOString(),
    checked: 0,
    due: 0,
    posted: 0,
    failed: 0,
    errors: []
  };

  console.log(`[CRON_TICK] now=${summary.now}`);
  console.log('[CRON_QUERY] checking scheduled jobs');

  try {
    await reclaimStaleLocks(nowDate);
  } catch (error) {
    const message = error.message || String(error);
    summary.errors.push({ error: `Stale lock recovery failed: ${message}` });
    console.error(`[LOCK_RECOVERY_FAILED] error=${message}`);
  }

  let dueJobs;
  try {
    dueJobs = await findDueJobs(nowTimestamp);
    summary.checked = dueJobs.length;
    summary.due = dueJobs.length;
  } catch (error) {
    const detail = describeQueryError(error);
    summary.ok = false;
    summary.errors.push({ error: detail.message, indexUrl: detail.indexUrl || undefined });
    console.error(`[CRON_QUERY_FAILED] error=${detail.message}`);
    if (detail.indexUrl) console.error(`[CRON_INDEX_REQUIRED] url=${detail.indexUrl}`);
    lastTickAt = new Date();
    lastTickSummary = { ...summary };
    return summary;
  }

  for (const job of dueJobs) {
    console.log(`[JOB_FOUND] id=${job.id} scheduledAt=${job.scheduledAt}`);
    console.log(`[JOB_DUE] id=${job.id}`);

    try {
      const result = await processPost(job.id, { force: false, workerId, now: nowDate });
      if (result.ok) {
        summary.posted += 1;
      } else if (result.mode !== 'skipped') {
        summary.failed += 1;
        summary.errors.push({ id: job.id, error: result.reason || 'Unknown publish error' });
      }
    } catch (error) {
      const message = error.message || String(error);
      summary.failed += 1;
      summary.errors.push({ id: job.id, error: message });
      console.error(`[POST_FAILED] id=${job.id} error=${message}`);
    }
  }

  // Record tick metadata for health monitoring
  lastTickAt = new Date();
  lastTickSummary = { ...summary };

  return summary;
}

// Kept for the old /run-scheduler route while deployments move to /api/cron/tick.
async function publishNextPost() {
  return runSchedulerTick();
}

async function findDueJobs(nowTimestamp) {
  const jobs = new Map();

  const canonical = await postsCollection()
    .where('status', '==', 'scheduled')
    .where('scheduledAt', '<=', nowTimestamp)
    .orderBy('scheduledAt', 'asc')
    .get();

  for (const doc of canonical.docs) {
    jobs.set(doc.id, {
      id: doc.id,
      scheduledAt: timestampToIso(doc.data().scheduledAt)
    });
  }

  // Recover jobs created by versions deployed before scheduledAt became the
  // canonical field. Remove this query after those documents are migrated.
  const legacy = await postsCollection()
    .where('status', '==', 'pending')
    .where('scheduledTimeUTC', '<=', nowTimestamp)
    .orderBy('scheduledTimeUTC', 'asc')
    .get();

  for (const doc of legacy.docs) {
    jobs.set(doc.id, {
      id: doc.id,
      scheduledAt: timestampToIso(doc.data().scheduledTimeUTC)
    });
  }

  return [...jobs.values()].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

async function reclaimStaleLocks(nowDate) {
  const threshold = Timestamp.fromMillis(nowDate.getTime() - STALE_LOCK_MS);
  const snapshot = await postsCollection()
    .where('status', '==', 'processing')
    .where('lockedAt', '<=', threshold)
    .get();

  await Promise.all(snapshot.docs.map((doc) => reclaimOne(doc.ref)));
}

async function reclaimOne(ref) {
  try {
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const data = snap.data();
      if (data.status !== 'processing') return;

      const attempts = Number(data.claimAttempts || 0);
      if (attempts >= MAX_CLAIM_ATTEMPTS) {
        const reason = `Publish worker stopped during ${attempts} attempts`;
        tx.update(ref, {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          failedAt: FieldValue.serverTimestamp(),
          errorMessage: reason,
          updatedAt: FieldValue.serverTimestamp(),
          lastResult: { ok: false, mode: 'api', reason, completedAt: new Date().toISOString() }
        });
        return;
      }

      const scheduledAt = data.scheduledAt || data.scheduledTimeUTC || Timestamp.now();
      tx.update(ref, {
        status: 'scheduled',
        scheduledAt,
        lockedAt: null,
        lockedBy: null,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    console.error(`[LOCK_RECOVERY_FAILED] id=${ref.id} error=${error.message || error}`);
  }
}

async function claimPost(id, { force, workerId, now = new Date() }) {
  const ref = postsCollection().doc(id);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.status === 'processing') return null;

    // Duplicate-post guard: if this job already has a durable publish
    // identifier and a terminal success status, never publish again.
    // This prevents duplicates when reclaimStaleLocks retries a post
    // that TikTok actually accepted before the crash.
    if (data.status === 'posted' && data.publishId) {
      return null;
    }

    if (!force) {
      const isCanonical = data.status === 'scheduled';
      const isLegacy = data.status === 'pending' && data.scheduledTimeUTC;
      if (!isCanonical && !isLegacy) return null;

      const scheduledAt = data.scheduledAt || data.scheduledTimeUTC;
      const scheduledTimestamp = normalizeTimestamp(scheduledAt);
      if (!scheduledTimestamp || scheduledTimestamp.toMillis() > now.getTime()) return null;
    } else if (!['pending', 'scheduled', 'failed', 'ready'].includes(data.status)) {
      return null;
    }

    // Even in force mode, refuse to re-publish a job that already has
    // a durable publish identifier — the content is already on TikTok.
    if (data.publishId) {
      return null;
    }

    tx.update(ref, {
      status: 'processing',
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy: workerId,
      claimAttempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    });

    const claimed = postFromDoc(snap);
    claimed.status = 'processing';
    return claimed;
  });
}

async function processPost(id, {
  force = false,
  workerId = `manual-${randomUUID()}`,
  now = new Date()
} = {}) {
  const claimed = await claimPost(id, { force, workerId, now });
  if (!claimed) {
    return {
      ok: false,
      mode: 'skipped',
      postId: id,
      reason: 'Job was already claimed, already handled, or is not due.'
    };
  }

  console.log(`[POST_START] id=${id}`);
  let result;
  try {
    if (String(claimed.platform || 'tiktok').toLowerCase() === 'instagram') {
      result = await publishScheduledInstagramPost(claimed);
    } else if (!claimed.accountId || claimed.accountId === 'legacy' || claimed.accountAssignment === 'legacy') {
      result = {
        ok: false,
        mode: 'api',
        reason: 'TikTok account is unassigned for this job; publishing was blocked.'
      };
    } else {
      result = await publishPhotoPost(claimed);
    }
  } catch (error) {
    result = {
      ok: false,
      mode: 'api',
      reason: error.message || 'Unexpected TikTok publish error',
      response: error.response || null
    };
  }

  const finalized = await finalize(id, workerId, result);
  if (finalized.ok) {
    console.log(`[POST_SUCCESS] id=${id} tiktokResponse=${JSON.stringify(safeTikTokSummary(result))}`);
  } else {
    console.error(`[POST_FAILED] id=${id} error=${finalized.reason || 'Unknown publish error'}`);
  }
  return finalized;
}

async function publishScheduledInstagramPost(post) {
  const health = await instagram.getInstagramHealth();
  if (!health.configured) {
    return {
      ok: false,
      mode: 'api',
      code: 'INSTAGRAM_NOT_CONFIGURED',
      reason: 'Instagram publishing is not configured.'
    };
  }
  if (!health.canPublish) {
    return {
      ok: false,
      mode: 'api',
      code: 'INSTAGRAM_LIVE_DISABLED',
      reason: 'Instagram live publishing is disabled.'
    };
  }

  return instagram.publishInstagramMedia({
    post,
    userId: post.userId,
    dryRun: false
  });
}

async function finalize(id, workerId, result) {
  const ref = postsCollection().doc(id);
  const completedAt = new Date().toISOString();
  const reason = result.reason || 'TikTok publish failed';
  let applied = false;
  let retryScheduled = false;

  // Extract a durable publish identifier from the TikTok API response
  // so we can guard against duplicate publishing on retry.
  const publishId = result.ok ? extractPublishId(result.response) : null;

  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status !== 'processing' || data.lockedBy !== workerId) return;

    if (result.ok) {
      const update = {
        status: 'posted',
        postedAt: Timestamp.now(),
        readyAt: null,
        failedAt: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
        lastResult: { ...result, completedAt },
        updatedAt: FieldValue.serverTimestamp()
      };
      if (publishId) {
        update.publishId = publishId;
      }
      tx.update(ref, update);
    } else {
      // Store redacted error metadata — no raw tokens or full payloads.
      const safeResult = {
        ok: false,
        mode: result.mode || 'api',
        reason,
        completedAt
      };
      if (result.code) safeResult.code = result.code;

      const attempts = Number(data.claimAttempts || 0);
      const shouldRetry = isTransientPublishFailure(result) && attempts < MAX_CLAIM_ATTEMPTS;

      if (shouldRetry) {
        const nextAttemptAt = Timestamp.fromMillis(Date.now() + retryBackoffMs(attempts));
        retryScheduled = true;
        tx.update(ref, {
          status: 'scheduled',
          scheduledAt: nextAttemptAt,
          failedAt: null,
          errorMessage: reason,
          lockedAt: null,
          lockedBy: null,
          lastResult: { ...safeResult, willRetry: true, attempts },
          updatedAt: FieldValue.serverTimestamp()
        });
      } else {
        tx.update(ref, {
          status: 'failed',
          failedAt: Timestamp.now(),
          errorMessage: reason,
          lockedAt: null,
          lockedBy: null,
          lastResult: safeResult,
          updatedAt: FieldValue.serverTimestamp()
        });
      }
    }
    applied = true;
  });

  if (!applied) {
    return { ok: false, mode: 'skipped', postId: id, reason: 'Job lock changed before completion.' };
  }
  if (result.ok) return { ok: true, mode: result.mode || 'api', postId: id };
  if (retryScheduled) {
    console.warn(`[POST_RETRY_SCHEDULED] id=${id} reason=${reason}`);
    return { ok: false, mode: result.mode || 'api', postId: id, reason, retryScheduled: true };
  }
  return { ok: false, mode: result.mode || 'api', postId: id, reason };
}

function normalizeTimestamp(value) {
  if (value && typeof value.toMillis === 'function') return value;
  return toTimestampOrNull(value);
}

function timestampToIso(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function safeTikTokSummary(result) {
  const response = result && result.response;
  const publishId = findSafeValue(response, new Set(['publish_id', 'publishid']));
  const status = findSafeValue(response, new Set(['status', 'publish_status']));
  return {
    mode: result && result.mode ? result.mode : 'api',
    publishId: publishId || null,
    status: status || 'accepted'
  };
}

/**
 * Extracts a durable publish identifier from a TikTok API response.
 * Returns the first matching value found, or null if none exists.
 */
function extractPublishId(response) {
  if (!response || typeof response !== 'object') return null;
  const keys = new Set([
    'publish_id', 'publishid', 'post_id', 'postid',
    'share_url', 'shareurl', 'item_id', 'itemid',
    'video_id', 'videoid'
  ]);
  return findSafeValue(response, keys);
}

function findSafeValue(value, keys) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLowerCase()) && ['string', 'number', 'boolean'].includes(typeof child)) {
      return child;
    }
    const nested = findSafeValue(child, keys);
    if (nested !== null) return nested;
  }
  return null;
}

function describeQueryError(error) {
  const message = error && error.message ? error.message : String(error);
  const match = message.match(/https:\/\/console\.firebase\.google\.com\/[^\s)]+/);
  return { message, indexUrl: match ? match[0] : null };
}

module.exports = {
  getSchedulerState,
  getSchedulerHealth,
  publishNextPost,
  runSchedulerTick,
  processPost,
  _private: {
    claimPost,
    findDueJobs,
    isTransientPublishFailure,
    retryBackoffMs,
    describeQueryError,
    safeTikTokSummary,
    extractPublishId,
    finalize
  }
};
