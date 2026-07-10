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

function runtimeContext(req, { accountId = '', actorId = 'agent-runtime', idempotencyKey = '' } = {}) {
  return applicationService.createExecutionContext({
    userId: req.runtimeUserId,
    actorId,
    accountId,
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
    claimAttempts: Number(post.claimAttempts || 0),
    lastErrorMessage: lastErrorMessage(post)
  };
}

// Queue listing. The route limit is intentionally narrower than the internal
// service maximum because this is a remote evidence surface.
router.get('/queue', applicationRoute(async (req, res) => {
  const accountId = String(req.query.accountId || '').trim();
  const rawLimit = req.query.limit === undefined ? QUEUE_LIST_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    fail(res, 400, 'validation_failed', `limit must be an integer between 1 and ${QUEUE_LIST_MAX_LIMIT}.`);
    return;
  }
  const limit = Math.min(rawLimit, QUEUE_LIST_MAX_LIMIT);
  const result = await applicationService.listQueue(runtimeContext(req, { accountId }), { accountId, limit });
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
  const { post } = await applicationService.getPostStatus(
    runtimeContext(req, { accountId }),
    { postId: req.params.id, accountId }
  );
  res.json({ ok: true, post: postStatusView(post) });
}));

router.post('/media/validate', applicationRoute(async (req, res) => {
  const validation = applicationService.validateMedia(runtimeContext(req), req.body || {});
  res.json({ ok: true, ...validation });
}));

// Controlled scheduling creates one unapproved draft. Runtime approval is
// permission to invoke this operation, never AutoPoster's human publish gate.
router.post('/schedule', applicationRoute(async (req, res) => {
  const body = req.body || {};
  const accountId = String(body.accountId || '').trim();
  const mediaUrl = String(body.mediaUrl || '').trim();
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  const requestedBy = String(body.requestedBy || '').trim() || 'agent-runtime';

  if (!accountId) { fail(res, 400, 'validation_failed', 'accountId is required.'); return; }
  if (!mediaUrl) { fail(res, 400, 'validation_failed', 'mediaUrl is required.'); return; }

  const result = await applicationService.schedulePost(
    runtimeContext(req, { accountId, actorId: requestedBy, idempotencyKey }),
    {
      accountId,
      mediaUrl,
      caption: body.caption,
      hashtags: body.hashtags,
      requestedBy,
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
