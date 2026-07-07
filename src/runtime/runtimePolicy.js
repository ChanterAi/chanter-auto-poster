'use strict';

// Decision-only policy preview for AutoPoster runtime tasks. Nothing in
// this module executes, publishes, deletes, or calls out to a network —
// it only returns what *would* be allowed, mirroring the policy-evaluator
// contract from chanter-agent-runtime P1 closely enough that a future
// package-link loop can swap this local copy out.

const ACTION_TYPES = new Set(['read', 'write', 'schedule', 'publish', 'delete', 'network']);

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'];

// Statuses considered terminal: the task/job has already reached a final
// outcome, so no further action (including read-as-actionable) is granted
// by this preview. Mirrors src/scheduler.js's own terminal outcomes.
const TERMINAL_STATUSES = new Set(['posted', 'failed', 'cancelled']);

// Internal statuses considered safe to write/schedule against. Deliberately
// excludes 'processing' (actively locked by a scheduler worker — see
// src/scheduler.js claimPost/finalize) so this preview never suggests a
// write is safe while a real publish attempt could be in flight.
const SAFE_WRITE_STATUSES = new Set(['pending', 'scheduled', 'ready']);

const EXECUTION_POLICY_PUBLISH_GUARDED = 'publish_guarded';
const EXECUTION_POLICY_STANDARD = 'standard';

function isHighRisk(riskLevel) {
  return riskLevel === 'high' || riskLevel === 'critical';
}

function isTerminalTask(task) {
  if (!task || typeof task !== 'object') return false;
  if (task.terminal === true) return true;
  return TERMINAL_STATUSES.has(String(task.status || '').toLowerCase());
}

function decision(outcome, reason, extra = {}) {
  return {
    decision: outcome,
    allowed: outcome === 'allow',
    requiresApproval: outcome === 'requires_approval',
    reason,
    ...extra
  };
}

/**
 * Evaluates a single action against a runtime task and returns a
 * decision-only preview: { decision: 'allow' | 'deny' | 'requires_approval', ... }.
 * Never executes, publishes, deletes, or makes a network call itself.
 */
function evaluatePolicy({ task, action, dryRun = false } = {}) {
  const evaluatedAt = new Date().toISOString();
  const normalizedAction = String(action || '').toLowerCase();

  const base = { action: normalizedAction, taskId: task && task.taskId ? task.taskId : null, dryRun: Boolean(dryRun), decisionOnly: true, evaluatedAt };

  if (!ACTION_TYPES.has(normalizedAction)) {
    return { ...base, ...decision('deny', `Unknown action type "${action}".`) };
  }
  if (!task || typeof task !== 'object') {
    return { ...base, ...decision('deny', 'No task supplied for policy evaluation.') };
  }

  if (isTerminalTask(task)) {
    return { ...base, ...decision('deny', 'Task is terminal; no further actions are permitted.') };
  }

  if (dryRun) {
    return { ...base, ...decision('allow', 'Dry run: decision-only preview, nothing executes.') };
  }

  const riskLevel = String(task.riskLevel || 'low').toLowerCase();
  const highRisk = isHighRisk(riskLevel);

  if (normalizedAction === 'read') {
    return { ...base, ...decision('allow', 'Read access is permitted for non-terminal tasks.') };
  }

  if (normalizedAction === 'delete') {
    return { ...base, ...decision('deny', 'Delete actions are blocked by default.') };
  }

  if (normalizedAction === 'write' || normalizedAction === 'schedule') {
    const status = String(task.status || '').toLowerCase();
    if (!SAFE_WRITE_STATUSES.has(status)) {
      return { ...base, ...decision('deny', `Task status "${task.status || 'unknown'}" is not a safe internal status for ${normalizedAction}.`) };
    }
    if (highRisk) {
      return { ...base, ...decision('requires_approval', `${riskLevel} risk requires approval before ${normalizedAction}.`) };
    }
    return { ...base, ...decision('allow', `${normalizedAction} permitted for task in status "${task.status}".`) };
  }

  if (normalizedAction === 'publish') {
    if (task.executionPolicy !== EXECUTION_POLICY_PUBLISH_GUARDED) {
      return { ...base, ...decision('deny', 'Publish actions must be classified publish_guarded before they can be previewed.') };
    }
    return { ...base, ...decision('requires_approval', 'Publish requires explicit approval via the publish_guarded path; this adapter never publishes itself.') };
  }

  if (normalizedAction === 'network') {
    return { ...base, ...decision('requires_approval', 'Network actions require approval; this preview never calls out itself.') };
  }

  return { ...base, ...decision('deny', 'Unrecognized action.') };
}

module.exports = {
  ACTION_TYPES,
  RISK_LEVELS,
  TERMINAL_STATUSES,
  SAFE_WRITE_STATUSES,
  EXECUTION_POLICY_PUBLISH_GUARDED,
  EXECUTION_POLICY_STANDARD,
  isTerminalTask,
  isHighRisk,
  evaluatePolicy
};
