'use strict';

// Client (tenant) portal routes. Deliberately kept in its own file, never
// imported by routes.js's admin views, so the client surface can never
// accidentally render admin UI. Every data read/write in this file is
// scoped by req.clientAccountId — see requireClientSession below, which
// re-verifies the session against Firestore on every request (fail-closed
// if the account was deleted or client access was revoked).
//
// The one unavoidable coupling with routes.js: TikTok's OAuth redirect_uri
// is a single fixed URL (config.tiktok.redirectUri -> /auth/tiktok/callback)
// shared by both the admin "connect a channel" flow and this file's client
// "reconnect my channel" flow. routes.js dispatches to
// handleTikTokReconnectCallback (exported below) when it sees the
// client-flow state cookie; otherwise it runs its own admin-only logic
// unchanged. See routes.js's /auth/tiktok/callback handler.

const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const applicationService = require('./autoposterApplicationService');
const scheduler = require('./scheduler');
const tiktok = require('./tiktok');
const { clearClientSessionCookie, setClientSessionCookie } = require('./clientAuth');
const {
  VIDEO_ONLY_UPLOAD_MESSAGE,
  isVideoUploadFile
} = require('./mediaPolicy');

const router = express.Router();
const CLIENT_OAUTH_STATE_COOKIE = 'client_tiktok_oauth_state';
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

const clientUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || defaultExtension(file);
      callback(null, `client-${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (isVideoUploadFile(file)) { callback(null, true); return; }
    const error = new Error(VIDEO_ONLY_UPLOAD_MESSAGE);
    error.status = 400;
    callback(error);
  },
  limits: { files: 1, fileSize: 250 * 1024 * 1024 }
});

// Wraps clientUpload.single so a rejected file keeps the client on their
// own portal with a truthful notice, instead of falling through to the
// admin-facing error middleware.
function clientUploadMedia(req, res, next) {
  clientUpload.single('media')(req, res, (error) => {
    if (error) {
      redirectClientNotice(res, error.message || 'Upload failed.');
      return;
    }
    next();
  });
}

function defaultExtension(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function clientApplicationContext(req, options = {}) {
  const account = req.clientAccount || {};
  const actorId = `client:@${account.username || req.clientAccountId || 'unknown'}`;
  return applicationService.createExecutionContext({
    userId: req.clientUserId,
    actorId,
    accountId: req.clientAccountId,
    source: 'website',
    correlationId: req.get('x-request-id') || req.get('x-correlation-id') || '',
    approval: options.selfApprove ? { approvedBy: actorId } : null
  });
}

// ── Session guard ────────────────────────────────────────────────────────

async function requireClientSession(req, res, next) {
  if (!req.clientSession) {
    res.redirect('/client/autoposter/login');
    return;
  }
  try {
    const account = await storage.resolveClientAccount(req.clientSession.userId, req.clientSession.accountId);
    if (!account) {
      clearClientSessionCookie(req, res);
      res.redirect(`/client/autoposter/login?notice=${encodeURIComponent('Your access is no longer valid. Contact CHANTER support for a new access code.')}`);
      return;
    }
    req.clientAccountId = account.accountId;
    req.clientUserId = account.userId;
    req.clientAccount = account;
    next();
  } catch (error) {
    next(error);
  }
}

// ── Login / logout ──────────────────────────────────────────────────────

router.get('/client/autoposter/login', (req, res) => {
  if (req.clientSession) {
    res.redirect('/client/autoposter');
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.render('client-login', {
    appName: config.appName,
    error: '',
    notice: String(req.query.notice || '')
  });
});

router.post('/client/autoposter/login', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const attempt = getLoginAttempt(req.ip);
  if (attempt.locked) {
    res.status(429).render('client-login', {
      appName: config.appName,
      error: 'Too many login attempts. Try again in 15 minutes.',
      notice: ''
    });
    return;
  }

  const account = await storage.verifyClientAccessCode(req.body.accessCode);
  if (!account) {
    recordFailedLogin(req.ip);
    res.status(401).render('client-login', {
      appName: config.appName,
      error: 'Invalid access code.',
      notice: ''
    });
    return;
  }

  loginAttempts.delete(req.ip);
  setClientSessionCookie(req, res, { accountId: account.accountId, userId: account.userId });
  res.redirect('/client/autoposter');
}));

router.post('/client/autoposter/logout', (req, res) => {
  clearClientSessionCookie(req, res);
  res.redirect('/client/autoposter/login?notice=You+have+been+logged+out.');
});

// ── Portal ───────────────────────────────────────────────────────────────

router.get('/client/autoposter', requireClientSession, asyncRoute(async (req, res) => {
  const queue = await applicationService.listQueue(clientApplicationContext(req), {
    accountId: req.clientAccountId,
    limit: 1000
  });

  res.set('Cache-Control', 'no-store');
  res.render('client-portal', {
    appName: config.appName,
    account: req.clientAccount,
    posts: queue.items,
    counts: queue.counts,
    notice: req.query.notice || '',
    helpers: clientViewHelpers
  });
}));

router.get('/client/autoposter/tiktok/reconnect', requireClientSession, (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    redirectClientNotice(res, 'TikTok connection is not configured yet. Contact CHANTER support.');
    return;
  }
  const state = randomUUID();
  res.cookie(CLIENT_OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(tiktok.buildTikTokAuthUrl(state));
});

// Invoked from routes.js's shared /auth/tiktok/callback dispatch — not
// mounted as its own route here, since the redirect_uri TikTok calls back
// to is a single fixed URL shared with the admin connect flow.
async function handleTikTokReconnectCallback(req, res) {
  const expectedState = parseCookies(req.headers.cookie)[CLIENT_OAUTH_STATE_COOKIE];
  res.clearCookie(CLIENT_OAUTH_STATE_COOKIE);

  if (!req.clientSession) {
    res.redirect('/client/autoposter/login');
    return;
  }
  const account = await storage.resolveClientAccount(req.clientSession.userId, req.clientSession.accountId);
  if (!account) {
    clearClientSessionCookie(req, res);
    res.redirect(`/client/autoposter/login?notice=${encodeURIComponent('Your access is no longer valid. Contact CHANTER support.')}`);
    return;
  }

  if (req.query.error) {
    redirectClientNotice(res, `TikTok connection failed: ${req.query.error_description || req.query.error}`);
    return;
  }
  if (!req.query.code || !req.query.state || req.query.state !== expectedState) {
    redirectClientNotice(res, 'TikTok connection failed: invalid OAuth state.');
    return;
  }

  try {
    const auth = await tiktok.exchangeCodeForToken(String(req.query.code));
    if (String(auth.open_id || '') !== account.accountId) {
      redirectClientNotice(res, 'Reconnect must use the same TikTok account you originally connected. Contact CHANTER support to link a different account.');
      return;
    }
    let updated = await storage.saveTikTokAccount(account.userId, auth);
    try {
      const profile = await tiktok.queryCreatorInfo(updated.accountId, account.userId);
      updated = await storage.updateTikTokAccountProfile(account.userId, updated.accountId, profile) || updated;
    } catch (profileError) {
      console.warn('[client-routes] TikTok profile unavailable after reconnect', profileError.message);
    }
    redirectClientNotice(res, `Reconnected as ${accountLabel(updated)}.`);
  } catch (error) {
    redirectClientNotice(res, `TikTok connection failed: ${error.message}`);
  }
}

// ── Create / schedule post ──────────────────────────────────────────────

router.post('/client/autoposter/upload', requireClientSession, clientUploadMedia, asyncRoute(async (req, res) => {
  const account = req.clientAccount;
  if (!account.connected) {
    redirectClientNotice(res, 'Reconnect your TikTok account before scheduling a post.');
    return;
  }

  const caption = String(req.body.caption || '').trim();
  const hashtags = String(req.body.hashtags || '').trim();
  const publicMediaUrl = String(req.body.publicMediaUrl || '').trim();

  if (!caption) {
    redirectClientNotice(res, 'Add a caption before scheduling.');
    return;
  }
  if (caption.length > 2200) {
    redirectClientNotice(res, 'Caption is too long (max 2200 characters).');
    return;
  }
  try {
    await applicationService.schedulePost(
      clientApplicationContext(req, { selfApprove: true }),
      {
        accountId: account.accountId,
        files: req.file ? [req.file] : [],
        mediaUrl: publicMediaUrl,
        caption,
        hashtags,
        requireSingle: true,
        schedule: String(req.body.scheduledAt || '').trim()
          ? {
              mode: 'browser_local',
              value: req.body.scheduledAt,
              timezoneOffsetMinutes: req.body.timezoneOffsetMinutes
            }
          : { mode: 'automatic' }
      }
    );
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectClientNotice(res, error.message);
      return;
    }
    throw error;
  }

  redirectClientNotice(res, 'Post scheduled.');
}));

router.post('/client/autoposter/posts/:id/prepare', requireClientSession, asyncRoute(async (req, res) => {
  try {
    await applicationService.getPostStatus(clientApplicationContext(req), {
      postId: req.params.id,
      accountId: req.clientAccountId
    });
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectClientNotice(res, error.message);
      return;
    }
    throw error;
  }

  const result = await scheduler.processPost(req.params.id, { force: true });
  if (result.ok) { redirectClientNotice(res, 'Posted. Check the status below to confirm.'); return; }
  if (result.mode === 'skipped') { redirectClientNotice(res, 'Already posting — check status below in a moment.'); return; }
  redirectClientNotice(res, `Needs attention: ${result.reason || "TikTok couldn't post this."}`);
}));

router.post('/client/autoposter/posts/:id/pending', requireClientSession, asyncRoute(async (req, res) => {
  try {
    await applicationService.retryPost(clientApplicationContext(req), {
      postId: req.params.id,
      accountId: req.clientAccountId
    });
    redirectClientNotice(res, 'Ready to retry.');
  } catch (error) {
    if (error instanceof applicationService.AutoPosterApplicationError) {
      redirectClientNotice(res, error.message);
      return;
    }
    throw error;
  }
}));

router.post('/client/autoposter/posts/:id/delete', requireClientSession, asyncRoute(async (req, res) => {
  const result = await applicationService.deletePost(clientApplicationContext(req), {
    postId: req.params.id,
    accountId: req.clientAccountId
  });
  redirectClientNotice(res, result.deleted ? 'Deleted.' : 'Post not found.');
}));

// ── Helpers ──────────────────────────────────────────────────────────────

function getLoginAttempt(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, count: 0 };
  }
  return { locked: attempt.count >= LOGIN_MAX_ATTEMPTS, count: attempt.count };
}

function recordFailedLogin(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, startedAt: now });
    return;
  }
  current.count += 1;
}

function redirectClientNotice(res, notice) {
  res.redirect(`/client/autoposter?notice=${encodeURIComponent(notice)}`);
}

function parseCookies(header) {
  return String(header || '').split(';').map((part) => part.trim()).filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
      return cookies;
    }, {});
}

function accountLabel(account) {
  if (!account) return 'TikTok account';
  if (account.username) return `@${account.username}`;
  if (account.displayName) return account.displayName;
  return `TikTok ${String(account.accountId || '').slice(0, 8)}`;
}

function getPostMediaType(post) {
  const mediaType = String((post && post.mediaType) || '').toLowerCase();
  if (mediaType === 'video') return 'video';
  const fileName = String((post && (post.fileName || post.mediaPath || post.videoPath)) || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].some((extension) => fileName.endsWith(extension))) return 'video';
  return 'photo';
}

function getPostMediaPath(post) {
  if (!post) return '';
  if (getPostMediaType(post) === 'video') return post.mediaUrl || post.videoPath || post.mediaPath || post.publicMediaUrl || post.imagePath || '';
  return post.mediaUrl || post.imagePath || post.mediaPath || post.publicMediaUrl || post.publicImageUrl || '';
}

function formatDateTime(value) {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

// Friendly status view for the client queue. Deliberately omits raw
// lastResult JSON / publish metadata dumps — only a short human message.
function clientPostStatus(post) {
  const status = String((post && post.status) || 'pending').toLowerCase();
  const lastResult = post && post.lastResult ? post.lastResult : null;
  const labels = {
    pending: 'Unscheduled',
    scheduled: 'Scheduled',
    processing: 'Publishing',
    ready: 'Needs verification',
    posted: 'Posted',
    failed: 'Failed'
  };

  let message = 'Not yet scheduled.';
  if (status === 'scheduled') {
    message = post.scheduledAt ? `Scheduled for ${formatDateTime(post.scheduledAt)}.` : 'Scheduled.';
  } else if (status === 'processing') {
    message = 'Posting to TikTok — this can take a moment for larger videos.';
  } else if (status === 'ready') {
    message = (lastResult && lastResult.reason) || 'Check the media, then confirm it inside TikTok.';
  } else if (status === 'failed') {
    const reason = (lastResult && lastResult.reason) || '';
    message = reason.includes('unaudited_client_can_only_post_to_private_accounts') || reason.includes('403')
      ? 'TikTok needs this account set to private until app review is complete.'
      : (reason || "TikTok couldn't post this. Try again or contact CHANTER support.");
  } else if (status === 'posted') {
    message = 'Posted.';
  }

  return { label: labels[status] || status, tone: status, message };
}

const clientViewHelpers = {
  mediaType(post) { return getPostMediaType(post); },
  mediaPath(post) { return getPostMediaPath(post); },
  mediaLabel(post) { return getPostMediaType(post) === 'video' ? 'Video' : 'Photo'; },
  formatDateTime,
  dateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  },
  postStatus(post) { return clientPostStatus(post); }
};

module.exports = router;
module.exports.handleTikTokReconnectCallback = handleTikTokReconnectCallback;
module.exports.CLIENT_OAUTH_STATE_COOKIE = CLIENT_OAUTH_STATE_COOKIE;
