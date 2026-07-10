'use strict';

// Canonical connected-account domain for the AutoPoster product.
//
// The source of truth stays the existing TikTok account records
// (storage.js / tiktokAccountsCollection plus the legacy singleton auth doc
// that storage already normalizes). This module maps one of those records
// into the one safe connected-account shape that the website, application
// service, Agent Runtime, and MCP may serialize.
//
// Security boundary: a connected-account view NEVER contains access tokens,
// refresh tokens, client secrets, authorization codes, or credential
// payloads. Every field below is copied explicitly (allowlist), so a new
// secret added to the underlying record cannot leak by spread/copy.

const providers = require('./providers');

// Connection status states the product can actually determine from stored
// records without a network call. These are the exact final states:
//
//   connected                - account record is connected and usable (its
//                              token is present and either unexpired or
//                              refreshable via a stored refresh token)
//   reauthorization_required - token is present but expired and there is no
//                              refresh token, so only a human reconnect can
//                              restore publishing
//   disconnected             - the record is not connected (disconnect
//                              cleared its tokens, or it never finished
//                              OAuth)
//
// States like "degraded", "revoked", or "unknown" are deliberately not
// produced: nothing stored today can distinguish them truthfully.
const CONNECTION_STATUS = Object.freeze({
  CONNECTED: 'connected',
  REAUTHORIZATION_REQUIRED: 'reauthorization_required',
  DISCONNECTED: 'disconnected'
});

// Publishing-readiness blockers. Connection existence and publishing
// readiness are different questions: a connected account may still be
// blocked from scheduling.
const READINESS_BLOCKERS = Object.freeze({
  PROVIDER_NOT_ACTIVE: 'provider_not_active',
  ACCOUNT_DISCONNECTED: 'account_disconnected',
  REAUTHORIZATION_REQUIRED: 'reauthorization_required',
  MISSING_VIDEO_PUBLISH_SCOPE: 'missing_video_publish_scope'
});

const VIDEO_PUBLISH_SCOPE = 'video.publish';

// The one scope each provider's publish path actually requires. Readiness
// gates on the provider's own scope — TikTok's video.publish, YouTube's
// youtube.upload — never on another provider's vocabulary.
const PROVIDER_PUBLISH_SCOPES = Object.freeze({
  tiktok: VIDEO_PUBLISH_SCOPE,
  youtube: 'https://www.googleapis.com/auth/youtube.upload'
});

function requiredPublishScope(providerId) {
  return PROVIDER_PUBLISH_SCOPES[providerId] || null;
}

function toIsoSafe(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function connectionId(providerId, accountId) {
  return `${providerId}:${accountId}`;
}

function parseScopes(rawScope) {
  return String(rawScope || '')
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function resolveTokenState(account, nowMs) {
  // Two record shapes feed this: TikTok records carry raw token fields;
  // YouTube records carry PRESENCE-ONLY metadata (their tokens exist only
  // inside an encrypted vault envelope that never reaches this module).
  const tokenPresent = 'tokenPresent' in account
    ? Boolean(account.tokenPresent)
    : Boolean(account.access_token);
  const refreshTokenPresent = 'refreshTokenPresent' in account
    ? Boolean(account.refreshTokenPresent)
    : Boolean(account.refresh_token);
  const tokenExpiresAt = toIsoSafe(account.accessTokenExpiresAt || account.expires_at);
  const expiresAtMs = tokenExpiresAt ? Date.parse(tokenExpiresAt) : NaN;
  // No stored expiry means "no known expiry" (matches the publish path's
  // refresh logic, which only refreshes when expires_at is present).
  const tokenExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  return {
    tokenPresent,
    refreshTokenPresent,
    tokenExpiresAt,
    tokenExpired,
    // An explicit stored flag (e.g. Google returned invalid_grant on a
    // refresh attempt) wins; otherwise derived exactly as before. An access
    // token merely being expired is NOT a blocker while a refresh token
    // exists — the publish path refreshes server-side.
    reauthorizationRequired: account.reauthorizationRequired === true
      || (tokenExpired && !refreshTokenPresent)
  };
}

function resolveConnectionStatus(account, tokenState) {
  // account.connected already encodes token presence for real records
  // (storage computes connected = Boolean(connected && access_token)), so it
  // is the trusted connection signal here.
  if (!account.connected) return CONNECTION_STATUS.DISCONNECTED;
  if (tokenState.reauthorizationRequired) return CONNECTION_STATUS.REAUTHORIZATION_REQUIRED;
  return CONNECTION_STATUS.CONNECTED;
}

function resolveReadiness(providerDefinition, status, authorization) {
  const blockers = [];
  if (!providerDefinition || providerDefinition.implementationStatus !== providers.IMPLEMENTATION_STATUS.ACTIVE) {
    blockers.push(READINESS_BLOCKERS.PROVIDER_NOT_ACTIVE);
  }
  if (status === CONNECTION_STATUS.DISCONNECTED) {
    blockers.push(READINESS_BLOCKERS.ACCOUNT_DISCONNECTED);
  }
  if (status === CONNECTION_STATUS.REAUTHORIZATION_REQUIRED) {
    blockers.push(READINESS_BLOCKERS.REAUTHORIZATION_REQUIRED);
  }
  // Scopes block only when they were recorded and provably exclude the
  // provider's own publish scope. Legacy records without a stored scope
  // stay usable — "not recorded" is not evidence of a missing grant.
  if (authorization.scopesRecorded && authorization.hasVideoPublishScope === false) {
    blockers.push(READINESS_BLOCKERS.MISSING_VIDEO_PUBLISH_SCOPE);
  }
  return { ready: blockers.length === 0, blockers };
}

/**
 * Maps one stored account record into the canonical safe connected-account
 * view. Accounts without an explicit provider are legacy TikTok records and
 * normalize to TikTok; an explicit unknown provider on a record is rejected
 * rather than silently treated as TikTok.
 */
function toConnectedAccount(account, { now = Date.now() } = {}) {
  if (!account || !account.accountId) return null;

  const resolved = providers.normalizeStoredProviderId(account.provider || account.platform);
  if (!resolved.known) {
    throw new providers.ProviderError(
      `Account ${account.accountId} references unknown publishing provider: ${resolved.providerId}.`,
      { status: 422, code: 'unknown_provider', details: { accountId: account.accountId } }
    );
  }
  const providerDefinition = providers.getProviderDefinition(resolved.providerId);

  const tokenState = resolveTokenState(account, now);
  const status = resolveConnectionStatus(account, tokenState);
  const scopes = parseScopes(account.scope);
  const requiredScope = requiredPublishScope(providerDefinition.id);
  const authorization = {
    scopesRecorded: scopes.length > 0,
    scopes,
    requiredPublishScope: requiredScope,
    hasVideoPublishScope: scopes.length > 0 && requiredScope ? scopes.includes(requiredScope) : null
  };
  const readiness = resolveReadiness(providerDefinition, status, authorization);

  return {
    connectionId: connectionId(providerDefinition.id, account.accountId),
    provider: providerDefinition.id,
    providerDisplayName: providerDefinition.displayName,
    providerImplementationStatus: providerDefinition.implementationStatus,
    providerSource: resolved.source,
    ownerUserId: String(account.userId || ''),
    accountId: String(account.accountId),
    providerAccountId: String(account.open_id || account.accountId),
    username: String(account.username || ''),
    displayName: String(account.displayName || ''),
    avatarUrl: String(account.avatarUrl || ''),
    connectionStatus: status,
    publishingReady: readiness.ready,
    readinessBlockers: readiness.blockers,
    authorization,
    token: {
      tokenPresent: tokenState.tokenPresent,
      refreshTokenPresent: tokenState.refreshTokenPresent,
      tokenExpiresAt: tokenState.tokenExpiresAt,
      tokenExpired: tokenState.tokenExpired,
      reauthorizationRequired: tokenState.reauthorizationRequired
    },
    clientAccessEnabled: Boolean(account.clientAccessEnabled),
    createdAt: toIsoSafe(account.createdAt),
    updatedAt: toIsoSafe(account.updatedAt),
    // connectedAt is written on every successful OAuth exchange, so it is
    // the last time this connection was verified against the provider.
    lastVerifiedAt: toIsoSafe(account.connectedAt)
  };
}

/**
 * Human-readable blocker labels for the website summary. Kept here so the
 * website and any future evidence surface describe readiness identically.
 */
const BLOCKER_LABELS = Object.freeze({
  [READINESS_BLOCKERS.PROVIDER_NOT_ACTIVE]: 'Provider is not active',
  [READINESS_BLOCKERS.ACCOUNT_DISCONNECTED]: 'Channel is disconnected — reconnect to publish',
  [READINESS_BLOCKERS.REAUTHORIZATION_REQUIRED]: 'Reauthorization required — reconnect this channel',
  [READINESS_BLOCKERS.MISSING_VIDEO_PUBLISH_SCOPE]: 'Missing the required publish permission — reconnect this channel'
});

function describeReadinessBlocker(code) {
  return BLOCKER_LABELS[code] || 'Publishing is blocked for this channel';
}

module.exports = {
  CONNECTION_STATUS,
  READINESS_BLOCKERS,
  VIDEO_PUBLISH_SCOPE,
  requiredPublishScope,
  connectionId,
  toConnectedAccount,
  describeReadinessBlocker
};
