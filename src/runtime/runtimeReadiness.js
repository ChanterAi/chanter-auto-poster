'use strict';

// Adapter readiness report for AutoPoster's runtime integration (P1A).
// Read-only, static description of what this adapter can and cannot do —
// no I/O, no live checks. Intended for Operator/SafeCommit-style review.

const ADAPTER_VERSION = 'P1A';

const SUPPORTED = [
  'task_mapping',
  'publish_policy_preview',
  'redacted_evidence_export',
  'dry_run_decisions',
  'schedule_job_metadata_mapping'
];

const NOT_SUPPORTED_YET = [
  'live_package_import_from_chanter_agent_runtime',
  'operator_live_bridge_wiring',
  'real_approval_workflow',
  'automatic_external_publish_control',
  'dashboard_runtime_panel'
];

function getAdapterReadiness() {
  return {
    product: 'auto_poster',
    adapter: 'autoposter_runtime_adapter',
    version: ADAPTER_VERSION,
    decisionOnly: true,
    executesNoNetworkCalls: true,
    supported: [...SUPPORTED],
    notSupportedYet: [...NOT_SUPPORTED_YET],
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  ADAPTER_VERSION,
  SUPPORTED,
  NOT_SUPPORTED_YET,
  getAdapterReadiness
};
