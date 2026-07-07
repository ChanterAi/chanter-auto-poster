'use strict';

// Single entry point for the AutoPoster Runtime Adapter (P1A). Other
// modules should `require('./runtime')` (or `require('../runtime')`)
// rather than reaching into individual runtime/* files directly.

const adapter = require('./autoposterRuntimeAdapter');
const policy = require('./runtimePolicy');
const redaction = require('./runtimeRedaction');
const readiness = require('./runtimeReadiness');

module.exports = {
  ...adapter,
  evaluatePolicy: policy.evaluatePolicy,
  isTerminalTask: policy.isTerminalTask,
  ACTION_TYPES: policy.ACTION_TYPES,
  RISK_LEVELS: policy.RISK_LEVELS,
  redactRuntimeValue: redaction.redactRuntimeValue,
  getAdapterReadiness: readiness.getAdapterReadiness
};
