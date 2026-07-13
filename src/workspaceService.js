'use strict';

// Canonical workspace and owner-membership boundary.
//
// Firestore is deliberately resolved inside operations. Requiring this module
// is therefore safe in tests/build checks without Firebase credentials, while
// callers can inject a Firestore-compatible db, clock and Timestamp adapter.

const { createHash, randomUUID } = require('crypto');

const SCHEMA_VERSION = 1;
const COLLECTIONS = Object.freeze({
  WORKSPACES: 'workspaces',
  MEMBERSHIPS: 'workspaceMemberships'
});
const WORKSPACE_STATUS = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  ARCHIVED: 'archived'
});
const MEMBERSHIP_ROLE = Object.freeze({
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
  VIEWER: 'viewer'
});
const MEMBERSHIP_STATUS = Object.freeze({ ACTIVE: 'active', INACTIVE: 'inactive' });
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const BLOCKED_METADATA_KEY = /(token|secret|password|credential|billing|subscription|entitlement|plan)/i;

class WorkspaceAccessError extends Error {
  constructor(message, { code = 'workspace_access_denied', status = 403 } = {}) {
    super(message);
    this.name = 'WorkspaceAccessError';
    this.code = code;
    this.status = status;
  }
}

function cleanRequiredId(value, fieldName) {
  const clean = String(value || '').trim();
  if (!clean || clean.length > 256) {
    throw new WorkspaceAccessError(`${fieldName} is required.`, {
      code: `invalid_${fieldName.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
      status: fieldName === 'userId' ? 401 : 400
    });
  }
  return clean;
}

function digest(parts, length) {
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, length);
}

function defaultWorkspaceId(userId) {
  const ownerUserId = cleanRequiredId(userId, 'userId');
  return `workspace-legacy-${digest([ownerUserId], 24)}`;
}

function workspaceMembershipDocumentId(workspaceId, userId) {
  const cleanWorkspaceId = cleanRequiredId(workspaceId, 'workspaceId');
  const cleanUserId = cleanRequiredId(userId, 'userId');
  return `membership-${digest([cleanWorkspaceId, cleanUserId], 40)}`;
}

function safeIsoTimestamp(value) {
  if (value === null || value === undefined) return null;
  let date = value;
  if (value && typeof value.toDate === 'function') date = value.toDate();
  else if (value && typeof value.toMillis === 'function') date = new Date(value.toMillis());
  else if (!(value instanceof Date)) date = new Date(value);
  return date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeDisplayName(value, fallback = 'CHANTER Workspace') {
  const clean = String(value || '').trim().replace(/\s+/g, ' ');
  return (clean || fallback).slice(0, 100);
}

function slugify(value, suffix) {
  const base = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
  return `${base}-${suffix}`.slice(0, 64);
}

function sanitizeMetadata(input) {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new WorkspaceAccessError('Workspace metadata must be a flat object.', {
      code: 'invalid_workspace_metadata',
      status: 400
    });
  }
  const entries = Object.entries(input);
  if (entries.length > 20) {
    throw new WorkspaceAccessError('Workspace metadata contains too many fields.', {
      code: 'invalid_workspace_metadata',
      status: 400
    });
  }
  const safe = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(key) || BLOCKED_METADATA_KEY.test(key)) {
      throw new WorkspaceAccessError('Workspace metadata contains an unsupported field.', {
        code: 'invalid_workspace_metadata',
        status: 400
      });
    }
    if (typeof value === 'string') safe[key] = value.slice(0, 200);
    else if (typeof value === 'boolean' || value === null) safe[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) safe[key] = value;
    else {
      throw new WorkspaceAccessError('Workspace metadata values must be scalar.', {
        code: 'invalid_workspace_metadata',
        status: 400
      });
    }
  }
  return safe;
}

function normalizeWorkspaceRecord(data, documentId) {
  const record = data || {};
  const workspaceId = String(record.workspaceId || documentId || '').trim();
  if (!workspaceId || record.workspaceId !== workspaceId) {
    throw new WorkspaceAccessError('Workspace state could not be verified.', {
      code: 'workspace_state_invalid',
      status: 503
    });
  }
  if (!Object.values(WORKSPACE_STATUS).includes(record.status)) {
    throw new WorkspaceAccessError('Workspace state could not be verified.', {
      code: 'workspace_state_invalid',
      status: 503
    });
  }
  return Object.freeze({
    workspaceId,
    displayName: normalizeDisplayName(record.displayName),
    slug: String(record.slug || '').trim(),
    ownerUserId: String(record.ownerUserId || '').trim(),
    status: record.status,
    metadata: Object.freeze(sanitizeMetadata(record.metadata)),
    createdAt: safeIsoTimestamp(record.createdAt),
    updatedAt: safeIsoTimestamp(record.updatedAt),
    schemaVersion: Number(record.schemaVersion || 0)
  });
}

function normalizeMembershipRecord(data, documentId) {
  const record = data || {};
  const workspaceId = String(record.workspaceId || '').trim();
  const userId = String(record.userId || '').trim();
  if (
    !workspaceId || !userId
    || documentId !== workspaceMembershipDocumentId(workspaceId, userId)
    || !Object.values(MEMBERSHIP_ROLE).includes(record.role)
    || !Object.values(MEMBERSHIP_STATUS).includes(record.status)
  ) {
    throw new WorkspaceAccessError('Workspace membership could not be verified.', {
      code: 'workspace_membership_invalid',
      status: 503
    });
  }
  return Object.freeze({
    membershipId: documentId,
    workspaceId,
    userId,
    role: record.role,
    status: record.status,
    createdAt: safeIsoTimestamp(record.createdAt),
    updatedAt: safeIsoTimestamp(record.updatedAt),
    schemaVersion: Number(record.schemaVersion || 0)
  });
}

function createWorkspaceService(dependencies = {}) {
  let defaultFirestore = null;

  function runtime() {
    let db = dependencies.db;
    let Timestamp = dependencies.Timestamp;
    if (!db || !Timestamp) {
      defaultFirestore ||= require('./firestore');
      db ||= defaultFirestore.getFirestore();
      Timestamp ||= defaultFirestore.Timestamp;
    }
    return { db, Timestamp };
  }

  function clockDate() {
    const clock = dependencies.clock;
    const value = typeof clock === 'function'
      ? clock()
      : (clock && typeof clock.now === 'function' ? clock.now() : Date.now());
    const date = value && typeof value.toDate === 'function'
      ? value.toDate()
      : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new WorkspaceAccessError('Workspace clock is invalid.', {
        code: 'workspace_clock_invalid',
        status: 503
      });
    }
    return date;
  }

  function toTimestamp(date, Timestamp) {
    if (Timestamp && typeof Timestamp.fromDate === 'function') return Timestamp.fromDate(date);
    if (Timestamp && typeof Timestamp.fromMillis === 'function') return Timestamp.fromMillis(date.getTime());
    return date;
  }

  function refs(db, workspaceId, userId) {
    return {
      workspace: db.collection(COLLECTIONS.WORKSPACES).doc(workspaceId),
      membership: db.collection(COLLECTIONS.MEMBERSHIPS)
        .doc(workspaceMembershipDocumentId(workspaceId, userId))
    };
  }

  function workspaceNotFound() {
    return new WorkspaceAccessError('Workspace not found.', {
      code: 'workspace_not_found',
      status: 404
    });
  }

  function assertOwnerAccess(workspace, membership, userId) {
    if (
      !workspace
      || !membership
      || workspace.ownerUserId !== userId
      || membership.workspaceId !== workspace.workspaceId
      || membership.userId !== userId
      || membership.role !== MEMBERSHIP_ROLE.OWNER
      || membership.status !== MEMBERSHIP_STATUS.ACTIVE
    ) throw workspaceNotFound();
    if (workspace.status !== WORKSPACE_STATUS.ACTIVE) {
      throw new WorkspaceAccessError('Workspace is not active.', {
        code: 'workspace_inactive',
        status: 403
      });
    }
  }

  function createInTransaction(transaction, ref, data) {
    if (typeof transaction.create === 'function') return transaction.create(ref, data);
    return transaction.set(ref, data);
  }

  async function resolveRequestedWorkspace(userId, workspaceId) {
    const { db } = runtime();
    const documentRefs = refs(db, workspaceId, userId);
    return db.runTransaction(async (transaction) => {
      // Membership is intentionally read first. An unknown workspace and a
      // workspace owned by another user therefore have the same observable
      // result, without probing the workspace document itself.
      const membershipSnapshot = await transaction.get(documentRefs.membership);
      if (!membershipSnapshot.exists) throw workspaceNotFound();
      const membership = normalizeMembershipRecord(
        membershipSnapshot.data(),
        documentRefs.membership.id
      );
      if (
        membership.workspaceId !== workspaceId
        || membership.userId !== userId
        || membership.role !== MEMBERSHIP_ROLE.OWNER
        || membership.status !== MEMBERSHIP_STATUS.ACTIVE
      ) throw workspaceNotFound();

      const workspaceSnapshot = await transaction.get(documentRefs.workspace);
      if (!workspaceSnapshot.exists) throw workspaceNotFound();
      const workspace = normalizeWorkspaceRecord(workspaceSnapshot.data(), workspaceId);
      assertOwnerAccess(workspace, membership, userId);
      return { workspace, membership, createdLegacy: false };
    });
  }

  async function resolveLegacyWorkspace(userId, displayName) {
    const { db, Timestamp } = runtime();
    const nowDate = clockDate();
    const nowTimestamp = toTimestamp(nowDate, Timestamp);
    const workspaceId = defaultWorkspaceId(userId);
    const documentRefs = refs(db, workspaceId, userId);
    const subscriptionService = require('./subscriptionService');
    const subscriptionId = subscriptionService.subscriptionDocumentId(workspaceId);
    const subscriptionRef = db.collection(subscriptionService.COLLECTIONS.SUBSCRIPTIONS).doc(subscriptionId);

    return db.runTransaction(async (transaction) => {
      // Firestore transactions require reads before writes. Reading all three
      // canonical records first also lets partial/corrupt state fail closed.
      const workspaceSnapshot = await transaction.get(documentRefs.workspace);
      const membershipSnapshot = await transaction.get(documentRefs.membership);
      const subscriptionSnapshot = await transaction.get(subscriptionRef);

      if (!workspaceSnapshot.exists && (membershipSnapshot.exists || subscriptionSnapshot.exists)) {
        throw new WorkspaceAccessError('Legacy workspace state could not be verified.', {
          code: 'workspace_state_invalid',
          status: 503
        });
      }

      let rawWorkspace;
      let createdLegacy = false;
      if (!workspaceSnapshot.exists) {
        rawWorkspace = {
          workspaceId,
          displayName: normalizeDisplayName(displayName),
          slug: slugify(displayName || 'chanter-workspace', digest([workspaceId], 8)),
          ownerUserId: userId,
          status: WORKSPACE_STATUS.ACTIVE,
          metadata: { compatibility: 'legacy_default' },
          createdAt: nowTimestamp,
          updatedAt: nowTimestamp,
          schemaVersion: SCHEMA_VERSION
        };
        createInTransaction(transaction, documentRefs.workspace, rawWorkspace);
        createdLegacy = true;
      } else {
        rawWorkspace = workspaceSnapshot.data() || {};
      }

      const workspace = normalizeWorkspaceRecord(rawWorkspace, workspaceId);
      if (workspace.ownerUserId !== userId) {
        throw new WorkspaceAccessError('Legacy workspace state could not be verified.', {
          code: 'workspace_state_invalid',
          status: 503
        });
      }

      let rawMembership;
      if (!membershipSnapshot.exists) {
        rawMembership = {
          workspaceId,
          userId,
          role: MEMBERSHIP_ROLE.OWNER,
          status: MEMBERSHIP_STATUS.ACTIVE,
          createdAt: nowTimestamp,
          updatedAt: nowTimestamp,
          schemaVersion: SCHEMA_VERSION
        };
        createInTransaction(transaction, documentRefs.membership, rawMembership);
      } else {
        rawMembership = membershipSnapshot.data() || {};
      }
      const membership = normalizeMembershipRecord(rawMembership, documentRefs.membership.id);
      assertOwnerAccess(workspace, membership, userId);

      if (!subscriptionSnapshot.exists) {
        createInTransaction(transaction, subscriptionRef, subscriptionService.buildLegacySubscriptionRecord({
          workspaceId,
          now: nowDate,
          toTimestamp: (date) => toTimestamp(date, Timestamp)
        }));
      } else if (String((subscriptionSnapshot.data() || {}).workspaceId || '') !== workspaceId) {
        throw new WorkspaceAccessError('Legacy subscription state could not be verified.', {
          code: 'workspace_state_invalid',
          status: 503
        });
      }

      return { workspace, membership, createdLegacy };
    });
  }

  async function resolveActiveWorkspace(input = {}) {
    const userId = cleanRequiredId(input.userId, 'userId');
    const requestedWorkspaceId = String(input.requestedWorkspaceId || '').trim();
    if (requestedWorkspaceId) {
      if (!SAFE_ID_PATTERN.test(requestedWorkspaceId)) throw workspaceNotFound();
      return resolveRequestedWorkspace(userId, requestedWorkspaceId);
    }
    if (input.legacyEligible !== true) {
      // A missing active workspace is not enough evidence that a future user
      // predates the workspace model. Only the server-side authenticated
      // legacy identity path may bootstrap compatibility access.
      throw workspaceNotFound();
    }
    return resolveLegacyWorkspace(userId, input.displayName);
  }

  async function createWorkspace(input = {}) {
    const ownerUserId = cleanRequiredId(input.ownerUserId || input.userId, 'userId');
    const { db, Timestamp } = runtime();
    const nowDate = clockDate();
    const nowTimestamp = toTimestamp(nowDate, Timestamp);
    const generated = dependencies.workspaceIdFactory
      ? dependencies.workspaceIdFactory()
      : `workspace-${randomUUID()}`;
    const workspaceId = String(generated || '').trim();
    if (!SAFE_ID_PATTERN.test(workspaceId) || workspaceId.startsWith('workspace-legacy-')) {
      throw new WorkspaceAccessError('Workspace ID generation failed.', {
        code: 'workspace_id_generation_failed',
        status: 503
      });
    }
    const displayName = normalizeDisplayName(input.displayName);
    const metadata = sanitizeMetadata(input.metadata);
    if (Object.prototype.hasOwnProperty.call(metadata, 'compatibility')) {
      throw new WorkspaceAccessError('Workspace metadata contains an unsupported field.', {
        code: 'invalid_workspace_metadata',
        status: 400
      });
    }
    const rawWorkspace = {
      workspaceId,
      displayName,
      slug: slugify(input.slug || displayName, digest([workspaceId], 8)),
      ownerUserId,
      status: WORKSPACE_STATUS.ACTIVE,
      metadata,
      createdAt: nowTimestamp,
      updatedAt: nowTimestamp,
      schemaVersion: SCHEMA_VERSION
    };
    const rawMembership = {
      workspaceId,
      userId: ownerUserId,
      role: MEMBERSHIP_ROLE.OWNER,
      status: MEMBERSHIP_STATUS.ACTIVE,
      createdAt: nowTimestamp,
      updatedAt: nowTimestamp,
      schemaVersion: SCHEMA_VERSION
    };
    const documentRefs = refs(db, workspaceId, ownerUserId);

    await db.runTransaction(async (transaction) => {
      const workspaceSnapshot = await transaction.get(documentRefs.workspace);
      const membershipSnapshot = await transaction.get(documentRefs.membership);
      if (workspaceSnapshot.exists || membershipSnapshot.exists) {
        throw new WorkspaceAccessError('Workspace ID collision.', {
          code: 'workspace_conflict',
          status: 409
        });
      }
      createInTransaction(transaction, documentRefs.workspace, rawWorkspace);
      createInTransaction(transaction, documentRefs.membership, rawMembership);
    });

    return Object.freeze({
      workspace: normalizeWorkspaceRecord(rawWorkspace, workspaceId),
      membership: normalizeMembershipRecord(rawMembership, documentRefs.membership.id)
    });
  }

  async function requireOwnerMembership(input = {}) {
    const userId = cleanRequiredId(input.userId, 'userId');
    const workspaceId = cleanRequiredId(input.workspaceId, 'workspaceId');
    if (!SAFE_ID_PATTERN.test(workspaceId)) throw workspaceNotFound();
    return resolveRequestedWorkspace(userId, workspaceId);
  }

  return Object.freeze({ resolveActiveWorkspace, createWorkspace, requireOwnerMembership });
}

let defaultService = null;
function defaultOperation(name) {
  return (...args) => {
    defaultService ||= createWorkspaceService();
    return defaultService[name](...args);
  };
}

module.exports = {
  SCHEMA_VERSION,
  COLLECTIONS,
  WORKSPACE_STATUS,
  MEMBERSHIP_ROLE,
  MEMBERSHIP_STATUS,
  WorkspaceAccessError,
  defaultWorkspaceId,
  workspaceMembershipDocumentId,
  normalizeWorkspaceRecord,
  normalizeMembershipRecord,
  createWorkspaceService,
  resolveActiveWorkspace: defaultOperation('resolveActiveWorkspace'),
  createWorkspace: defaultOperation('createWorkspace'),
  requireOwnerMembership: defaultOperation('requireOwnerMembership'),
  _private: Object.freeze({ safeIsoTimestamp, sanitizeMetadata, slugify })
};
