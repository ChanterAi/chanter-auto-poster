'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  USAGE_METRIC_SCHEDULED_POSTS,
  USAGE_STATES,
  UsageTruthError,
  UsageTransitionError,
  calendarMonthUsageCycle,
  normalizeUsageCycle,
  buildUsageIds,
  buildQueueDocumentId,
  createUsageService
} = require('../src/usageService');

function clone(value) {
  return structuredClone(value);
}

class TransactionConflict extends Error {}

class MemorySnapshot {
  constructor(record) {
    this.exists = Boolean(record);
    this._data = record ? clone(record.data) : undefined;
  }

  data() {
    return clone(this._data);
  }
}

class MemoryDocumentReference {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    this.db.documentReads += 1;
    return new MemorySnapshot(this.db.records.get(this.path));
  }
}

class MemoryTransaction {
  constructor(db) {
    this.db = db;
    this.readVersions = new Map();
    this.writes = [];
  }

  async get(ref) {
    if (this.writes.length > 0) {
      throw new Error('transaction attempted a read after a write');
    }
    // Yield so Promise.all transactions observe the same initial versions and
    // exercise the fake's optimistic retry path.
    await Promise.resolve();
    this.db.documentReads += 1;
    const record = this.db.records.get(ref.path);
    this.readVersions.set(ref.path, record ? record.version : 0);
    return new MemorySnapshot(record);
  }

  create(ref, data) {
    this.writes.push({ operation: 'create', ref, data: clone(data) });
  }

  update(ref, data) {
    this.writes.push({ operation: 'update', ref, data: clone(data) });
  }
}

class MemoryFirestore {
  constructor() {
    this.records = new Map();
    this.version = 0;
    this.documentReads = 0;
    this.queryScans = 0;
    this.transactionRetries = 0;
    this.failWritePaths = new Set();
  }

  collection(name) {
    return {
      doc: (id) => new MemoryDocumentReference(this, name, id),
      get: async () => {
        this.queryScans += 1;
        throw new Error('full collection scans are forbidden in usage tests');
      }
    };
  }

  async runTransaction(callback) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const tx = new MemoryTransaction(this);
      const result = await callback(tx);
      await Promise.resolve();
      try {
        this.commit(tx);
        return result;
      } catch (error) {
        if (!(error instanceof TransactionConflict)) throw error;
        this.transactionRetries += 1;
      }
    }
    throw new Error('transaction retry limit exceeded');
  }

  commit(tx) {
    for (const [path, version] of tx.readVersions.entries()) {
      const current = this.records.get(path);
      if ((current ? current.version : 0) !== version) throw new TransactionConflict();
    }

    for (const write of tx.writes) {
      const current = this.records.get(write.ref.path);
      if (write.operation === 'create' && current) throw new TransactionConflict();
      if (write.operation === 'update' && !current) throw new TransactionConflict();
      if (this.failWritePaths.has(write.ref.path)) {
        this.failWritePaths.delete(write.ref.path);
        throw new Error(`injected atomic write failure: ${write.ref.path}`);
      }
    }

    // Apply only after every write has passed preflight, matching Firestore's
    // all-or-none transaction commit semantics.
    for (const write of tx.writes) {
      const current = this.records.get(write.ref.path);
      const data = write.operation === 'update'
        ? { ...clone(current.data), ...clone(write.data) }
        : clone(write.data);
      this.version += 1;
      this.records.set(write.ref.path, { data, version: this.version });
    }
  }

  setDocument(collectionName, id, data) {
    this.version += 1;
    this.records.set(`${collectionName}/${id}`, { data: clone(data), version: this.version });
  }

  failNextWrite(collectionName, id) {
    this.failWritePaths.add(`${collectionName}/${id}`);
  }

  document(collectionName, id) {
    const record = this.records.get(`${collectionName}/${id}`);
    return record ? clone(record.data) : null;
  }

  documents(collectionName) {
    const prefix = `${collectionName}/`;
    return [...this.records.entries()]
      .filter(([path]) => path.startsWith(prefix))
      .map(([path, record]) => ({ id: path.slice(prefix.length), ...clone(record.data) }));
  }
}

function harness(at = '2026-07-11T10:00:00.000Z') {
  const db = new MemoryFirestore();
  const mutableClock = { current: new Date(at) };
  const clock = { now: () => new Date(mutableClock.current.getTime()) };
  const service = createUsageService({ db, clock });
  return { db, mutableClock, service };
}

function limits(overrides = {}) {
  return {
    scheduledPostsPerCycle: 30,
    activeQueueLimit: 20,
    ...overrides
  };
}

function reservationInput({
  at = new Date('2026-07-11T10:00:00.000Z'),
  workspaceId = 'workspace-a',
  idempotencyKey = 'schedule-request-1',
  source = 'website',
  usageLimits = limits(),
  queueDocumentId,
  queueData = { userId: 'owner', status: 'scheduled' }
} = {}) {
  return {
    workspaceId,
    usageCycle: calendarMonthUsageCycle(at),
    idempotencyKey,
    source,
    limits: usageLimits,
    queue: {
      ...(queueDocumentId ? { documentId: queueDocumentId } : {}),
      data: queueData
    }
  };
}

function locator(result) {
  return {
    workspaceId: result.workspaceId,
    usageCycleId: result.usageCycleId,
    ledgerId: result.ledgerId,
    relatedResourceId: result.queueDocumentId
  };
}

test('cycle and identifier helpers are deterministic and cycle-scoped', () => {
  const july = calendarMonthUsageCycle(new Date('2026-07-31T23:59:59.999Z'));
  const august = calendarMonthUsageCycle(new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(july.usageCycleId, 'calendar-2026-07');
  assert.equal(july.startAt.toISOString(), '2026-07-01T00:00:00.000Z');
  assert.equal(july.endAt.toISOString(), '2026-08-01T00:00:00.000Z');
  assert.equal(august.usageCycleId, 'calendar-2026-08');

  const first = buildUsageIds({
    workspaceId: 'workspace-a', usageCycleId: july.usageCycleId, idempotencyKey: 'same-key'
  });
  const retry = buildUsageIds({
    workspaceId: 'workspace-a', usageCycleId: july.usageCycleId, idempotencyKey: 'same-key'
  });
  const nextCycle = buildUsageIds({
    workspaceId: 'workspace-a', usageCycleId: august.usageCycleId, idempotencyKey: 'same-key'
  });
  assert.deepEqual(first, retry);
  assert.notEqual(first.reservationId, nextCycle.reservationId);
  assert.notEqual(first.ledgerId, nextCycle.ledgerId);
  assert.notEqual(first.counterId, nextCycle.counterId);
  for (const id of Object.values(first)) assert.match(id, /^[A-Za-z0-9_-]+$/);

  const explicit = normalizeUsageCycle({
    usageCycleId: 'subscription-period-7',
    currentPeriodStart: '2026-07-10T00:00:00.000Z',
    currentPeriodEnd: '2026-08-10T00:00:00.000Z'
  }, new Date('2026-07-11T00:00:00.000Z'));
  assert.equal(explicit.usageCycleId, 'subscription-period-7');
});

test('accepted queue creation atomically creates one reservation, counter, and queue item', async () => {
  const { db, service } = harness();
  const result = await service.reserveAndCreateQueueItem(reservationInput());

  assert.equal(result.ok, true);
  assert.equal(result.allowed, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.code, 'usage_reserved');
  assert.equal(result.queueCreated, true);

  const ledger = db.document('usageLedger', result.ledgerId);
  assert.equal(ledger.reservationId, result.reservationId);
  assert.equal(ledger.state, USAGE_STATES.RESERVED);
  assert.equal(ledger.metric, USAGE_METRIC_SCHEDULED_POSTS);
  assert.equal(ledger.quantity, 1);
  assert.equal(ledger.activeQueueCounted, true);

  const counter = db.document('usageCounters', result.counterId);
  assert.deepEqual(
    {
      reserved: counter.reservedQuantity,
      consumed: counter.consumedQuantity,
      released: counter.releasedQuantity,
      accepted: counter.acceptedQuantity
    },
    { reserved: 1, consumed: 0, released: 0, accepted: 1 }
  );
  assert.equal(db.document('usageActiveQueueCounters', result.activeQueueCounterId).activeQueue, 1);

  const queue = db.document('posts', result.queueDocumentId);
  assert.equal(queue.workspaceId, 'workspace-a');
  assert.equal(queue.usageReservationId, result.reservationId);
  assert.equal(queue.usageLedgerId, result.ledgerId);
  assert.equal(queue.usageCycleId, result.usageCycleId);
  assert.equal(db.queryScans, 0);
});

test('duplicate idempotency is structured and does not reserve or create twice', async () => {
  const { db, service } = harness();
  const input = reservationInput();
  const first = await service.reserveAndCreateQueueItem(input);
  const duplicate = await service.reserveAndCreateQueueItem(input);

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.allowed, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.code, 'duplicate_idempotency_key');
  assert.equal(duplicate.queueCreated, false);
  assert.equal(duplicate.ledgerId, first.ledgerId);
  assert.equal(duplicate.queueDocumentId, first.queueDocumentId);
  assert.equal(duplicate.usage.reserved, 1);
  assert.equal(db.documents('usageLedger').length, 1);
  assert.equal(db.documents('posts').length, 1);
  assert.equal(db.queryScans, 0);
});

test('concurrent retries with one idempotency key converge on one reservation and queue item', async () => {
  const { db, service } = harness();
  const input = reservationInput({ idempotencyKey: 'concurrent-same-key' });
  const results = await Promise.all([
    service.reserveAndCreateQueueItem(input),
    service.reserveAndCreateQueueItem(input)
  ]);

  assert.deepEqual(results.map((result) => result.code).sort(), [
    'duplicate_idempotency_key',
    'usage_reserved'
  ]);
  assert.equal(db.documents('usageLedger').length, 1);
  assert.equal(db.documents('posts').length, 1);
  assert.equal(db.documents('usageCounters')[0].reservedQuantity, 1);
  assert.equal(db.documents('usageActiveQueueCounters')[0].activeQueue, 1);
  assert.ok(db.transactionRetries >= 1, 'the fake exercised optimistic transaction retry');
});

test('concurrent distinct reservations cannot exceed the scheduled-post quota', async () => {
  const { db, service } = harness();
  const usageLimits = limits({ scheduledPostsPerCycle: 1, activeQueueLimit: 10 });
  const results = await Promise.all([
    service.reserveAndCreateQueueItem(reservationInput({ idempotencyKey: 'quota-a', usageLimits })),
    service.reserveAndCreateQueueItem(reservationInput({ idempotencyKey: 'quota-b', usageLimits }))
  ]);

  assert.equal(results.filter((result) => result.ok).length, 1);
  const denied = results.find((result) => !result.ok);
  assert.equal(denied.code, 'monthly_post_limit_reached');
  assert.equal(denied.current, 1);
  assert.equal(denied.limit, 1);
  assert.equal(denied.remaining, 0);
  assert.equal(db.documents('usageLedger').length, 1);
  assert.equal(db.documents('posts').length, 1);
  assert.equal(db.documents('usageCounters')[0].reservedQuantity, 1);
  assert.equal(db.documents('usageActiveQueueCounters')[0].activeQueue, 1);
});

test('active queue limit is enforced independently without scanning the queue', async () => {
  const { db, service } = harness();
  const usageLimits = limits({ scheduledPostsPerCycle: 10, activeQueueLimit: 1 });
  await service.reserveAndCreateQueueItem(reservationInput({ idempotencyKey: 'active-a', usageLimits }));
  const denied = await service.reserveAndCreateQueueItem(
    reservationInput({ idempotencyKey: 'active-b', usageLimits })
  );

  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'active_queue_limit_reached');
  assert.equal(denied.current, 1);
  assert.equal(denied.limit, 1);
  assert.equal(db.documents('posts').length, 1);
  assert.equal(db.documents('usageActiveQueueCounters')[0].activeQueue, 1);
  assert.equal(db.queryScans, 0);
});

test('batch reservation is cumulative, all-or-none, and returns per-item identifiers', async () => {
  const { db, service } = harness();
  const usageCycle = calendarMonthUsageCycle(new Date('2026-07-11T10:00:00.000Z'));
  const batchBase = {
    workspaceId: 'workspace-a',
    usageCycle,
    source: 'website',
    limits: limits({ scheduledPostsPerCycle: 2, activeQueueLimit: 2 })
  };
  const denied = await service.reserveAndCreateQueueItems({
    ...batchBase,
    items: ['one', 'two', 'three'].map((key) => ({
      idempotencyKey: `batch-${key}`,
      queue: { data: { userId: 'owner', status: 'scheduled', label: key } }
    }))
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'monthly_post_limit_reached');
  assert.equal(db.documents('usageLedger').length, 0);
  assert.equal(db.documents('usageCounters').length, 0);
  assert.equal(db.documents('posts').length, 0);

  const accepted = await service.reserveAndCreateQueueItems({
    ...batchBase,
    items: ['one', 'two'].map((key) => ({
      idempotencyKey: `batch-${key}`,
      queue: { data: { userId: 'owner', status: 'scheduled', label: key } }
    }))
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.reservedCount, 2);
  assert.equal(accepted.duplicateCount, 0);
  assert.equal(accepted.items.length, 2);
  assert.ok(accepted.items.every((item) => item.reservationId && item.ledgerId && item.queueDocumentId));
  assert.equal(db.documents('usageCounters')[0].reservedQuantity, 2);
  assert.equal(db.documents('posts').length, 2);
});

test('a mixed duplicate and new batch charges only the new item', async () => {
  const { db, service } = harness();
  const usageCycle = calendarMonthUsageCycle(new Date('2026-07-11T10:00:00.000Z'));
  const base = {
    workspaceId: 'workspace-a', usageCycle, source: 'runtime',
    limits: limits({ scheduledPostsPerCycle: 3, activeQueueLimit: 3 })
  };
  const firstItem = {
    idempotencyKey: 'mixed-one',
    queue: { data: { userId: 'owner', status: 'scheduled' } }
  };
  await service.reserveAndCreateQueueItems({ ...base, items: [firstItem] });
  const mixed = await service.reserveAndCreateQueueItems({
    ...base,
    items: [firstItem, {
      idempotencyKey: 'mixed-two',
      queue: { data: { userId: 'owner', status: 'scheduled' } }
    }]
  });

  assert.equal(mixed.reservedCount, 1);
  assert.equal(mixed.duplicateCount, 1);
  assert.deepEqual(mixed.items.map((item) => item.duplicate), [true, false]);
  assert.equal(db.documents('usageCounters')[0].reservedQuantity, 2);
  assert.equal(db.documents('posts').length, 2);
});

test('consume moves reserved to consumed once and decrements active queue once', async () => {
  const { db, service } = harness();
  const reservation = await service.reserveAndCreateQueueItem(
    reservationInput({ idempotencyKey: 'youtube-private' })
  );
  const consumed = await service.consumeReservation({
    ...locator(reservation), reason: 'youtube_uploaded_private'
  });
  const duplicate = await service.consumeReservation(locator(reservation));

  assert.equal(consumed.applied, true);
  assert.equal(consumed.code, 'usage_consumed');
  assert.equal(consumed.activeQueueDecremented, true);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.code, 'usage_already_consumed');
  const counter = db.document('usageCounters', reservation.counterId);
  assert.deepEqual(
    [counter.reservedQuantity, counter.consumedQuantity, counter.releasedQuantity],
    [0, 1, 0]
  );
  assert.equal(db.document('usageActiveQueueCounters', reservation.activeQueueCounterId).activeQueue, 0);
  assert.equal(db.document('usageLedger', reservation.ledgerId).state, USAGE_STATES.CONSUMED);
});

test('release moves reserved to released once and returns quota', async () => {
  const { db, service } = harness();
  const reservation = await service.reserveAndCreateQueueItem(
    reservationInput({ idempotencyKey: 'canceled-before-provider' })
  );
  const released = await service.releaseReservation({
    ...locator(reservation), reason: 'queue_deleted_before_provider'
  });
  const duplicate = await service.releaseReservation(locator(reservation));

  assert.equal(released.applied, true);
  assert.equal(released.code, 'usage_released');
  assert.equal(released.activeQueueDecremented, true);
  assert.equal(duplicate.applied, false);
  assert.equal(duplicate.code, 'usage_already_released');
  const counter = db.document('usageCounters', reservation.counterId);
  assert.deepEqual(
    [counter.reservedQuantity, counter.consumedQuantity, counter.releasedQuantity],
    [0, 0, 1]
  );
  assert.equal(db.document('usageActiveQueueCounters', reservation.activeQueueCounterId).activeQueue, 0);
  await assert.rejects(
    service.consumeReservation(locator(reservation)),
    (error) => error instanceof UsageTransitionError && error.code === 'usage_already_released'
  );
});

test('outcome_unknown preserves reserved usage but leaves active queue exactly once', async () => {
  const { db, service } = harness();
  const reservation = await service.reserveAndCreateQueueItem(
    reservationInput({ idempotencyKey: 'unknown-provider-outcome' })
  );
  const unknown = await service.markOutcomeUnknown({
    ...locator(reservation), reason: 'provider_reconciliation_required'
  });
  const duplicate = await service.markOutcomeUnknown(locator(reservation));

  assert.equal(unknown.applied, true);
  assert.equal(unknown.state, USAGE_STATES.RESERVED);
  assert.equal(unknown.activeQueueDecremented, true);
  assert.equal(duplicate.applied, false);
  const afterUnknown = db.document('usageCounters', reservation.counterId);
  assert.deepEqual(
    [afterUnknown.reservedQuantity, afterUnknown.consumedQuantity],
    [1, 0]
  );
  assert.equal(db.document('usageActiveQueueCounters', reservation.activeQueueCounterId).activeQueue, 0);
  const ledger = db.document('usageLedger', reservation.ledgerId);
  assert.equal(ledger.state, USAGE_STATES.RESERVED);
  assert.equal(ledger.outcomeUnknown, true);
  assert.equal(ledger.activeQueueCounted, false);

  // A later positive reconciliation consumes the held reservation without a
  // second active-queue decrement.
  const reconciled = await service.consumeReservation(locator(reservation));
  assert.equal(reconciled.activeQueueDecremented, false);
  const finalCounter = db.document('usageCounters', reservation.counterId);
  assert.deepEqual(
    [finalCounter.reservedQuantity, finalCounter.consumedQuantity],
    [0, 1]
  );
});

test('scheduled-post counters remain cycle-scoped while active queue truth is workspace-wide', async () => {
  const { db, mutableClock, service } = harness('2026-07-31T23:00:00.000Z');
  const julyInput = reservationInput({
    at: mutableClock.current,
    idempotencyKey: 'recurring-client-key',
    usageLimits: limits({ scheduledPostsPerCycle: 1, activeQueueLimit: 10 })
  });
  const july = await service.reserveAndCreateQueueItem(julyInput);

  mutableClock.current = new Date('2026-08-01T01:00:00.000Z');
  const august = await service.reserveAndCreateQueueItem(reservationInput({
    at: mutableClock.current,
    idempotencyKey: 'recurring-client-key',
    usageLimits: limits({ scheduledPostsPerCycle: 1, activeQueueLimit: 10 })
  }));

  assert.equal(july.ok, true);
  assert.equal(august.ok, true);
  assert.notEqual(july.ledgerId, august.ledgerId);
  assert.notEqual(july.counterId, august.counterId);
  assert.equal(db.documents('usageCounters').length, 2);
  assert.deepEqual(db.documents('usageCounters').map((counter) => counter.reservedQuantity), [1, 1]);
  assert.equal(db.documents('usageActiveQueueCounters').length, 1);
  assert.equal(db.documents('usageActiveQueueCounters')[0].activeQueue, 2);
});

test('an active reservation from the previous cycle still occupies the workspace queue limit', async () => {
  const { mutableClock, service } = harness('2026-07-31T23:00:00.000Z');
  const usageLimits = limits({ scheduledPostsPerCycle: 1, activeQueueLimit: 1 });
  const july = await service.reserveAndCreateQueueItem(reservationInput({
    at: mutableClock.current,
    idempotencyKey: 'cross-cycle-active',
    usageLimits
  }));

  mutableClock.current = new Date('2026-08-01T01:00:00.000Z');
  const denied = await service.reserveAndCreateQueueItem(reservationInput({
    at: mutableClock.current,
    idempotencyKey: 'august-attempt',
    usageLimits
  }));
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'active_queue_limit_reached');
  assert.equal(denied.current, 1);

  await service.consumeReservation(locator(july));
  const accepted = await service.reserveAndCreateQueueItem(reservationInput({
    at: mutableClock.current,
    idempotencyKey: 'august-attempt',
    usageLimits
  }));
  assert.equal(accepted.ok, true);
});

test('a verified legacy baseline participates in concurrent transactional active-queue enforcement', async () => {
  const { db, service } = harness();
  const usageLimits = limits({ scheduledPostsPerCycle: 10, activeQueueLimit: 2 });
  const results = await Promise.all([
    service.reserveAndCreateQueueItem({
      ...reservationInput({ idempotencyKey: 'legacy-baseline-a', usageLimits }),
      activeQueueBaseline: 1
    }),
    service.reserveAndCreateQueueItem({
      ...reservationInput({ idempotencyKey: 'legacy-baseline-b', usageLimits }),
      activeQueueBaseline: 1
    })
  ]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.find((result) => !result.ok).code, 'active_queue_limit_reached');
  assert.equal(db.documents('usageActiveQueueCounters')[0].activeQueue, 1);
});

test('queue write failure commits neither reservation nor counter', async () => {
  const { db, service } = harness();
  const input = reservationInput({ idempotencyKey: 'atomic-write-failure' });
  const queueDocumentId = buildQueueDocumentId({
    workspaceId: input.workspaceId,
    usageCycleId: input.usageCycle.usageCycleId,
    idempotencyKey: input.idempotencyKey
  });
  db.failNextWrite('posts', queueDocumentId);

  await assert.rejects(
    service.reserveAndCreateQueueItem(input),
    /injected atomic write failure/
  );
  assert.equal(db.documents('usageLedger').length, 0);
  assert.equal(db.documents('usageCounters').length, 0);
  assert.equal(db.documents('usageActiveQueueCounters').length, 0);
  assert.equal(db.documents('posts').length, 0);
});

test('missing and corrupt usage truth fail closed without creating a queue item', async () => {
  const { db, service } = harness();
  await assert.rejects(
    service.consumeReservation({
      workspaceId: 'workspace-a',
      usageCycleId: 'calendar-2026-07',
      ledgerId: 'ledger_missing'
    }),
    (error) => error instanceof UsageTruthError && error.code === 'missing_usage_reservation'
  );

  const reservation = await service.reserveAndCreateQueueItem(
    reservationInput({ idempotencyKey: 'corrupt-counter' })
  );
  const counter = db.document('usageCounters', reservation.counterId);
  db.setDocument('usageCounters', reservation.counterId, { ...counter, acceptedQuantity: 99 });
  await assert.rejects(
    service.reserveAndCreateQueueItem(reservationInput({ idempotencyKey: 'corrupt-counter' })),
    (error) => error instanceof UsageTruthError && error.code === 'corrupt_usage_counter'
  );

  const fresh = harness();
  const collisionInput = reservationInput({ idempotencyKey: 'queue-collision' });
  const collisionQueueId = buildQueueDocumentId({
    workspaceId: collisionInput.workspaceId,
    usageCycleId: collisionInput.usageCycle.usageCycleId,
    idempotencyKey: collisionInput.idempotencyKey
  });
  fresh.db.setDocument('posts', collisionQueueId, { userId: 'owner', status: 'scheduled' });
  await assert.rejects(
    fresh.service.reserveAndCreateQueueItem(collisionInput),
    (error) => error instanceof UsageTruthError && error.code === 'queue_document_collision'
  );
  assert.equal(fresh.db.documents('usageLedger').length, 0);
  assert.equal(fresh.db.documents('usageCounters').length, 0);
});

test('usage snapshots read only the deterministic counter document', async () => {
  const { db, service } = harness();
  const input = reservationInput({ idempotencyKey: 'snapshot-source' });
  await service.reserveAndCreateQueueItem(input);
  const snapshot = await service.getUsageSnapshot({
    workspaceId: input.workspaceId,
    usageCycle: input.usageCycle,
    limits: input.limits
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.initialized, true);
  assert.equal(snapshot.used, 1);
  assert.equal(snapshot.scheduledPostsRemaining, 29);
  assert.equal(snapshot.activeQueue, 1);
  assert.equal(snapshot.activeQueueRemaining, 19);
  assert.equal(db.queryScans, 0);
});
