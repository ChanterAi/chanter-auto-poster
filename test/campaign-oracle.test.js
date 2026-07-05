'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reviewCampaign } = require('../src/campaignOracle');

const fixedNow = new Date('2026-07-05T12:00:00.000Z');
const healthyEvidence = { durableHeartbeat: { status: 'healthy' } };
const child = (overrides = {}) => ({
  id: 'child-x', accountId: 'account-x', username: 'x',
  scheduledAt: '2026-07-05T10:00:00.000Z',
  ...overrides
});

test('oracle: all children posted is SUCCESS with high confidence and no retry advice', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-1',
    childJobs: [
      child({ status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1', postedAt: '2026-07-05T10:01:00.000Z' }),
      child({ id: 'child-y', accountId: 'account-y', status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-2', postedAt: '2026-07-05T10:16:00.000Z' })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  assert.equal(review.verdict, 'SUCCESS');
  assert.equal(review.postedCount, 2);
  assert.equal(review.acceptedCount, 0);
  assert.equal(review.failedCount, 0);
  assert.equal(review.retryRequiredCount, 0);
  assert.equal(review.blockedReason, '');
  assert.equal(review.evidenceConfidence, 'HIGH');
  assert.match(review.summary, /All 2 child job\(s\) posted/);
  assert.match(review.summary, /publish ids are stored/);
  assert.doesNotMatch(review.recommendedNextAction, /requeue|retry|re-post/i,
    'a fully posted campaign must never be told to retry anything');
});

test('oracle: posted plus retry_required is PARTIAL_SUCCESS and protects posted jobs', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-2',
    childJobs: [
      child({ status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1' }),
      child({
        id: 'child-y', accountId: 'account-y', status: 'failed', campaignJobStatus: 'retry_required',
        errorMessage: 'Rate limit exceeded',
        errorEvidence: { ok: false, retryable: true, reason: 'Rate limit exceeded' }
      })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  assert.equal(review.verdict, 'PARTIAL_SUCCESS');
  assert.equal(review.postedCount, 1);
  assert.equal(review.retryRequiredCount, 1);
  assert.equal(review.failedCount, 0);
  assert.match(review.blockedReason, /Transient provider rejection: Rate limit exceeded/);
  assert.match(review.recommendedNextAction, /Requeue only the retry-safe child jobs/);
  assert.match(review.recommendedNextAction, /leave the posted and accepted jobs untouched/i,
    'partial success must never suggest re-posting the successful child');
  assert.ok(review.riskNotes.some((note) => /retry-safe/.test(note)));
});

test('oracle: all terminal failures is FAILED with a fix-first recommendation', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-3',
    childJobs: [
      child({ status: 'failed', campaignJobStatus: 'failed', errorMessage: 'Token revoked', errorEvidence: { ok: false, retryable: false, reason: 'Token revoked' } }),
      child({ id: 'child-y', accountId: 'account-y', status: 'failed', campaignJobStatus: 'failed', errorMessage: 'Token revoked', errorEvidence: { ok: false, retryable: false, reason: 'Token revoked' } })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  assert.equal(review.verdict, 'FAILED');
  assert.equal(review.failedCount, 2);
  assert.equal(review.retryRequiredCount, 0);
  assert.equal(review.blockedReason, 'Token revoked');
  assert.match(review.recommendedNextAction, /Fix the underlying account or media problem/);
  assert.match(review.summary, /All 2 child job\(s\) failed/);
});

test('oracle: queued jobs without a heartbeat are WAITING with low confidence', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-4',
    childJobs: [
      child({ status: 'scheduled', campaignJobStatus: 'queued', scheduledAt: '2026-07-05T18:00:00.000Z' }),
      child({ id: 'child-y', accountId: 'account-y', status: 'scheduled', campaignJobStatus: 'queued', scheduledAt: '2026-07-05T18:15:00.000Z' })
    ]
  }, { schedulerEvidence: null, now: fixedNow });

  assert.equal(review.verdict, 'WAITING');
  assert.equal(review.evidenceConfidence, 'LOW');
  assert.ok(review.riskNotes.some((note) => /heartbeat is not fresh/.test(note)));
  assert.match(review.recommendedNextAction, /Wait for the scheduler/);

  const empty = reviewCampaign({ campaignId: 'cmp-empty', childJobs: [] }, { schedulerEvidence: null, now: fixedNow });
  assert.equal(empty.verdict, 'UNKNOWN');
  assert.equal(empty.evidenceConfidence, 'LOW');
  assert.match(empty.summary, /no child jobs/);
});

test('oracle: overdue queued jobs with a stale heartbeat point at the cron', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-5',
    childJobs: [
      child({ status: 'scheduled', campaignJobStatus: 'queued', scheduledAt: '2026-07-05T10:00:00.000Z' })
    ]
  }, { schedulerEvidence: { durableHeartbeat: { status: 'stale' } }, now: fixedNow });

  assert.equal(review.verdict, 'WAITING');
  assert.match(review.blockedReason, /external cron may not be running/);
  assert.match(review.recommendedNextAction, /\/api\/cron\/tick/);
  assert.ok(review.riskNotes.some((note) => /past their scheduled time/.test(note)));
});

test('oracle: unverified outcomes are UNKNOWN with duplicate-risk warning', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-6',
    childJobs: [
      child({ status: 'unknown', campaignJobStatus: 'unknown', publishId: 'publish-1' }),
      child({ id: 'child-y', accountId: 'account-y', status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-2' })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  assert.equal(review.verdict, 'UNKNOWN');
  assert.equal(review.evidenceConfidence, 'LOW');
  assert.match(review.recommendedNextAction, /Verify the TikTok outcome manually/);
  assert.ok(review.riskNotes.some((note) => /Duplicate-post risk/.test(note)));
});

test('oracle: review output never contains raw provider payloads or tokens', () => {
  const review = reviewCampaign({
    campaignId: 'cmp-7',
    access_token: 'campaign-token-must-not-leak',
    childJobs: [
      child({
        status: 'posted', campaignJobStatus: 'posted', publishId: 'publish-1',
        access_token: 'child-token-must-not-leak',
        lastResult: {
          ok: true, mode: 'api', completedAt: '2026-07-05T10:01:00.000Z',
          response: { data: { upload_token: 'raw-response-secret-never', publish_id: 'publish-1' } }
        }
      }),
      child({
        id: 'child-y', accountId: 'account-y', status: 'failed', campaignJobStatus: 'failed',
        errorMessage: 'Token revoked',
        errorEvidence: { ok: false, retryable: false, reason: 'Token revoked' }
      })
    ]
  }, { schedulerEvidence: healthyEvidence, now: fixedNow });

  const serialized = JSON.stringify(review);
  assert.doesNotMatch(serialized, /campaign-token-must-not-leak/);
  assert.doesNotMatch(serialized, /child-token-must-not-leak/);
  assert.doesNotMatch(serialized, /raw-response-secret-never/);
  assert.doesNotMatch(serialized, /upload_token/);
  assert.doesNotMatch(serialized, /access_token/);
  assert.equal(review.verdict, 'PARTIAL_SUCCESS');
});
