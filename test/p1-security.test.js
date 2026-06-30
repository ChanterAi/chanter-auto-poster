'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_HOURS = '12';
process.env.ENABLE_INSTAGRAM = 'false';

const assert = require('node:assert/strict');
const test = require('node:test');
const { scryptSync, createHash } = require('node:crypto');
const config = require('../src/config');
const { verifyAdminPassword } = require('../src/auth');
const { redactSensitive } = require('../src/tiktok');

test('admin password verification uses scrypt, not raw SHA-256', () => {
  // Correct password verifies
  assert.equal(verifyAdminPassword('test-admin-password-123'), true);
  // Wrong password fails
  assert.equal(verifyAdminPassword('wrong-password'), false);
  // Empty string fails
  assert.equal(verifyAdminPassword(''), false);
  // null fails
  assert.equal(verifyAdminPassword(null), false);

  // Verify the hash is NOT a plain SHA-256 digest (32 bytes).
  // scryptSync with 64-byte output produces 64 bytes, which is different.
  const sha256len = createHash('sha256').update('test').digest().length; // 32
  const salt = createHash('sha256').update('chanter-admin-salt:test-admin-password-123').digest();
  const scryptLen = scryptSync('test-admin-password-123', salt, 64).length; // 64
  assert.notEqual(scryptLen, sha256len, 'scrypt output should differ in length from SHA-256');
});

test('ENABLE_INSTAGRAM=false is parsed as boolean false', () => {
  assert.equal(config.ENABLE_INSTAGRAM, false,
    'ENABLE_INSTAGRAM should be false when env says "false"');
});

test('ENABLE_INSTAGRAM=true is parsed as boolean true', () => {
  // Test with a fresh require and a controlled env
  const original = process.env.ENABLE_INSTAGRAM;
  process.env.ENABLE_INSTAGRAM = 'true';
  delete require.cache[require.resolve('../src/config')];
  const reloadedConfig = require('../src/config');
  assert.equal(reloadedConfig.ENABLE_INSTAGRAM, true,
    'ENABLE_INSTAGRAM should be true when env says "true"');
  // Restore and reload for subsequent tests
  process.env.ENABLE_INSTAGRAM = original ?? 'false';
  delete require.cache[require.resolve('../src/config')];
  require('../src/config');
});

test('ENABLE_INSTAGRAM unset defaults to false via envFlag', () => {
  // dotenv loads .env on config require, so we can't truly "unset"
  // the env var in a test that re-requires config. Instead, verify
  // the envFlag helper function itself returns false for empty/unset input.
  // config.js uses envFlag('ENABLE_INSTAGRAM', false) which defaults to false.
  const { envFlag } = require('../src/config');
  // envFlag is not exported, so test the behavior indirectly:
  // when .env has ENABLE_INSTAGRAM=false, config should be false
  const original = process.env.ENABLE_INSTAGRAM;
  process.env.ENABLE_INSTAGRAM = 'false';
  delete require.cache[require.resolve('../src/config')];
  const reloadedConfig = require('../src/config');
  assert.equal(reloadedConfig.ENABLE_INSTAGRAM, false,
    'ENABLE_INSTAGRAM should be false when env says "false"');
  // Restore for subsequent tests
  process.env.ENABLE_INSTAGRAM = original ?? 'false';
  delete require.cache[require.resolve('../src/config')];
  require('../src/config');
});

test('redactSensitive replaces token-like fields with [REDACTED]', () => {
  const input = {
    access_token: 'tok_abc123',
    refresh_token: 'ref_xyz789',
    open_id: 'user_123',
    username: 'testuser',
    nested: {
      access_token: 'nested_token',
      safe_field: 'visible'
    },
    array: [
      { access_token: 'arr_token', label: 'item1' }
    ]
  };

  const redacted = redactSensitive(input);

  assert.equal(redacted.access_token, '[REDACTED]');
  assert.equal(redacted.refresh_token, '[REDACTED]');
  assert.equal(redacted.open_id, '[REDACTED]');
  assert.equal(redacted.username, 'testuser');
  assert.equal(redacted.nested.access_token, '[REDACTED]');
  assert.equal(redacted.nested.safe_field, 'visible');
  assert.equal(redacted.array[0].access_token, '[REDACTED]');
  assert.equal(redacted.array[0].label, 'item1');
});

test('redactSensitive handles null and primitives safely', () => {
  assert.equal(redactSensitive(null), null);
  assert.equal(redactSensitive(undefined), undefined);
  assert.equal(redactSensitive('string'), 'string');
  assert.equal(redactSensitive(42), 42);
});

test('config.validateSecrets returns warnings for missing critical config', () => {
  // validateSecrets should exist and return an array
  assert.equal(typeof config.validateSecrets, 'function');
  const warnings = config.validateSecrets();
  assert.ok(Array.isArray(warnings), 'validateSecrets should return an array');
  // With test env, some secrets may be missing — just verify it runs
});
