'use strict';

// OAuth transaction store semantics against a transactional Firestore
// fake: single-use, short-lived, user/provider-bound, replay-proof.

const assert = require('node:assert/strict');
const test = require('node:test');

const firestorePath = require.resolve('../src/firestore');
delete require.cache[firestorePath];

const records = new Map();
const timestamp = (ms) => ({ toMillis: () => ms, toDate: () => new Date(ms) });

require.cache[firestorePath] = {
  id: firestorePath,
  filename: firestorePath,
  loaded: true,
  exports: {
    oauthTransactionsCollection: () => ({
      doc: (id) => ({
        id,
        async set(data) { records.set(id, data); },
        async get() {
          return { exists: records.has(id), data: () => records.get(id) };
        }
      })
    }),
    getFirestore: () => ({
      runTransaction: async (callback) => callback({
        get: async (ref) => ({ exists: records.has(ref.id), data: () => records.get(ref.id) }),
        delete: (ref) => { records.delete(ref.id); }
      })
    }),
    Timestamp: {
      fromMillis: (ms) => timestamp(ms),
      now: () => timestamp(Date.now())
    }
  }
};

const store = require('../src/oauthStateStore');

test('state ids are cryptographically random and non-static', async () => {
  const a = await store.createOAuthState({ userId: 'owner', provider: 'youtube', returnTo: '/private/autoposter', codeVerifier: 'v1' });
  const b = await store.createOAuthState({ userId: 'owner', provider: 'youtube', returnTo: '/private/autoposter', codeVerifier: 'v2' });
  assert.notEqual(a, b);
  assert.ok(a.length >= 40, 'state must encode at least 32 random bytes');
});

test('a valid state preserves workspace binding and is consumed exactly once', async () => {
  const state = await store.createOAuthState({
    userId: 'owner',
    provider: 'youtube',
    returnTo: '/private/autoposter',
    codeVerifier: 'pkce-verifier',
    mode: 'connect',
    workspaceId: 'workspace-verified-00000001'
  });
  const first = await store.consumeOAuthState(state, { userId: 'owner', provider: 'youtube' });
  assert.equal(first.ok, true);
  assert.equal(first.record.codeVerifier, 'pkce-verifier');
  assert.equal(first.record.returnTo, '/private/autoposter');
  assert.equal(first.record.workspaceId, 'workspace-verified-00000001');
  const replay = await store.consumeOAuthState(state, { userId: 'owner', provider: 'youtube' });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, store.CONSUME_FAILURES.MISSING);
});

test('missing and altered states fail closed', async () => {
  assert.equal((await store.consumeOAuthState('', { userId: 'owner', provider: 'youtube' })).ok, false);
  assert.equal((await store.consumeOAuthState('not-a-real-state', { userId: 'owner', provider: 'youtube' })).ok, false);
});

test('expired states fail closed and are spent by the attempt', async () => {
  const state = await store.createOAuthState(
    { userId: 'owner', provider: 'youtube', returnTo: '/private/autoposter', codeVerifier: 'v' },
    { now: Date.now() - store.STATE_TTL_MS - 1000 }
  );
  const result = await store.consumeOAuthState(state, { userId: 'owner', provider: 'youtube' });
  assert.equal(result.ok, false);
  assert.equal(result.code, store.CONSUME_FAILURES.EXPIRED);
  // The attempt consumed the record: a second try cannot succeed either.
  const again = await store.consumeOAuthState(state, { userId: 'owner', provider: 'youtube' });
  assert.equal(again.code, store.CONSUME_FAILURES.MISSING);
});

test('states are bound to the user and the provider', async () => {
  const wrongUser = await store.createOAuthState({ userId: 'someone-else', provider: 'youtube', returnTo: '/', codeVerifier: 'v' });
  const asOwner = await store.consumeOAuthState(wrongUser, { userId: 'owner', provider: 'youtube' });
  assert.equal(asOwner.ok, false);
  assert.equal(asOwner.code, store.CONSUME_FAILURES.WRONG_USER);

  const wrongProvider = await store.createOAuthState({ userId: 'owner', provider: 'tiktok', returnTo: '/', codeVerifier: 'v' });
  const asYouTube = await store.consumeOAuthState(wrongProvider, { userId: 'owner', provider: 'youtube' });
  assert.equal(asYouTube.ok, false);
  assert.equal(asYouTube.code, store.CONSUME_FAILURES.WRONG_PROVIDER);
});

test('channel selections are single-use, bound, and cannot be consumed as states', async () => {
  const channels = [{ channelId: 'UC-one', title: 'One', handle: '@one', thumbnailUrl: '' }];
  const id = await store.createChannelSelection({
    userId: 'owner',
    provider: 'youtube',
    returnTo: '/private/autoposter',
    mode: 'connect',
    channels,
    credentialEnvelope: { v: 1, alg: 'aes-256-gcm', kv: 1, iv: 'i', ct: 'c', tag: 't' },
    tokenMeta: { tokenPresent: true }
  });
  // A selection id is not an OAuth state.
  const asState = await store.consumeOAuthState(id, { userId: 'owner', provider: 'youtube' });
  assert.equal(asState.ok, false);
  // ...and consuming it as a state spent it, proving single-use across kinds.
  const spent = await store.consumeChannelSelection(id, { userId: 'owner', provider: 'youtube' });
  assert.equal(spent.ok, false);

  const second = await store.createChannelSelection({
    userId: 'owner', provider: 'youtube', returnTo: '/', mode: 'connect', channels,
    credentialEnvelope: { v: 1, alg: 'aes-256-gcm', kv: 1, iv: 'i', ct: 'c', tag: 't' },
    tokenMeta: {}
  });
  const consumed = await store.consumeChannelSelection(second, { userId: 'owner', provider: 'youtube' });
  assert.equal(consumed.ok, true);
  assert.deepEqual(consumed.record.channels, channels);
  const replay = await store.consumeChannelSelection(second, { userId: 'owner', provider: 'youtube' });
  assert.equal(replay.ok, false);
});
