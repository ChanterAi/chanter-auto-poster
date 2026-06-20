'use strict';

const cron = require('node-cron');
const config = require('./config');
const { postsCollection, getFirestore, Timestamp, FieldValue } = require('./firestore');
const { postFromDoc } = require('./postsMapper');
const { publishPhotoPost } = require('./tiktok');

const STALE_LOCK_MS = Math.max(1, config.scheduler.staleLockMinutes) * 60 * 1000;
const MAX_CLAIM_ATTEMPTS = Math.max(1, config.scheduler.maxClaimAttempts);
const TICK_BATCH_SIZE = Math.max(1, config.scheduler.batchSize);
// Identifies which process/instance is holding a lock — useful in logs and
// in the `lockedBy` field if you ever need to debug a stuck post by hand.
const WORKER_ID = `${process.env.RENDER_INSTANCE_ID || 'local'}-${process.pid}`;

let task = null;
const schedulerState = {
  startedAt: null,
  lastTickStartedAt: null,
  lastTickFinishedAt: null,
  lastResult: null,
  lastError: null,
  skippedTicks: 0
};
let tickInFlight = false; // politeness only — see note in runSchedulerTick().

function startScheduler() {
  if (task) return task;

  task = cron.schedule('* * * * *', () => {
    runSchedulerTick().catch((error) => {
      console.error('[scheduler] tick failed:', error);
    });
  });

  schedulerState.startedAt = new Date().toISOString();

  return task;
}

function getSchedulerState() {
  return {
    ...schedulerState,
    running: Boolean(task),
    tickInFlight,
    workerId: WORKER_ID
  };
}

/**
 * One pass: reclaim anything stuck from a crash, then claim and publish
 * whatever is currently due.
 *
 * `tickInFlight` only prevents two ticks overlapping *within this one
 * process* — it is NOT what makes this safe to call concurrently or from
 * multiple Render instances. That guarantee comes entirely from the
 * Firestore transaction inside claimPost(): if two processes (or this
 * in-process cron and an external ping to /run-scheduler) both try to
 * claim the same post at the same moment, Firestore lets exactly one
 * transaction win and the other sees status is no longer "pending" and
 * backs off. This flag just avoids a bit of wasted work, nothing more.
 */
async function runSchedulerTick({ batchSize = TICK_BATCH_SIZE } = {}) {
  if (tickInFlight) {
    schedulerState.skippedTicks += 1;
    return { ok: true, skipped: true, reason: 'Previous tick still running on this instance' };
  }

  tickInFlight = true;
  schedulerState.lastTickStartedAt = new Date().toISOString();
  try {
    await reclaimStaleLocks();
    const dueIds = await findDuePostIds(batchSize);

    const results = [];
    for (const id of dueIds) {
      results.push(await processPost(id, { force: false, workerId: WORKER_ID }));
    }

    const result = { ok: true, processed: results.length, dueIds, results };
    schedulerState.lastResult = result;
    schedulerState.lastError = null;
    return result;
  } catch (error) {
    schedulerState.lastError = {
      message: error.message || String(error),
      at: new Date().toISOString()
    };
    throw error;
  } finally {
    schedulerState.lastTickFinishedAt = new Date().toISOString();
    tickInFlight = false;
  }
}

// Name kept for compatibility with the existing /run-scheduler route.
async function publishNextPost() {
  return runSchedulerTick();
}

async function findDuePostIds(limit) {
  const now = Timestamp.now();
  const snapshot = await postsCollection()
    .where('status', '==', 'pending')
    .where('scheduledTimeUTC', '<=', now)
    .orderBy('scheduledTimeUTC', 'asc')
    .limit(limit)
    .get();

  return snapshot.docs.map((doc) => doc.id);
}

async function reclaimStaleLocks() {
  const threshold = Timestamp.fromMillis(Date.now() - STALE_LOCK_MS);
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
      if (data.status !== 'processing') return; // already resolved elsewhere

      const attempts = Number(data.claimAttempts || 0);

      if (attempts >= MAX_CLAIM_ATTEMPTS) {
        tx.update(ref, {
          status: 'failed',
          lockedAt: null,
          lockedBy: null,
          updatedAt: FieldValue.serverTimestamp(),
          lastResult: {
            ok: false,
            mode: 'api',
            reason: `Gave up after ${attempts} attempts — the worker likely crashed mid-publish each time.`,
            completedAt: new Date().toISOString()
          }
        });
        return;
      }

      // Send it back to pending so the next tick (or a manual "Post now")
      // picks it up again. This is the actual crash-recovery mechanism:
      // nothing needs to "remember" this post was in flight — Firestore
      // already has it, just no longer marked as claimed.
      tx.update(ref, {
        status: 'pending',
        lockedAt: null,
        lockedBy: null,
        updatedAt: FieldValue.serverTimestamp()
      });
    });
  } catch (error) {
    console.error('[scheduler] failed to reclaim stale lock', ref.id, error);
  }
}

/**
 * The only place a post's status moves to "processing". Runs as a single
 * Firestore transaction: read current state, decide, write — if another
 * worker's transaction commits first, this one's read no longer matches
 * and Firestore aborts/retries it automatically, so at most one caller
 * ever succeeds for a given post.
 */
async function claimPost(id, { force, workerId }) {
  const ref = postsCollection().doc(id);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;

    const data = snap.data();
    if (data.status === 'processing') return null; // never double-claim

    if (!force) {
      if (data.status !== 'pending') return null;
      const now = Timestamp.now();
      if (!data.scheduledTimeUTC || data.scheduledTimeUTC.toMillis() > now.toMillis()) return null;
    }

    tx.update(ref, {
      status: 'processing',
      lockedAt: FieldValue.serverTimestamp(),
      lockedBy: workerId,
      claimAttempts: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    });

    const claimed = postFromDoc(snap);
    claimed.status = 'processing'; // snap predates the write above
    return claimed;
  });
}

/**
 * Claim-then-publish-then-finalize for one post. Safe to call from the
 * automatic tick (force: false — must be pending and due) or from the
 * "Post now" button (force: true — anything except already-processing).
 * Either path goes through the same transaction, so a double-click and a
 * tick racing each other can't both publish.
 */
async function processPost(id, { force = false, workerId = `manual-${process.pid}` } = {}) {
  const claimed = await claimPost(id, { force, workerId });
  if (!claimed) {
    return {
      ok: false,
      mode: 'skipped',
      postId: id,
      reason: 'Not claimable right now (already publishing, already handled, or not due yet).'
    };
  }

  let result;
  try {
    result = await publishPhotoPost(claimed);
  } catch (error) {
    result = {
      ok: false,
      mode: 'api',
      reason: error.message || 'Unexpected publish error',
      response: error.response || null
    };
  }

  return finalize(id, workerId, result);
}

async function finalize(id, workerId, result) {
  const ref = postsCollection().doc(id);
  const completedAt = new Date().toISOString();

  // Guarded: only the worker that still holds the lock may finalize it. If
  // the stale-lock watchdog already reclaimed this post (this worker took
  // too long and a retry is already underway elsewhere), step aside rather
  // than clobbering the retry with a late result.
  const guardedUpdate = async (fields) => {
    let applied = false;
    await getFirestore().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data();
      if (data.status !== 'processing' || data.lockedBy !== workerId) return;
      tx.update(ref, { ...fields, updatedAt: FieldValue.serverTimestamp() });
      applied = true;
    });
    return applied;
  };

  if (result.ok) {
    await guardedUpdate({
      status: 'posted',
      postedAt: Timestamp.now(),
      readyAt: null,
      lockedAt: null,
      lockedBy: null,
      lastResult: { ...result, completedAt }
    });
    return { ok: true, mode: result.mode, postId: id };
  }

  if (result.mode === 'manual') {
    await guardedUpdate({
      status: 'ready',
      readyAt: Timestamp.now(),
      lockedAt: null,
      lockedBy: null,
      lastResult: { ...result, completedAt }
    });
    return { ok: false, mode: 'manual', postId: id, reason: result.reason };
  }

  await guardedUpdate({
    status: 'failed',
    lockedAt: null,
    lockedBy: null,
    lastResult: { ...result, completedAt }
  });
  return { ok: false, mode: result.mode || 'api', postId: id, reason: result.reason };
}

module.exports = {
  startScheduler,
  getSchedulerState,
  publishNextPost,
  runSchedulerTick,
  processPost
};
