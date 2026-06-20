'use strict';

const { randomUUID } = require('crypto');
const config = require('./config');
const { postsCollection, getFirestore, Timestamp, FieldValue } = require('./firestore');
const { postFromDoc, toTimestampOrNull } = require('./postsMapper');
const { publishPhotoPost } = require('./tiktok');

const STALE_LOCK_MS = Math.max(1, config.scheduler.staleLockMinutes) * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = Math.max(1, config.scheduler.maxClaimAttempts);

function getSchedulerState() {
  return {
    mode: 'external_cron',
    persistent: true,
    inMemoryTimer: false,
    schedule: 'every minute',
    endpoint: '/api/cron/tick'
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
    result = await publishPhotoPost(claimed);
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

async function finalize(id, workerId, result) {
  const ref = postsCollection().doc(id);
  const completedAt = new Date().toISOString();
  const reason = result.reason || 'TikTok publish failed';
  let applied = false;

  await getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    if (data.status !== 'processing' || data.lockedBy !== workerId) return;

    if (result.ok) {
      tx.update(ref, {
        status: 'posted',
        postedAt: Timestamp.now(),
        readyAt: null,
        failedAt: null,
        errorMessage: null,
        lockedAt: null,
        lockedBy: null,
        lastResult: { ...result, completedAt },
        updatedAt: FieldValue.serverTimestamp()
      });
    } else {
      tx.update(ref, {
        status: 'failed',
        failedAt: Timestamp.now(),
        errorMessage: reason,
        lockedAt: null,
        lockedBy: null,
        lastResult: { ...result, completedAt },
        updatedAt: FieldValue.serverTimestamp()
      });
    }
    applied = true;
  });

  if (!applied) {
    return { ok: false, mode: 'skipped', postId: id, reason: 'Job lock changed before completion.' };
  }
  if (result.ok) return { ok: true, mode: result.mode || 'api', postId: id };
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
  publishNextPost,
  runSchedulerTick,
  processPost,
  _private: {
    claimPost,
    findDueJobs,
    describeQueryError,
    safeTikTokSummary
  }
};
