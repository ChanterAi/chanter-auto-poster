'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const runtime = require('../src/runtime');

const RUNTIME_DIR = path.join(__dirname, '..', 'src', 'runtime');

const samplePost = {
  id: 'job-1',
  platform: 'tiktok',
  accountId: 'account-a',
  username: 'creator_a',
  status: 'scheduled',
  scheduledAt: '2026-07-08T09:00:00.000Z',
  caption: 'New drop this Friday!',
  mediaType: 'video',
  mediaUrl: 'https://cdn.example.com/videos/clip.mp4?token=shh',
  createdAt: '2026-07-07T09:00:00.000Z',
  updatedAt: '2026-07-07T09:00:00.000Z'
};

test('mapScheduledPostTask produces a runtime task with publish_guarded policy and attached evidence', () => {
  const task = runtime.mapScheduledPostTask(samplePost);

  assert.equal(task.product, 'auto_poster');
  assert.equal(task.taskType, 'scheduled_post');
  assert.equal(task.executionPolicy, 'publish_guarded');
  assert.equal(task.status, 'scheduled');
  assert.ok(task.evidence);
  assert.equal(task.evidence.taskId, task.taskId);
  assert.equal(task.result.status, 'not_executed');
});

test('mapPostNowRequestTask requires approval through the publish_guarded path', () => {
  const task = runtime.mapPostNowRequestTask({ ...samplePost, status: 'pending' });
  const decision = runtime.evaluateAction(task, 'publish');

  assert.equal(task.executionPolicy, 'publish_guarded');
  assert.equal(decision.decision, 'requires_approval');
  assert.equal(task.evidence.decisionResult, 'requires_approval');
});

test('mapPublishAttemptTask never allows an outright publish decision', () => {
  const task = runtime.mapPublishAttemptTask({ ...samplePost, status: 'processing' });
  const decision = runtime.evaluateAction(task, 'publish');
  assert.notEqual(decision.decision, 'allow');
});

test('mapCronTickTask carries only safe numeric tick fields, never triggers a tick itself', () => {
  const task = runtime.mapCronTickTask({ now: '2026-07-07T12:00:00.000Z', checked: 3, due: 3, posted: 2, failed: 1, ok: true });
  assert.equal(task.taskType, 'cron_tick');
  assert.deepEqual(task.evidence.tickSummary, { checked: 3, due: 3, posted: 2, failed: 1, ok: true });
});

test('mapPublishResultTask reflects success and failure outcomes distinctly', () => {
  const success = runtime.mapPublishResultTask({ ...samplePost, status: 'posted' }, { ok: true, mode: 'api', publishId: 'pub-1' });
  const failure = runtime.mapPublishResultTask({ ...samplePost, status: 'failed' }, { ok: false, mode: 'api', reason: 'TikTok returned HTTP 500' });

  assert.equal(success.riskLevel, 'medium');
  assert.equal(success.evidence.resultSummary.ok, true);
  assert.equal(failure.riskLevel, 'high');
  assert.equal(failure.evidence.resultSummary.reason, 'TikTok returned HTTP 500');
});

test('mapAccountSelectionTask and mapMediaCaptionPayloadTask stay standard (non-publishing) policy', () => {
  const account = runtime.mapAccountSelectionTask({ accountId: 'account-a', username: 'creator_a', connected: true });
  const payload = runtime.mapMediaCaptionPayloadTask(samplePost);

  assert.equal(account.executionPolicy, 'standard');
  assert.equal(payload.executionPolicy, 'standard');
});

test('delete is blocked by default for every mapped task type', () => {
  const tasks = [
    runtime.mapCampaignCreationTask({ campaignId: 'camp-1', accountIds: ['a', 'b'] }),
    runtime.mapScheduledPostTask(samplePost),
    runtime.mapQueuedJobTask(samplePost),
    runtime.mapAccountSelectionTask({ accountId: 'account-a' })
  ];
  for (const task of tasks) {
    assert.equal(runtime.evaluateAction(task, 'delete').decision, 'deny');
  }
});

test('a terminal task blocks further actions through evaluateAction', () => {
  const posted = runtime.mapPublishResultTask({ ...samplePost, status: 'posted' }, { ok: true });
  assert.equal(runtime.evaluateAction(posted, 'read').decision, 'deny');
  assert.equal(runtime.evaluateAction(posted, 'write').decision, 'deny');
});

test('dryRun previews a non-terminal task without executing anything', () => {
  const task = runtime.mapScheduledPostTask(samplePost);
  const decision = runtime.evaluateAction(task, 'write', { dryRun: true });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.dryRun, true);
});

test('mapped task evidence and inputs redact TikTok/OAuth secrets even if upstream data leaks them', () => {
  const dirtyPost = {
    ...samplePost,
    accessToken: 'should-never-appear',
    refreshToken: 'also-should-never-appear',
    mediaUrl: 'https://cdn.example.com/videos/clip.mp4?token=shh&signature=abc123'
  };
  const task = runtime.mapScheduledPostTask(dirtyPost);
  const serialized = JSON.stringify(task);

  assert.ok(!serialized.includes('should-never-appear'));
  assert.ok(!serialized.includes('also-should-never-appear'));
  assert.ok(!serialized.includes('token=shh'));
  assert.ok(!serialized.includes('signature=abc123'));
});

test('getAdapterReadiness reports the P1A decision-only capability set', () => {
  const readiness = runtime.getAdapterReadiness();
  assert.equal(readiness.product, 'auto_poster');
  assert.equal(readiness.decisionOnly, true);
  assert.equal(readiness.executesNoNetworkCalls, true);
  assert.ok(readiness.supported.includes('publish_policy_preview'));
  assert.ok(readiness.supported.includes('redacted_evidence_export'));
  assert.ok(readiness.notSupportedYet.includes('automatic_external_publish_control'));
  assert.ok(readiness.notSupportedYet.includes('operator_live_bridge_wiring'));
});

test('every mapped task and evidence bundle survives a JSON round trip unchanged', () => {
  const task = runtime.mapCampaignCreationTask({ campaignId: 'camp-2', accountIds: ['account-a', 'account-b'], caption: 'launch week' });
  const roundTripped = JSON.parse(JSON.stringify(task));
  assert.deepEqual(roundTripped, task);
});

test('the runtime module never requires TikTok/Instagram/Firestore/scheduler production modules', () => {
  const forbidden = ['tiktok', 'instagram', 'firestore', 'scheduler', 'storage', 'cloudinary'];
  const files = fs.readdirSync(RUNTIME_DIR).filter((name) => name.endsWith('.js'));
  assert.ok(files.length > 0);

  for (const file of files) {
    const source = fs.readFileSync(path.join(RUNTIME_DIR, file), 'utf8');
    const requireCalls = [...source.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((match) => match[1]);
    for (const requirePath of requireCalls) {
      const normalized = requirePath.toLowerCase();
      const hitsForbidden = forbidden.some((name) => normalized.includes(name));
      assert.equal(hitsForbidden, false, `${file} must not require "${requirePath}"`);
    }
    // No live network primitives anywhere in the adapter.
    assert.equal(/\bfetch\s*\(/.test(source), false, `${file} must not call fetch()`);
    assert.equal(source.includes("require('http')"), false, `${file} must not require http`);
    assert.equal(source.includes("require('https')"), false, `${file} must not require https`);
  }
});
