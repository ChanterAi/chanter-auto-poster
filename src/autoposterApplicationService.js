'use strict';

// AutoPoster's product-level application boundary. Browser, client-portal,
// and Agent Runtime controllers translate transport input into these
// operations; Firestore/media/provider details stay in their existing modules.

const { createHash } = require('crypto');
const storage = require('./storage');
const mediaPolicy = require('./mediaPolicy');
const providers = require('./providers');
const connectedAccounts = require('./connectedAccounts');
const { parseDateTimeLocal } = require('./timeUtil');
const { computeMaxSchedulePlan } = require('./maxScheduler');
const { validateYouTubeMetadata } = require('./youtube');

const PROVIDER_TIKTOK = providers.PROVIDER_TIKTOK;
const PROVIDER_YOUTUBE = providers.PROVIDER_YOUTUBE;
const REQUEST_SOURCES = new Set(['website', 'runtime', 'internal_worker']);
const DEFAULT_QUEUE_LIMIT = 100;
const MAX_QUEUE_LIMIT = 1000;
const INTERNAL_PLAN_DUE_GRACE_MS = 60_000;
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

class AutoPosterApplicationError extends Error {
  constructor(message, { status = 400, code = 'validation_failed', details = {} } = {}) {
    super(message);
    this.name = 'AutoPosterApplicationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// Provider-domain failures surface through the same application error type
// every controller already knows how to render.
function translateProviderError(error) {
  if (error instanceof providers.ProviderError) {
    return new AutoPosterApplicationError(error.message, {
      status: error.status,
      code: error.code,
      details: error.details
    });
  }
  return error;
}

function createExecutionContext(input = {}) {
  const userId = String(input.userId || '').trim();
  if (!userId) {
    throw new AutoPosterApplicationError('An authenticated AutoPoster owner is required.', {
      status: 401,
      code: 'unauthorized'
    });
  }

  const source = String(input.source || '').trim();
  if (!REQUEST_SOURCES.has(source)) {
    throw new AutoPosterApplicationError('request source must be website, runtime, or internal_worker.');
  }

  const approvedBy = String((input.approval && input.approval.approvedBy) || '').trim();
  const idempotencyKey = String(
    (input.idempotency && input.idempotency.key) || input.idempotencyKey || ''
  ).trim();

  return Object.freeze({
    userId,
    actorId: String(input.actorId || userId).trim() || userId,
    accountId: String(input.accountId || '').trim(),
    // The current product has no workspace model. Keep the slot explicit and
    // empty instead of pretending userId is a workspace identifier.
    workspaceId: String(input.workspaceId || '').trim() || null,
    source,
    correlationId: String(input.correlationId || '').trim(),
    approval: approvedBy ? Object.freeze({ approvedBy }) : null,
    idempotency: Object.freeze({ key: idempotencyKey })
  });
}

function countQueueItems(posts) {
  return (Array.isArray(posts) ? posts : []).reduce((counts, post) => {
    counts.total += 1;
    const status = String((post && post.status) || 'pending').toLowerCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 });
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function uploadRejectionCode(fileName, mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  const lowerName = String(fileName || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image_mime';
  if (mime.startsWith('video/')) return 'mime_extension_mismatch';
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(lowerName)) return 'image_extension';
  return 'unsupported_media';
}

function normalizeAccountIds(context, input = {}) {
  const raw = Array.isArray(input.accountIds)
    ? input.accountIds
    : [input.accountId || context.accountId];
  return [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
}

function normalizeExplicitSchedule(value, { requireExplicitTimezone = false, requireFuture = false, nowMs = Date.now() } = {}) {
  const raw = String(value || '').trim();
  if (requireExplicitTimezone && !ISO_WITH_ZONE_PATTERN.test(raw)) {
    throw new AutoPosterApplicationError(
      'scheduledAt must be ISO-8601 with an explicit timezone, e.g. 2026-07-11T09:00:00Z.'
    );
  }
  const scheduledMs = Date.parse(raw);
  if (!raw || Number.isNaN(scheduledMs)) {
    throw new AutoPosterApplicationError('scheduledAt is not a parseable timestamp.');
  }
  if (requireFuture && scheduledMs <= nowMs) {
    throw new AutoPosterApplicationError('scheduledAt must be in the future.');
  }
  return new Date(scheduledMs).toISOString();
}

function deterministicPostId(userId, accountId, idempotencyKey) {
  const digest = createHash('sha256')
    .update(`${userId}\n${accountId}\n${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40);
  return `runtime-${digest}`;
}

function isAlreadyExistsError(error) {
  const code = error && error.code;
  return code === 6 || code === '6' || code === 'already-exists' || code === 'ALREADY_EXISTS';
}

function createAutoPosterApplicationService(dependencies = {}) {
  const storageAdapter = dependencies.storage || storage;
  const policy = dependencies.mediaPolicy || mediaPolicy;
  const now = dependencies.now || (() => Date.now());
  const maxSchedulePlanner = dependencies.computeMaxSchedulePlan || computeMaxSchedulePlan;

  function toConnectedAccountView(account) {
    try {
      return connectedAccounts.toConnectedAccount(account, { now: now() });
    } catch (error) {
      throw translateProviderError(error);
    }
  }

  // One account lookup per provider — the sole account-resolution dispatch
  // point in the service. Unknown providers fail closed.
  async function getProviderAccount(context, providerId, accountId) {
    if (providerId === PROVIDER_YOUTUBE) {
      return storageAdapter.getYouTubeAccount(context.userId, accountId);
    }
    if (providerId === PROVIDER_TIKTOK) {
      return storageAdapter.getTikTokAccount(context.userId, accountId);
    }
    throw new AutoPosterApplicationError(`Unsupported publishing provider: ${providerId || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }

  async function resolveOwnedAccounts(context, accountIds, { requireConnected = true, provider = PROVIDER_TIKTOK } = {}) {
    if (accountIds.length === 0) {
      throw new AutoPosterApplicationError('Select a connected publishing channel before creating scheduled posts.');
    }

    const accounts = [];
    for (const accountId of accountIds) {
      const account = await getProviderAccount(context, provider, accountId);
      if (!account) {
        throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
          status: 404,
          code: 'not_found'
        });
      }
      const view = toConnectedAccountView(account);
      if (view.ownerUserId !== context.userId || view.accountId !== accountId) {
        throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
          status: 404,
          code: 'not_found'
        });
      }
      if (
        view.provider !== provider
        || view.connectionId !== connectedAccounts.connectionId(provider, accountId)
      ) {
        throw new AutoPosterApplicationError(
          'Selected publishing channel does not match the requested provider.',
          {
            status: 409,
            code: 'provider_account_mismatch',
            details: { accountId, requestedProvider: provider, accountProvider: view.provider }
          }
        );
      }
      if (requireConnected && view.connectionStatus === connectedAccounts.CONNECTION_STATUS.DISCONNECTED) {
        throw new AutoPosterApplicationError('Publishing channel needs to be reconnected before it can be scheduled.', {
          status: 409
        });
      }
      if (requireConnected) {
        // Connection existence and publishing readiness are different: a
        // connected channel may still be blocked (token expired without a
        // refresh token, or a recorded scope that excludes video.publish).
        if (!view.publishingReady) {
          const blocker = view.readinessBlockers[0];
          throw new AutoPosterApplicationError(
            `Publishing channel is not ready: ${connectedAccounts.describeReadinessBlocker(blocker)}.`,
            {
              status: 409,
              code: 'account_not_ready',
              details: { accountId: view.accountId, blockers: view.readinessBlockers }
            }
          );
        }
      }
      accounts.push(account);
    }
    return accounts;
  }

  // Ownership check for scope filters (queue listing, status lookup): the
  // accountId may belong to either provider; the caller only needs proof
  // the channel exists and is owned by this tenant.
  async function findOwnedAccountAnyProvider(context, accountId) {
    const tiktok = await storageAdapter.getTikTokAccount(context.userId, accountId);
    if (tiktok) return tiktok;
    const youtube = typeof storageAdapter.getYouTubeAccount === 'function'
      ? await storageAdapter.getYouTubeAccount(context.userId, accountId)
      : null;
    if (youtube) return youtube;
    throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
      status: 404,
      code: 'not_found'
    });
  }

  function validateMedia(contextInput, input = {}) {
    createExecutionContext(contextInput);
    const mediaUrl = String(input.mediaUrl || input.publicMediaUrl || '').trim();
    const providedFiles = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
    const standaloneFile = input.fileName || input.mimeType
      ? { originalname: String(input.fileName || ''), mimetype: String(input.mimeType || '') }
      : null;
    const files = providedFiles.length > 0 ? providedFiles : (standaloneFile ? [standaloneFile] : []);

    if (!mediaUrl && files.length === 0) {
      throw new AutoPosterApplicationError('Provide mediaUrl, or fileName/mimeType, to validate media.');
    }

    const contract = {
      videoOnly: true,
      allowedExtensions: policy.VIDEO_EXTENSIONS,
      validator: 'mediaPolicy.js'
    };
    const rejected = (rejectionCode, reason) => ({
      valid: false,
      classification: 'rejected',
      rejectionCode,
      reason,
      policy: contract
    });

    if (mediaUrl) {
      if (!isHttpsUrl(mediaUrl)) {
        return rejected('not_https_url', 'Public Media URL must be a valid HTTPS URL.');
      }
      if (!policy.isVideoMediaUrl(mediaUrl)) {
        return rejected('unsupported_url', policy.VIDEO_ONLY_URL_MESSAGE);
      }
    }

    for (const file of files) {
      if (!policy.isVideoUploadFile(file)) {
        return rejected(
          uploadRejectionCode(file.originalname, file.mimetype),
          policy.VIDEO_ONLY_UPLOAD_MESSAGE
        );
      }
    }

    return { valid: true, classification: 'video', policy: contract };
  }

  async function listQueue(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const accountId = String(input.accountId || context.accountId || '').trim();
    const rawLimit = input.limit === undefined ? DEFAULT_QUEUE_LIMIT : Number(input.limit);
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_QUEUE_LIMIT) {
      throw new AutoPosterApplicationError(`limit must be an integer between 1 and ${MAX_QUEUE_LIMIT}.`);
    }
    if (accountId) await findOwnedAccountAnyProvider(context, accountId);

    const posts = await storageAdapter.getPosts(context.userId, accountId || undefined);
    const items = posts.slice(0, rawLimit);
    return {
      items,
      count: items.length,
      totalInScope: posts.length,
      counts: countQueueItems(posts),
      scope: { accountId: accountId || 'all' }
    };
  }

  async function getPostStatus(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const postId = String(input.postId || input.id || '').trim();
    const accountId = String(input.accountId || context.accountId || '').trim() || undefined;
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    const post = await storageAdapter.getPost(context.userId, postId, accountId);
    if (!post) {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    return { post };
  }

  function resolveSchedule(context, input, accounts) {
    const schedule = input.schedule || {};
    const mode = String(schedule.mode || 'automatic').trim();
    if (mode === 'automatic') return { mode };

    if (mode === 'explicit') {
      return {
        mode,
        scheduledAt: normalizeExplicitSchedule(schedule.scheduledAt, {
          requireExplicitTimezone: Boolean(schedule.requireExplicitTimezone),
          // Future enforcement happens only after idempotency replay lookup so
          // a delayed retry can still return the item created by the original.
          requireFuture: false,
          nowMs: now()
        }),
        requireFuture: Boolean(schedule.requireFuture)
      };
    }

    if (mode === 'browser_local') {
      const raw = String(schedule.value || '').trim();
      if (!raw) return { mode: 'automatic' };
      const scheduledAt = parseDateTimeLocal(raw, schedule.timezoneOffsetMinutes);
      if (!scheduledAt) {
        throw new AutoPosterApplicationError('The posting date/time could not be parsed.');
      }
      return { mode: 'explicit', scheduledAt };
    }

    if (mode === 'max') {
      const plan = maxSchedulePlanner({
        startDate: schedule.startDate,
        startTime: schedule.startTime,
        timezoneOffsetMinutes: schedule.timezoneOffsetMinutes,
        offsetMinutes: schedule.offsetMinutes,
        channels: accounts.map((account) => ({
          accountId: account.accountId,
          tiktokOpenId: account.open_id,
          username: account.username,
          connected: account.connected
        }))
      });
      if (!plan.ok) throw new AutoPosterApplicationError(plan.reason);
      return { mode, plan };
    }

    if (mode === 'explicit_plan') {
      if (context.source !== 'internal_worker') {
        throw new AutoPosterApplicationError('Explicit schedule plans are restricted to the controlled internal workflow.', {
          status: 403,
          code: 'forbidden'
        });
      }
      const rawPlan = schedule.plan || {};
      const rawChannels = Array.isArray(rawPlan.channels) ? rawPlan.channels : [];
      const expectedIds = accounts.map((account) => account.accountId);
      const planIds = rawChannels.map((channel) => String((channel && channel.accountId) || '').trim());
      if (
        rawChannels.length !== accounts.length
        || new Set(planIds).size !== accounts.length
        || expectedIds.some((accountId) => !planIds.includes(accountId))
      ) {
        throw new AutoPosterApplicationError('The explicit schedule plan must contain each selected channel exactly once.');
      }
      const validationNowMs = now();
      const normalizePlanTimestamp = (value) => {
        const normalized = normalizeExplicitSchedule(value);
        // The existing controlled CLI accepts --buffer-minutes 0. Preserve
        // that due-now behavior without accepting an arbitrarily stale plan
        // after the human confirmation and service hand-off.
        if (Date.parse(normalized) < validationNowMs - INTERNAL_PLAN_DUE_GRACE_MS) {
          throw new AutoPosterApplicationError('The controlled schedule plan is stale; rebuild it before creating queue items.');
        }
        return normalized;
      };
      const channels = rawChannels.map((channel, index) => ({
        accountId: String(channel.accountId),
        scheduledAt: normalizePlanTimestamp(channel.scheduledAt),
        offsetMinutes: Number(channel.offsetMinutes || 0),
        order: Number.isInteger(Number(channel.order)) ? Number(channel.order) : index
      }));
      return {
        mode: 'max',
        plan: {
          baseAt: normalizePlanTimestamp(rawPlan.baseAt || channels[0].scheduledAt),
          offsetMinutes: Number(rawPlan.offsetMinutes || 0),
          channels
        }
      };
    }

    throw new AutoPosterApplicationError(`Unsupported scheduling mode: ${mode}.`);
  }

  function partialScheduleError(created, reason) {
    const ids = created.map((post) => post.id);
    return new AutoPosterApplicationError(reason, {
      status: 500,
      code: 'internal',
      details: {
        createdPostId: ids.length === 1 ? ids[0] : undefined,
        createdPostIds: ids
      }
    });
  }

  async function schedulePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    // Provider gate: a request without a provider targets TikTok (the only
    // active provider); an explicit provider must resolve through the
    // registry and be schedulable. Unknown and non-active providers fail
    // closed here, before any account, media, or queue work happens.
    const requestedProvider = providers.normalizeStoredProviderId(input.provider);
    let providerDefinition;
    try {
      providerDefinition = providers.assertSchedulableProvider(requestedProvider.providerId);
      providers.assertProviderCapability(providerDefinition.id, 'schedulable');
    } catch (error) {
      throw translateProviderError(error);
    }
    const provider = providerDefinition.id;

    // Provider-specific metadata contract. YouTube requires an explicit,
    // valid title (no silent caption-to-title mapping); TikTok requests
    // must not be burdened with YouTube fields.
    let youtubeMetadata = null;
    if (provider === PROVIDER_YOUTUBE) {
      const rawYouTube = input.youtube && typeof input.youtube === 'object' ? input.youtube : {};
      const checked = validateYouTubeMetadata({
        title: rawYouTube.title,
        description: rawYouTube.description
      });
      if (!checked.ok) {
        throw new AutoPosterApplicationError(checked.reason, { code: 'invalid_provider_metadata' });
      }
      youtubeMetadata = { title: checked.title, description: checked.description };
    }

    const accountIds = normalizeAccountIds(context, input);
    const accounts = await resolveOwnedAccounts(context, accountIds, { provider });
    const schedule = resolveSchedule(context, input, accounts);
    const idempotencyKey = context.idempotency.key;

    if (context.source === 'runtime' && !idempotencyKey) {
      throw new AutoPosterApplicationError('idempotencyKey is required.');
    }
    if (idempotencyKey && accounts.length !== 1) {
      throw new AutoPosterApplicationError('An idempotent schedule request must target exactly one publishing channel.');
    }

    const duplicateResult = (existing) => {
      const scheduleWasApplied = Boolean(existing.scheduledAt)
        && ['scheduled', 'processing', 'ready', 'posted', 'failed'].includes(existing.status);
      if (schedule.mode === 'explicit' && !scheduleWasApplied) {
        throw new AutoPosterApplicationError(
          'This idempotency key belongs to an existing incomplete draft. Review that queue item before retrying.',
          {
            status: 409,
            details: { createdPostId: existing.id }
          }
        );
      }
      return { duplicate: true, posts: [existing], post: existing, scheduledCount: 1, schedule, accounts };
    };

    let deterministicId = '';
    if (idempotencyKey) {
      const existingPosts = await storageAdapter.getPosts(context.userId, accounts[0].accountId);
      const existing = existingPosts.find((post) =>
        post.idempotencyKey === idempotencyKey || post.runtimeIdempotencyKey === idempotencyKey
      );
      if (existing) return duplicateResult(existing);
      deterministicId = deterministicPostId(context.userId, accounts[0].accountId, idempotencyKey);
      const deterministicExisting = await storageAdapter.getPost(
        context.userId,
        deterministicId,
        accounts[0].accountId
      );
      if (deterministicExisting) {
        return duplicateResult(deterministicExisting);
      }
    }

    if (
      schedule.mode === 'explicit'
      && schedule.requireFuture
      && Date.parse(schedule.scheduledAt) <= now()
    ) {
      throw new AutoPosterApplicationError('scheduledAt must be in the future.');
    }

    const media = validateMedia(context, {
      files: input.files,
      mediaUrl: input.mediaUrl || input.publicMediaUrl
    });
    if (!media.valid) throw new AutoPosterApplicationError(media.reason);

    const firstAccount = accounts[0];
    const selfApprove = context.source === 'website' && context.approval
      ? { approvedBy: context.approval.approvedBy }
      : null;
    const requestedBy = String(input.requestedBy || context.actorId || '').trim();
    const creationDefaults = {
      caption: String(input.caption || '').trim(),
      hashtags: String(input.hashtags || '').trim(),
      publicMediaUrl: String(input.mediaUrl || input.publicMediaUrl || '').trim(),
      accounts: accounts.map((account) => ({
        accountId: account.accountId,
        tiktokOpenId: provider === PROVIDER_TIKTOK ? account.open_id : '',
        username: account.username
      })),
      // Preserve the legacy single-account constructor contract.
      accountId: firstAccount.accountId,
      tiktokOpenId: provider === PROVIDER_TIKTOK ? firstAccount.open_id : '',
      username: firstAccount.username,
      preparedMedia: input.preparedMedia,
      selfApprove,
      provider,
      // Bounded provider metadata; storage locks privacyStatus to 'private'
      // and notifySubscribers to false at write time.
      providerMetadata: youtubeMetadata ? { youtube: youtubeMetadata } : undefined,
      creationSource: context.source,
      createdBy: context.actorId,
      correlationId: context.correlationId,
      idempotencyKey,
      runtimeIdempotencyKey: context.source === 'runtime' ? idempotencyKey : '',
      runtimeScheduledBy: context.source === 'runtime' ? requestedBy : '',
      scheduledAt: schedule.mode === 'explicit' ? schedule.scheduledAt : '',
      scheduleHistory: schedule.mode === 'explicit'
        ? (context.source === 'runtime'
            ? {
                event: 'runtime_scheduled',
                detail: `Scheduled via Agent Runtime by ${requestedBy || 'agent-runtime'} for ${schedule.scheduledAt}. Draft awaits human approval before publishing.`
              }
            : { event: 'scheduled', detail: `Posting time set during website intake for ${schedule.scheduledAt}.` })
        : null,
      documentId: deterministicId,
      createOnly: Boolean(deterministicId)
    };

    let created;
    try {
      created = await storageAdapter.addUploadedPosts(
        context.userId,
        Array.isArray(input.files) ? input.files : [],
        creationDefaults
      );
    } catch (error) {
      if (deterministicId && isAlreadyExistsError(error)) {
        const existing = await storageAdapter.getPost(context.userId, deterministicId, firstAccount.accountId);
        if (existing) return duplicateResult(existing);
      }
      throw error;
    }

    if (!Array.isArray(created) || created.length === 0) {
      throw new AutoPosterApplicationError('AutoPoster did not create a queue item.', {
        status: 500,
        code: 'internal'
      });
    }
    if (input.requireSingle && created.length !== 1) {
      throw partialScheduleError(
        created,
        `Expected exactly one queue item, got ${created.length}. The created items remain unscheduled drafts.`
      );
    }

    try {
      if (schedule.mode === 'explicit') {
        if (created.some((post) => !post.scheduledAt || post.status !== 'scheduled')) {
          throw partialScheduleError(
            created,
            'Queue item creation returned without its requested schedule. Review the visible draft before retrying.'
          );
        }
        return {
          duplicate: false,
          posts: created,
          post: created.length === 1 ? created[0] : undefined,
          scheduledCount: created.length,
          schedule,
          accounts
        };
      }

      let scheduledCount = 0;
      if (schedule.mode === 'max') {
        scheduledCount = await storageAdapter.applyExplicitSchedule(context.userId, created, schedule.plan);
      } else {
        for (const account of accounts) {
          const ids = created.filter((post) => post.accountId === account.accountId).map((post) => post.id);
          scheduledCount += await storageAdapter.autoSchedulePosts(context.userId, ids, account.accountId);
        }
      }
      if (scheduledCount !== created.length) {
        throw partialScheduleError(
          created,
          `Created ${created.length} queue item(s), but only ${scheduledCount} were scheduled. Review the queue before retrying.`
        );
      }
      const persisted = await Promise.all(created.map((post) =>
        storageAdapter.getPost(context.userId, post.id, post.accountId)
      ));
      if (persisted.some((post) => !post || post.status !== 'scheduled' || !post.scheduledAt)) {
        throw partialScheduleError(
          created,
          'Scheduling reported success, but the persisted queue state could not be confirmed. Review the queue before retrying.'
        );
      }
      return {
        duplicate: false,
        posts: persisted,
        post: persisted.length === 1 ? persisted[0] : undefined,
        scheduledCount,
        schedule,
        accounts
      };
    } catch (error) {
      if (error instanceof AutoPosterApplicationError) throw error;
      throw partialScheduleError(
        created,
        'Queue item creation succeeded, but scheduling could not be fully confirmed. Review these items in the queue before retrying.'
      );
    }
  }

  async function approvePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website' || !context.approval) {
      throw new AutoPosterApplicationError('Human website approval is required for this operation.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const approvedBy = String(input.approvedBy || context.approval.approvedBy).trim();
    const post = await storageAdapter.approvePost(
      context.userId,
      String(input.postId || ''),
      { approvedBy },
      input.accountId || context.accountId || undefined
    );
    return { ok: Boolean(post), post };
  }

  async function revokeApproval(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the human website workflow can revoke approval.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const post = await storageAdapter.revokePostApproval(
      context.userId,
      String(input.postId || ''),
      input.accountId || context.accountId || undefined
    );
    return { ok: Boolean(post), post };
  }

  async function deletePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    const deleted = await storageAdapter.deletePost(
      context.userId,
      postId,
      input.accountId || context.accountId || undefined
    );
    return { ok: Boolean(deleted), deleted: Boolean(deleted), postId };
  }

  async function deleteMarkedPosts(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const ids = [...new Set((Array.isArray(input.postIds) ? input.postIds : [])
      .map((id) => String(id || '').trim()).filter(Boolean))];
    if (ids.length === 0) throw new AutoPosterApplicationError('Select at least one post to delete.');
    if (ids.length > 200) throw new AutoPosterApplicationError('Too many posts selected — delete at most 200 at a time.');

    const deleted = [];
    const failed = [];
    for (const postId of ids) {
      try {
        const result = await deletePost(context, { postId, accountId: input.accountId });
        if (result.deleted) deleted.push(postId);
        else failed.push({ id: postId, reason: 'Post not found in your account.' });
      } catch (error) {
        failed.push({ id: postId, reason: error.message || 'Delete failed.' });
      }
    }
    return { ok: failed.length === 0, deleted, failed };
  }

  async function retryPost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the website workflow can reset a post for retry.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const { post } = await getPostStatus(context, input);
    const updated = await storageAdapter.updatePost(context.userId, post.id, {
      status: post.scheduledAt ? 'scheduled' : 'pending',
      postedAt: null,
      readyAt: null,
      errorMessage: null,
      lastResult: null,
      claimAttempts: 0,
      lockedAt: null,
      lockedBy: null
    }, input.accountId || context.accountId || undefined,
    { event: 'reset', detail: 'Returned to the queue by the operator; attempt counter cleared.' });
    return { ok: Boolean(updated), post: updated };
  }

  async function updatePost(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the website workflow can edit a queue item.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const postId = String(input.postId || '').trim();
    if (!postId) throw new AutoPosterApplicationError('postId is required.');
    const patch = { ...(input.patch || {}) };
    if (input.scheduleInput) {
      const raw = String(input.scheduleInput.value || '').trim();
      const scheduledAt = raw
        ? parseDateTimeLocal(raw, input.scheduleInput.timezoneOffsetMinutes)
        : null;
      if (raw && !scheduledAt) {
        throw new AutoPosterApplicationError('The posting date/time could not be parsed.');
      }
      patch.scheduledAt = scheduledAt;
    }
    const post = await storageAdapter.updatePost(
      context.userId,
      postId,
      patch,
      input.accountId || context.accountId || undefined,
      input.historyEvent
    );
    if (!post) {
      throw new AutoPosterApplicationError('Post not found for this tenant/account scope.', {
        status: 404,
        code: 'not_found'
      });
    }
    return { ok: true, post };
  }

  async function markPostManually(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    if (context.source !== 'website') {
      throw new AutoPosterApplicationError('Only the human website workflow can mark a post manually.', {
        status: 403,
        code: 'forbidden'
      });
    }
    const nowIso = new Date(now()).toISOString();
    return updatePost(context, {
      postId: input.postId,
      accountId: input.accountId,
      patch: {
        status: 'posted',
        postedAt: nowIso,
        readyAt: null,
        lastResult: { ok: true, mode: 'manual', reason: 'Marked posted manually', completedAt: nowIso }
      },
      historyEvent: {
        event: 'marked_posted',
        detail: 'Marked posted manually by the operator; no API publish occurred.'
      }
    });
  }

  async function rescheduleQueue(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const accountId = String(input.accountId || context.accountId || '').trim();
    await resolveOwnedAccounts(context, [accountId]);
    const count = await storageAdapter.reschedulePendingQueue(context.userId, accountId);
    return { ok: true, count, accountId };
  }

  // Shared connected-account resolution: the website and Agent Runtime both
  // read channel identity/readiness through these operations, so neither
  // surface can drift into its own account model. Responses are the safe
  // connected-account view only — never raw account records with tokens.
  async function getConnectedAccount(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const accountId = String(input.accountId || context.accountId || '').trim();
    if (!accountId) throw new AutoPosterApplicationError('accountId is required.');
    const requestedProvider = String(input.provider || '').trim().toLowerCase();
    const account = requestedProvider
      ? await getProviderAccount(context, requestedProvider, accountId)
      : await findOwnedAccountAnyProvider(context, accountId);
    if (!account) {
      throw new AutoPosterApplicationError('Publishing channel not found for this tenant.', {
        status: 404,
        code: 'not_found'
      });
    }
    const view = toConnectedAccountView(account);
    return { account: view, provider: providers.getProviderSummary(view.provider) };
  }

  async function listConnectedAccounts(contextInput, input = {}) {
    const context = createExecutionContext(contextInput);
    const requestedProvider = String((input && input.provider) || '').trim().toLowerCase();
    if (requestedProvider && !providers.isKnownProvider(requestedProvider)) {
      throw new AutoPosterApplicationError(`Unsupported publishing provider: ${requestedProvider}.`, {
        status: 400,
        code: 'unknown_provider'
      });
    }
    const includeTikTok = !requestedProvider || requestedProvider === PROVIDER_TIKTOK;
    const includeYouTube = (!requestedProvider || requestedProvider === PROVIDER_YOUTUBE)
      && typeof storageAdapter.getYouTubeAccounts === 'function';
    const tiktokAccounts = includeTikTok ? await storageAdapter.getTikTokAccounts(context.userId) : [];
    const youtubeAccounts = includeYouTube ? await storageAdapter.getYouTubeAccounts(context.userId) : [];
    const views = [...(Array.isArray(tiktokAccounts) ? tiktokAccounts : []), ...(Array.isArray(youtubeAccounts) ? youtubeAccounts : [])]
      .map((account) => toConnectedAccountView(account))
      .filter(Boolean);
    return {
      accounts: views,
      count: views.length,
      // Backward-compatible single summary plus the per-provider list.
      provider: providers.getProviderSummary(requestedProvider || PROVIDER_TIKTOK),
      providers: [PROVIDER_TIKTOK, PROVIDER_YOUTUBE].map((id) => providers.getProviderSummary(id))
    };
  }

  return {
    approvePost,
    deleteMarkedPosts,
    deletePost,
    getConnectedAccount,
    getPostStatus,
    listConnectedAccounts,
    listQueue,
    markPostManually,
    rescheduleQueue,
    retryPost,
    revokeApproval,
    schedulePost,
    updatePost,
    validateMedia
  };
}

const defaultService = createAutoPosterApplicationService();

module.exports = {
  AutoPosterApplicationError,
  DEFAULT_QUEUE_LIMIT,
  MAX_QUEUE_LIMIT,
  PROVIDER_TIKTOK,
  PROVIDER_YOUTUBE,
  REQUEST_SOURCES,
  countQueueItems,
  createAutoPosterApplicationService,
  createExecutionContext,
  deterministicPostId,
  isHttpsUrl,
  normalizeExplicitSchedule,
  ...defaultService
};
