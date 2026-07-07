'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { redactRuntimeValue, looksLikeSecretValue, redactMediaReference } = require('../src/runtime/runtimeRedaction');

test('redacts TikTok/OAuth/API secret fields by key name, including nested and array forms', () => {
  const input = {
    access_token: 'tok_abc123',
    accessToken: 'tok_camel',
    refresh_token: 'ref_xyz789',
    client_secret: 'shh-secret',
    open_id: 'user_123',
    code: 'oauth-authorization-code',
    admin_password: 'hunter2',
    session_secret: 'zzz',
    username: 'creator_handle',
    caption: 'New drop this Friday, link in bio!',
    nested: { access_token: 'nested_token', safe_field: 'visible' },
    accounts: [{ refreshToken: 'array_token', label: 'primary' }]
  };

  const redacted = redactRuntimeValue(input);

  assert.equal(redacted.access_token, '[REDACTED]');
  assert.equal(redacted.accessToken, '[REDACTED]');
  assert.equal(redacted.refresh_token, '[REDACTED]');
  assert.equal(redacted.client_secret, '[REDACTED]');
  assert.equal(redacted.open_id, '[REDACTED]');
  assert.equal(redacted.code, '[REDACTED]');
  assert.equal(redacted.admin_password, '[REDACTED]');
  assert.equal(redacted.session_secret, '[REDACTED]');
  assert.equal(redacted.nested.access_token, '[REDACTED]');
  assert.equal(redacted.accounts[0].refreshToken, '[REDACTED]');

  // Non-sensitive campaign text stays readable.
  assert.equal(redacted.username, 'creator_handle');
  assert.equal(redacted.caption, 'New drop this Friday, link in bio!');
  assert.equal(redacted.nested.safe_field, 'visible');
  assert.equal(redacted.accounts[0].label, 'primary');
});

test('redacts long suspicious secret-shaped strings even under an innocuous key name', () => {
  const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dGhpc2lzYXNpZ25hdHVyZXBhcnQ';
  const longToken = 'aB3xK9pQzR7mN2vL8wE4tY6uI1oP5sD0fG9hJ3kM7nB2c';
  const redacted = redactRuntimeValue({
    weirdlyNamedField: jwtLike,
    anotherField: longToken,
    normalCaption: 'This is a perfectly normal caption with spaces and punctuation!'
  });

  assert.equal(redacted.weirdlyNamedField, '[REDACTED]');
  assert.equal(redacted.anotherField, '[REDACTED]');
  assert.equal(redacted.normalCaption, 'This is a perfectly normal caption with spaces and punctuation!');
});

test('looksLikeSecretValue rejects short strings and ordinary prose', () => {
  assert.equal(looksLikeSecretValue('short'), false);
  assert.equal(looksLikeSecretValue('This caption has plenty of characters but also spaces.'), false);
  assert.equal(looksLikeSecretValue(42), false);
  assert.equal(looksLikeSecretValue(null), false);
});

test('redacts signed/query tokens from media URLs but keeps the rest of the URL readable', () => {
  const signedUrl = 'https://cdn.example.com/videos/clip.mp4?token=abc123def456&expires=1999999999';
  const redacted = redactMediaReference(signedUrl);
  const parsed = new URL(redacted);

  assert.equal(parsed.origin + parsed.pathname, 'https://cdn.example.com/videos/clip.mp4');
  assert.equal(parsed.searchParams.get('token'), '[REDACTED]');
  assert.equal(parsed.searchParams.get('expires'), '[REDACTED]');
});

test('leaves plain media URLs without sensitive query params untouched', () => {
  const plainUrl = 'https://cdn.example.com/images/photo.jpg?size=large';
  assert.equal(redactMediaReference(plainUrl), plainUrl);
});

test('handles null, undefined, and primitive values safely', () => {
  assert.equal(redactRuntimeValue(null), null);
  assert.equal(redactRuntimeValue(undefined), undefined);
  assert.equal(redactRuntimeValue('plain string'), 'plain string');
  assert.equal(redactRuntimeValue(42), 42);
});

test('does not throw on circular references', () => {
  const circular = { name: 'campaign' };
  circular.self = circular;
  const redacted = redactRuntimeValue(circular);
  assert.equal(redacted.name, 'campaign');
  assert.equal(redacted.self, '[CIRCULAR]');
});
