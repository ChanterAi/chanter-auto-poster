'use strict';

// Agent Runtime control surface (P1B) — the four token-guarded JSON routes
// the CHANTER Agent Runtime's AutoPoster adapter calls:
//
//   GET  /api/runtime/queue?accountId=&limit=   bounded queue listing
//   GET  /api/runtime/posts/:id/status          one post's normalized status
//   POST /api/runtime/media/validate            video-only media policy check
//   POST /api/runtime/schedule                  create ONE scheduled queue item
//
// Design rules (deliberate, do not loosen):
//  - Authentication is a dedicated service token (RUNTIME_CONTROL_TOKEN),
//    compared in constant time. No token configured -> every request is
//    refused (fail closed). Admin session cookies are never accepted here,
//    and this router must be mounted before csrfOriginCheck — token auth is
//    immune to CSRF by construction (no cookie is involved).
//  - Tenant identity is derived server-side from the token (the single
//    config.defaultUserId owner). A caller-supplied userId is ignored, so
//    the runtime can never impersonate another tenant.
//  - All business rules stay in storage.js / mediaPolicy.js. This file only
//    validates transport-level input, maps results to safe JSON views, and
//    reports failures truthfully. Media acceptance is decided exclusively
//    by mediaPolicy (route-level) and storage.addUploadedPosts (chokepoint).
//  - Scheduling creates an UNAPPROVED queue item. The existing human
//    approval gate (storage.approvePost + scheduler claim refusal) is the
//    only path to publishing; nothing here can trigger a TikTok call.
//  - Responses never include tokens, credentials, media URLs with signed
//    query params, or raw provider payloads — only the allowlisted fields
//    in the view builders below.

const express = require('express');
const { createHash, timingSafeEqual } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const {
  VIDEO_EXTENSIONS,
  VIDEO_ONLY_UPLOAD_MESSAGE,
  VIDEO_ONLY_URL_MESSAGE,
  isVideoUploadFile,
  isVideoMediaUrl
} = require('./mediaPolicy');

const router = express.Router();

const QUEUE_LIST_DEFAULT_LIMIT = 25;
const QUEUE_LIST_MAX_LIMIT = 100;
const CAPTION_SUMMARY_LIMIT = 140;

// scheduledAt must carry an explicit timezone so normalization to UTC never
// depends on this server's local zone. Mirrors the Agent Runtime contract.
const ISO_WITH_ZONE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(res, status, code, reason, extra = {}) {
  res.status(status).json({ ok: false, code, reason, ...extra });
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
  // Tenant identity comes from the token, never from the request body.
  req.runtimeUserId = config.defaultUserId;
  next();
}

router.use(requireRuntimeControlToken);
router.use(express.json({ limit: '64kb' }));

function captionSummary(caption) {
  const text = String(caption || '');
  return text.length > CAPTION_SUMMARY_LIMIT ? `${text.slice(0, CAPTION_SUMMARY_LIMIT)}…` : text;
}

function queueItemView(post) {
  return {
    id: post.id,
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

async function resolveOwnedAccount(userId, accountId) {
  const account = await storage.getTikTokAccount(userId, accountId);
  return account || null;
}

// ── Queue list ───────────────────────────────────────────────────────────

router.get('/queue', asyncRoute(async (req, res) => {
  const userId = req.runtimeUserId;
  const accountId = String(req.query.accountId || '').trim();
  const rawLimit = req.query.limit === undefined ? QUEUE_LIST_DEFAULT_LIMIT : Number(req.query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit < 1) {
    fail(res, 400, 'validation_failed', `limit must be an integer between 1 and ${QUEUE_LIST_MAX_LIMIT}.`);
    return;
  }
  const limit = Math.min(rawLimit, QUEUE_LIST_MAX_LIMIT);

  if (accountId) {
    const account = await resolveOwnedAccount(userId, accountId);
    if (!account) {
      // Single-tenant convention: an account this tenant does not own does
      // not exist from this API's point of view (matches storage.getPost).
      fail(res, 404, 'not_found', 'Publishing channel not found for this tenant.');
      return;
    }
  }

  const posts = await storage.getPosts(userId, accountId || undefined);
  const items = posts.slice(0, limit).map(queueItemView);
  res.json({
    ok: true,
    items,
    count: items.length,
    totalInScope: posts.length,
    scope: { accountId: accountId || 'all' }
  });
}));

// ── Post status ──────────────────────────────────────────────────────────

router.get('/posts/:id/status', asyncRoute(async (req, res) => {
  const userId = req.runtimeUserId;
  const accountId = String(req.query.accountId || '').trim() || undefined;
  const post = await storage.getPost(userId, req.params.id, accountId);
  if (!post) {
    // storage.getPost returns null for both missing and non-owned posts —
    // the repo's existing intentional convention (no ownership probing).
    fail(res, 404, 'not_found', 'Post not found for this tenant/account scope.');
    return;
  }
  res.json({ ok: true, post: postStatusView(post) });
}));

// ── Media validation ─────────────────────────────────────────────────────

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

// Classifies WHY mediaPolicy rejected an upload — reporting only. The
// accept/reject decision itself is always isVideoUploadFile's.
function uploadRejectionCode(fileName, mimeType) {
  const mime = String(mimeType || '').toLowerCase();
  const lowerName = String(fileName || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image_mime';
  // A video MIME rejected by the policy means the extension disagreed.
  if (mime.startsWith('video/')) return 'mime_extension_mismatch';
  if (/\.(png|jpe?g|gif|webp|bmp|heic|heif)$/.test(lowerName)) return 'image_extension';
  return 'unsupported_media';
}

router.post('/media/validate', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const fileName = String(body.fileName || '').trim();
  const mimeType = String(body.mimeType || '').trim();
  const mediaUrl = String(body.mediaUrl || '').trim();

  if (!mediaUrl && !fileName && !mimeType) {
    fail(res, 400, 'validation_failed', 'Provide mediaUrl, or fileName/mimeType, to validate media.');
    return;
  }

  const policy = { videoOnly: true, allowedExtensions: VIDEO_EXTENSIONS, validator: 'mediaPolicy.js' };
  const reject = (rejectionCode, reason) => {
    res.json({ ok: true, valid: false, classification: 'rejected', rejectionCode, reason, policy });
  };

  if (mediaUrl) {
    if (!isHttpsUrl(mediaUrl)) {
      reject('not_https_url', 'Public Media URL must be a valid HTTPS URL.');
      return;
    }
    if (!isVideoMediaUrl(mediaUrl)) {
      // Extensionless/ambiguous URLs land here too — fail closed.
      reject('unsupported_url', VIDEO_ONLY_URL_MESSAGE);
      return;
    }
  }

  if (fileName || mimeType) {
    const candidate = { originalname: fileName, mimetype: mimeType };
    if (!isVideoUploadFile(candidate)) {
      reject(uploadRejectionCode(fileName, mimeType), VIDEO_ONLY_UPLOAD_MESSAGE);
      return;
    }
  }

  res.json({ ok: true, valid: true, classification: 'video', policy });
}));

// ── Controlled scheduling ────────────────────────────────────────────────

router.post('/schedule', asyncRoute(async (req, res) => {
  const userId = req.runtimeUserId;
  const body = req.body || {};
  const accountId = String(body.accountId || '').trim();
  const mediaUrl = String(body.mediaUrl || '').trim();
  const caption = String(body.caption || '').trim();
  const hashtags = String(body.hashtags || '').trim();
  const scheduledAtRaw = String(body.scheduledAt || '').trim();
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  const requestedBy = String(body.requestedBy || '').trim() || 'agent-runtime';

  if (!accountId) { fail(res, 400, 'validation_failed', 'accountId is required.'); return; }
  if (!mediaUrl) { fail(res, 400, 'validation_failed', 'mediaUrl is required.'); return; }
  if (!idempotencyKey) { fail(res, 400, 'validation_failed', 'idempotencyKey is required.'); return; }
  if (!ISO_WITH_ZONE_PATTERN.test(scheduledAtRaw)) {
    fail(res, 400, 'validation_failed',
      'scheduledAt must be ISO-8601 with an explicit timezone, e.g. 2026-07-11T09:00:00Z.');
    return;
  }
  const scheduledMs = Date.parse(scheduledAtRaw);
  if (Number.isNaN(scheduledMs)) {
    fail(res, 400, 'validation_failed', 'scheduledAt is not a parseable timestamp.');
    return;
  }
  if (scheduledMs <= Date.now()) {
    fail(res, 400, 'validation_failed', 'scheduledAt must be in the future.');
    return;
  }
  const scheduledAtIso = new Date(scheduledMs).toISOString();

  const account = await resolveOwnedAccount(userId, accountId);
  if (!account) {
    fail(res, 404, 'not_found', 'Publishing channel not found for this tenant.');
    return;
  }
  if (!account.connected) {
    fail(res, 409, 'validation_failed', 'Publishing channel is not connected; reconnect it before scheduling.');
    return;
  }

  // Idempotency: the queue itself is the durable record. A key that already
  // produced a queue item returns that item — never a second one.
  const existingPosts = await storage.getPosts(userId, accountId);
  const existing = existingPosts.find((post) => post.runtimeIdempotencyKey === idempotencyKey);
  if (existing) {
    res.json({ ok: true, duplicate: true, post: postStatusView(existing) });
    return;
  }

  // Creation goes through the one real chokepoint (video-only media policy,
  // HTTPS check, approval-gated draft, ownership tagging all live there).
  const created = await storage.addUploadedPosts(userId, [], {
    publicMediaUrl: mediaUrl,
    caption,
    hashtags,
    accounts: [{
      accountId: account.accountId,
      tiktokOpenId: account.open_id,
      username: account.username
    }]
  });
  if (!Array.isArray(created) || created.length !== 1) {
    fail(res, 500, 'internal',
      `Expected exactly one queue item, got ${Array.isArray(created) ? created.length : 'none'}.`);
    return;
  }

  let scheduled;
  try {
    scheduled = await storage.updatePost(userId, created[0].id, {
      scheduledAt: scheduledAtIso,
      runtimeIdempotencyKey: idempotencyKey,
      runtimeScheduledBy: requestedBy
    }, account.accountId, {
      event: 'runtime_scheduled',
      detail: `Scheduled via Agent Runtime by ${requestedBy} for ${scheduledAtIso}. Draft awaits human approval before publishing.`
    });
  } catch (error) {
    scheduled = null;
  }
  if (!scheduled) {
    // Partial state reported truthfully: the draft exists but is NOT scheduled.
    fail(res, 500, 'internal',
      'Queue item was created but applying the schedule failed; the item remains an unscheduled draft.',
      { createdPostId: created[0].id });
    return;
  }

  res.status(201).json({ ok: true, duplicate: false, post: postStatusView(scheduled) });
}));

module.exports = router;
