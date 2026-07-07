'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluatePolicy, EXECUTION_POLICY_PUBLISH_GUARDED, EXECUTION_POLICY_STANDARD } = require('../src/runtime/runtimePolicy');

function baseTask(overrides = {}) {
  return {
    taskId: 'autoposter:scheduled_post:test-1',
    status: 'pending',
    riskLevel: 'low',
    executionPolicy: EXECUTION_POLICY_STANDARD,
    ...overrides
  };
}

test('read is allowed for a non-terminal task', () => {
  const result = evaluatePolicy({ task: baseTask(), action: 'read' });
  assert.equal(result.decision, 'allow');
  assert.equal(result.allowed, true);
});

test('terminal tasks cannot perform any action, including read', () => {
  const terminalTask = baseTask({ status: 'posted' });
  for (const action of ['read', 'write', 'schedule', 'publish', 'network', 'delete']) {
    const result = evaluatePolicy({ task: terminalTask, action });
    assert.equal(result.decision, 'deny', `expected ${action} to be denied on a terminal task`);
  }
});

test('write is allowed for a safe internal status at low risk', () => {
  const result = evaluatePolicy({ task: baseTask({ status: 'scheduled' }), action: 'write' });
  assert.equal(result.decision, 'allow');
});

test('write is denied when the task is not in a safe internal status', () => {
  const result = evaluatePolicy({ task: baseTask({ status: 'processing' }), action: 'write' });
  assert.equal(result.decision, 'deny');
});

test('schedule requires approval when risk is high or critical', () => {
  const high = evaluatePolicy({ task: baseTask({ riskLevel: 'high' }), action: 'schedule' });
  const critical = evaluatePolicy({ task: baseTask({ riskLevel: 'critical' }), action: 'schedule' });
  assert.equal(high.decision, 'requires_approval');
  assert.equal(critical.decision, 'requires_approval');
});

test('publish always requires the publish_guarded execution policy', () => {
  const guarded = evaluatePolicy({
    task: baseTask({ executionPolicy: EXECUTION_POLICY_PUBLISH_GUARDED, riskLevel: 'high' }),
    action: 'publish'
  });
  assert.equal(guarded.decision, 'requires_approval');

  const unguarded = evaluatePolicy({
    task: baseTask({ executionPolicy: EXECUTION_POLICY_STANDARD }),
    action: 'publish'
  });
  assert.equal(unguarded.decision, 'deny');
});

test('network actions always require approval and never auto-execute', () => {
  const result = evaluatePolicy({ task: baseTask(), action: 'network' });
  assert.equal(result.decision, 'requires_approval');
});

test('delete is blocked by default regardless of status or risk', () => {
  const result = evaluatePolicy({ task: baseTask({ status: 'scheduled', riskLevel: 'low' }), action: 'delete' });
  assert.equal(result.decision, 'deny');
});

test('dryRun allows a non-terminal task without executing anything', () => {
  const result = evaluatePolicy({ task: baseTask({ status: 'processing' }), action: 'write', dryRun: true });
  assert.equal(result.decision, 'allow');
  assert.equal(result.dryRun, true);
});

test('dryRun does not override the terminal-task block', () => {
  const result = evaluatePolicy({ task: baseTask({ status: 'failed' }), action: 'read', dryRun: true });
  assert.equal(result.decision, 'deny');
});

test('unknown actions and missing tasks are denied', () => {
  assert.equal(evaluatePolicy({ task: baseTask(), action: 'launch_missiles' }).decision, 'deny');
  assert.equal(evaluatePolicy({ task: null, action: 'read' }).decision, 'deny');
});

test('every decision is marked decision-only and carries no execution side effect flag', () => {
  const result = evaluatePolicy({ task: baseTask(), action: 'read' });
  assert.equal(result.decisionOnly, true);
});
