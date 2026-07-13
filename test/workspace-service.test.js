'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  COLLECTIONS,
  MEMBERSHIP_ROLE,
  WorkspaceAccessError,
  createWorkspaceService,
  defaultWorkspaceId,
  workspaceMembershipDocumentId
} = require('../src/workspaceService');
const subscriptionService = require('../src/subscriptionService');

function timestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Object.freeze({
    toDate: () => new Date(date.getTime()),
    toMillis: () => date.getTime()
  });
}

const Timestamp = Object.freeze({
  fromDate: (date) => timestamp(date),
  fromMillis: (milliseconds) => timestamp(milliseconds)
});

function createFirestoreFake() {
  const stores = new Map();
  const reads = [];

  function store(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function reference(collectionName, id) {
    return Object.freeze({ collectionName, id, path: `${collectionName}/${id}` });
  }

  function snapshot(ref) {
    const records = store(ref.collectionName);
    return {
      id: ref.id,
      exists: records.has(ref.id),
      data: () => records.get(ref.id)
    };
  }

  const db = {
    collection(name) {
      return { doc: (id) => reference(name, id) };
    },
    async runTransaction(callback) {
      const pending = [];
      const result = await callback({
        async get(ref) {
          reads.push(ref.path);
          return snapshot(ref);
        },
        create(ref, data) { pending.push({ type: 'create', ref, data }); },
        set(ref, data) { pending.push({ type: 'set', ref, data }); },
        update(ref, patch) { pending.push({ type: 'update', ref, data: patch }); }
      });
      for (const operation of pending) {
        const records = store(operation.ref.collectionName);
        if (operation.type === 'create' && records.has(operation.ref.id)) {
          const error = new Error('already exists');
          error.code = 6;
          throw error;
        }
        if (operation.type === 'update' && !records.has(operation.ref.id)) {
          throw new Error('missing update target');
        }
        const current = records.get(operation.ref.id) || {};
        records.set(operation.ref.id, operation.type === 'update'
          ? { ...current, ...operation.data }
          : operation.data);
      }
      return result;
    }
  };

  return {
    db,
    reads,
    seed(collectionName, id, data) { store(collectionName).set(id, data); },
    get(collectionName, id) { return store(collectionName).get(id); },
    count(collectionName) { return store(collectionName).size; },
    clearReads() { reads.length = 0; }
  };
}

function makeService(fake, overrides = {}) {
  return createWorkspaceService({
    db: fake.db,
    Timestamp,
    clock: () => new Date('2026-07-11T12:30:00.000Z'),
    workspaceIdFactory: () => 'workspace-new-00000001',
    ...overrides
  });
}

test('a legacy owner resolves one deterministic workspace, owner membership, and internal subscription atomically', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);

  const first = await service.resolveActiveWorkspace({ userId: 'owner', displayName: 'CHANTER', legacyEligible: true });
  const expectedWorkspaceId = defaultWorkspaceId('owner');
  const membershipId = workspaceMembershipDocumentId(expectedWorkspaceId, 'owner');
  const subscriptionId = subscriptionService.subscriptionDocumentId(expectedWorkspaceId);

  assert.equal(first.createdLegacy, true);
  assert.equal(first.workspace.workspaceId, expectedWorkspaceId);
  assert.equal(first.workspace.ownerUserId, 'owner');
  assert.equal(first.workspace.status, 'active');
  assert.equal(first.workspace.metadata.compatibility, 'legacy_default');
  assert.equal(first.workspace.schemaVersion, 1);
  assert.equal(first.workspace.createdAt, '2026-07-11T12:30:00.000Z');
  assert.equal(first.membership.membershipId, membershipId);
  assert.equal(first.membership.role, MEMBERSHIP_ROLE.OWNER);
  assert.equal(first.membership.status, 'active');

  const storedSubscription = fake.get(subscriptionService.COLLECTIONS.SUBSCRIPTIONS, subscriptionId);
  assert.equal(storedSubscription.workspaceId, expectedWorkspaceId);
  assert.equal(storedSubscription.planId, 'legacy_full_access');
  assert.equal(storedSubscription.status, 'internal');
  assert.equal(storedSubscription.source, 'internal');
  assert.equal(storedSubscription.externalCustomerId, null);
  assert.equal(storedSubscription.billingProvider, null);
  assert.equal(storedSubscription.currentPeriodStart.toDate().toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(storedSubscription.currentPeriodEnd.toDate().toISOString(), '2026-08-01T00:00:00.000Z');

  const second = await service.resolveActiveWorkspace({ userId: 'owner', legacyEligible: true });
  assert.equal(second.createdLegacy, false);
  assert.equal(second.workspace.workspaceId, expectedWorkspaceId);
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 1);
  assert.equal(fake.count(COLLECTIONS.MEMBERSHIPS), 1);
  assert.equal(fake.count(subscriptionService.COLLECTIONS.SUBSCRIPTIONS), 1);
});

test('explicit workspace creation persists canonical owner state and never creates a legacy subscription', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  const created = await service.createWorkspace({
    ownerUserId: 'new-owner',
    displayName: 'Creator Studio',
    metadata: { locale: 'en-CY', timezone: 'Asia/Nicosia' }
  });

  assert.equal(created.workspace.workspaceId, 'workspace-new-00000001');
  assert.equal(created.workspace.displayName, 'Creator Studio');
  assert.match(created.workspace.slug, /^creator-studio-/);
  assert.equal(created.workspace.ownerUserId, 'new-owner');
  assert.deepEqual(created.workspace.metadata, { locale: 'en-CY', timezone: 'Asia/Nicosia' });
  assert.equal(created.membership.role, 'owner');
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 1);
  assert.equal(fake.count(COLLECTIONS.MEMBERSHIPS), 1);
  assert.equal(fake.count(subscriptionService.COLLECTIONS.SUBSCRIPTIONS), 0);

  const resolved = await service.resolveActiveWorkspace({
    userId: 'new-owner',
    requestedWorkspaceId: created.workspace.workspaceId
  });
  assert.equal(resolved.createdLegacy, false);
  assert.equal(resolved.workspace.workspaceId, created.workspace.workspaceId);
});

test('an explicit unknown or non-member workspace rejects identically without default fallback or existence probing', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  const requestedWorkspaceId = 'workspace-private-00000001';
  fake.seed(COLLECTIONS.WORKSPACES, requestedWorkspaceId, {
    workspaceId: requestedWorkspaceId,
    displayName: 'Private',
    slug: 'private-00000001',
    ownerUserId: 'other-owner',
    status: 'active',
    metadata: {},
    createdAt: timestamp('2026-07-01T00:00:00Z'),
    updatedAt: timestamp('2026-07-01T00:00:00Z'),
    schemaVersion: 1
  });

  await assert.rejects(
    service.resolveActiveWorkspace({ userId: 'intruder', requestedWorkspaceId }),
    (error) => error instanceof WorkspaceAccessError
      && error.code === 'workspace_not_found'
      && error.status === 404
  );
  assert.deepEqual(fake.reads, [
    `${COLLECTIONS.MEMBERSHIPS}/${workspaceMembershipDocumentId(requestedWorkspaceId, 'intruder')}`
  ]);
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 1, 'no default workspace was created');
  assert.equal(fake.count(subscriptionService.COLLECTIONS.SUBSCRIPTIONS), 0);

  fake.clearReads();
  await assert.rejects(
    service.resolveActiveWorkspace({
      userId: 'intruder',
      requestedWorkspaceId: 'workspace-unknown-00000001'
    }),
    (error) => error.code === 'workspace_not_found' && error.status === 404
  );
  assert.equal(fake.reads.length, 1);
  assert.match(fake.reads[0], /^workspaceMemberships\//);
});

test('membership and ownership checks fail closed before returning a workspace', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  const workspaceId = 'workspace-owned-00000001';
  const membershipId = workspaceMembershipDocumentId(workspaceId, 'owner');
  fake.seed(COLLECTIONS.WORKSPACES, workspaceId, {
    workspaceId,
    displayName: 'Owned',
    slug: 'owned-00000001',
    ownerUserId: 'owner',
    status: 'active',
    metadata: {},
    createdAt: timestamp('2026-07-01T00:00:00Z'),
    updatedAt: timestamp('2026-07-01T00:00:00Z'),
    schemaVersion: 1
  });
  fake.seed(COLLECTIONS.MEMBERSHIPS, membershipId, {
    workspaceId,
    userId: 'owner',
    role: 'member',
    status: 'active',
    createdAt: timestamp('2026-07-01T00:00:00Z'),
    updatedAt: timestamp('2026-07-01T00:00:00Z'),
    schemaVersion: 1
  });

  await assert.rejects(
    service.requireOwnerMembership({ userId: 'owner', workspaceId }),
    (error) => error.code === 'workspace_not_found' && error.status === 404
  );
  assert.deepEqual(fake.reads, [`${COLLECTIONS.MEMBERSHIPS}/${membershipId}`]);
});

test('a user is never granted legacy compatibility without server eligibility', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  await assert.rejects(
    service.resolveActiveWorkspace({ userId: 'future-user' }),
    (error) => error instanceof WorkspaceAccessError
      && error.code === 'workspace_not_found'
      && error.status === 404
  );
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 0);
  assert.equal(fake.count(COLLECTIONS.MEMBERSHIPS), 0);
});

test('explicit workspace creation cannot forge the legacy compatibility marker', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  await assert.rejects(
    service.createWorkspace({
      ownerUserId: 'owner',
      displayName: 'Forged Legacy Workspace',
      metadata: { compatibility: 'legacy_default' }
    }),
    (error) => error instanceof WorkspaceAccessError
      && error.code === 'invalid_workspace_metadata'
      && error.status === 400
  );
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 0);
});

test('workspace metadata rejects secret-like or nested values before persistence', async () => {
  const fake = createFirestoreFake();
  const service = makeService(fake);
  await assert.rejects(
    service.createWorkspace({ ownerUserId: 'owner', metadata: { apiToken: 'canary-secret' } }),
    (error) => error.code === 'invalid_workspace_metadata'
  );
  await assert.rejects(
    service.createWorkspace({ ownerUserId: 'owner', metadata: { nested: { unsafe: true } } }),
    (error) => error.code === 'invalid_workspace_metadata'
  );
  assert.equal(fake.count(COLLECTIONS.WORKSPACES), 0);
  assert.equal(JSON.stringify([...fake.reads]).includes('canary-secret'), false);
});
