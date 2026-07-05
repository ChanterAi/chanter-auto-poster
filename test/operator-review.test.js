'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildOperatorReview, SAFE_ACTION_TYPES } = require('../src/campaignOracle');

const fixedNow = new Date('2026-07-05T12:00:00.000Z');
const healthyEvidence = {
  durableHeartbeat: { status: 'healthy', lastTickAt: '2026-07-05T11:59:00.000Z' }
};
const child = (overrides = {}) => ({
  id: 'child-x', accountId: 'account-x', username: 'x',
  caption: 'Caption A', hashtags: '#alpha #beta',
  scheduledAt: '2026-07-05T10:00:00.000Z',
  ...overrides
});

function assertAdvisoryOnly(review) {
  assert.ok(review.safeActions.length > 0);
  for (const action of review.safeActions) {
    assert.ok(SAFE_ACTION_TYPES.includes(action.type), `unexpected action type ${action.type}`);
    assert.equal(action.destructive, false);
    assert.equal(action.enabled, false);
    assert.ok(action.label && action.description);
    assert.doesNotMatch(`${action.type} ${action.label} ${action.description}`, /re-?post|requeue|retry/i,
      'safe actions must never instruct retrying/re-posting');
  }
}

test('operator review: fully posted campaign is SUCCESS with NO_ACTION', () => {
  const review = buildOperatorReview({
    campaignId: 'cmp-success',
    campaignStatus: 'posted',
    createdAt: '2026-07-04T09:00:00.000Z',
    scheduleBaseTime: '2026-07-05T10:00:00.000Z',
    childJobs: [
      child({ status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1', postedAt: '2026-07-05T10:01:00.000Z' }),
      child({ id: 'child-y', accountId: 'account-y', caption: 'Caption B', hashtags: '#beta', status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-2', postedAt: '2026-07-05T10:16:00.000Z' })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  assert.equal(review.ok, true);
  assert.equal(review.campaignId, 'cmp-success');
  assert.equal(review.generatedAt, '2026-07-05T12:00:00.000Z');
  assert.deepEqual(review.campaign, {
    status: 'posted',
    caption: 'Caption A',
    hashtags: ['#alpha', '#beta'],
    scheduledAt: '2026-07-05T10:00:00.000Z',
    createdAt: '2026-07-04T09:00:00.000Z'
  });
  assert.deepEqual(review.evidence, {
    childrenTotal: 2,
    postedCount: 2,
    acceptedCount: 0,
    failedCount: 0,
    retryRequiredCount: 0,
    lastTickAt: '2026-07-05T11:59:00.000Z',
    heartbeatStatus: 'healthy'
  });
  assert.equal(review.oracle.verdict, 'SUCCESS');
  assert.equal(review.oracle.evidenceConfidence, 'HIGH');
  assert.deepEqual(review.safeActions.map((action) => action.type), ['NO_ACTION']);
  assertAdvisoryOnly(review);
});

test('operator review: partial success yields advisory manual review or reconnect', () => {
  const rateLimited = buildOperatorReview({
    campaignId: 'cmp-partial',
    campaignStatus: 'retry_required',
    childJobs: [
      child({ status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1' }),
      child({
        id: 'child-y', accountId: 'account-y', status: 'failed', campaignJobStatus: 'retry_required',
        errorMessage: 'Rate limit exceeded',
        errorEvidence: { ok: false, retryable: true, reason: 'Rate limit exceeded' }
      })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });
  assert.equal(rateLimited.oracle.verdict, 'PARTIAL_SUCCESS');
  assert.ok(rateLimited.safeActions.some((action) => action.type === 'MANUAL_REVIEW'));
  assertAdvisoryOnly(rateLimited);

  const tokenBroken = buildOperatorReview({
    campaignId: 'cmp-token',
    campaignStatus: 'partial_failure',
    childJobs: [
      child({ status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1' }),
      child({
        id: 'child-y', accountId: 'account-y', status: 'failed', campaignJobStatus: 'failed',
        errorMessage: 'Token revoked; reconnect the TikTok account.',
        errorEvidence: { ok: false, retryable: false, reason: 'Token revoked; reconnect the TikTok account.' }
      })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });
  assert.equal(tokenBroken.oracle.verdict, 'PARTIAL_SUCCESS');
  assert.ok(tokenBroken.safeActions.some((action) => action.type === 'RECONNECT_ACCOUNT'));
  assertAdvisoryOnly(tokenBroken);
});

test('operator review: incomplete evidence is WAITING/UNKNOWN with LOW confidence', () => {
  const waiting = buildOperatorReview({
    campaignId: 'cmp-waiting',
    campaignStatus: 'queued',
    childJobs: [
      child({ status: 'scheduled', campaignJobStatus: 'queued', scheduledAt: '2026-07-05T18:00:00.000Z' })
    ]
  }, { schedulerEvidence: null, now: fixedNow });
  assert.equal(waiting.ok, true);
  assert.equal(waiting.oracle.verdict, 'WAITING');
  assert.equal(waiting.oracle.evidenceConfidence, 'LOW');
  assert.equal(waiting.evidence.heartbeatStatus, 'unknown');
  assert.equal(waiting.evidence.lastTickAt, null);
  const waitingTypes = waiting.safeActions.map((action) => action.type);
  assert.ok(waitingTypes.includes('CHECK_SCHEDULER'));
  assert.ok(waitingTypes.includes('WAIT_FOR_PROCESSING'));
  assertAdvisoryOnly(waiting);

  const empty = buildOperatorReview({ campaignId: 'cmp-empty', childJobs: [] }, {
    schedulerEvidence: { durableHeartbeat: { status: 'missing', lastTickAt: null } },
    now: fixedNow
  });
  assert.equal(empty.ok, true);
  assert.equal(empty.oracle.verdict, 'UNKNOWN');
  assert.equal(empty.oracle.evidenceConfidence, 'LOW');
  assert.equal(empty.evidence.heartbeatStatus, 'missing');
  assert.ok(empty.safeActions.some((action) => action.type === 'MANUAL_REVIEW'));
  assertAdvisoryOnly(empty);
});

test('operator review: degraded heartbeat maps to degraded and recommends checking the scheduler', () => {
  const review = buildOperatorReview({
    campaignId: 'cmp-stale',
    childJobs: [child({ status: 'scheduled', campaignJobStatus: 'queued', scheduledAt: '2026-07-05T10:00:00.000Z' })]
  }, { schedulerEvidence: { durableHeartbeat: { status: 'stale', lastTickAt: '2026-07-05T09:00:00.000Z' } }, now: fixedNow });

  assert.equal(review.evidence.heartbeatStatus, 'degraded');
  assert.equal(review.evidence.lastTickAt, '2026-07-05T09:00:00.000Z');
  assert.ok(review.safeActions.some((action) => action.type === 'CHECK_SCHEDULER'));
});

test('operator review: raw provider payloads and tokens never appear in the JSON', () => {
  const review = buildOperatorReview({
    campaignId: 'cmp-poison',
    access_token: 'campaign-token-never',
    childJobs: [
      child({
        status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1',
        access_token: 'child-access-token-never',
        refresh_token: 'child-refresh-token-never',
        lastResult: {
          ok: true, mode: 'api', completedAt: '2026-07-05T10:01:00.000Z',
          response: {
            data: { upload_token: 'raw-upload-token-never', publish_id: 'publish-1' },
            headers: { authorization: 'Bearer raw-bearer-never' }
          }
        }
      })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  const serialized = JSON.stringify(review);
  assert.doesNotMatch(serialized, /campaign-token-never/);
  assert.doesNotMatch(serialized, /child-access-token-never/);
  assert.doesNotMatch(serialized, /child-refresh-token-never/);
  assert.doesNotMatch(serialized, /raw-upload-token-never/);
  assert.doesNotMatch(serialized, /raw-bearer-never/);
  assert.doesNotMatch(serialized, /upload_token|access_token|refresh_token|authorization/i);
});
