'use strict';

// YouTube provider adapter (Provider #2).
//
// Owns provider-specific behavior only: Google OAuth (server-side
// authorization-code flow with PKCE), credential refresh, safe channel
// resolution, resumable video upload, status lookup, and provider error
// normalization. Ownership, approval, queue creation, scheduling, and
// locking stay in the application service and worker exactly as they do
// for TikTok.
//
// Safety policy hard-wired for Part 3:
//   - privacyStatus is ALWAYS 'private'
//   - notifySubscribers is ALWAYS false
//   - images are never accepted
//   - no publishAt / native scheduling (the product queue is the scheduler)
//
// Token custody: this module only handles plaintext tokens in memory
// between a Google response and tokenVault encryption (or between vault
// decryption and an Authorization header). Nothing here persists or logs a
// plaintext token.

const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const tokenVault = require('./tokenVault');
const mediaPolicy = require('./mediaPolicy');
const providers = require('./providers');

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const UPLOAD_SCOPE = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const UPLOAD_METHOD = 'resumable';
const VERIFICATION_ATTEMPTS = 3;
const VERIFICATION_BACKOFF_MS = Object.freeze([250, 1_000]);

const SENSITIVE_KEYS = new Set([
  'access_token', 'accessToken', 'refresh_token', 'refreshToken',
  'client_secret', 'clientSecret', 'code', 'id_token', 'idToken',
  'authorization', 'Authorization', 'codeVerifier', 'code_verifier',
  'credentialEnvelope'
]);

function redactSensitive(value) {
  if (value == null) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) result[key] = '[REDACTED]';
    else if (val && typeof val === 'object') result[key] = redactSensitive(val);
    else result[key] = val;
  }
  return result;
}

function safeWarn(label, obj) {
  console.warn(label, JSON.stringify(redactSensitive(obj)));
}

function requestSignal(timeoutMs = config.youtube.requestTimeoutMs) {
  return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 30_000));
}

/** Reads a response body as JSON, returning null for empty/non-JSON bodies. */
async function parseResponseBody(response) {
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    return null;
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

// ── Configuration truth ────────────────────────────────────────────────────

// Single source: the provider registry owns configuration truth; the
// adapter re-exports it so callers that only know the adapter still get
// the same answer.
const { getYouTubeConfigStatus } = providers;

function isYouTubeConfigured() {
  return getYouTubeConfigStatus().configured;
}

// ── OAuth: authorize URL, PKCE, code exchange, refresh, revoke ─────────────

/** RFC 7636 S256 PKCE pair via Node stdlib. */
function createPkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function configuredScopes() {
  return String(config.youtube.scopes || '')
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

/**
 * Builds the Google authorize URL. `prompt=consent` is only sent when the
 * caller knows a refresh token must be (re)issued — never on every visit.
 */
function buildYouTubeAuthUrl(state, { codeChallenge, forceConsent = false } = {}) {
  const url = new URL(config.youtube.authUrl);
  const params = {
    client_id: config.youtube.clientId,
    response_type: 'code',
    redirect_uri: config.youtube.redirectUri,
    scope: configuredScopes().join(' '),
    access_type: 'offline',
    include_granted_scopes: 'true',
    state
  };
  if (codeChallenge) {
    params.code_challenge = codeChallenge;
    params.code_challenge_method = 'S256';
  }
  if (forceConsent) params.prompt = 'consent';
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

async function requestGoogleToken(params) {
  const status = getYouTubeConfigStatus();
  if (!status.configured) {
    const error = new Error(`YouTube OAuth is not configured (missing: ${status.missing.join(', ')}).`);
    error.code = 'youtube_not_configured';
    throw error;
  }
  const response = await fetch(config.youtube.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.youtube.clientId,
      client_secret: config.youtube.clientSecret,
      ...params
    }).toString(),
    signal: requestSignal()
  });
  const body = await parseResponseBody(response);
  if (!response.ok || (body && body.error)) {
    const error = new Error(normalizeGoogleOAuthErrorMessage(body, response.status));
    error.code = isInvalidGrant(body) ? 'reauthorization_required' : 'google_oauth_error';
    error.status = response.status;
    throw error;
  }
  return body || {};
}

async function exchangeCodeForToken(code, codeVerifier) {
  const body = await requestGoogleToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.youtube.redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {})
  });
  return normalizeTokenResponse(body);
}

async function refreshAccessToken(refreshToken) {
  const body = await requestGoogleToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });
  return normalizeTokenResponse(body, { refresh_token: refreshToken });
}

/**
 * Best-effort Google-side revocation. Returns { revoked } and never
 * throws — the caller must clear local credentials regardless and report
 * a revocation failure truthfully.
 */
async function revokeToken(token) {
  if (!token) return { revoked: false, reason: 'No token available to revoke.' };
  try {
    const response = await fetch(config.youtube.revokeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: requestSignal()
    });
    if (response.ok) return { revoked: true };
    return { revoked: false, reason: `Google revocation returned HTTP ${response.status}.` };
  } catch (error) {
    return { revoked: false, reason: `Google revocation failed: ${error.message}` };
  }
}

/**
 * Normalizes a Google token response into { tokens, meta } where `tokens`
 * is the plaintext payload destined for the vault and `meta` is the safe
 * metadata destined for the account record. A missing refresh_token in the
 * response PRESERVES the previous refresh token (Google only reissues it
 * on consent), never overwrites it with null.
 */
function normalizeTokenResponse(body, previous = {}) {
  const expiresIn = Number(body.expires_in || 0);
  const accessTokenExpiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const refreshToken = body.refresh_token || previous.refresh_token || '';
  const tokens = {
    access_token: body.access_token || '',
    refresh_token: refreshToken
  };
  return {
    tokens,
    meta: {
      tokenPresent: Boolean(tokens.access_token),
      refreshTokenPresent: Boolean(refreshToken),
      accessTokenExpiresAt,
      grantedScopes: String(body.scope || previous.scope || '').trim(),
      refreshTokenRotated: Boolean(body.refresh_token)
    }
  };
}

/** Encrypts a normalized token payload for persistence. */
function encryptTokens(tokens) {
  return tokenVault.encryptCredentials(tokens);
}

// ── Channel resolution ─────────────────────────────────────────────────────

/**
 * Resolves the channels of the authenticated Google identity. Requires the
 * youtube.readonly scope; a 403 here is normalized to a truthful
 * missing-scope failure instead of a generic error.
 */
async function listMyChannels(accessToken) {
  const url = new URL(`${config.youtube.apiBaseUrl}/channels`);
  url.search = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' }).toString();
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: requestSignal()
  });
  const body = await parseResponseBody(response);
  if (!response.ok) {
    const error = new Error(normalizeGoogleApiErrorMessage(body, response.status, 'YouTube channel lookup'));
    error.code = response.status === 403 ? 'missing_readonly_scope' : 'youtube_api_error';
    error.status = response.status;
    throw error;
  }
  const items = body && Array.isArray(body.items) ? body.items : [];
  return items.map((item) => {
    const snippet = item && item.snippet ? item.snippet : {};
    const thumbnails = snippet.thumbnails || {};
    const thumbnail = (thumbnails.default && thumbnails.default.url)
      || (thumbnails.medium && thumbnails.medium.url) || '';
    return {
      channelId: String(item.id || ''),
      title: String(snippet.title || ''),
      handle: String(snippet.customUrl || ''),
      thumbnailUrl: /^https:\/\//.test(String(thumbnail)) ? String(thumbnail) : ''
    };
  }).filter((channel) => channel.channelId);
}

// ── Connection finalization ────────────────────────────────────────────────

/** Decrypts a stored credential envelope (custody stays in this module). */
function decryptTokens(envelope) {
  return tokenVault.decryptCredentials(envelope);
}

/**
 * Persists one resolved channel as a connected account. Preservation rule:
 * when Google returned no new refresh token (normal on reconnect without a
 * consent prompt), the previously stored encrypted refresh token is merged
 * forward — never overwritten with null. If no refresh path exists at all,
 * the account is saved but immediately marked reauthorization_required so
 * it can never be presented as ready without offline access.
 */
async function finalizeYouTubeConnection({
  userId,
  channel,
  tokens,
  meta,
  workspaceScope,
  activationContext
}) {
  let finalTokens = { ...tokens };
  if (!finalTokens.refresh_token) {
    const existingEnvelope = await storage.getYouTubeAccountCredential(
      userId,
      channel.channelId,
      workspaceScope
    );
    if (existingEnvelope) {
      try {
        const previous = tokenVault.decryptCredentials(existingEnvelope);
        if (previous.refresh_token) finalTokens.refresh_token = previous.refresh_token;
      } catch (error) {
        // The old envelope is unreadable (rotated key, tampering): treat as
        // no stored refresh token rather than failing the whole reconnect.
      }
    }
  }
  const refreshTokenPresent = Boolean(finalTokens.refresh_token);
  const account = await storage.saveYouTubeAccount(userId, {
    channelId: channel.channelId,
    profile: channel,
    credentialEnvelope: encryptTokens(finalTokens),
    tokenMeta: {
      ...meta,
      tokenPresent: Boolean(finalTokens.access_token),
      refreshTokenPresent
    }
  }, workspaceScope, activationContext);
  if (!refreshTokenPresent) {
    await storage.markYouTubeAccountReauthorizationRequired(
      userId,
      channel.channelId,
      'no_refresh_token',
      workspaceScope
    );
    return { account: { ...account, reauthorizationRequired: true }, refreshTokenPresent: false };
  }
  return { account, refreshTokenPresent: true };
}

// ── Active credentials for publishing ──────────────────────────────────────

/**
 * Resolves usable credentials for one connected YouTube account: decrypts
 * the stored envelope and refreshes the access token server-side when it
 * is missing or near expiry. Refresh results are persisted atomically
 * (refresh token preserved unless rotated); invalid_grant marks the
 * account reauthorization_required. Returns { ok, accessToken } or
 * { ok: false, code, reason }.
 */
async function getActiveYouTubeCredentials(userId, accountId, workspaceScope) {
  const account = await storage.getYouTubeAccount(userId, accountId, workspaceScope);
  if (!account || !account.connected) {
    return { ok: false, code: 'account_disconnected', reason: `YouTube channel ${accountId} is not connected.` };
  }
  if (account.reauthorizationRequired) {
    return { ok: false, code: 'reauthorization_required', reason: 'YouTube channel requires reauthorization. Reconnect it from the AutoPoster site.' };
  }
  const envelope = await storage.getYouTubeAccountCredential(userId, accountId, workspaceScope);
  if (!envelope) {
    return { ok: false, code: 'credentials_unavailable', reason: 'No stored YouTube credentials for this channel.' };
  }
  let tokens;
  try {
    tokens = tokenVault.decryptCredentials(envelope);
  } catch (error) {
    return { ok: false, code: error.code || 'vault_decrypt_failed', reason: 'Stored YouTube credentials could not be decrypted.' };
  }

  const expiresAtMs = account.accessTokenExpiresAt ? Date.parse(account.accessTokenExpiresAt) : NaN;
  const needsRefresh = !tokens.access_token
    || (Number.isFinite(expiresAtMs) && expiresAtMs - TOKEN_REFRESH_BUFFER_MS <= Date.now());
  if (!needsRefresh) return { ok: true, accessToken: tokens.access_token };

  if (!tokens.refresh_token) {
    await storage.markYouTubeAccountReauthorizationRequired(
      userId,
      accountId,
      'no_refresh_token',
      workspaceScope
    );
    return { ok: false, code: 'reauthorization_required', reason: 'The YouTube access token expired and no refresh token is stored. Reconnect the channel.' };
  }
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    await storage.updateYouTubeAccountTokenState(userId, accountId, {
      credentialEnvelope: encryptTokens(refreshed.tokens),
      tokenMeta: { ...refreshed.meta, lastRefreshAt: new Date().toISOString(), lastRefreshFailureCode: '' }
    }, workspaceScope);
    return { ok: true, accessToken: refreshed.tokens.access_token };
  } catch (error) {
    if (error.code === 'reauthorization_required') {
      await storage.markYouTubeAccountReauthorizationRequired(
        userId,
        accountId,
        'invalid_grant',
        workspaceScope
      );
      return { ok: false, code: 'reauthorization_required', reason: 'Google rejected the stored refresh token (invalid_grant). Reconnect the channel.' };
    }
    safeWarn('[youtube] token refresh failed', { accountId, error: error.message });
    return { ok: false, code: 'token_refresh_failed', reason: `YouTube token refresh failed: ${error.message}` };
  }
}

// ── Media source (trusted boundary, streaming, SSRF hardened) ──────────────

function getLocalMediaPath(post) {
  const fileName = String(post.fileName || '').trim();
  if (!fileName) return '';
  const uploadPath = path.resolve(config.uploadsDir, fileName);
  const uploadsRoot = path.resolve(config.uploadsDir);
  if (!uploadPath.startsWith(uploadsRoot)) return '';
  return uploadPath;
}

function isPrivateHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  if (value === 'localhost' || value === '::1' || value.endsWith('.local') || value.endsWith('.internal')) return true;
  // Reject every IP-literal host outright: the product's durable media
  // lives behind DNS names (Cloudinary / admin-entered HTTPS CDN URLs).
  if (/^\[?[0-9a-f:]+\]?$/.test(value) && value.includes(':')) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return true;
  return false;
}

/**
 * The only remote-media gate for YouTube uploads: HTTPS, DNS-named host,
 * video extension per mediaPolicy, no redirects followed, bounded size,
 * and a Content-Length is mandatory (the resumable protocol needs it and
 * it enforces the size cap before any byte is streamed).
 */
function isTrustedRemoteMediaUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:') return false;
    if (isPrivateHostname(url.hostname)) return false;
    return mediaPolicy.isVideoMediaUrl(url.toString());
  } catch (error) {
    return false;
  }
}

async function getVideoSource(post) {
  const localPath = getLocalMediaPath(post);
  if (localPath) {
    try {
      const stats = fs.statSync(localPath);
      if (stats.isFile() && stats.size > 0) {
        if (stats.size > config.youtube.maxVideoBytes) {
          return { ok: false, reason: `Video exceeds the ${config.youtube.maxVideoBytes} byte YouTube upload limit configured for this product.` };
        }
        return { ok: true, source: 'local', createBody: () => fs.createReadStream(localPath), fileSize: stats.size };
      }
    } catch (error) {
      // Local uploads are wiped on redeploy; fall through to the durable URL.
    }
  }

  const remoteUrl = [post.mediaUrl, post.videoPath, post.mediaPath, post.publicMediaUrl]
    .map((value) => String(value || '').trim())
    .find(Boolean) || '';
  if (!remoteUrl) return { ok: false, reason: 'Video media reference is missing for this job.' };
  if (!isTrustedRemoteMediaUrl(remoteUrl)) {
    return { ok: false, reason: 'Video media URL is not a trusted HTTPS video source; YouTube upload was blocked.' };
  }

  let response;
  try {
    response = await fetch(remoteUrl, { redirect: 'error', signal: requestSignal(config.youtube.uploadTimeoutMs) });
  } catch (error) {
    return { ok: false, reason: `Could not load video media: ${error.message}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `Video media download returned HTTP ${response.status}` };
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    await cancelBody(response);
    return { ok: false, reason: 'Video media source did not declare a Content-Length; YouTube upload was blocked.' };
  }
  if (contentLength > config.youtube.maxVideoBytes) {
    await cancelBody(response);
    return { ok: false, reason: `Video exceeds the ${config.youtube.maxVideoBytes} byte YouTube upload limit configured for this product.` };
  }
  return { ok: true, source: 'remote', createBody: () => response.body, fileSize: contentLength, cancel: () => cancelBody(response) };
}

async function cancelBody(response) {
  try {
    if (response && response.body && typeof response.body.cancel === 'function') await response.body.cancel();
  } catch (error) {
    // Stream may already be consumed or closed.
  }
}

// ── Resumable upload ───────────────────────────────────────────────────────

function validateYouTubeMetadata(metadata = {}) {
  const title = String(metadata.title || '').trim();
  if (!title) return { ok: false, reason: 'YouTube upload requires a non-empty title.' };
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, reason: `YouTube title must be at most ${MAX_TITLE_LENGTH} characters.` };
  }
  if (/[<>]/.test(title)) return { ok: false, reason: 'YouTube titles cannot contain the characters < or >.' };
  const description = String(metadata.description || '').trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return { ok: false, reason: `YouTube description must be at most ${MAX_DESCRIPTION_LENGTH} characters.` };
  }
  if (/[<>]/.test(description)) return { ok: false, reason: 'YouTube descriptions cannot contain the characters < or >.' };
  return { ok: true, title, description };
}

/**
 * Uploads one video through the documented YouTube resumable protocol:
 *
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable  -> session URL
 *   2. PUT <session URL> with the streamed bytes            -> video resource
 *
 * privacyStatus is forced to 'private' and notifySubscribers to false —
 * callers cannot override either. The result distinguishes:
 *   ok:true                       — Google returned the video resource
 *   ok:false, sessionCreated:false — nothing external happened (retry-safe)
 *   ok:false, definitiveFailure    — Google rejected the upload (no video)
 *   ok:false, outcomeUnknown       — bytes may have arrived, no definitive
 *                                    answer (NEVER blind-retry)
 */
async function uploadVideo({ accessToken, media, metadata }) {
  const meta = validateYouTubeMetadata(metadata);
  if (!meta.ok) return { ok: false, sessionCreated: false, reason: meta.reason };

  const initUrl = new URL(`${config.youtube.uploadBaseUrl}/videos`);
  initUrl.search = new URLSearchParams({
    uploadType: 'resumable',
    part: 'snippet,status',
    notifySubscribers: 'false'
  }).toString();
  const contentType = String(metadata.mimeType || 'video/mp4');

  let initResponse;
  try {
    initResponse = await fetch(initUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': contentType,
        'X-Upload-Content-Length': String(media.fileSize)
      },
      body: JSON.stringify({
        snippet: {
          title: meta.title,
          ...(meta.description ? { description: meta.description } : {})
        },
        status: { privacyStatus: 'private' }
      }),
      signal: requestSignal()
    });
  } catch (error) {
    return { ok: false, sessionCreated: false, reason: `YouTube upload session request failed: ${error.message}` };
  }

  if (!initResponse.ok) {
    const body = await parseResponseBody(initResponse);
    return {
      ok: false,
      sessionCreated: false,
      reason: normalizeGoogleApiErrorMessage(body, initResponse.status, 'YouTube upload session'),
      providerErrorCategory: categorizeGoogleApiError(body, initResponse.status)
    };
  }

  const sessionUrl = initResponse.headers.get('location');
  if (!sessionUrl) {
    return { ok: false, sessionCreated: false, reason: 'YouTube did not return a resumable upload session URL.' };
  }

  // From here on an external session exists. The session URL is sensitive
  // operational state: it is never returned, logged, or persisted in any
  // caller-visible field.
  let putResponse;
  try {
    putResponse = await fetch(sessionUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(media.fileSize)
      },
      body: media.createBody(),
      duplex: 'half',
      signal: requestSignal(config.youtube.uploadTimeoutMs)
    });
  } catch (error) {
    // Bytes may have reached YouTube; a video may or may not exist.
    return {
      ok: false,
      sessionCreated: true,
      outcomeUnknown: true,
      reason: `YouTube upload did not return a definitive result (${error.message}). A video may exist; reconcile before retrying.`
    };
  }

  const body = await parseResponseBody(putResponse);
  if (putResponse.ok && body && body.id) {
    const status = body.status || {};
    return {
      ok: true,
      mode: 'api',
      response: {
        video_id: String(body.id),
        privacy_status: String(status.privacyStatus || ''),
        upload_status: String(status.uploadStatus || ''),
        channel_id: String((body.snippet && body.snippet.channelId) || ''),
        upload_method: UPLOAD_METHOD
      }
    };
  }
  if (putResponse.status >= 400 && putResponse.status < 500) {
    // Definitive rejection: YouTube documents 4xx during a resumable
    // session as a failed upload with no video created.
    return {
      ok: false,
      sessionCreated: true,
      definitiveFailure: true,
      reason: normalizeGoogleApiErrorMessage(body, putResponse.status, 'YouTube video upload'),
      providerErrorCategory: categorizeGoogleApiError(body, putResponse.status)
    };
  }
  // 5xx or a 2xx without a video id: not provably created, not provably
  // absent. Fail ambiguous, never blind-retry.
  return {
    ok: false,
    sessionCreated: true,
    outcomeUnknown: true,
    reason: `YouTube upload returned HTTP ${putResponse.status} without a definitive video resource. Reconcile before retrying.`
  };
}

// ── Status lookup (youtube.readonly) ───────────────────────────────────────

async function readUploadedVideo(accessToken, videoId) {
  const cleanVideoId = String(videoId || '').trim();
  if (!cleanVideoId) return { ok: false, reason: 'A YouTube video ID is required.' };

  const url = new URL(`${config.youtube.apiBaseUrl}/videos`);
  url.search = new URLSearchParams({ part: 'snippet,status,processingDetails', id: cleanVideoId }).toString();
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: requestSignal()
    });
  } catch (error) {
    return {
      ok: false,
      code: 'youtube_api_unavailable',
      retryable: true,
      reason: `YouTube status lookup failed: ${error.message}`
    };
  }
  const body = await parseResponseBody(response);
  if (!response.ok) {
    return {
      ok: false,
      reason: normalizeGoogleApiErrorMessage(body, response.status, 'YouTube status lookup'),
      code: response.status === 403 ? 'missing_readonly_scope' : 'youtube_api_error',
      retryable: response.status === 429 || response.status >= 500
    };
  }
  const item = body && Array.isArray(body.items) ? body.items[0] : null;
  if (!item) {
    return {
      ok: false,
      reason: 'YouTube returned no video for this ID (it may still be propagating or may have been deleted).',
      code: 'video_not_found',
      retryable: true
    };
  }
  const status = item.status || {};
  const snippet = item.snippet || {};
  const processing = item.processingDetails || {};
  return {
    ok: true,
    videoId: cleanVideoId,
    channelId: String(snippet.channelId || ''),
    channelTitle: String(snippet.channelTitle || ''),
    channelHandle: '',
    title: String(snippet.title || ''),
    uploadStatus: String(status.uploadStatus || ''),
    privacyStatus: String(status.privacyStatus || ''),
    processingStatus: String(processing.processingStatus || '')
  };
}

async function getUploadedVideoStatus({ userId, accountId, videoId, workspaceScope }) {
  const credentials = await getActiveYouTubeCredentials(userId, accountId, workspaceScope);
  if (!credentials.ok) return { ok: false, code: credentials.code, reason: credentials.reason };
  return readUploadedVideo(credentials.accessToken, videoId);
}

function verificationFailure(code, reason, status = null) {
  return {
    ok: false,
    code,
    reason,
    ...(status && status.videoId ? { externalVideoId: status.videoId } : {})
  };
}

async function verifyUploadedVideo({ accessToken, accountId, videoId, expectedTitle }) {
  let status = null;
  for (let attempt = 0; attempt < VERIFICATION_ATTEMPTS; attempt += 1) {
    status = await readUploadedVideo(accessToken, videoId);
    if (status.ok || !status.retryable || attempt === VERIFICATION_ATTEMPTS - 1) break;
    await new Promise((resolve) => setTimeout(resolve, VERIFICATION_BACKOFF_MS[attempt] || 1_000));
  }
  if (!status || !status.ok) {
    return verificationFailure(
      status && status.code ? status.code : 'provider_verification_failed',
      status && status.reason ? status.reason : 'YouTube read-back verification did not return a resource.',
      status
    );
  }
  if (status.videoId !== String(videoId || '').trim()) {
    return verificationFailure('provider_video_id_mismatch', 'YouTube read-back returned a different video ID.', status);
  }
  if (status.channelId !== String(accountId || '').trim()) {
    return verificationFailure('provider_channel_mismatch', 'YouTube read-back returned a different channel.', status);
  }
  if (status.privacyStatus !== 'private') {
    return verificationFailure('provider_privacy_mismatch', 'YouTube read-back did not confirm private visibility.', status);
  }
  if (status.title !== String(expectedTitle || '').trim()) {
    return verificationFailure('provider_title_mismatch', 'YouTube read-back title does not match the submitted proof title.', status);
  }
  if (['rejected', 'deleted', 'failed'].includes(status.uploadStatus.toLowerCase())) {
    return verificationFailure('provider_upload_rejected', `YouTube reported upload status ${status.uploadStatus}.`, status);
  }
  let channel;
  try {
    const channels = await listMyChannels(accessToken);
    channel = channels.find((entry) => entry.channelId === status.channelId);
  } catch (error) {
    return verificationFailure('provider_channel_verification_failed', error.message, status);
  }
  if (!channel) {
    return verificationFailure('provider_channel_mismatch', 'The uploaded resource channel is not owned by the authenticated YouTube identity.', status);
  }
  return {
    ok: true,
    provider: 'youtube',
    externalVideoId: status.videoId,
    channelId: status.channelId,
    channelTitle: channel.title || status.channelTitle,
    channelHandle: channel.handle,
    title: status.title,
    privacyStatus: status.privacyStatus,
    uploadStatus: status.uploadStatus,
    processingStatus: status.processingStatus,
    verifiedAt: new Date().toISOString(),
    uploadMethod: UPLOAD_METHOD
  };
}

// ── Worker publish path ────────────────────────────────────────────────────

function scopeIncludesUpload(scopeValue) {
  return String(scopeValue || '').split(/[,\s]+/).includes(UPLOAD_SCOPE);
}

function preProviderUploadFailure(reason, code) {
  return {
    ok: false,
    mode: 'api',
    ...(code ? { code } : {}),
    providerMutationStarted: false,
    failureBoundary: 'before_provider_upload_session',
    reason
  };
}

/**
 * The worker's YouTube publish handler. Every gate fails closed BEFORE any
 * external call; only a fully-gated job reaches the upload session. The
 * shape of the return value matches the TikTok publish results the worker
 * already finalizes, plus outcomeUnknown/providerStatus extensions.
 */
async function publishScheduledYouTubePost(post) {
  const configStatus = getYouTubeConfigStatus();
  if (!configStatus.configured) {
    return preProviderUploadFailure('YouTube publishing is not configured on this deployment; publishing was blocked.');
  }
  if (!configStatus.privateOnly) {
    // Part 3 implements private uploads only. Disabling the safety mode
    // does not unlock anything — it halts the provider.
    return preProviderUploadFailure('YOUTUBE_PRIVATE_ONLY is disabled but only private publishing is implemented; publishing was blocked.');
  }
  const accountId = String(post.accountId || '').trim();
  if (!accountId || accountId === 'legacy') {
    return preProviderUploadFailure('YouTube channel is unassigned for this job; publishing was blocked.');
  }
  if (post.publishId) {
    return preProviderUploadFailure('This job already has a YouTube video ID; publishing again was blocked.');
  }

  const workspaceScope = post.workspaceId ? { workspaceId: post.workspaceId } : undefined;
  const account = await storage.getYouTubeAccount(post.userId, accountId, workspaceScope);
  if (!account) {
    return preProviderUploadFailure(`YouTube channel ${accountId} is not connected for this owner; publishing was blocked.`);
  }
  if (!account.connected) {
    return preProviderUploadFailure('YouTube channel is disconnected; reconnect it before publishing.');
  }
  if (account.reauthorizationRequired) {
    return preProviderUploadFailure('YouTube channel requires reauthorization; reconnect it before publishing.', 'reauthorization_required');
  }
  if (account.grantedScopes && !scopeIncludesUpload(account.grantedScopes)) {
    return preProviderUploadFailure('The stored YouTube authorization is missing the youtube.upload scope; reconnect the channel.');
  }

  const youtubeMeta = (post.providerMetadata && post.providerMetadata.youtube) || {};
  const metadataCheck = validateYouTubeMetadata(youtubeMeta);
  if (!metadataCheck.ok) {
    return preProviderUploadFailure(metadataCheck.reason);
  }
  if (String(post.mediaType || '').toLowerCase() !== 'video') {
    return preProviderUploadFailure('YouTube publishing is video-only; this job has no video media.');
  }

  const credentials = await getActiveYouTubeCredentials(post.userId, accountId, workspaceScope);
  if (!credentials.ok) {
    return preProviderUploadFailure(credentials.reason, credentials.code);
  }

  const media = await getVideoSource(post);
  if (!media.ok) {
    return preProviderUploadFailure(media.reason);
  }

  try {
    const result = await uploadVideo({
      accessToken: credentials.accessToken,
      media,
      metadata: {
        title: youtubeMeta.title,
        description: youtubeMeta.description,
        mimeType: post.mimeType || 'video/mp4'
      }
    });
    if (result.ok) {
      const verification = await verifyUploadedVideo({
        accessToken: credentials.accessToken,
        accountId,
        videoId: result.response.video_id,
        expectedTitle: metadataCheck.title
      });
      if (!verification.ok) {
        return {
          ok: false,
          mode: 'api',
          code: 'PROVIDER_VERIFICATION_FAILED',
          outcomeUnknown: true,
          sessionCreated: true,
          providerMutationStarted: true,
          failureBoundary: 'provider_read_back',
          providerStatus: 'provider_verification_required',
          response: result.response,
          reason: verification.reason
        };
      }
      return {
        ...result,
        providerMutationStarted: true,
        providerStatus: 'uploaded_private',
        providerVerification: verification
      };
    }
    return {
      ok: false,
      mode: 'api',
      reason: result.reason,
      providerMutationStarted: result.sessionCreated === true,
      failureBoundary: result.sessionCreated === true
        ? 'provider_upload_session'
        : 'before_provider_upload_session',
      ...(result.outcomeUnknown ? { outcomeUnknown: true, code: 'PROVIDER_RECONCILIATION_REQUIRED' } : {}),
      ...(result.providerErrorCategory ? { providerErrorCategory: result.providerErrorCategory } : {})
    };
  } finally {
    if (typeof media.cancel === 'function') await media.cancel();
  }
}

// ── Error normalization ────────────────────────────────────────────────────

function isInvalidGrant(body) {
  return Boolean(body && typeof body === 'object' && String(body.error || '') === 'invalid_grant');
}

function normalizeGoogleOAuthErrorMessage(body, httpStatus) {
  if (body && typeof body === 'object') {
    const code = String(body.error || '').trim();
    const description = String(body.error_description || '').trim();
    if (code) return `Google OAuth error: ${code}${description ? ` (${description})` : ''}`;
  }
  return `Google OAuth returned HTTP ${httpStatus}`;
}

/** Safe one-line message from a Google API error body — never the raw body. */
function normalizeGoogleApiErrorMessage(body, httpStatus, operation) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
    ? body.error
    : null;
  if (error) {
    const reason = Array.isArray(error.errors) && error.errors[0] && error.errors[0].reason
      ? String(error.errors[0].reason)
      : '';
    const message = String(error.message || '').slice(0, 200);
    return `${operation} failed (HTTP ${httpStatus}${reason ? `, ${reason}` : ''})${message ? `: ${message}` : ''}`;
  }
  return `${operation} returned HTTP ${httpStatus}`;
}

function categorizeGoogleApiError(body, httpStatus) {
  const error = body && typeof body === 'object' && body.error && typeof body.error === 'object'
    ? body.error
    : {};
  const reason = Array.isArray(error.errors) && error.errors[0] && error.errors[0].reason
    ? String(error.errors[0].reason)
    : '';
  if (httpStatus === 401 || reason === 'authError') return 'authorization';
  if (httpStatus === 403 && /quota/i.test(reason)) return 'quota';
  if (httpStatus === 403) return 'permission';
  if (httpStatus === 400) return 'invalid_request';
  return 'provider_error';
}

module.exports = {
  UPLOAD_SCOPE,
  READONLY_SCOPE,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  getYouTubeConfigStatus,
  isYouTubeConfigured,
  createPkcePair,
  buildYouTubeAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
  normalizeTokenResponse,
  encryptTokens,
  decryptTokens,
  finalizeYouTubeConnection,
  listMyChannels,
  getActiveYouTubeCredentials,
  validateYouTubeMetadata,
  isTrustedRemoteMediaUrl,
  getVideoSource,
  uploadVideo,
  readUploadedVideo,
  getUploadedVideoStatus,
  verifyUploadedVideo,
  publishScheduledYouTubePost,
  redactSensitive
};
