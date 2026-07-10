'use strict';

// Versioned authenticated-encryption envelope for provider OAuth
// credentials (Part 3: YouTube). This is the ONLY module allowed to see
// both a plaintext token and its stored form.
//
// Envelope (plain JSON, safe to persist in Firestore):
//   { v: 1, alg: 'aes-256-gcm', kv: <key version>, iv, ct, tag }  (base64url)
//
// Properties enforced here:
//   - AES-256-GCM authenticated encryption (tamper -> decrypt fails)
//   - fresh random 12-byte IV per encryption (never static, never reused)
//   - key versioning: records written under an old key version stay
//     readable after a new write key is introduced
//   - no plaintext fallback: a missing/malformed key fails closed
//   - decrypt errors are normalized so raw key/cipher material never
//     appears in error messages or logs

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');
const config = require('./config');

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

class TokenVaultError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TokenVaultError';
    this.code = code || 'token_vault_error';
  }
}

/**
 * Accepts a 32-byte key as base64 (44 chars, most common), base64url, or
 * hex (64 chars). Returns null instead of throwing so callers can report
 * "not configured" distinctly from "wrong key".
 */
function parseKeyMaterial(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  const attempts = [];
  if (/^[0-9a-fA-F]{64}$/.test(value)) attempts.push(() => Buffer.from(value, 'hex'));
  attempts.push(() => Buffer.from(value, 'base64'));
  attempts.push(() => Buffer.from(value, 'base64url'));
  for (const attempt of attempts) {
    try {
      const key = attempt();
      if (key.length === KEY_BYTES) return key;
    } catch (error) {
      // Try the next encoding.
    }
  }
  return null;
}

function keyForVersion(version, keys) {
  const table = keys || config.tokenEncryption.keys;
  return parseKeyMaterial(table[version]);
}

function isVaultConfigured({ keys, writeKeyVersion } = {}) {
  const version = writeKeyVersion || config.tokenEncryption.writeKeyVersion;
  return Boolean(keyForVersion(version, keys));
}

/**
 * Encrypts a plain object (e.g. { access_token, refresh_token }) into a
 * versioned envelope. Throws TokenVaultError when no valid write key is
 * configured — callers must treat that as "provider unavailable", never
 * fall back to plaintext persistence.
 */
function encryptCredentials(payload, { keys, writeKeyVersion } = {}) {
  const version = writeKeyVersion || config.tokenEncryption.writeKeyVersion;
  const key = keyForVersion(version, keys);
  if (!key) {
    throw new TokenVaultError(
      'Token encryption key is not configured; refusing to persist credentials.',
      'vault_not_configured'
    );
  }
  const plaintext = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    kv: version,
    iv: iv.toString('base64url'),
    ct: ciphertext.toString('base64url'),
    tag: tag.toString('base64url')
  };
}

/**
 * Decrypts an envelope produced by encryptCredentials. Every failure mode
 * (missing key, unknown version, tampered ciphertext, wrong key) throws a
 * TokenVaultError with a stable code and NO cipher/key material attached.
 */
function decryptCredentials(envelope, { keys } = {}) {
  if (!envelope || typeof envelope !== 'object' || envelope.v !== ENVELOPE_VERSION || envelope.alg !== ALGORITHM) {
    throw new TokenVaultError('Credential envelope is missing or malformed.', 'vault_bad_envelope');
  }
  const key = keyForVersion(envelope.kv, keys);
  if (!key) {
    throw new TokenVaultError(
      `No token encryption key is configured for key version ${Number(envelope.kv) || '?'}.`,
      'vault_key_unavailable'
    );
  }
  let plaintext;
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(String(envelope.iv || ''), 'base64url'));
    decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64url'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.ct || ''), 'base64url')),
      decipher.final()
    ]);
  } catch (error) {
    throw new TokenVaultError(
      'Credential decryption failed authentication (wrong key or tampered record).',
      'vault_decrypt_failed'
    );
  }
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } catch (error) {
    throw new TokenVaultError('Decrypted credential payload is not valid JSON.', 'vault_bad_payload');
  }
}

/** True when the value looks like a vault envelope (never logs contents). */
function isCredentialEnvelope(value) {
  return Boolean(
    value && typeof value === 'object'
    && value.v === ENVELOPE_VERSION && value.alg === ALGORITHM
    && typeof value.ct === 'string' && typeof value.iv === 'string' && typeof value.tag === 'string'
  );
}

module.exports = {
  ENVELOPE_VERSION,
  KEY_BYTES,
  TokenVaultError,
  isVaultConfigured,
  encryptCredentials,
  decryptCredentials,
  isCredentialEnvelope
};
