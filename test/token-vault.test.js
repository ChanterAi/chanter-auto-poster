'use strict';

// Token vault security properties. No live services; keys are supplied
// explicitly so nothing here depends on ambient configuration.

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomBytes } = require('node:crypto');

const tokenVault = require('../src/tokenVault');

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const CANARY_ACCESS = 'CANARY-ACCESS-TOKEN-1a2b3c4d';
const CANARY_REFRESH = 'CANARY-REFRESH-TOKEN-9z8y7x6w';
const CANARY_SECRET = 'CANARY-CLIENT-SECRET-5e4f3g2h';

const keysA = { keys: { 1: KEY_A }, writeKeyVersion: 1 };

test('encrypt/decrypt round trip preserves the payload', () => {
  const payload = { access_token: CANARY_ACCESS, refresh_token: CANARY_REFRESH };
  const envelope = tokenVault.encryptCredentials(payload, keysA);
  assert.deepEqual(tokenVault.decryptCredentials(envelope, keysA), payload);
});

test('the serialized envelope never contains plaintext token or secret material', () => {
  const envelope = tokenVault.encryptCredentials({
    access_token: CANARY_ACCESS,
    refresh_token: CANARY_REFRESH,
    client_secret: CANARY_SECRET
  }, keysA);
  const serialized = JSON.stringify(envelope);
  assert.equal(serialized.includes(CANARY_ACCESS), false, 'access token must not appear');
  assert.equal(serialized.includes(CANARY_REFRESH), false, 'refresh token must not appear');
  assert.equal(serialized.includes(CANARY_SECRET), false, 'client secret must not appear');
  assert.equal(tokenVault.isCredentialEnvelope(envelope), true);
});

test('every encryption uses a fresh nonce and produces distinct ciphertext', () => {
  const payload = { access_token: CANARY_ACCESS };
  const first = tokenVault.encryptCredentials(payload, keysA);
  const second = tokenVault.encryptCredentials(payload, keysA);
  assert.notEqual(first.iv, second.iv, 'IV must be unique per encryption');
  assert.notEqual(first.ct, second.ct, 'ciphertext must differ under unique IVs');
});

test('the wrong key fails closed', () => {
  const envelope = tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, keysA);
  assert.throws(
    () => tokenVault.decryptCredentials(envelope, { keys: { 1: KEY_B } }),
    (error) => error instanceof tokenVault.TokenVaultError && error.code === 'vault_decrypt_failed'
  );
});

test('tampered ciphertext and tampered tags fail authentication', () => {
  const envelope = tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, keysA);
  const flip = (value) => Buffer.from(value, 'base64url').map((byte, index) => (index === 0 ? byte ^ 0xff : byte));
  assert.throws(
    () => tokenVault.decryptCredentials({ ...envelope, ct: Buffer.from(flip(envelope.ct)).toString('base64url') }, keysA),
    (error) => error.code === 'vault_decrypt_failed'
  );
  assert.throws(
    () => tokenVault.decryptCredentials({ ...envelope, tag: Buffer.from(flip(envelope.tag)).toString('base64url') }, keysA),
    (error) => error.code === 'vault_decrypt_failed'
  );
});

test('key versioning: old-version envelopes stay readable after a new write key', () => {
  const envelope = tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, keysA);
  assert.equal(envelope.kv, 1);
  const rotated = { keys: { 1: KEY_A, 2: KEY_B }, writeKeyVersion: 2 };
  assert.equal(tokenVault.decryptCredentials(envelope, rotated).access_token, CANARY_ACCESS);
  const fresh = tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, rotated);
  assert.equal(fresh.kv, 2);
});

test('a missing or malformed key fails closed on both directions', () => {
  assert.equal(tokenVault.isVaultConfigured({ keys: {}, writeKeyVersion: 1 }), false);
  assert.equal(tokenVault.isVaultConfigured({ keys: { 1: 'too-short' }, writeKeyVersion: 1 }), false);
  assert.throws(
    () => tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, { keys: {}, writeKeyVersion: 1 }),
    (error) => error.code === 'vault_not_configured'
  );
  const envelope = tokenVault.encryptCredentials({ access_token: CANARY_ACCESS }, keysA);
  assert.throws(
    () => tokenVault.decryptCredentials({ ...envelope, kv: 9 }, keysA),
    (error) => error.code === 'vault_key_unavailable'
  );
});

test('malformed envelopes are rejected without throwing raw crypto errors', () => {
  for (const bad of [null, {}, { v: 1 }, { v: 2, alg: 'aes-256-gcm', kv: 1, iv: 'a', ct: 'b', tag: 'c' }]) {
    assert.throws(
      () => tokenVault.decryptCredentials(bad, keysA),
      (error) => error instanceof tokenVault.TokenVaultError
    );
  }
});
