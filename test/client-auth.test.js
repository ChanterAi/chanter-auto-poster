'use strict';

process.env.ADMIN_PASSWORD = 'test-admin-password-123';
process.env.ADMIN_SESSION_SECRET = 'test-admin-session-secret';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  generateAccessCode,
  parseAccessCode,
  verifyAccessSecret,
  createClientSessionToken,
  verifyClientSessionToken
} = require('../src/clientAuth');
const { createAdminSessionToken, verifyAdminSessionToken } = require('../src/auth');

test('generateAccessCode produces a verifiable code and rejects tampered secrets', () => {
  const generated = generateAccessCode();
  assert.match(generated.code, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const parsed = parseAccessCode(generated.code);
  assert.equal(parsed.clientLoginId, generated.clientLoginId);
  assert.equal(parsed.secret, generated.secret);

  assert.equal(verifyAccessSecret(parsed.secret, parsed.clientLoginId, generated.secretHash), true);
  assert.equal(verifyAccessSecret('wrong-secret', parsed.clientLoginId, generated.secretHash), false);
  // A secret hash is salted per clientLoginId, so it must not verify under
  // a different (even otherwise-valid-looking) loginId.
  assert.equal(verifyAccessSecret(parsed.secret, 'someone-elses-login-id', generated.secretHash), false);
});

test('parseAccessCode rejects malformed input', () => {
  assert.equal(parseAccessCode(''), null);
  assert.equal(parseAccessCode('no-separator'), null);
  assert.equal(parseAccessCode('.missing-login-id'), null);
  assert.equal(parseAccessCode('missing-secret.'), null);
});

test('two generated codes never collide and are independently verifiable', () => {
  const a = generateAccessCode();
  const b = generateAccessCode();
  assert.notEqual(a.clientLoginId, b.clientLoginId);
  assert.notEqual(a.code, b.code);
  assert.equal(verifyAccessSecret(a.secret, a.clientLoginId, b.secretHash), false);
});

test('client session tokens are role-isolated from admin session tokens', () => {
  const clientToken = createClientSessionToken({ accountId: 'account-a', userId: 'owner' });
  const clientSession = verifyClientSessionToken(clientToken);
  assert.ok(clientSession);
  assert.equal(clientSession.role, 'client');
  assert.equal(clientSession.accountId, 'account-a');

  // An admin-signed token must never verify as a client session, and
  // vice versa, even though both are HMAC-signed with related key material.
  const adminToken = createAdminSessionToken();
  assert.equal(verifyClientSessionToken(adminToken), null);
  assert.equal(verifyAdminSessionToken(clientToken), null);
});

test('expired client session tokens are rejected', () => {
  const past = Date.now() - 1000 * 60 * 60 * 24;
  const token = createClientSessionToken({ accountId: 'account-a', userId: 'owner' }, past);
  assert.equal(verifyClientSessionToken(token, Date.now()), null);
});
