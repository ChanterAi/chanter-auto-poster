'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const evidence = require('../src/runtime/runtimeEvidence');

const task = {
  taskId: 'autoposter:scheduled_post:job-1',
  taskType: 'scheduled_post',
  createdAt: '2026-06-20T10:00:00.000Z',
  updatedAt: '2026-06-20T10:00:00.000Z'
};

function assertJsonSafe(value) {
  const roundTripped = JSON.parse(JSON.stringify(value));
  assert.deepEqual(roundTripped, value);
}

test('caption summary truncates long captions and leaves short ones intact', () => {
  const longCaption = 'x'.repeat(200);
  const long = evidence.scheduleCreatedEvidence(task, { accountLabel: 'acct', caption: longCaption });
  assert.equal(long.captionSummary.length, 141); // 140 chars + ellipsis
  assert.ok(long.captionSummary.endsWith('…'));

  const short = evidence.scheduleCreatedEvidence(task, { accountLabel: 'acct', caption: 'short caption' });
  assert.equal(short.captionSummary, 'short caption');

  const none = evidence.scheduleCreatedEvidence(task, { accountLabel: 'acct' });
  assert.equal(none.captionSummary, null);
});

test('evidence bundles redact secret-shaped values even under safe field names', () => {
  const secretLookingCaption = 'aB3xK9pQzR7mN2vL8wE4tY6uI1oP5sD0fG9hJ3kM7nB2c';
  const bundle = evidence.scheduleCreatedEvidence(task, { accountLabel: 'acct', caption: secretLookingCaption });
  assert.equal(bundle.captionSummary, '[REDACTED]');
});

test('publishResultEvidence records a redacted, JSON-safe result summary', () => {
  const bundle = evidence.publishResultEvidence(task, {
    accountLabel: 'creator1',
    ok: false,
    mode: 'api',
    reason: 'TikTok returned HTTP 500',
    publishId: null
  });

  assert.equal(bundle.decisionResult, 'failed');
  assert.equal(bundle.resultSummary.ok, false);
  assert.equal(bundle.resultSummary.reason, 'TikTok returned HTTP 500');
  assertJsonSafe(bundle);
});

test('cronTickEvidence only carries safe numeric tick fields', () => {
  const bundle = evidence.cronTickEvidence(task, {
    tickSummary: { checked: 5, due: 5, posted: 4, failed: 1, ok: true }
  });

  assert.deepEqual(bundle.tickSummary, { checked: 5, due: 5, posted: 4, failed: 1, ok: true });
  assertJsonSafe(bundle);
});

test('validationResultEvidence carries the actual commands and pass/fail state', () => {
  const bundle = evidence.validationResultEvidence(task, {
    commands: ['npm run build', 'npm test'],
    passed: true,
    notes: 'All checks green.'
  });

  assert.deepEqual(bundle.validation.commands, ['npm run build', 'npm test']);
  assert.equal(bundle.validation.passed, true);
  assertJsonSafe(bundle);
});

test('every evidence bundle is fully JSON-safe', () => {
  assertJsonSafe(evidence.campaignQueuedEvidence(task, { accountLabels: ['a', 'b'], caption: 'hi' }));
  assertJsonSafe(evidence.postNowRequestedEvidence(task, { accountLabel: 'a', caption: 'hi', policyDecision: { decision: 'requires_approval' } }));
  assertJsonSafe(evidence.publishDecisionEvidence(task, { accountLabel: 'a', policyDecision: { decision: 'requires_approval' } }));
});
