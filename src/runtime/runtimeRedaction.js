'use strict';

// Redaction boundary for everything the AutoPoster runtime adapter exports
// (evidence bundles, task inputs, policy previews). Nothing built in
// src/runtime/* is allowed to leak a token, secret, password, or signed
// media URL — this module is the single place that guarantee is enforced.
//
// Deliberately independent from src/tiktok.js's redactSensitive(): that
// function's SENSITIVE_KEYS set is a production posting-flow concern this
// adapter must not couple to or influence. Overlap in behavior is
// intentional; the two are not the same contract.

const REDACTED = '[REDACTED]';

// Key names that are always treated as secrets, compared after lowercasing
// and stripping non-alphanumeric characters (so access_token, accessToken,
// and Access-Token all normalize to "accesstoken").
const EXACT_SENSITIVE_KEYS = new Set([
  'accesstoken', 'refreshtoken', 'bearer', 'bearertoken', 'authorization',
  'apikey', 'apisecret', 'clientsecret', 'clientid', 'sessionsecret',
  'adminsessionsecret', 'adminpassword', 'password', 'passwd',
  'oauthcode', 'authcode', 'oauth_code', 'code', 'openid', 'open_id',
  'cronsecret', 'tokensecret', 'privatekey', 'firebaseprivatekey'
]);

// Any normalized key that *contains* one of these substrings is treated as
// sensitive too, so nested/prefixed variants (tiktokAccessToken,
// instagramClientSecret, musicTokenSecret, ...) are caught without having
// to enumerate every combination.
const SENSITIVE_KEY_SUBSTRINGS = ['token', 'secret', 'password', 'apikey', 'bearer'];

// Query-string parameter names that indicate a signed/temporary media URL.
// Only these values are stripped from an otherwise-safe media reference —
// the path, host, and non-sensitive params stay visible for evidence review.
const SIGNED_URL_PARAM_NAMES = new Set([
  'token', 'signature', 'sig', 'expires', 'expiry', 'policy', 'keypairid',
  'xamzsignature', 'xamzcredential', 'xamzsecuritytoken', 'xamzalgorithm',
  'xgoogsignature', 'xgoogcredential', 'xgoogalgorithm', 'oe', 'auth'
]);

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_SUBSTRINGS.some((needle) => normalized.includes(needle));
}

/**
 * Heuristic for "long suspicious secret" string values that show up under
 * an innocuous key name: JWT-shaped triples, or a long unbroken run of
 * base64url/hex-like characters with no whitespace. Ordinary captions and
 * messages contain spaces/punctuation and never match this.
 */
function looksLikeSecretValue(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;
  if (/^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/.test(trimmed)) return true;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z0-9_\-.]{32,}$/.test(trimmed) && /[0-9]/.test(trimmed) && /[A-Za-z]/.test(trimmed);
}

/**
 * Redacts sensitive query parameters from a media/reference URL. Only the
 * matching parameter values are replaced — the rest of the URL (host,
 * path, non-sensitive params) stays intact for evidence review. Falls back
 * to whole-value redaction for non-URL strings that look like secrets.
 */
function redactMediaReference(value) {
  const text = String(value || '');
  if (!text) return text;

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return looksLikeSecretValue(text) ? REDACTED : text;
  }

  let redactedAny = false;
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key) || SIGNED_URL_PARAM_NAMES.has(normalizeKey(key))) {
      parsed.searchParams.set(key, REDACTED);
      redactedAny = true;
    }
  }
  return redactedAny ? parsed.toString() : text;
}

function redactStringValue(value) {
  if (looksLikeSecretValue(value)) return REDACTED;
  if (/^https?:\/\//i.test(value)) return redactMediaReference(value);
  return value;
}

/**
 * Deep, JSON-safe redaction. Walks objects/arrays recursively; sensitive
 * keys are replaced wholesale, string values are scanned for secret-shaped
 * content and signed-URL query params, and circular references degrade to
 * a marker instead of throwing.
 */
function redactRuntimeValue(value, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return redactStringValue(value);
  if (typeof value !== 'object') return value;

  const seenSet = seen || new WeakSet();
  if (seenSet.has(value)) return '[CIRCULAR]';
  seenSet.add(value);

  if (Array.isArray(value)) return value.map((item) => redactRuntimeValue(item, seenSet));

  const result = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = val == null ? val : REDACTED;
      continue;
    }
    result[key] = redactRuntimeValue(val, seenSet);
  }
  return result;
}

module.exports = {
  REDACTED,
  isSensitiveKey,
  looksLikeSecretValue,
  redactMediaReference,
  redactRuntimeValue
};
