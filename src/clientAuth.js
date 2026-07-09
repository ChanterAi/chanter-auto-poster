'use strict';

// Client (tenant) authentication — deliberately separate from src/auth.js
// (the admin session module). A client is not an admin: a client session
// can only ever resolve to exactly one TikTok accountId, carried inside the
// signed token itself, and re-checked against Firestore on every request
// (see requireClientSession) so a revoked/disabled account loses access
// immediately instead of waiting out the token's expiry.
//
// Credential shape: an access code is `${clientLoginId}.${secret}`.
// `clientLoginId` is a random, non-secret lookup key stored in the
// tiktokAccounts document (queried by equality — O(1), never a collection
// scan). `secret` is the actual credential; only its scrypt hash is stored,
// salted deterministically from clientLoginId (unique per account) plus the
// server-side session secret (so a leaked Firestore doc alone isn't enough
// to precompute a rainbow table without also knowing the deployment's
// secret). This mirrors the admin password scheme in src/auth.js.

const { createHash, createHmac, randomBytes, timingSafeEqual, scryptSync } = require('crypto');
const config = require('./config');

const CLIENT_SESSION_COOKIE = 'chanter_client_session';
const SESSION_VERSION = 1;
const CODE_SEPARATOR = '.';

function sessionSigningKey() {
  return createHash('sha256')
    .update(`chanter-client-session:${config.adminSessionSecret || config.adminPassword}`)
    .digest();
}

function sign(value) {
  return createHmac('sha256', sessionSigningKey()).update(value).digest('base64url');
}

function createClientSessionToken({ accountId, userId }, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    v: SESSION_VERSION,
    role: 'client',
    accountId: String(accountId),
    userId: String(userId),
    iat: now,
    exp: now + config.adminSessionHours * 60 * 60 * 1000,
    nonce: randomBytes(16).toString('base64url')
  })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyClientSessionToken(token, now = Date.now()) {
  if (!token) return null;
  const [payload, signature, extra] = String(token).split('.');
  if (!payload || !signature || extra) return null;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      session.v !== SESSION_VERSION ||
      session.role !== 'client' ||
      !session.accountId ||
      !session.userId ||
      !Number.isFinite(session.exp) ||
      session.exp <= now
    ) return null;
    return session;
  } catch (error) {
    return null;
  }
}

function isSecureRequest(req) {
  return Boolean(req.secure || String(req.get('x-forwarded-proto') || '').toLowerCase() === 'https');
}

function setClientSessionCookie(req, res, claims) {
  const token = createClientSessionToken(claims);
  res.cookie(CLIENT_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    maxAge: config.adminSessionHours * 60 * 60 * 1000,
    path: '/'
  });
}

function clearClientSessionCookie(req, res) {
  res.clearCookie(CLIENT_SESSION_COOKIE, {
    httpOnly: true,
    secure: isSecureRequest(req),
    sameSite: 'lax',
    path: '/'
  });
}

function parseCookies(header) {
  return String(header || '').split(';').map((part) => part.trim()).filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      try {
        cookies[decodeURIComponent(part.slice(0, separator))] = decodeURIComponent(part.slice(separator + 1));
      } catch (error) {
        // Ignore malformed cookies instead of failing the entire request.
      }
      return cookies;
    }, {});
}

// Attaches req.clientSession from the signed cookie alone (cheap, no DB
// call) so it's safe to run on every request globally. Route guards that
// actually need to trust the identity (requireClientSession) re-verify
// against Firestore before using it — see clientRoutes.js.
function attachClientSession(req, res, next) {
  const token = parseCookies(req.headers.cookie)[CLIENT_SESSION_COOKIE];
  req.clientSession = verifyClientSessionToken(token);
  next();
}

// ── Access code generation / verification ──────────────────────────────

function randomToken(bytes) {
  return randomBytes(bytes).toString('base64url');
}

function accessSecretSalt(clientLoginId) {
  return createHash('sha256')
    .update(`chanter-client-access:${clientLoginId}:${config.adminSessionSecret || config.adminPassword}`)
    .digest();
}

function hashAccessSecret(secret, clientLoginId) {
  return scryptSync(String(secret), accessSecretSalt(clientLoginId), 64).toString('base64url');
}

function generateAccessCode() {
  const clientLoginId = randomToken(10);
  const secret = randomToken(24);
  return {
    clientLoginId,
    secret,
    code: `${clientLoginId}${CODE_SEPARATOR}${secret}`,
    secretHash: hashAccessSecret(secret, clientLoginId)
  };
}

function parseAccessCode(rawCode) {
  const value = String(rawCode || '').trim();
  const separatorIndex = value.indexOf(CODE_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null;
  return {
    clientLoginId: value.slice(0, separatorIndex),
    secret: value.slice(separatorIndex + 1)
  };
}

function verifyAccessSecret(candidateSecret, clientLoginId, storedHash) {
  if (!storedHash) return false;
  const expected = Buffer.from(String(storedHash));
  let actual;
  try {
    actual = Buffer.from(hashAccessSecret(candidateSecret, clientLoginId));
  } catch (error) {
    return false;
  }
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

module.exports = {
  CLIENT_SESSION_COOKIE,
  attachClientSession,
  clearClientSessionCookie,
  createClientSessionToken,
  generateAccessCode,
  hashAccessSecret,
  parseAccessCode,
  setClientSessionCookie,
  verifyAccessSecret,
  verifyClientSessionToken
};
