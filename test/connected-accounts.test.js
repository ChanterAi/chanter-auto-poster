'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { CONNECTION_STATUS, READINESS_BLOCKERS, connectionId, toConnectedAccount, describeReadinessBlocker } = require('../src/connectedAccounts');
const { ProviderError } = require('../src/providers');

const CANARY_ACCESS_TOKEN = 'CANARY-ACCESS-TOKEN-a1b2c3d4e5f6a7b8';
const CANARY_REFRESH_TOKEN = 'CANARY-REFRESH-TOKEN-f6e5d4c3b2a1f6e5';
const NOW = Date.parse('2026-07-10T12:00:00.000Z');

function makeAccount(overrides = {}) {
  return {
    accountId: 'open-123',
    id: 'open-123',
    userId: 'owner',
    platform: 'tiktok',
    open_id: 'open-123',
    username: 'creator_one',
    displayName: 'Creator One',
    avatarUrl: 'https://cdn.example.com/avatar.jpg',
    connected: true,
    access_token: CANARY_ACCESS_TOKEN,
    refresh_token: CANARY_REFRESH_TOKEN,
    expires_at: '2026-07-11T12:00:00.000Z',
    scope: 'user.info.basic,video.publish',
    createdAt: { toDate: () => new Date('2026-06-01T00:00:00.000Z') },
    updatedAt: '2026-07-01T00:00:00.000Z',
    connectedAt: '2026-07-01T00:00:00.000Z',
    clientLoginId: 'client-login-1',
    clientAccessEnabled: true,
    ...overrides
  };
}

test('a healthy account maps to a connected, publishing-ready view with no secrets', () => {
  const view = toConnectedAccount(makeAccount(), { now: NOW });

  assert.equal(view.connectionId, connectionId('tiktok', 'open-123'));
  assert.equal(view.provider, 'tiktok');
  assert.equal(view.providerImplementationStatus, 'active');
  assert.equal(view.ownerUserId, 'owner');
  assert.equal(view.providerAccountId, 'open-123');
  assert.equal(view.connectionStatus, CONNECTION_STATUS.CONNECTED);
  assert.equal(view.publishingReady, true);
  assert.deepEqual(view.readinessBlockers, []);
  assert.equal(view.token.tokenPresent, true);
  assert.equal(view.token.refreshTokenPresent, true);
  assert.equal(view.token.tokenExpiresAt, '2026-07-11T12:00:00.000Z');
  assert.equal(view.token.reauthorizationRequired, false);
  assert.equal(view.authorization.hasVideoPublishScope, true);
  assert.equal(view.createdAt, '2026-06-01T00:00:00.000Z');
  assert.equal(view.lastVerifiedAt, '2026-07-01T00:00:00.000Z');

  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes(CANARY_ACCESS_TOKEN), false, 'access token must never serialize');
  assert.equal(serialized.includes(CANARY_REFRESH_TOKEN), false, 'refresh token must never serialize');
  assert.equal(serialized.includes('access_token'), false, 'no raw credential keys may appear');
  assert.equal(serialized.includes('refresh_token'), false, 'no raw credential keys may appear');
  assert.equal(serialized.includes('clientLoginId'), false, 'client login lookup key stays internal');
});

test('a disconnected account is not ready and reports the blocker', () => {
  const view = toConnectedAccount(
    makeAccount({ connected: false, access_token: '', refresh_token: '', expires_at: null }),
    { now: NOW }
  );
  assert.equal(view.connectionStatus, CONNECTION_STATUS.DISCONNECTED);
  assert.equal(view.publishingReady, false);
  assert.deepEqual(view.readinessBlockers, [READINESS_BLOCKERS.ACCOUNT_DISCONNECTED]);
  assert.equal(view.token.tokenPresent, false);
});

test('an expired token without a refresh token requires reauthorization', () => {
  const view = toConnectedAccount(
    makeAccount({ expires_at: '2026-07-09T12:00:00.000Z', refresh_token: '' }),
    { now: NOW }
  );
  assert.equal(view.connectionStatus, CONNECTION_STATUS.REAUTHORIZATION_REQUIRED);
  assert.equal(view.publishingReady, false);
  assert.deepEqual(view.readinessBlockers, [READINESS_BLOCKERS.REAUTHORIZATION_REQUIRED]);
  assert.equal(view.token.reauthorizationRequired, true);
  assert.ok(describeReadinessBlocker(view.readinessBlockers[0]).toLowerCase().includes('reauthorization'));
});

test('an expired token with a stored refresh token stays connected (refresh path exists)', () => {
  const view = toConnectedAccount(
    makeAccount({ expires_at: '2026-07-09T12:00:00.000Z' }),
    { now: NOW }
  );
  assert.equal(view.connectionStatus, CONNECTION_STATUS.CONNECTED);
  assert.equal(view.publishingReady, true);
  assert.equal(view.token.tokenExpired, true);
  assert.equal(view.token.reauthorizationRequired, false);
});

test('a recorded scope without video.publish blocks publishing; an unrecorded scope does not', () => {
  const wrongScope = toConnectedAccount(makeAccount({ scope: 'user.info.basic' }), { now: NOW });
  assert.equal(wrongScope.connectionStatus, CONNECTION_STATUS.CONNECTED);
  assert.equal(wrongScope.publishingReady, false);
  assert.deepEqual(wrongScope.readinessBlockers, [READINESS_BLOCKERS.MISSING_VIDEO_PUBLISH_SCOPE]);

  const noScope = toConnectedAccount(makeAccount({ scope: '' }), { now: NOW });
  assert.equal(noScope.publishingReady, true);
  assert.equal(noScope.authorization.scopesRecorded, false);
  assert.equal(noScope.authorization.hasVideoPublishScope, null);
});

test('missing provider on a legacy account normalizes to TikTok; explicit unknown is rejected', () => {
  const legacy = toConnectedAccount(makeAccount({ platform: undefined, provider: undefined }), { now: NOW });
  assert.equal(legacy.provider, 'tiktok');
  assert.equal(legacy.providerSource, 'legacy_default');

  assert.throws(
    () => toConnectedAccount(makeAccount({ platform: 'mastodon' }), { now: NOW }),
    (error) => error instanceof ProviderError && error.code === 'unknown_provider'
  );
});
