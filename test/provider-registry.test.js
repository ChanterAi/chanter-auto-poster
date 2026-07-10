'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const providers = require('../src/providers');
const mediaPolicy = require('../src/mediaPolicy');

test('TikTok is Provider #1: active, connectable, and schedulable', () => {
  const definition = providers.getProviderDefinition('tiktok');
  assert.ok(definition, 'tiktok must be a known provider');
  assert.equal(definition.implementationStatus, 'active');
  assert.equal(definition.connection.supported, true);
  assert.equal(definition.capabilities.schedulable, true);
  assert.equal(providers.isProviderActive('tiktok'), true);
  assert.equal(providers.assertSchedulableProvider('TikTok ').id, 'tiktok');
});

test('TikTok capabilities match the actual product behavior', () => {
  const definition = providers.getProviderDefinition('tiktok');
  // New intake is video-only and formats come from the one shared media
  // policy, so registry truth cannot drift from enforcement truth.
  assert.deepEqual(definition.capabilities.mediaTypes, ['video']);
  assert.deepEqual(definition.capabilities.videoFormats, mediaPolicy.VIDEO_EXTENSIONS);
  assert.equal(definition.capabilities.videoPublishing, true);
  assert.equal(definition.capabilities.imagePublishing, false);
  assert.equal(definition.capabilities.directPost, true);
  assert.equal(definition.capabilities.approvalRequired, true);
  assert.equal(definition.capabilities.remoteStatusLookup, false);
  assert.equal(definition.capabilities.remoteDeletion, false);
  assert.equal(definition.capabilities.analytics, false);
  assert.equal(providers.providerSupportsMediaType('tiktok', 'video'), true);
  assert.equal(providers.providerSupportsMediaType('tiktok', 'photo'), false);
});

test('only TikTok is active; no other provider is schedulable or connectable', () => {
  for (const summary of providers.listProviderSummaries()) {
    if (summary.id === 'tiktok') continue;
    assert.notEqual(summary.implementationStatus, 'active', `${summary.id} must not be active`);
    assert.equal(summary.schedulable, false, `${summary.id} must not be schedulable`);
    assert.equal(summary.connectionSupported, false, `${summary.id} must not be connectable`);
  }
  assert.equal(providers.getImplementationStatus('youtube'), 'unsupported');
  assert.equal(providers.getImplementationStatus('linkedin'), 'unsupported');
  // ENABLE_INSTAGRAM defaults off in tests, so the partial legacy
  // integration reads as disabled.
  assert.equal(providers.getImplementationStatus('instagram'), 'disabled');
});

test('unknown providers fail closed', () => {
  assert.equal(providers.isKnownProvider('mastodon'), false);
  assert.equal(providers.getProviderDefinition('mastodon'), null);
  assert.throws(
    () => providers.assertSchedulableProvider('mastodon'),
    (error) => error instanceof providers.ProviderError && error.code === 'unknown_provider'
  );
  assert.throws(
    () => providers.providerSupportsCapability('mastodon', 'schedulable'),
    (error) => error.code === 'unknown_provider'
  );
  assert.throws(
    () => providers.providerSupportsMediaType('mastodon', 'video'),
    (error) => error.code === 'unknown_provider'
  );
});

test('disabled and unsupported providers cannot schedule', () => {
  for (const providerId of ['instagram', 'youtube', 'linkedin']) {
    assert.throws(
      () => providers.assertSchedulableProvider(providerId),
      (error) => error instanceof providers.ProviderError && error.code === 'provider_not_schedulable',
      `${providerId} must be rejected for scheduling`
    );
  }
});

test('unsupported capabilities produce explicit structured errors', () => {
  assert.throws(
    () => providers.assertProviderCapability('tiktok', 'imagePublishing'),
    (error) => error instanceof providers.ProviderError
      && error.code === 'capability_unsupported'
      && error.details.capability === 'imagePublishing'
  );
  assert.throws(
    () => providers.providerSupportsCapability('tiktok', 'teleportation'),
    (error) => error.code === 'unknown_capability'
  );
});

test('stored provider normalization: missing defaults to TikTok, explicit unknown never does', () => {
  assert.deepEqual(providers.normalizeStoredProviderId(''), {
    providerId: 'tiktok',
    source: 'legacy_default',
    known: true
  });
  assert.deepEqual(providers.normalizeStoredProviderId(undefined), {
    providerId: 'tiktok',
    source: 'legacy_default',
    known: true
  });
  assert.deepEqual(providers.normalizeStoredProviderId(' TikTok '), {
    providerId: 'tiktok',
    source: 'explicit',
    known: true
  });
  const unknown = providers.normalizeStoredProviderId('mastodon');
  assert.equal(unknown.providerId, 'mastodon');
  assert.equal(unknown.source, 'explicit');
  assert.equal(unknown.known, false);
});

test('the registry is declarative: it owns no storage, queue, or provider-API code', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'providers.js'), 'utf8');
  for (const forbidden of ["require('./storage')", "require('./firestore')", "require('./tiktok')", "require('./instagram')", "require('./scheduler')", 'fetch(']) {
    assert.equal(source.includes(forbidden), false, `providers.js must not contain ${forbidden}`);
  }
});
