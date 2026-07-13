'use strict';

// Server-side, single-use OAuth transaction store (YouTube and admin TikTok).
//
// Two record kinds live in one short-lived collection:
//
//   kind 'oauth_state'        — the OAuth `state` value for one authorize
//                               redirect. Binds the transaction to the
//                               authenticated local user, the provider, an
//                               allowlisted internal return path, the PKCE
//                               code verifier, and (for reauthorize) the
//                               intended existing account.
//   kind 'channel_selection'  — a pending multi-channel selection created
//                               after a successful code exchange returned
//                               more than one channel. Holds the ENCRYPTED
//                               credential envelope and the safe channel
//                               list Google actually returned, so the
//                               follow-up POST can only pick one of those.
//
// Single-use is enforced with a Firestore transaction that reads and
// deletes atomically: a replayed value finds no document and fails closed.
// Expiry is enforced on read (expired records are deleted, not honored).

const { randomBytes } = require('crypto');
const { oauthTransactionsCollection, getFirestore, Timestamp } = require('./firestore');

const STATE_TTL_MS = 10 * 60 * 1000;
const SELECTION_TTL_MS = 10 * 60 * 1000;

const CONSUME_FAILURES = Object.freeze({
  MISSING: 'missing_or_replayed',
  EXPIRED: 'expired',
  WRONG_USER: 'wrong_user',
  WRONG_PROVIDER: 'wrong_provider',
  WRONG_KIND: 'wrong_kind'
});

function newTransactionId() {
  return randomBytes(32).toString('base64url');
}

function expiryTimestamp(ttlMs, now) {
  return Timestamp.fromMillis(now + ttlMs);
}

async function createRecord(kind, ttlMs, fields, { now = Date.now() } = {}) {
  const id = newTransactionId();
  await oauthTransactionsCollection().doc(id).set({
    kind,
    createdAt: Timestamp.fromMillis(now),
    expiresAt: expiryTimestamp(ttlMs, now),
    ...fields
  });
  return id;
}

/**
 * Atomically consumes (reads + deletes) one transaction record. Returns
 * { ok: true, record } or { ok: false, code } — the record is deleted in
 * every reachable case, so no failure path leaves a usable value behind.
 */
async function consumeRecord(id, { kind, userId, provider, now = Date.now() } = {}) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return { ok: false, code: CONSUME_FAILURES.MISSING };
  const ref = oauthTransactionsCollection().doc(cleanId);

  return getFirestore().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return { ok: false, code: CONSUME_FAILURES.MISSING };
    const record = snap.data() || {};
    // Delete unconditionally: whatever the outcome, this value is spent.
    tx.delete(ref);

    if (record.kind !== kind) return { ok: false, code: CONSUME_FAILURES.WRONG_KIND };
    const expiresAtMs = record.expiresAt && typeof record.expiresAt.toMillis === 'function'
      ? record.expiresAt.toMillis()
      : 0;
    if (!expiresAtMs || expiresAtMs <= now) return { ok: false, code: CONSUME_FAILURES.EXPIRED };
    if (String(record.userId || '') !== String(userId || '')) {
      return { ok: false, code: CONSUME_FAILURES.WRONG_USER };
    }
    if (provider && String(record.provider || '') !== String(provider)) {
      return { ok: false, code: CONSUME_FAILURES.WRONG_PROVIDER };
    }
    return { ok: true, record };
  });
}

/**
 * Creates the state record for one authorize redirect. `returnTo` must
 * already be validated by auth.safeReturnTo — this module stores, it does
 * not re-derive trust.
 */
async function createOAuthState({ userId, provider, returnTo, codeVerifier, mode, accountId, workspaceId }, options) {
  return createRecord('oauth_state', STATE_TTL_MS, {
    userId: String(userId || ''),
    provider: String(provider || ''),
    returnTo: String(returnTo || ''),
    codeVerifier: String(codeVerifier || ''),
    mode: mode === 'reauthorize' ? 'reauthorize' : 'connect',
    accountId: String(accountId || ''),
    workspaceId: String(workspaceId || '')
  }, options);
}

async function consumeOAuthState(state, { userId, provider, now } = {}) {
  return consumeRecord(state, { kind: 'oauth_state', userId, provider, now });
}

/**
 * Pending multi-channel selection. `credentialEnvelope` must already be an
 * encrypted vault envelope — this module never sees plaintext tokens.
 */
async function createChannelSelection({
  userId,
  provider,
  returnTo,
  mode,
  accountId,
  workspaceId,
  channels,
  credentialEnvelope,
  tokenMeta
}, options) {
  return createRecord('channel_selection', SELECTION_TTL_MS, {
    userId: String(userId || ''),
    provider: String(provider || ''),
    returnTo: String(returnTo || ''),
    mode: mode === 'reauthorize' ? 'reauthorize' : 'connect',
    accountId: String(accountId || ''),
    workspaceId: String(workspaceId || ''),
    channels: Array.isArray(channels) ? channels : [],
    credentialEnvelope: credentialEnvelope || null,
    tokenMeta: tokenMeta || null
  }, options);
}

async function consumeChannelSelection(id, { userId, provider, now } = {}) {
  return consumeRecord(id, { kind: 'channel_selection', userId, provider, now });
}

/**
 * Read-only peek used to render the selection view (safe fields only —
 * never the credential envelope). Does not consume the record.
 */
async function peekChannelSelection(id, { userId, provider, now = Date.now() } = {}) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;
  const snap = await oauthTransactionsCollection().doc(cleanId).get();
  if (!snap.exists) return null;
  const record = snap.data() || {};
  const expiresAtMs = record.expiresAt && typeof record.expiresAt.toMillis === 'function'
    ? record.expiresAt.toMillis()
    : 0;
  if (
    record.kind !== 'channel_selection'
    || !expiresAtMs || expiresAtMs <= now
    || String(record.userId || '') !== String(userId || '')
    || (provider && String(record.provider || '') !== String(provider))
  ) return null;
  return {
    channels: Array.isArray(record.channels) ? record.channels : [],
    mode: record.mode || 'connect'
  };
}

module.exports = {
  STATE_TTL_MS,
  SELECTION_TTL_MS,
  CONSUME_FAILURES,
  createOAuthState,
  consumeOAuthState,
  createChannelSelection,
  consumeChannelSelection,
  peekChannelSelection
};
