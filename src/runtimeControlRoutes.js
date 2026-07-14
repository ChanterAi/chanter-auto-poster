'use strict';

// Agent Runtime control surface (P1B). Authentication and safe JSON mapping
// stay here; every product operation goes through the same application
// service used by the website and client portal.

const express = require('express');
const { createHash, timingSafeEqual } = require('crypto');
const config = require('./config');
const applicationService = require('./autoposterApplicationService');

const router = express.Router();
const QUEUE_LIST_DEFAULT_LIMIT = 25;
const QUEUE_LIST_MAX_LIMIT = 100;
const CAPTION_SUMMARY_LIMIT = 140;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(res, status, code, reason, extra = {}) {
  res.status(status).json({ ok: false, code, reason, ...extra });
}

function applicationRoute(handler) {
  return asyncRoute(async (req, res, next) => {
    try {
      return await handler(req, res, next);
    } catch (error) {
      if (error instanceof applicationService.AutoPosterApplicationError) {
        fail(res, error.status, error.code, error.message, error.details);
        return;
      }
      throw error;
    }
  });
}

// Constant-time comparison over fixed-length digests so token length is not
// observable either.
function tokensMatch(candidate, expected) {
  const candidateDigest = createHash('sha256').update(String(candidate || '')).digest();
  const expectedDigest = createHash('sha256').update(String(expected || '')).digest();
  return timingSafeEqual(candidateDigest, expectedDigest);
}

function requireRuntimeControlToken(req, res, next) {
  const expected = config.runtimeControl.token;
  if (!expected) {
    fail(res, 503, 'unavailable', 'Runtime control is disabled: RUNTIME_CONTROL_TOKEN is not configured.');
    return;
  }
  const candidate = req.get('x-chanter-runtime-token');
  if (!candidate || !tokensMatch(candidate, expected)) {
    fail(res, 401, 'unauthorized', 'A valid runtime control token is required.');
    return;
  }
  // Tenant identity comes from the service token, never from the body.
  req.runtimeUserId = config.defaultUserId;
  next();
}

router.use(requireRuntimeControlToken);
router.use(express.json({ limit: '64kb' }));

function runtimeContext(req, {
  accountId = '',
  actorId = 'agent-runtime',
  idempotencyKey = '',
  workspaceId = ''
} = {}) {
  return applicationService.createExecutionContext({
    userId: req.runtimeUserId,
    actorId,
    accountId,
    workspaceId: String(workspaceId || req.get('x-chanter-workspace-id') || ''),
    source: 'runtime',
    correlationId: req.get('x-request-id') || req.get('x-correlation-id') || '',
    idempotency: { key: idempotencyKey }
  });
}

function captionSummary(caption) {
  const text = String(caption || '');
  return text.length > CAPTION_SUMMARY_LIMIT ? `${text.slice(0, CAPTION_SUMMARY_LIMIT)}…` : text;
}

function queueItemView(post) {
  return {
    id: post.id,
    // Canonical provider/connected-account identity (additive, safe
    // metadata only — never tokens or credentials).
    provider: post.provider || 'tiktok',
    connectedAccountId: post.connectedAccountId || '',
    accountId: post.accountId,
    username: post.username,
    status: post.status,
    scheduledAt: post.scheduledAt || null,
    approved: Boolean(post.approved),
    mediaType: post.mediaType,
    captionSummary: captionSummary(post.caption),
    createdAt: post.createdAt || null,
    updatedAt: post.updatedAt || null
  };
}

function lastErrorMessage(post) {
  const lastResult = post.lastResult || null;
  const reason = lastResult && (lastResult.reason || lastResult.error || lastResult.message);
  return String(reason || '').slice(0, 300);
}

function postStatusView(post) {
  return {
    ...queueItemView(post),
    approvedAt: post.approvedAt || null,
    approvedBy: post.approvedBy || '',
    postedAt: post.postedAt || null,
    publishId: post.publishId || '',
    // Provider-reported state and bounded provider metadata (postsMapper
    // allowlist — titles/privacy flags only, never credentials).
    providerStatus: post.providerStatus || '',
    providerMetadata: post.providerMetadata || null,
    claimAttempts: Number(post.claimAttempts || 0),
    lastErrorMessage: lastErrorMessage(post)
  };
}

function connectedAccountView(account) {
  return {
    provider: String(account.provider || ''),
    providerDisplayName: String(account.providerDisplayName || ''),
    accountId: String(account.accountId || ''),
    connectedAccountId: String(account.connectionId || ''),
    username: String(account.username || ''),
    displayName: String(account.displayName || ''),
    connectionStatus: String(account.connectionStatus || ''),
    publishingReady: Boolean(account.publishingReady),
    readinessBlockers: Array.isArray(account.readinessBlockers)
      ? account.readinessBlockers.map((value) => String(value))
      : [],
    lastVerifiedAt: account.lastVerifiedAt || null
  };
}

// Canonical connected-account discovery for Operator/Runtime selectors. The
// application service resolves the authenticated workspace and returns its
// allowlisted domain views; this transport applies an even narrower wire
// allowlist so token metadata and provider/account payloads cannot escape.
router.get('/connected-accounts', applicationRoute(async (req, res) => {
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const provider = String(req.query.provider || '').trim().toLowerCase();
  const result = await applicationService.listConnectedAccounts(
    runtimeContext(req, { workspaceId }),
    { provider: provider || undefined }
  );
  const accounts = result.accounts.map(connectedAccountView);
  res.json({
    ok: true,
    workspaceId: result.workspaceId,
    count: accounts.length,
    accounts
  });
}));

// Revalidates the exact selected opaque ID immediately before Operator
// persistence. accountId is deliberately not trimmed or case-normalized.
router.post('/connected-accounts/validate', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const accountId = String(body.accountId || '');
  const provider = String(body.provider || '').trim().toLowerCase();
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  if (!provider) { fail(res, 400, 'validation_failed', 'provider is required.'); return; }

  const result = await applicationService.validateConnectedAccount(
    runtimeContext(req, { accountId, workspaceId }),
    { provider, accountId }
  );
  res.json({
    ok: true,
    workspaceId: result.workspaceId,
    account: connectedAccountView(result.account)
  });
}));

// Queue listing. The route limit is intentionally narrower than the internal
// service maximum because this is a remote evidence surface.
router.get('/queue', applicationRoute(async (req, res) => {
  const accountId = String(req.query.accountId || '').trim();
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const rawLimit = req.query.limit === undefined ? QUEUE_LIST_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    fail(res, 400, 'validation_failed', `limit must be an integer between 1 and ${QUEUE_LIST_MAX_LIMIT}.`);
    return;
  }
  const limit = Math.min(rawLimit, QUEUE_LIST_MAX_LIMIT);
  const result = await applicationService.listQueue(
    runtimeContext(req, { accountId, workspaceId }),
    { accountId, limit }
  );
  const items = result.items.map(queueItemView);
  res.json({
    ok: true,
    items,
    count: items.length,
    totalInScope: result.totalInScope,
    scope: result.scope
  });
}));

router.get('/posts/:id/status', applicationRoute(async (req, res) => {
  const accountId = String(req.query.accountId || '').trim() || undefined;
  const workspaceId = String(req.query.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  const { post } = await applicationService.getPostStatus(
    runtimeContext(req, { accountId, workspaceId }),
    { postId: req.params.id, accountId }
  );
  res.json({ ok: true, post: postStatusView(post) });
}));

router.post('/media/validate', applicationRoute(async (req, res) => {
  const validation = applicationService.validateMedia(runtimeContext(req), req.body || {});
  res.json({ ok: true, ...validation });
}));

// Read-only recovery contract. It returns zero/one/conflicting exact durable
// queue records and never creates, approves, publishes, or repairs anything.
router.post('/schedule/reconcile', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '');
  const accountId = String(body.accountId || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  const result = await applicationService.reconcileRuntimeSchedule(
    runtimeContext(req, { accountId, idempotencyKey, workspaceId }),
    {
      provider: String(body.provider || ''),
      accountId,
      scheduledAt: String(body.scheduledAt || ''),
      missionId: String(body.missionId || ''),
      action: String(body.action || ''),
      missionPayloadHash: String(body.missionPayloadHash || '')
    }
  );
  res.json({
    ok: true,
    ...result,
    ...(result.post ? { post: postStatusView(result.post) } : {})
  });
}));

// Controlled scheduling creates one unapproved draft. Runtime approval is
// permission to invoke this operation, never AutoPoster's human publish gate.
router.post('/schedule', applicationRoute(async (req, res) => {
  const body = req.body || {};
  // Preserve the exact opaque ID; the shared account validator rejects case
  // and whitespace mismatches before queue creation.
  const accountId = String(body.accountId || '');
  const mediaUrl = String(body.mediaUrl || '').trim();
  const idempotencyKey = String(body.idempotencyKey || '');
  const requestedBy = String(body.requestedBy || '').trim() || 'agent-runtime';
  const workspaceId = String(body.workspaceId || req.get('x-chanter-workspace-id') || '').trim();
  // Optional provider selection (defaults to TikTok for full backward
  // compatibility). The application service owns provider validation,
  // account resolution, and the YouTube title requirement.
  const provider = String(body.provider || '').trim().toLowerCase();

  if (!accountId) { fail(res, 400, 'validation_failed', 'accountId is required.'); return; }
  if (!mediaUrl) { fail(res, 400, 'validation_failed', 'mediaUrl is required.'); return; }

  const result = await applicationService.schedulePost(
    runtimeContext(req, { accountId, actorId: requestedBy, idempotencyKey, workspaceId }),
    {
      provider: provider || undefined,
      accountId,
      mediaUrl,
      caption: body.caption,
      hashtags: body.hashtags,
      youtube: provider === 'youtube'
        ? { title: body.title, description: body.description }
        : undefined,
      requestedBy,
      runtimeMissionId: body.missionId,
      runtimeAction: body.action,
      runtimePayloadHash: body.missionPayloadHash,
      requireSingle: true,
      schedule: {
        mode: 'explicit',
        scheduledAt: body.scheduledAt,
        requireExplicitTimezone: true,
        requireFuture: true
      }
    }
  );

  res.status(result.duplicate ? 200 : 201).json({
    ok: true,
    duplicate: result.duplicate,
    post: postStatusView(result.post)
  });
}));

module.exports = router;
