'use strict';

// Platform batch intake: massive upload -> persisted batch + item records ->
// bounded-parallel AI preparation -> human review -> staggered acceptance.
//
// Boundaries, stated once:
// - Batch ITEMS are ordinary queue posts (drafts). Every existing safety
//   gate — the approvedAt human gate, claimPost's transactional refusal of
//   unapproved work, attempt budgets, history evidence — applies unchanged.
// - This module never publishes. Acceptance approves a draft and guarantees
//   its release slot is safely in the future; the scheduler remains the only
//   publisher.
// - Preparation is resumable: per-item transactional lease claims in
//   storage.js make interrupted work reclaimable without double-preparing.

const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const defaultConfig = require('./config');
const defaultStorage = require('./storage');
const defaultAutoCaption = require('./autoCaption');
const defaultApplicationService = require('./autoposterApplicationService');

class BatchServiceError extends Error {
  constructor(message, { status = 400, code = 'validation_failed', details = {} } = {}) {
    super(message);
    this.name = 'BatchServiceError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function deriveBatchId(userId, workspaceId, intakeKey) {
  const digest = createHash('sha256')
    .update(`${workspaceId}\n${userId}\n${intakeKey}`)
    .digest('hex')
    .slice(0, 40);
  return `batch-${digest}`;
}

// Streamed HTTPS download with a hard byte cap and timeout. Used to bring a
// durable Cloudinary asset back to local disk for FFmpeg analysis, so
// preparation survives restarts even though intake staging files are gone.
async function defaultDownloadMedia(mediaUrl, { timeoutMs, maxBytes, targetPath }) {
  const url = new URL(String(mediaUrl || ''));
  if (url.protocol !== 'https:') {
    throw new BatchServiceError('Preparation media must be an HTTPS URL.', { code: 'media_unreachable' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new BatchServiceError(`Media download failed with HTTP ${response.status}.`, { code: 'media_unreachable' });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) {
      throw new BatchServiceError('The media file is larger than the preparation limit.', { code: 'media_too_large' });
    }
    let received = 0;
    const handle = await fsPromises.open(targetPath, 'w');
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > maxBytes) {
          throw new BatchServiceError('The media file is larger than the preparation limit.', { code: 'media_too_large' });
        }
        await handle.write(chunk);
      }
    } finally {
      await handle.close();
    }
    return { bytes: received };
  } finally {
    clearTimeout(timer);
  }
}

function createBatchService(dependencies = {}) {
  const config = dependencies.config || defaultConfig;
  const storage = dependencies.storage || defaultStorage;
  const autoCaption = dependencies.autoCaption || defaultAutoCaption;
  const applicationService = dependencies.applicationService || defaultApplicationService;
  const downloadMedia = dependencies.downloadMedia || defaultDownloadMedia;
  const now = dependencies.now || (() => Date.now());
  const log = dependencies.logger || console;
  const settings = config.batchIntake;

  // One in-process preparation runner per batch. Cross-process safety comes
  // from the transactional per-item lease claims, not from this map.
  const activeRunners = new Map();

  async function resolveScope(context) {
    if (context.commercialContext && context.commercialContext.workspaceScope) {
      return context.commercialContext;
    }
    const resolved = await applicationService.getPlanUsage(context);
    return resolved.commercialContext;
  }

  function normalizeStagger(value) {
    if (value === undefined || value === null || value === '') return settings.staggerDefaultMinutes;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    if (parsed < settings.staggerMinMinutes || parsed > settings.staggerMaxMinutes) return null;
    return Math.round(parsed);
  }

  // ── Item view: derived validation, never duplicated canonical state ──────

  function itemValidation(post) {
    const problems = [];
    if (!String(post.mediaUrl || '').trim()) problems.push('missing_media');
    if (!String(post.caption || '').trim()) problems.push('missing_caption');
    // Provider-specific requirements follow the item's OWN destination: a
    // YouTube item cannot be accepted without the title its provider
    // contract requires (never silently derived from the caption).
    if (String(post.provider || '') === 'youtube') {
      const title = post.providerMetadata && post.providerMetadata.youtube
        ? String(post.providerMetadata.youtube.title || '').trim()
        : '';
      if (!title) problems.push('missing_youtube_title');
    }
    const preparation = post.preparation || null;
    if (preparation && (preparation.status === 'pending' || preparation.status === 'running')) {
      problems.push('preparation_in_progress');
    }
    const scheduledMs = post.scheduledAt ? Date.parse(post.scheduledAt) : NaN;
    if (!Number.isFinite(scheduledMs)) problems.push('missing_schedule');
    else if (scheduledMs < now() + settings.safetyBufferMinutes * 60_000 && !post.approved) {
      problems.push('schedule_in_past');
    }
    return problems;
  }

  function itemView(post) {
    const problems = itemValidation(post);
    const preparation = post.preparation || null;
    const prepStatus = preparation ? preparation.status : 'pending';
    let itemState;
    if (post.approved) itemState = 'accepted';
    else if (prepStatus === 'pending' || prepStatus === 'running') itemState = 'preparing';
    else if (prepStatus === 'failed' && problems.includes('missing_caption')) itemState = 'needs_attention';
    else if (problems.filter((problem) => !['schedule_in_past'].includes(problem)).length > 0) itemState = 'needs_attention';
    else itemState = 'ready';
    return {
      ...post,
      itemState,
      validationProblems: problems,
      // schedule_in_past never blocks acceptance: acceptance re-staggers to a
      // safe future slot, so it is a notice, not a defect.
      readyToAccept: !post.approved
        && ['pending', 'scheduled'].includes(post.status)
        && problems.filter((problem) => problem !== 'schedule_in_past').length === 0
    };
  }

  function deriveBatchStatus(items) {
    const total = items.length;
    const counts = {
      total,
      preparing: items.filter((item) => item.itemState === 'preparing').length,
      needsAttention: items.filter((item) => item.itemState === 'needs_attention').length,
      ready: items.filter((item) => item.itemState === 'ready').length,
      accepted: items.filter((item) => item.itemState === 'accepted').length,
      preparedOk: items.filter((item) => item.preparation && item.preparation.status === 'succeeded').length,
      prepareFailed: items.filter((item) => item.preparation && item.preparation.status === 'failed').length
    };
    let status;
    if (total === 0) status = 'empty';
    else if (counts.preparing > 0) status = 'preparing';
    else if (counts.accepted === total) status = 'completed';
    else if (counts.needsAttention > 0) status = 'attention_required';
    else status = 'ready';
    return { status, counts };
  }

  // ── Intake ───────────────────────────────────────────────────────────────

  async function createBatch(context, input = {}) {
    const files = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
    if (files.length === 0) {
      throw new BatchServiceError('Upload at least one video to create a batch.');
    }
    if (files.length > settings.maxItems) {
      throw new BatchServiceError(`A batch can contain at most ${settings.maxItems} videos.`, {
        code: 'batch_too_large'
      });
    }
    const staggerMinutes = normalizeStagger(input.staggerMinutes);
    if (staggerMinutes === null) {
      throw new BatchServiceError(
        `The stagger interval must be between ${settings.staggerMinMinutes} and ${settings.staggerMaxMinutes} minutes.`
      );
    }
    const provider = String(input.provider || 'tiktok').trim().toLowerCase();
    if (provider !== 'tiktok') {
      // v1 boundary, stated honestly: YouTube requires a per-video title and
      // keeps its dedicated single-video flow. The batch surface does not
      // silently invent titles.
      throw new BatchServiceError('Batch intake currently supports TikTok channels. Use the single-video flow for YouTube.', {
        code: 'provider_not_batchable'
      });
    }
    const accountId = String(input.accountId || '').trim();
    if (!accountId) {
      throw new BatchServiceError('Select a connected publishing channel for this batch.');
    }
    const intakeKey = String(input.intakeKey || '').trim() || randomUUID();

    const commercialContext = await resolveScope(context);
    const workspaceId = commercialContext.workspace.workspaceId;
    const batchId = deriveBatchId(context.userId, workspaceId, intakeKey);

    const existing = await storage.getBatchRecord(context.userId, batchId, commercialContext.workspaceScope);
    if (existing) {
      // Exact intake replay: return the durable truth; the route discards the
      // re-uploaded staging files. No second batch, no second usage charge.
      return { replayed: true, ...(await getBatchView(context, batchId)) };
    }

    const scheduleResult = await applicationService.schedulePost(context, {
      provider,
      accountIds: [accountId],
      files,
      caption: String(input.caption || ''),
      hashtags: String(input.hashtags || ''),
      batchId,
      schedule: {
        mode: 'staggered',
        startDate: String(input.startDate || '').trim(),
        startTime: String(input.startTime || '').trim(),
        timezoneName: input.timezoneName,
        timezoneOffsetMinutes: input.timezoneOffsetMinutes,
        staggerMinutes
      }
    });

    const account = scheduleResult.accounts[0];
    const record = await storage.createBatchRecord({
      batchId,
      userId: context.userId,
      workspaceId,
      provider,
      accountId: account.accountId,
      accountLabel: account.username ? `@${account.username}` : account.accountId,
      status: 'preparing',
      itemCount: scheduleResult.posts.length,
      staggerMinutes,
      baseAt: scheduleResult.schedule.plan.baseAt,
      timezoneName: scheduleResult.schedule.plan.timezone,
      intakeKey
    });

    startPreparation(context, batchId).catch((error) => {
      log.warn('[batch] preparation kickoff failed', { batchId, message: error.message });
    });

    return {
      replayed: false,
      batch: record,
      items: scheduleResult.posts.map(itemView)
    };
  }

  // ── Views ────────────────────────────────────────────────────────────────

  async function getBatchView(context, batchId, options = {}) {
    const commercialContext = await resolveScope(context);
    const record = await storage.getBatchRecord(context.userId, batchId, commercialContext.workspaceScope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const posts = await storage.getBatchPosts(context.userId, batchId, commercialContext.workspaceScope);
    const items = posts.map(itemView);
    const derived = deriveBatchStatus(items);

    // Resume-on-view: if durable item state says work is still owed and no
    // runner is active in this process, restart it. Idempotent via leases.
    if (options.autoResume !== false && derived.status === 'preparing' && !activeRunners.has(runnerKey(context.userId, batchId))) {
      startPreparation(context, batchId).catch((error) => {
        log.warn('[batch] preparation auto-resume failed', { batchId, message: error.message });
      });
    }

    return {
      batch: { ...record, status: derived.status, counts: derived.counts },
      items
    };
  }

  async function listBatches(context, limit = 20) {
    const commercialContext = await resolveScope(context);
    const records = await storage.listBatchRecords(context.userId, commercialContext.workspaceScope, limit);
    return { batches: records };
  }

  // ── Preparation engine ───────────────────────────────────────────────────

  function runnerKey(userId, batchId) {
    return `${userId}:${batchId}`;
  }

  async function startPreparation(context, batchId) {
    const key = runnerKey(context.userId, batchId);
    const existing = activeRunners.get(key);
    if (existing) return existing;

    const run = (async () => {
      try {
        await runPreparation(context, batchId);
      } finally {
        activeRunners.delete(key);
      }
    })();
    activeRunners.set(key, run);
    return run;
  }

  async function runPreparation(context, batchId) {
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const queue = posts
      .filter((post) => {
        const preparation = post.preparation;
        if (!preparation) return false;
        return preparation.status !== 'succeeded';
      })
      .sort((a, b) => (a.batchOrder ?? 0) - (b.batchOrder ?? 0));

    const concurrency = Math.max(1, settings.prepareConcurrency);
    let cursor = 0;
    const workers = [];
    for (let slot = 0; slot < Math.min(concurrency, queue.length); slot += 1) {
      workers.push((async () => {
        while (cursor < queue.length) {
          const post = queue[cursor];
          cursor += 1;
          await prepareOneItem(context.userId, post.id);
        }
      })());
    }
    await Promise.all(workers);
    await refreshBatchRecord(context, batchId, scope);
  }

  async function prepareOneItem(userId, postId) {
    const claim = await storage.claimBatchItemPreparation(userId, postId, {
      leaseMs: settings.prepareLeaseMinutes * 60_000,
      maxAttempts: settings.prepareMaxAttempts
    });
    if (claim.outcome !== 'claimed') return claim;

    const post = claim.post;
    let result;
    try {
      result = await generateItemCopy(post);
    } catch (error) {
      result = { ok: false, error: error.message || 'Preparation failed.' };
    }
    await storage.recordBatchItemPreparationResult(userId, postId, result);
    return { outcome: 'processed', ok: result.ok };
  }

  async function generateItemCopy(post) {
    const mediaUrl = String(post.mediaUrl || '').trim();
    if (!mediaUrl) {
      return { ok: false, error: 'The item has no durable media URL to analyze.' };
    }
    const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'chanter-batch-'));
    const extension = path.extname(String(post.fileName || '')).toLowerCase() || '.mp4';
    const tempPath = path.join(tempDir, `prepare${extension}`);
    try {
      await downloadMedia(mediaUrl, {
        timeoutMs: settings.downloadTimeoutMs,
        maxBytes: settings.maxDownloadBytes,
        targetPath: tempPath
      });
      const analysis = await autoCaption.analyzeVideoForCaption(
        tempPath,
        { caption: String(post.caption || ''), hashtags: String(post.hashtags || '') },
        { filename: String(post.originalName || post.fileName || '') }
      );
      return {
        ok: true,
        caption: analysis.caption,
        hashtags: analysis.hashtags,
        provider: analysis.provider || '',
        fallbackUsed: Boolean(analysis.fallbackUsed)
      };
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function refreshBatchRecord(context, batchId, scope) {
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const items = posts.map(itemView);
    const derived = deriveBatchStatus(items);
    await storage.updateBatchRecord(context.userId, batchId, {
      status: derived.status,
      itemCount: derived.counts.total,
      preparedCount: derived.counts.preparedOk,
      failedCount: derived.counts.prepareFailed,
      acceptedCount: derived.counts.accepted
    }, scope);
    return derived;
  }

  async function resumePreparation(context, batchId) {
    const view = await getBatchView(context, batchId, { autoResume: false });
    await startPreparation(context, batchId);
    return view;
  }

  // ── Review: edit + destination + accept ──────────────────────────────────

  async function findBatchItem(context, batchId, postId, workspaceScope) {
    const posts = await storage.getBatchPosts(context.userId, batchId, workspaceScope);
    const post = posts.find((candidate) => candidate.id === String(postId || '').trim());
    if (!post) {
      throw new BatchServiceError('This item does not belong to the batch.', { status: 404, code: 'not_found' });
    }
    return post;
  }

  async function updateItem(context, batchId, postId, input = {}) {
    const commercialContext = await resolveScope(context);
    let post = await findBatchItem(context, batchId, postId, commercialContext.workspaceScope);

    const patch = {};
    if (typeof input.caption === 'string') patch.caption = input.caption.trim().slice(0, 2200);
    if (typeof input.hashtags === 'string') patch.hashtags = input.hashtags.trim().slice(0, 500);
    const scheduleInput = input.scheduleInput && typeof input.scheduleInput === 'object'
      ? { value: String(input.scheduleInput.value || ''), timezoneOffsetMinutes: input.scheduleInput.timezoneOffsetMinutes }
      : undefined;
    const titleEdit = typeof input.youtubeTitle === 'string' || typeof input.youtubeDescription === 'string';
    if (Object.keys(patch).length === 0 && !scheduleInput && !titleEdit) {
      throw new BatchServiceError('Provide a caption, hashtags, a release time, or a YouTube title to update.');
    }

    // Provider-specific text lives behind the dedicated destination
    // operation (generic patches strip providerMetadata). Same destination,
    // new metadata — validated against the provider contract.
    if (titleEdit) {
      if (String(post.provider || '') !== 'youtube') {
        throw new BatchServiceError('A YouTube title applies only to items whose destination is YouTube.', {
          status: 409,
          code: 'provider_mismatch'
        });
      }
      const result = await applicationService.changePostDestination(context, {
        postId: post.id,
        provider: 'youtube',
        accountId: post.accountId,
        youtube: {
          ...(typeof input.youtubeTitle === 'string' ? { title: input.youtubeTitle } : {}),
          ...(typeof input.youtubeDescription === 'string' ? { description: input.youtubeDescription } : {})
        }
      });
      post = result.post;
    }

    if (Object.keys(patch).length > 0 || scheduleInput) {
      const updated = await applicationService.updatePost(context, {
        postId: post.id,
        accountId: post.accountId,
        patch,
        scheduleInput,
        historyEvent: { event: 'edited', detail: 'Batch review edit from the Platform.' }
      });
      post = updated.post;
    }
    return { item: itemView(post) };
  }

  async function changeItemDestination(context, batchId, postId, input = {}) {
    const commercialContext = await resolveScope(context);
    const post = await findBatchItem(context, batchId, postId, commercialContext.workspaceScope);

    const provider = String(input.provider || '').trim().toLowerCase();
    const accountId = String(input.accountId || '').trim();
    if (!provider || !accountId) {
      throw new BatchServiceError('Select a destination provider and connected channel.');
    }
    const youtube = provider === 'youtube'
      ? {
          ...(typeof input.youtubeTitle === 'string' ? { title: input.youtubeTitle } : {}),
          ...(typeof input.youtubeDescription === 'string' ? { description: input.youtubeDescription } : {})
        }
      : undefined;

    const result = await applicationService.changePostDestination(context, {
      postId: post.id,
      provider,
      accountId,
      youtube
    });
    return { item: itemView(result.post), identityChanged: result.identityChanged };
  }

  // Connected destinations the review surface may offer. Only connected
  // accounts of schedulable providers are listed; nothing is fabricated for
  // unconfigured providers.
  async function listDestinations(context) {
    const resolved = await applicationService.listConnectedAccounts(context);
    const schedulable = new Set(
      (resolved.providers || [])
        .filter((summary) => summary && summary.schedulable && summary.implementationStatus === 'active')
        .map((summary) => summary.id)
    );
    return {
      destinations: (resolved.accounts || [])
        .filter((account) => account.connectionStatus === 'connected' && schedulable.has(account.provider))
        .map((account) => ({
          provider: account.provider,
          providerDisplayName: account.providerDisplayName,
          accountId: account.accountId,
          label: account.username
            ? `@${account.username}`
            : (account.displayName || account.accountId),
          publishingReady: account.publishingReady === true
        }))
    };
  }

  async function acceptItems(context, batchId, input = {}) {
    if (!context.approval || !context.approval.approvedBy) {
      throw new BatchServiceError('Acceptance requires an explicit human approver.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const commercialContext = await resolveScope(context);
    const scope = commercialContext.workspaceScope;
    const record = await storage.getBatchRecord(context.userId, batchId, scope);
    if (!record) {
      throw new BatchServiceError('Batch not found for this workspace.', { status: 404, code: 'not_found' });
    }
    const posts = await storage.getBatchPosts(context.userId, batchId, scope);
    const items = posts.map(itemView);

    const requestedIds = input.postIds === 'all' || input.postIds === undefined
      ? null
      : new Set((Array.isArray(input.postIds) ? input.postIds : [input.postIds]).map((id) => String(id || '').trim()));

    const targets = items.filter((item) => {
      if (item.approved) return false;
      if (requestedIds) return requestedIds.has(item.id);
      return item.readyToAccept;
    });
    if (requestedIds) {
      for (const id of requestedIds) {
        if (!items.some((item) => item.id === id)) {
          throw new BatchServiceError(`Item ${id} does not belong to this batch.`, { status: 404, code: 'not_found' });
        }
      }
    }
    if (targets.length === 0) {
      return { accepted: [], failed: [], skipped: items.filter((item) => item.approved).map((item) => item.id) };
    }

    // Safe staggered acceptance: walk targets in release order and guarantee
    // every accepted slot is (a) at least the safety buffer in the future and
    // (b) at least one stagger interval after the previous accepted slot.
    // Nothing is ever pulled earlier, so nothing can publish immediately.
    const staggerMs = Math.max(1, record.staggerMinutes || settings.staggerDefaultMinutes) * 60_000;
    const bufferMs = settings.safetyBufferMinutes * 60_000;
    const ordered = [...targets].sort((a, b) => {
      const aMs = a.scheduledAt ? Date.parse(a.scheduledAt) : Number.MAX_SAFE_INTEGER;
      const bMs = b.scheduledAt ? Date.parse(b.scheduledAt) : Number.MAX_SAFE_INTEGER;
      if (aMs !== bMs) return aMs - bMs;
      return (a.batchOrder ?? 0) - (b.batchOrder ?? 0);
    });

    const accepted = [];
    const failed = [];
    let previousMs = 0;
    for (const item of ordered) {
      try {
        if (!item.readyToAccept) {
          throw new BatchServiceError(
            item.itemState === 'preparing'
              ? 'This item is still being prepared.'
              : `This item is not ready: ${item.validationProblems.join(', ') || item.itemState}.`,
            { status: 409, code: 'item_not_ready' }
          );
        }
        // Destination truth may have changed since review rendered: the
        // item's OWN provider/account must still resolve to a connected,
        // publishing-ready channel at the moment of acceptance.
        try {
          await applicationService.validateConnectedAccount(context, {
            provider: item.provider,
            accountId: item.accountId
          });
        } catch (error) {
          throw new BatchServiceError(
            `The destination channel is no longer available: ${error.message}`,
            { status: 409, code: 'destination_unavailable' }
          );
        }
        const currentMs = item.scheduledAt ? Date.parse(item.scheduledAt) : NaN;
        const minimumMs = Math.max(
          now() + bufferMs,
          previousMs > 0 ? previousMs + staggerMs : 0
        );
        let finalMs = Number.isFinite(currentMs) ? currentMs : minimumMs;
        if (finalMs < minimumMs) finalMs = minimumMs;
        if (finalMs !== currentMs) {
          await applicationService.updatePost(context, {
            postId: item.id,
            accountId: item.accountId,
            patch: { scheduledAt: new Date(finalMs).toISOString() },
            historyEvent: {
              event: 'rescheduled',
              detail: `Moved to ${new Date(finalMs).toISOString()} at acceptance to keep a safe staggered release.`
            }
          });
        }
        const approval = await applicationService.approvePost(context, {
          postId: item.id,
          accountId: item.accountId,
          approvedBy: context.approval.approvedBy
        });
        if (!approval.ok) {
          throw new BatchServiceError('Approval was refused for this item.', { status: 409, code: 'approval_refused' });
        }
        previousMs = finalMs;
        accepted.push({ id: item.id, scheduledAt: new Date(finalMs).toISOString() });
      } catch (error) {
        failed.push({ id: item.id, reason: error.message || 'Acceptance failed.' });
      }
    }

    const derived = await refreshBatchRecord(context, batchId, scope);
    return { accepted, failed, skipped: [], batchStatus: derived.status };
  }

  return {
    createBatch,
    getBatchView,
    listBatches,
    listDestinations,
    resumePreparation,
    startPreparation,
    updateItem,
    changeItemDestination,
    acceptItems,
    // Exposed for tests: deterministic identity + derived views.
    deriveBatchId,
    itemView,
    deriveBatchStatus
  };
}

const defaultService = createBatchService();

module.exports = {
  BatchServiceError,
  createBatchService,
  deriveBatchId,
  ...defaultService
};
