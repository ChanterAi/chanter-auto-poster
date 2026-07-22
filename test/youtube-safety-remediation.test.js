'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  claimReconciliationLease,
  createInitialYouTubeProviderOperation,
  reconciliationLeaseAuthorizes,
  transitionProviderOperation
} = require('../src/youtubeProviderOperation');
const { containsForbiddenMaterial, safeDiagnosticText, FORBIDDEN_MATERIAL_MESSAGE } = require('../src/forbiddenMaterial');
const { inspectMp4Buffer, sanitizeApprovedMediaIdentity } = require('../src/approvedMediaIdentity');
const { acceptedOffsetFromRange } = require('../src/youtube');

function validMp4() {
  return Buffer.concat([
    Buffer.from([0, 0, 0, 24]), Buffer.from('ftyp'), Buffer.from('isom'),
    Buffer.from([0, 0, 0, 0]), Buffer.from('isom'), Buffer.from('mp42'),
    Buffer.from([0, 0, 0, 8]), Buffer.from('mdat')
  ]);
}

function proofPost(overrides = {}) {
  return {
    userId: 'owner', workspaceId: 'workspace', accountId: 'UC-safe',
    connectedAccountId: 'youtube:UC-safe', runtimeMissionId: 'graph:g:node:n',
    runtimeGraphId: 'g', runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64), approvedBy: 'founder',
    approvedAt: '2026-07-22T00:00:00.000Z', providerProofMode: true,
    approvedMedia: { sha256: 'b'.repeat(64), byteSize: 32, mimeType: 'video/mp4', fileName: 'proof.mp4', container: 'mp4' },
    ...overrides
  };
}

test('ADV-01 terminal provider outcomes are immutable and undeclared transitions fail closed', () => {
  const base = createInitialYouTubeProviderOperation({ queueId: 'queue', post: proofPost(), attemptNumber: 1 });
  const failed = transitionProviderOperation(base, 'terminal_failure');
  assert.throws(() => transitionProviderOperation(failed, 'completed_private'), /Invalid provider operation transition/);
  const contradiction = transitionProviderOperation({ ...base, operationState: 'uploading' }, 'contradictory_public');
  assert.throws(() => transitionProviderOperation(contradiction, 'completed_private'), /Invalid provider operation transition/);
  assert.equal(transitionProviderOperation(failed, 'terminal_failure'), failed);
});

test('ADV-02 nested, URL-encoded, base64, token, and protected locator material is contained', () => {
  const locator = 'https://upload.youtube.com/upload-session/canary?upload_id=synthetic';
  for (const value of [
    { nested: { error: locator } },
    encodeURIComponent(locator),
    Buffer.from(locator).toString('base64'),
    { authorization: 'Bearer synthetic-token-value' },
    { message: 'protected-canary-value' }
  ]) assert.equal(containsForbiddenMaterial(value, { protectedValues: ['protected-canary-value'] }), true);
  assert.equal(safeDiagnosticText(locator), FORBIDDEN_MATERIAL_MESSAGE);
  assert.equal(safeDiagnosticText('SAFE_PROVIDER_TIMEOUT'), 'SAFE_PROVIDER_TIMEOUT');
});

test('ADV-04 actual MP4 bytes are required regardless of filename', () => {
  assert.deepEqual(inspectMp4Buffer(validMp4()), {
    valid: true, mimeType: 'video/mp4', container: 'mp4', brands: ['isom', 'isom', 'mp42']
  });
  for (const bytes of [Buffer.alloc(0), Buffer.from('{}'), Buffer.from('text'), validMp4().subarray(0, 20)]) {
    assert.equal(inspectMp4Buffer(bytes).valid, false);
  }
  assert.equal(sanitizeApprovedMediaIdentity({ sha256: 'b'.repeat(64), byteSize: 32, mimeType: 'video/mp4', fileName: '../proof.mp4', container: 'mp4' }), null);
  assert.equal(sanitizeApprovedMediaIdentity({ sha256: 'b'.repeat(64), byteSize: 32, mimeType: 'video/mp4', fileName: 'proof.mp4', container: 'mp4', extra: true }), null);
});

test('ADV-05 accepted offsets are bounded by media size', () => {
  assert.equal(acceptedOffsetFromRange('bytes=0-30', 32), 31);
  assert.equal(acceptedOffsetFromRange('bytes=0-31', 32), 32);
  assert.equal(acceptedOffsetFromRange('bytes=0-32', 32), null);
  assert.equal(acceptedOffsetFromRange('bytes=0--1', 32), null);
});

test('ADV-06 durable lease claims have one owner, reclaim expiry, fence stale owners, and stop at three', () => {
  const start = Date.parse('2026-07-22T00:00:00.000Z');
  const base = {
    ...createInitialYouTubeProviderOperation({ queueId: 'queue', post: proofPost(), attemptNumber: 1 }),
    operationState: 'session_persisted', sessionLocatorEnvelope: { encrypted: true }
  };
  const first = claimReconciliationLease(base, { ownerId: 'owner-a', leaseDurationMs: 1000 }, start);
  assert.equal(first.outcome, 'claimed');
  assert.equal(claimReconciliationLease(first.operation, { ownerId: 'owner-b' }, start + 1).outcome, 'lease_active');
  const second = claimReconciliationLease(first.operation, { ownerId: 'owner-b', leaseDurationMs: 1000 }, start + 1001);
  assert.equal(second.outcome, 'claimed');
  assert.equal(reconciliationLeaseAuthorizes(second.operation, { leaseOwnerId: 'owner-a', fencingToken: 1 }, start + 1002), false);
  assert.equal(reconciliationLeaseAuthorizes(second.operation, { leaseOwnerId: 'owner-b', fencingToken: 2 }, start + 1002), true);
  const third = claimReconciliationLease(second.operation, { ownerId: 'owner-c', leaseDurationMs: 1000 }, start + 2002);
  assert.equal(third.outcome, 'claimed');
  assert.equal(claimReconciliationLease(third.operation, { ownerId: 'owner-d' }, start + 3003).outcome, 'budget_exhausted');
});

test('ADV-13 every approval and custody identity change changes the operation identity', () => {
  const base = createInitialYouTubeProviderOperation({ queueId: 'queue', post: proofPost(), attemptNumber: 1 }).providerOperationId;
  const changes = [
    ['queue-2', proofPost(), 1],
    ['queue', proofPost({ userId: 'owner-2' }), 1],
    ['queue', proofPost({ workspaceId: 'workspace-2' }), 1],
    ['queue', proofPost({ accountId: 'UC-other', connectedAccountId: 'youtube:UC-other' }), 1],
    ['queue', proofPost({ runtimeMissionId: 'graph:g:node:other' }), 1],
    ['queue', proofPost({ runtimeGraphId: 'g-other' }), 1],
    ['queue', proofPost({ approvedBy: 'other-founder' }), 1],
    ['queue', proofPost({ approvedAt: '2026-07-22T00:00:01.000Z' }), 1],
    ['queue', proofPost({ approvedMedia: { ...proofPost().approvedMedia, sha256: 'c'.repeat(64) } }), 1],
    ['queue', proofPost(), 2]
  ];
  for (const [queueId, post, attemptNumber] of changes) {
    assert.notEqual(createInitialYouTubeProviderOperation({ queueId, post, attemptNumber }).providerOperationId, base);
  }
  assert.equal(createInitialYouTubeProviderOperation({ queueId: 'queue', post: proofPost(), attemptNumber: 1 }).providerOperationId, base);
});
