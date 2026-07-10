'use strict';

// Canonical provider domain for the AutoPoster product.
//
// This registry is declarative capability truth: it says what each publishing
// provider is, whether it is implemented, and what it can do. It owns no
// business operations — it never touches Firestore, the queue, tokens, or a
// provider API. Callers (application service, scheduler worker, routes)
// consult it and then use their existing execution paths.
//
// Provider #1 is TikTok: the only active provider. Instagram has a real but
// env-gated partial integration (legacy singleton auth + manual test route +
// worker path); it is never schedulable through the product queue. YouTube
// and LinkedIn are reserved identifiers only — no adapter, no OAuth, no
// posting support — and must fail closed everywhere.

const config = require('./config');
const mediaPolicy = require('./mediaPolicy');

const PROVIDER_TIKTOK = 'tiktok';
const PROVIDER_INSTAGRAM = 'instagram';
const PROVIDER_YOUTUBE = 'youtube';
const PROVIDER_LINKEDIN = 'linkedin';

// Implementation status vocabulary. Only TikTok may be "active".
const IMPLEMENTATION_STATUS = Object.freeze({
  ACTIVE: 'active',
  DEVELOPMENT: 'development',
  DISABLED: 'disabled',
  UNSUPPORTED: 'unsupported'
});

// How a stored provider value was resolved (see normalizeStoredProviderId).
const PROVIDER_SOURCE_EXPLICIT = 'explicit';
const PROVIDER_SOURCE_LEGACY_DEFAULT = 'legacy_default';

class ProviderError extends Error {
  constructor(message, { status = 400, code = 'unknown_provider', details = {} } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

const DEFINITIONS = deepFreeze({
  [PROVIDER_TIKTOK]: {
    id: PROVIDER_TIKTOK,
    displayName: 'TikTok',
    implementationStatus: IMPLEMENTATION_STATUS.ACTIVE,
    authMode: 'oauth2_authorization_code',
    connection: { supported: true, mode: 'oauth', route: '/connect/tiktok' },
    // Declared from actual product behavior, not aspiration: new intake is
    // video-only (mediaPolicy.js), publishing is Direct Post via the queue,
    // and every job requires the human approval gate before the worker may
    // claim it. TikTok's API here has no remote status lookup, remote
    // deletion, or analytics surface in this product.
    capabilities: {
      schedulable: true,
      directPost: true,
      videoPublishing: true,
      imagePublishing: false,
      mediaTypes: ['video'],
      videoFormats: [...mediaPolicy.VIDEO_EXTENSIONS],
      privacyControls: true,
      captionsSupported: true,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'video_only'
  },
  [PROVIDER_INSTAGRAM]: {
    id: PROVIDER_INSTAGRAM,
    displayName: 'Instagram',
    // A partial Meta Graph integration exists (legacy single-account auth
    // doc, manual admin test route, worker path), gated behind
    // ENABLE_INSTAGRAM which defaults off. It is not connectable through
    // the canonical connected-account model and never schedulable through
    // the product queue.
    implementationStatus: config.ENABLE_INSTAGRAM
      ? IMPLEMENTATION_STATUS.DEVELOPMENT
      : IMPLEMENTATION_STATUS.DISABLED,
    authMode: 'oauth2_authorization_code',
    connection: { supported: false, mode: 'legacy_singleton' },
    capabilities: {
      schedulable: false,
      directPost: false,
      videoPublishing: false,
      imagePublishing: false,
      mediaTypes: [],
      videoFormats: [],
      privacyControls: false,
      captionsSupported: false,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'none'
  },
  [PROVIDER_YOUTUBE]: {
    id: PROVIDER_YOUTUBE,
    displayName: 'YouTube',
    implementationStatus: IMPLEMENTATION_STATUS.UNSUPPORTED,
    authMode: 'none',
    connection: { supported: false, mode: 'none' },
    capabilities: {
      schedulable: false,
      directPost: false,
      videoPublishing: false,
      imagePublishing: false,
      mediaTypes: [],
      videoFormats: [],
      privacyControls: false,
      captionsSupported: false,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'none'
  },
  [PROVIDER_LINKEDIN]: {
    id: PROVIDER_LINKEDIN,
    displayName: 'LinkedIn',
    implementationStatus: IMPLEMENTATION_STATUS.UNSUPPORTED,
    authMode: 'none',
    connection: { supported: false, mode: 'none' },
    capabilities: {
      schedulable: false,
      directPost: false,
      videoPublishing: false,
      imagePublishing: false,
      mediaTypes: [],
      videoFormats: [],
      privacyControls: false,
      captionsSupported: false,
      remoteStatusLookup: false,
      remoteDeletion: false,
      analytics: false,
      approvalRequired: true
    },
    mediaValidationPolicy: 'none'
  }
});

function normalizeProviderId(value) {
  return String(value || '').trim().toLowerCase();
}

function isKnownProvider(providerId) {
  return Boolean(DEFINITIONS[normalizeProviderId(providerId)]);
}

function getProviderDefinition(providerId) {
  return DEFINITIONS[normalizeProviderId(providerId)] || null;
}

function getImplementationStatus(providerId) {
  const definition = getProviderDefinition(providerId);
  return definition ? definition.implementationStatus : null;
}

function isProviderActive(providerId) {
  return getImplementationStatus(providerId) === IMPLEMENTATION_STATUS.ACTIVE;
}

/**
 * Resolves a stored provider value under the documented backward-
 * compatibility rule:
 *
 *   MISSING legacy provider value  -> normalize to TikTok (legacy_default)
 *   EXPLICIT provider value        -> kept as-is; unknown values stay
 *                                     unknown (known: false) and must never
 *                                     silently become TikTok.
 */
function normalizeStoredProviderId(rawValue) {
  const value = normalizeProviderId(rawValue);
  if (!value) {
    return { providerId: PROVIDER_TIKTOK, source: PROVIDER_SOURCE_LEGACY_DEFAULT, known: true };
  }
  return { providerId: value, source: PROVIDER_SOURCE_EXPLICIT, known: Boolean(DEFINITIONS[value]) };
}

/**
 * Fail-closed gate for every new scheduling write. Unknown providers and
 * providers that are not active are rejected with structured errors; there
 * is no fallback to TikTok here.
 */
function assertSchedulableProvider(providerId) {
  const normalized = normalizeProviderId(providerId);
  const definition = DEFINITIONS[normalized];
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalized || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  if (definition.implementationStatus !== IMPLEMENTATION_STATUS.ACTIVE || !definition.capabilities.schedulable) {
    throw new ProviderError(
      `Publishing provider ${definition.displayName} is ${definition.implementationStatus} and cannot schedule posts.`,
      {
        status: 400,
        code: 'provider_not_schedulable',
        details: { provider: definition.id, implementationStatus: definition.implementationStatus }
      }
    );
  }
  return definition;
}

/**
 * Declarative capability lookup. Unknown providers and unknown capability
 * names fail closed with structured errors instead of returning a default.
 */
function providerSupportsCapability(providerId, capability) {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalizeProviderId(providerId) || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  const key = String(capability || '').trim();
  if (!(key in definition.capabilities) || typeof definition.capabilities[key] !== 'boolean') {
    throw new ProviderError(`Unknown provider capability: ${key || '(empty)'}.`, {
      status: 400,
      code: 'unknown_capability',
      details: { provider: definition.id }
    });
  }
  return definition.capabilities[key];
}

function assertProviderCapability(providerId, capability) {
  if (!providerSupportsCapability(providerId, capability)) {
    const definition = getProviderDefinition(providerId);
    throw new ProviderError(
      `Publishing provider ${definition.displayName} does not support ${capability}.`,
      {
        status: 400,
        code: 'capability_unsupported',
        details: { provider: definition.id, capability }
      }
    );
  }
  return true;
}

function providerSupportsMediaType(providerId, mediaType) {
  const definition = getProviderDefinition(providerId);
  if (!definition) {
    throw new ProviderError(`Unsupported publishing provider: ${normalizeProviderId(providerId) || '(empty)'}.`, {
      status: 400,
      code: 'unknown_provider'
    });
  }
  return definition.capabilities.mediaTypes.includes(String(mediaType || '').trim().toLowerCase());
}

/**
 * Safe display metadata (no credentials exist in this registry at all, but
 * this is the shape intended for UI/evidence serialization).
 */
function getProviderSummary(providerId) {
  const definition = getProviderDefinition(providerId);
  if (!definition) return null;
  return {
    id: definition.id,
    displayName: definition.displayName,
    implementationStatus: definition.implementationStatus,
    connectionSupported: definition.connection.supported,
    schedulable: definition.capabilities.schedulable,
    mediaTypes: [...definition.capabilities.mediaTypes],
    mediaValidationPolicy: definition.mediaValidationPolicy
  };
}

function listProviderSummaries() {
  return Object.keys(DEFINITIONS).map(getProviderSummary);
}

module.exports = {
  PROVIDER_TIKTOK,
  PROVIDER_INSTAGRAM,
  PROVIDER_YOUTUBE,
  PROVIDER_LINKEDIN,
  IMPLEMENTATION_STATUS,
  PROVIDER_SOURCE_EXPLICIT,
  PROVIDER_SOURCE_LEGACY_DEFAULT,
  ProviderError,
  isKnownProvider,
  getProviderDefinition,
  getImplementationStatus,
  isProviderActive,
  normalizeStoredProviderId,
  assertSchedulableProvider,
  providerSupportsCapability,
  assertProviderCapability,
  providerSupportsMediaType,
  getProviderSummary,
  listProviderSummaries
};
