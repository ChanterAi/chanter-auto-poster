'use strict';

const { createHash } = require('node:crypto');

const USAGE_METRIC_SCHEDULED_POSTS = 'scheduled_posts';
const USAGE_STATES = Object.freeze({
  RESERVED: 'reserved',
  CONSUMED: 'consumed',
  RELEASED: 'released'
});
const USAGE_SCHEMA_VERSION = 1;
const DEFAULT_COLLECTIONS = Object.freeze({
  ledger: 'usageLedger',
  counters: 'usageCounters',
  activeQueueCounters: 'usageActiveQueueCounters',
  queue: 'posts'
});
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

class UsageTruthError extends Error {
  constructor(message, { code = 'usage_truth_unverified', status = 409, details = null } = {}) {
    super(message);
    this.name = 'UsageTruthError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

class UsageLimitError extends Error {
  constructor(message, decision) {
    super(message);
    this.name = 'UsageLimitError';
    this.code = decision.code;
    this.status = 409;
    this.decision = decision;
  }
}

class UsageTransitionError extends Error {
  constructor(message, { code = 'invalid_usage_transition', details = null } = {}) {
    super(message);
    this.name = 'UsageTransitionError';
    this.code = code;
    this.status = 409;
    this.details = details;
  }
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function requireText(value, field, { maxLength = 256 } = {}) {
  const normalized = text(value);
  if (!normalized || normalized.length > maxLength) {
    throw new UsageTruthError(`A valid ${field} is required.`, {
      code: 'invalid_usage_request',
      status: 400,
      details: { field }
    });
  }
  return normalized;
}

function requireDocumentId(value, field) {
  const normalized = requireText(value, field, { maxLength: 128 });
  if (!SAFE_DOCUMENT_ID.test(normalized)) {
    throw new UsageTruthError(`A valid ${field} is required.`, {
      code: 'invalid_usage_request',
      status: 400,
      details: { field }
    });
  }
  return normalized;
}

function requireDate(value, field) {
  let date;
  if (value instanceof Date) date = new Date(value.getTime());
  else if (value && typeof value.toDate === 'function') date = value.toDate();
  else date = new Date(value);

  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new UsageTruthError(`A valid ${field} is required.`, {
      code: 'invalid_usage_cycle',
      status: 400,
      details: { field }
    });
  }
  return date;
}

function deterministicId(prefix, parts) {
  const serialized = parts
    .map((part) => {
      const value = requireText(part, 'identifier component', { maxLength: 512 });
      return `${Buffer.byteLength(value, 'utf8')}:${value}`;
    })
    .join('|');
  const digest = createHash('sha256').update(serialized).digest('hex').slice(0, 48);
  return `${prefix}_${digest}`;
}

function calendarMonthUsageCycle(now = new Date()) {
  const current = requireDate(now, 'now');
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth();
  const startAt = new Date(Date.UTC(year, month, 1));
  const endAt = new Date(Date.UTC(year, month + 1, 1));
  return {
    usageCycleId: `calendar-${year}-${String(month + 1).padStart(2, '0')}`,
    startAt,
    endAt
  };
}

function normalizeUsageCycle(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new UsageTruthError('A verified usage cycle is required.', {
      code: 'invalid_usage_cycle',
      status: 400
    });
  }

  const startAt = requireDate(value.startAt ?? value.currentPeriodStart, 'usage cycle start');
  const endAt = requireDate(value.endAt ?? value.currentPeriodEnd, 'usage cycle end');
  const current = requireDate(now, 'now');
  if (startAt.getTime() >= endAt.getTime()) {
    throw new UsageTruthError('The usage cycle end must be after its start.', {
      code: 'invalid_usage_cycle',
      status: 400
    });
  }
  if (current.getTime() < startAt.getTime() || current.getTime() >= endAt.getTime()) {
    throw new UsageTruthError('The requested usage cycle is not active.', {
      code: 'inactive_usage_cycle',
      status: 409
    });
  }

  const suppliedId = text(value.usageCycleId || value.id);
  const usageCycleId = suppliedId
    ? requireDocumentId(suppliedId, 'usageCycleId')
    : deterministicId('cycle', [startAt.toISOString(), endAt.toISOString()]);

  return { usageCycleId, startAt, endAt };
}

function buildUsageIds({ workspaceId, usageCycleId, idempotencyKey, metric = USAGE_METRIC_SCHEDULED_POSTS }) {
  const safeWorkspaceId = requireText(workspaceId, 'workspaceId');
  const safeCycleId = requireDocumentId(usageCycleId, 'usageCycleId');
  const safeMetric = requireText(metric, 'metric');
  const safeIdempotencyKey = requireText(idempotencyKey, 'idempotencyKey', { maxLength: 512 });
  const identity = [safeWorkspaceId, safeMetric, safeCycleId, safeIdempotencyKey];
  return {
    reservationId: deterministicId('reservation', identity),
    ledgerId: deterministicId('ledger', identity),
    counterId: deterministicId('counter', [safeWorkspaceId, safeMetric, safeCycleId])
  };
}

function buildQueueDocumentId({ workspaceId, usageCycleId, idempotencyKey, metric = USAGE_METRIC_SCHEDULED_POSTS }) {
  return deterministicId('queue', [workspaceId, metric, usageCycleId, idempotencyKey]);
}

function buildActiveQueueCounterId({ workspaceId, metric = USAGE_METRIC_SCHEDULED_POSTS }) {
  return deterministicId('active_queue_counter', [workspaceId, metric]);
}

function normalizeLimit(value, field) {
  if (value === null || value === Number.POSITIVE_INFINITY) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageTruthError(`A verified ${field} is required.`, {
      code: 'invalid_usage_limits',
      status: 400,
      details: { field }
    });
  }
  return value;
}

function normalizeLimits(limits) {
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new UsageTruthError('Verified usage limits are required.', {
      code: 'invalid_usage_limits',
      status: 400
    });
  }
  const scheduledPostsPerCycle = normalizeLimit(limits.scheduledPostsPerCycle, 'scheduledPostsPerCycle');
  const hasCanonicalActiveLimit = Object.prototype.hasOwnProperty.call(limits, 'activeQueueLimit');
  const hasCompatibilityActiveLimit = Object.prototype.hasOwnProperty.call(limits, 'activeQueue');
  if (!hasCanonicalActiveLimit && !hasCompatibilityActiveLimit) {
    throw new UsageTruthError('A verified activeQueueLimit is required.', {
      code: 'invalid_usage_limits',
      status: 400,
      details: { field: 'activeQueueLimit' }
    });
  }
  if (hasCanonicalActiveLimit && hasCompatibilityActiveLimit
    && limits.activeQueueLimit !== limits.activeQueue) {
    throw new UsageTruthError('Conflicting active queue limits were supplied.', {
      code: 'invalid_usage_limits',
      status: 400,
      details: { field: 'activeQueueLimit' }
    });
  }
  const activeQueueLimit = normalizeLimit(
    hasCanonicalActiveLimit ? limits.activeQueueLimit : limits.activeQueue,
    'activeQueueLimit'
  );
  return { scheduledPostsPerCycle, activeQueueLimit };
}

function requireScheduledPostsMetric(metric) {
  const normalized = text(metric || USAGE_METRIC_SCHEDULED_POSTS);
  if (normalized !== USAGE_METRIC_SCHEDULED_POSTS) {
    throw new UsageTruthError('The requested usage metric is not supported.', {
      code: 'unsupported_usage_metric',
      status: 400,
      details: { metric: normalized }
    });
  }
  return normalized;
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOptionalFieldMatch(record, field, expected) {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return;
  if (text(record[field]) !== text(expected)) {
    throw new UsageTruthError(`Queue data contains a conflicting ${field}.`, {
      code: 'queue_usage_binding_conflict',
      status: 409,
      details: { field }
    });
  }
}

function snapshotData(snapshot) {
  return snapshot && snapshot.exists && typeof snapshot.data === 'function' ? snapshot.data() : null;
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageTruthError('Stored usage counter truth is corrupt.', {
      code: 'corrupt_usage_counter',
      details: { field }
    });
  }
  return value;
}

function validateCounter(counter, expected) {
  if (!isPlainRecord(counter)) {
    throw new UsageTruthError('Stored usage counter truth is corrupt.', {
      code: 'corrupt_usage_counter'
    });
  }
  for (const field of ['workspaceId', 'metric', 'usageCycleId']) {
    if (text(counter[field]) !== text(expected[field])) {
      throw new UsageTruthError('Stored usage counter scope does not match the request.', {
        code: 'usage_scope_mismatch',
        details: { field }
      });
    }
  }
  if (Number(counter.schemaVersion) !== USAGE_SCHEMA_VERSION) {
    throw new UsageTruthError('Stored usage counter schema is unsupported.', {
      code: 'corrupt_usage_counter',
      details: { field: 'schemaVersion' }
    });
  }

  const normalized = {
    ...counter,
    reservedQuantity: requireNonNegativeInteger(counter.reservedQuantity, 'reservedQuantity'),
    consumedQuantity: requireNonNegativeInteger(counter.consumedQuantity, 'consumedQuantity'),
    releasedQuantity: requireNonNegativeInteger(counter.releasedQuantity, 'releasedQuantity'),
    acceptedQuantity: requireNonNegativeInteger(counter.acceptedQuantity, 'acceptedQuantity')
  };
  if (normalized.acceptedQuantity !== normalized.reservedQuantity
    + normalized.consumedQuantity + normalized.releasedQuantity) {
    throw new UsageTruthError('Stored usage counter totals do not reconcile.', {
      code: 'corrupt_usage_counter',
      details: { field: 'acceptedQuantity' }
    });
  }
  if (expected.cycleStartAt && expected.cycleEndAt) {
    const storedStart = requireDate(counter.cycleStartAt, 'stored usage cycle start');
    const storedEnd = requireDate(counter.cycleEndAt, 'stored usage cycle end');
    if (
      storedStart.getTime() !== requireDate(expected.cycleStartAt, 'usage cycle start').getTime()
      || storedEnd.getTime() !== requireDate(expected.cycleEndAt, 'usage cycle end').getTime()
    ) {
      throw new UsageTruthError('Stored usage counter period does not match the request.', {
        code: 'usage_scope_mismatch',
        details: { field: 'usageCyclePeriod' }
      });
    }
  }
  return normalized;
}

function validateActiveQueueCounter(counter, expected) {
  if (!isPlainRecord(counter)) {
    throw new UsageTruthError('Stored active queue counter truth is corrupt.', {
      code: 'corrupt_active_queue_counter'
    });
  }
  for (const field of ['activeQueueCounterId', 'workspaceId', 'metric']) {
    if (text(counter[field]) !== text(expected[field])) {
      throw new UsageTruthError('Stored active queue counter scope does not match the request.', {
        code: 'usage_scope_mismatch',
        details: { field }
      });
    }
  }
  if (Number(counter.schemaVersion) !== USAGE_SCHEMA_VERSION) {
    throw new UsageTruthError('Stored active queue counter schema is unsupported.', {
      code: 'corrupt_active_queue_counter',
      details: { field: 'schemaVersion' }
    });
  }
  return {
    ...counter,
    activeQueue: requireNonNegativeInteger(counter.activeQueue, 'activeQueue')
  };
}

function validateLedger(ledger, expected) {
  if (!isPlainRecord(ledger)) {
    throw new UsageTruthError('Stored usage ledger truth is corrupt.', {
      code: 'corrupt_usage_ledger'
    });
  }
  for (const field of ['ledgerId', 'workspaceId', 'metric', 'usageCycleId']) {
    if (text(ledger[field]) !== text(expected[field])) {
      throw new UsageTruthError('Stored usage ledger scope does not match the request.', {
        code: 'usage_scope_mismatch',
        details: { field }
      });
    }
  }
  if (expected.idempotencyKey && text(ledger.idempotencyKey) !== text(expected.idempotencyKey)) {
    throw new UsageTruthError('The idempotency key resolves to conflicting usage truth.', {
      code: 'idempotency_scope_conflict'
    });
  }
  if (expected.relatedResourceId
    && text(ledger.relatedResourceId) !== text(expected.relatedResourceId)) {
    throw new UsageTruthError('The usage reservation points to a different queue item.', {
      code: 'idempotency_scope_conflict'
    });
  }
  if (Number(ledger.schemaVersion) !== USAGE_SCHEMA_VERSION
    || !Object.values(USAGE_STATES).includes(ledger.state)
    || !Number.isSafeInteger(ledger.quantity)
    || ledger.quantity !== 1
    || typeof ledger.activeQueueCounted !== 'boolean'
    || typeof ledger.outcomeUnknown !== 'boolean') {
    throw new UsageTruthError('Stored usage ledger truth is corrupt.', {
      code: 'corrupt_usage_ledger'
    });
  }
  const cycleStartAt = requireDate(ledger.cycleStartAt, 'stored usage cycle start');
  const cycleEndAt = requireDate(ledger.cycleEndAt, 'stored usage cycle end');
  if (
    cycleStartAt.getTime() >= cycleEndAt.getTime()
    || (expected.cycleStartAt
      && cycleStartAt.getTime() !== requireDate(expected.cycleStartAt, 'usage cycle start').getTime())
    || (expected.cycleEndAt
      && cycleEndAt.getTime() !== requireDate(expected.cycleEndAt, 'usage cycle end').getTime())
  ) {
    throw new UsageTruthError('Stored usage ledger period does not match the request.', {
      code: 'usage_scope_mismatch',
      details: { field: 'usageCyclePeriod' }
    });
  }
  if (ledger.state !== USAGE_STATES.RESERVED && ledger.activeQueueCounted) {
    throw new UsageTruthError('Terminal usage remains in the active queue counter.', {
      code: 'corrupt_usage_ledger'
    });
  }
  if (ledger.state === USAGE_STATES.RESERVED
    && !ledger.activeQueueCounted && !ledger.outcomeUnknown) {
    throw new UsageTruthError('Reserved usage left the active queue without reconciliation evidence.', {
      code: 'corrupt_usage_ledger'
    });
  }
  return ledger;
}

function buildEmptyCounter({ counterId, workspaceId, metric, usageCycle, now }) {
  return {
    counterId,
    workspaceId,
    metric,
    usageCycleId: usageCycle.usageCycleId,
    cycleStartAt: usageCycle.startAt,
    cycleEndAt: usageCycle.endAt,
    reservedQuantity: 0,
    consumedQuantity: 0,
    releasedQuantity: 0,
    acceptedQuantity: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: USAGE_SCHEMA_VERSION
  };
}

function buildEmptyActiveQueueCounter({ activeQueueCounterId, workspaceId, metric, now }) {
  return {
    activeQueueCounterId,
    workspaceId,
    metric,
    activeQueue: 0,
    createdAt: now,
    updatedAt: now,
    schemaVersion: USAGE_SCHEMA_VERSION
  };
}

function remaining(limit, current) {
  return limit === null ? null : Math.max(0, limit - current);
}

function usageSummary(counter, limits, activeQueue = 0) {
  const used = counter.reservedQuantity + counter.consumedQuantity;
  return {
    metric: counter.metric,
    usageCycleId: counter.usageCycleId,
    reserved: counter.reservedQuantity,
    consumed: counter.consumedQuantity,
    released: counter.releasedQuantity,
    accepted: counter.acceptedQuantity,
    used,
    activeQueue,
    scheduledPostsLimit: limits.scheduledPostsPerCycle,
    scheduledPostsRemaining: remaining(limits.scheduledPostsPerCycle, used),
    activeQueueLimit: limits.activeQueueLimit,
    activeQueueRemaining: remaining(limits.activeQueueLimit, activeQueue)
  };
}

function limitDecision({ code, reason, workspaceId, counter, limits, activeQueue }) {
  const summary = usageSummary(counter, limits, activeQueue);
  const isScheduledLimit = code === 'monthly_post_limit_reached';
  const current = isScheduledLimit ? summary.used : summary.activeQueue;
  const limit = isScheduledLimit ? limits.scheduledPostsPerCycle : limits.activeQueueLimit;
  const error = new UsageLimitError(reason, {
    ok: false,
    allowed: false,
    duplicate: false,
    code,
    reason,
    workspaceId,
    metric: counter.metric,
    usageCycleId: counter.usageCycleId,
    current,
    limit,
    remaining: remaining(limit, current),
    usage: summary
  });
  return error.decision;
}

function createUsageService({ db, clock = { now: () => new Date() }, collections = {} } = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new UsageTruthError('A transactional Firestore database is required.', {
      code: 'invalid_usage_configuration',
      status: 500
    });
  }
  if (!clock || typeof clock.now !== 'function') {
    throw new UsageTruthError('A usage clock is required.', {
      code: 'invalid_usage_configuration',
      status: 500
    });
  }

  const collectionNames = {
    ledger: requireText(collections.ledger || DEFAULT_COLLECTIONS.ledger, 'ledger collection'),
    counters: requireText(collections.counters || DEFAULT_COLLECTIONS.counters, 'counter collection'),
    activeQueueCounters: requireText(
      collections.activeQueueCounters || DEFAULT_COLLECTIONS.activeQueueCounters,
      'active queue counter collection'
    ),
    queue: requireText(collections.queue || DEFAULT_COLLECTIONS.queue, 'queue collection')
  };

  function now() {
    return requireDate(clock.now(), 'now');
  }

  function prepareReservationBatch(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new UsageTruthError('A usage reservation request is required.', {
        code: 'invalid_usage_request',
        status: 400
      });
    }
    const at = now();
    const workspaceId = requireText(input.workspaceId, 'workspaceId');
    const metric = requireScheduledPostsMetric(input.metric);
    const usageCycle = normalizeUsageCycle(input.usageCycle, at);
    const source = requireText(input.source, 'source', { maxLength: 64 });
    const limits = normalizeLimits(input.limits);
    const activeQueueBaseline = input.activeQueueBaseline === undefined
      ? 0
      : requireNonNegativeInteger(input.activeQueueBaseline, 'activeQueueBaseline');
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new UsageTruthError('At least one queue item is required.', {
        code: 'invalid_usage_request',
        status: 400,
        details: { field: 'items' }
      });
    }

    const seenLedgerIds = new Set();
    const seenQueueIds = new Set();
    const items = input.items.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new UsageTruthError('Every usage item must be an object.', {
          code: 'invalid_usage_request',
          status: 400,
          details: { field: `items[${index}]` }
        });
      }
      const idempotencyKey = requireText(item.idempotencyKey, 'idempotencyKey', { maxLength: 512 });
      if (!item.queue || !isPlainRecord(item.queue) || !isPlainRecord(item.queue.data)) {
        throw new UsageTruthError('Every usage item requires plain queue data.', {
          code: 'invalid_usage_request',
          status: 400,
          details: { field: `items[${index}].queue.data` }
        });
      }
      const ids = buildUsageIds({ workspaceId, usageCycleId: usageCycle.usageCycleId, idempotencyKey, metric });
      const queueDocumentId = item.queue.documentId
        ? requireDocumentId(item.queue.documentId, 'queue document ID')
        : buildQueueDocumentId({ workspaceId, usageCycleId: usageCycle.usageCycleId, idempotencyKey, metric });

      if (seenLedgerIds.has(ids.ledgerId)) {
        throw new UsageTruthError('A batch cannot repeat an idempotency key.', {
          code: 'duplicate_batch_idempotency_key',
          status: 400
        });
      }
      if (seenQueueIds.has(queueDocumentId)) {
        throw new UsageTruthError('A batch cannot target one queue document twice.', {
          code: 'duplicate_batch_queue_document',
          status: 400
        });
      }
      seenLedgerIds.add(ids.ledgerId);
      seenQueueIds.add(queueDocumentId);

      for (const [field, expected] of Object.entries({
        workspaceId,
        usageReservationId: ids.reservationId,
        usageLedgerId: ids.ledgerId,
        usageCycleId: usageCycle.usageCycleId,
        usageMetric: metric
      })) {
        assertOptionalFieldMatch(item.queue.data, field, expected);
      }

      return {
        index,
        idempotencyKey,
        ids,
        queueDocumentId,
        queueData: { ...item.queue.data },
        ledgerRef: db.collection(collectionNames.ledger).doc(ids.ledgerId),
        queueRef: db.collection(collectionNames.queue).doc(queueDocumentId)
      };
    });

    const counterId = buildUsageIds({
      workspaceId,
      usageCycleId: usageCycle.usageCycleId,
      idempotencyKey: '__counter__',
      metric
    }).counterId;
    const activeQueueCounterId = buildActiveQueueCounterId({ workspaceId, metric });
    return {
      at,
      workspaceId,
      metric,
      usageCycle,
      source,
      limits,
      activeQueueBaseline,
      items,
      counterId,
      counterRef: db.collection(collectionNames.counters).doc(counterId),
      activeQueueCounterId,
      activeQueueCounterRef: db.collection(collectionNames.activeQueueCounters).doc(activeQueueCounterId)
    };
  }

  async function reserveAndCreateQueueItemsInTransaction(tx, input) {
    if (!tx || typeof tx.get !== 'function' || typeof tx.create !== 'function') {
      throw new UsageTruthError('A Firestore transaction with create support is required.', {
        code: 'invalid_usage_transaction',
        status: 500
      });
    }
    const request = prepareReservationBatch(input);

    // Firestore forbids reads after writes. Read the shared counter and every
    // ledger/queue pair before evaluating or creating anything.
    const counterSnapshot = await tx.get(request.counterRef);
    const activeQueueCounterSnapshot = await tx.get(request.activeQueueCounterRef);
    const snapshots = [];
    for (const item of request.items) {
      const ledgerSnapshot = await tx.get(item.ledgerRef);
      const queueSnapshot = await tx.get(item.queueRef);
      snapshots.push({ item, ledgerSnapshot, queueSnapshot });
    }

    let counter;
    if (counterSnapshot.exists) {
      counter = validateCounter(snapshotData(counterSnapshot), {
        workspaceId: request.workspaceId,
        metric: request.metric,
        usageCycleId: request.usageCycle.usageCycleId,
        cycleStartAt: request.usageCycle.startAt,
        cycleEndAt: request.usageCycle.endAt
      });
    } else {
      counter = buildEmptyCounter({
        counterId: request.counterId,
        workspaceId: request.workspaceId,
        metric: request.metric,
        usageCycle: request.usageCycle,
        now: request.at
      });
    }

    const activeQueueCounter = activeQueueCounterSnapshot.exists
      ? validateActiveQueueCounter(snapshotData(activeQueueCounterSnapshot), {
          activeQueueCounterId: request.activeQueueCounterId,
          workspaceId: request.workspaceId,
          metric: request.metric
        })
      : buildEmptyActiveQueueCounter({
          activeQueueCounterId: request.activeQueueCounterId,
          workspaceId: request.workspaceId,
          metric: request.metric,
          now: request.at
        });

    const existing = [];
    const fresh = [];
    for (const entry of snapshots) {
      const { item, ledgerSnapshot, queueSnapshot } = entry;
      if (ledgerSnapshot.exists) {
        if (!counterSnapshot.exists) {
          throw new UsageTruthError('A usage ledger exists without its counter.', {
            code: 'missing_usage_counter'
          });
        }
        if (!activeQueueCounterSnapshot.exists) {
          throw new UsageTruthError('A usage ledger exists without its active queue counter.', {
            code: 'missing_active_queue_counter'
          });
        }
        const ledger = validateLedger(snapshotData(ledgerSnapshot), {
          ledgerId: item.ids.ledgerId,
          workspaceId: request.workspaceId,
          metric: request.metric,
          usageCycleId: request.usageCycle.usageCycleId,
          cycleStartAt: request.usageCycle.startAt,
          cycleEndAt: request.usageCycle.endAt,
          idempotencyKey: item.idempotencyKey,
          relatedResourceId: item.queueDocumentId
        });
        if (!queueSnapshot.exists) {
          throw new UsageTruthError('A usage reservation exists without its queue item.', {
            code: 'missing_reserved_queue_item'
          });
        }
        const queueData = snapshotData(queueSnapshot);
        if (!isPlainRecord(queueData)
          || text(queueData.workspaceId) !== request.workspaceId
          || text(queueData.usageLedgerId) !== item.ids.ledgerId
          || text(queueData.usageReservationId) !== item.ids.reservationId
          || text(queueData.usageCycleId) !== request.usageCycle.usageCycleId
          || text(queueData.usageMetric) !== request.metric) {
          throw new UsageTruthError('The existing queue item has conflicting usage binding.', {
            code: 'queue_usage_binding_conflict'
          });
        }
        existing.push({ item, ledger });
      } else {
        if (queueSnapshot.exists) {
          throw new UsageTruthError('The target queue document already exists without this reservation.', {
            code: 'queue_document_collision'
          });
        }
        fresh.push(item);
      }
    }

    const newQuantity = fresh.length;
    const currentUsed = counter.reservedQuantity + counter.consumedQuantity;
    const activeQueueCurrent = activeQueueCounter.activeQueue + request.activeQueueBaseline;
    if (request.limits.scheduledPostsPerCycle !== null
      && currentUsed + newQuantity > request.limits.scheduledPostsPerCycle) {
      return limitDecision({
        code: 'monthly_post_limit_reached',
        reason: 'The scheduled-post limit for this usage cycle has been reached.',
        workspaceId: request.workspaceId,
        counter,
        limits: request.limits,
        activeQueue: activeQueueCurrent
      });
    }
    if (request.limits.activeQueueLimit !== null
      && activeQueueCurrent + newQuantity > request.limits.activeQueueLimit) {
      return limitDecision({
        code: 'active_queue_limit_reached',
        reason: 'The active queue limit for this workspace has been reached.',
        workspaceId: request.workspaceId,
        counter,
        limits: request.limits,
        activeQueue: activeQueueCurrent
      });
    }

    const nextCounter = {
      ...counter,
      reservedQuantity: counter.reservedQuantity + newQuantity,
      acceptedQuantity: counter.acceptedQuantity + newQuantity,
      updatedAt: request.at
    };
    const nextActiveQueueCounter = {
      ...activeQueueCounter,
      activeQueue: activeQueueCounter.activeQueue + newQuantity,
      updatedAt: request.at
    };

    if (newQuantity > 0) {
      if (counterSnapshot.exists) tx.update(request.counterRef, nextCounter);
      else tx.create(request.counterRef, nextCounter);
      if (activeQueueCounterSnapshot.exists) {
        tx.update(request.activeQueueCounterRef, nextActiveQueueCounter);
      } else {
        tx.create(request.activeQueueCounterRef, nextActiveQueueCounter);
      }

      for (const item of fresh) {
        const ledger = {
          reservationId: item.ids.reservationId,
          ledgerId: item.ids.ledgerId,
          workspaceId: request.workspaceId,
          metric: request.metric,
          usageCycleId: request.usageCycle.usageCycleId,
          cycleStartAt: request.usageCycle.startAt,
          cycleEndAt: request.usageCycle.endAt,
          quantity: 1,
          state: USAGE_STATES.RESERVED,
          idempotencyKey: item.idempotencyKey,
          source: request.source,
          relatedResourceId: item.queueDocumentId,
          activeQueueCounted: true,
          outcomeUnknown: false,
          reservedAt: request.at,
          consumedAt: null,
          releasedAt: null,
          outcomeUnknownAt: null,
          createdAt: request.at,
          updatedAt: request.at,
          schemaVersion: USAGE_SCHEMA_VERSION
        };
        tx.create(item.ledgerRef, ledger);
        tx.create(item.queueRef, {
          ...item.queueData,
          workspaceId: request.workspaceId,
          usageReservationId: item.ids.reservationId,
          usageLedgerId: item.ids.ledgerId,
          usageCycleId: request.usageCycle.usageCycleId,
          usageMetric: request.metric,
          usageState: USAGE_STATES.RESERVED
        });
      }
    }

    const freshIds = new Set(fresh.map((item) => item.ids.ledgerId));
    const ledgerById = new Map(existing.map(({ item, ledger }) => [item.ids.ledgerId, ledger]));
    const results = request.items.map((item) => ({
      ok: true,
      allowed: true,
      duplicate: !freshIds.has(item.ids.ledgerId),
      code: freshIds.has(item.ids.ledgerId) ? 'usage_reserved' : 'duplicate_idempotency_key',
      state: freshIds.has(item.ids.ledgerId)
        ? USAGE_STATES.RESERVED
        : ledgerById.get(item.ids.ledgerId).state,
      reservationId: item.ids.reservationId,
      ledgerId: item.ids.ledgerId,
      counterId: request.counterId,
      activeQueueCounterId: request.activeQueueCounterId,
      queueDocumentId: item.queueDocumentId,
      queueCreated: freshIds.has(item.ids.ledgerId)
    }));
    return {
      ok: true,
      allowed: true,
      duplicate: fresh.length === 0,
      code: fresh.length === 0 ? 'duplicate_idempotency_key' : 'usage_batch_reserved',
      workspaceId: request.workspaceId,
      metric: request.metric,
      usageCycleId: request.usageCycle.usageCycleId,
      reservedCount: fresh.length,
      duplicateCount: existing.length,
      items: results,
      usage: usageSummary(
        nextCounter,
        request.limits,
        nextActiveQueueCounter.activeQueue + request.activeQueueBaseline
      )
    };
  }

  function singleResult(batchResult) {
    if (!batchResult.ok) return batchResult;
    const item = batchResult.items[0];
    return { ...batchResult, ...item, items: batchResult.items, usage: batchResult.usage };
  }

  async function reserveAndCreateQueueItemInTransaction(tx, input) {
    const item = {
      idempotencyKey: input && input.idempotencyKey,
      queue: input && input.queue
    };
    return singleResult(await reserveAndCreateQueueItemsInTransaction(tx, { ...input, items: [item] }));
  }

  async function locateReservation(tx, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new UsageTruthError('A usage reservation locator is required.', {
        code: 'invalid_usage_request',
        status: 400
      });
    }
    const workspaceId = requireText(input.workspaceId, 'workspaceId');
    const usageCycleId = requireDocumentId(input.usageCycleId, 'usageCycleId');
    const metric = requireScheduledPostsMetric(input.metric);
    const ledgerId = requireDocumentId(input.ledgerId, 'ledgerId');
    const counterId = deterministicId('counter', [workspaceId, metric, usageCycleId]);
    const activeQueueCounterId = buildActiveQueueCounterId({ workspaceId, metric });
    const ledgerRef = db.collection(collectionNames.ledger).doc(ledgerId);
    const counterRef = db.collection(collectionNames.counters).doc(counterId);
    const activeQueueCounterRef = db.collection(collectionNames.activeQueueCounters).doc(activeQueueCounterId);

    const ledgerSnapshot = await tx.get(ledgerRef);
    const counterSnapshot = await tx.get(counterRef);
    const activeQueueCounterSnapshot = await tx.get(activeQueueCounterRef);
    if (!ledgerSnapshot.exists) {
      throw new UsageTruthError('The usage reservation does not exist.', {
        code: 'missing_usage_reservation'
      });
    }
    if (!counterSnapshot.exists) {
      throw new UsageTruthError('The usage counter does not exist.', {
        code: 'missing_usage_counter'
      });
    }
    if (!activeQueueCounterSnapshot.exists) {
      throw new UsageTruthError('The active queue counter does not exist.', {
        code: 'missing_active_queue_counter'
      });
    }
    const ledger = validateLedger(snapshotData(ledgerSnapshot), {
      ledgerId,
      workspaceId,
      metric,
      usageCycleId,
      relatedResourceId: text(input.relatedResourceId) || null
    });
    const cycleStartAt = requireDate(ledger.cycleStartAt, 'stored usage cycle start');
    const cycleEndAt = requireDate(ledger.cycleEndAt, 'stored usage cycle end');
    if (cycleStartAt.getTime() >= cycleEndAt.getTime()) {
      throw new UsageTruthError('Stored usage ledger period is corrupt.', {
        code: 'corrupt_usage_ledger'
      });
    }
    const counter = validateCounter(snapshotData(counterSnapshot), {
      workspaceId,
      metric,
      usageCycleId,
      cycleStartAt,
      cycleEndAt
    });
    const activeQueueCounter = validateActiveQueueCounter(snapshotData(activeQueueCounterSnapshot), {
      activeQueueCounterId,
      workspaceId,
      metric
    });
    return {
      workspaceId,
      usageCycleId,
      metric,
      ledgerId,
      counterId,
      activeQueueCounterId,
      ledgerRef,
      counterRef,
      activeQueueCounterRef,
      ledger,
      counter,
      activeQueueCounter
    };
  }

  function transitionResult({ located, state, code, applied, activeQueueDecremented }) {
    return {
      ok: true,
      applied,
      duplicate: !applied,
      code,
      workspaceId: located.workspaceId,
      usageCycleId: located.usageCycleId,
      metric: located.metric,
      reservationId: located.ledger.reservationId,
      ledgerId: located.ledgerId,
      counterId: located.counterId,
      activeQueueCounterId: located.activeQueueCounterId,
      queueDocumentId: located.ledger.relatedResourceId,
      state,
      activeQueueDecremented
    };
  }

  async function consumeReservationInTransaction(tx, input) {
    const located = await locateReservation(tx, input);
    if (located.ledger.state === USAGE_STATES.CONSUMED) {
      return transitionResult({
        located,
        state: USAGE_STATES.CONSUMED,
        code: 'usage_already_consumed',
        applied: false,
        activeQueueDecremented: false
      });
    }
    if (located.ledger.state !== USAGE_STATES.RESERVED) {
      throw new UsageTransitionError('Released usage cannot be consumed.', {
        code: 'usage_already_released'
      });
    }

    const at = now();
    const activeQueueDecremented = located.ledger.activeQueueCounted;
    if (located.counter.reservedQuantity < 1
      || (activeQueueDecremented && located.activeQueueCounter.activeQueue < 1)) {
      throw new UsageTruthError('Stored usage counter truth cannot apply this consumption.', {
        code: 'corrupt_usage_counter'
      });
    }
    tx.update(located.ledgerRef, {
      ...located.ledger,
      state: USAGE_STATES.CONSUMED,
      activeQueueCounted: false,
      consumedAt: at,
      updatedAt: at
    });
    tx.update(located.counterRef, {
      ...located.counter,
      reservedQuantity: located.counter.reservedQuantity - 1,
      consumedQuantity: located.counter.consumedQuantity + 1,
      updatedAt: at
    });
    if (activeQueueDecremented) {
      tx.update(located.activeQueueCounterRef, {
        ...located.activeQueueCounter,
        activeQueue: located.activeQueueCounter.activeQueue - 1,
        updatedAt: at
      });
    }
    return transitionResult({
      located,
      state: USAGE_STATES.CONSUMED,
      code: 'usage_consumed',
      applied: true,
      activeQueueDecremented
    });
  }

  async function releaseReservationInTransaction(tx, input) {
    const located = await locateReservation(tx, input);
    if (located.ledger.state === USAGE_STATES.RELEASED) {
      return transitionResult({
        located,
        state: USAGE_STATES.RELEASED,
        code: 'usage_already_released',
        applied: false,
        activeQueueDecremented: false
      });
    }
    if (located.ledger.state !== USAGE_STATES.RESERVED) {
      throw new UsageTransitionError('Consumed usage cannot be released.', {
        code: 'usage_already_consumed'
      });
    }

    const at = now();
    const activeQueueDecremented = located.ledger.activeQueueCounted;
    if (located.counter.reservedQuantity < 1
      || (activeQueueDecremented && located.activeQueueCounter.activeQueue < 1)) {
      throw new UsageTruthError('Stored usage counter truth cannot apply this release.', {
        code: 'corrupt_usage_counter'
      });
    }
    tx.update(located.ledgerRef, {
      ...located.ledger,
      state: USAGE_STATES.RELEASED,
      activeQueueCounted: false,
      releasedAt: at,
      releaseReason: text(input.reason).slice(0, 128) || 'pre_provider_release',
      updatedAt: at
    });
    tx.update(located.counterRef, {
      ...located.counter,
      reservedQuantity: located.counter.reservedQuantity - 1,
      releasedQuantity: located.counter.releasedQuantity + 1,
      updatedAt: at
    });
    if (activeQueueDecremented) {
      tx.update(located.activeQueueCounterRef, {
        ...located.activeQueueCounter,
        activeQueue: located.activeQueueCounter.activeQueue - 1,
        updatedAt: at
      });
    }
    return transitionResult({
      located,
      state: USAGE_STATES.RELEASED,
      code: 'usage_released',
      applied: true,
      activeQueueDecremented
    });
  }

  async function markOutcomeUnknownInTransaction(tx, input) {
    const located = await locateReservation(tx, input);
    if (located.ledger.state !== USAGE_STATES.RESERVED) {
      throw new UsageTransitionError('Only reserved usage can record an unknown provider outcome.', {
        code: 'invalid_usage_transition'
      });
    }
    if (located.ledger.outcomeUnknown) {
      return transitionResult({
        located,
        state: USAGE_STATES.RESERVED,
        code: 'usage_outcome_unknown_already_recorded',
        applied: false,
        activeQueueDecremented: false
      });
    }

    const at = now();
    const activeQueueDecremented = located.ledger.activeQueueCounted;
    if (!activeQueueDecremented || located.activeQueueCounter.activeQueue < 1) {
      throw new UsageTruthError('Stored usage counter truth cannot leave the active queue.', {
        code: 'corrupt_usage_counter'
      });
    }
    tx.update(located.ledgerRef, {
      ...located.ledger,
      activeQueueCounted: false,
      outcomeUnknown: true,
      outcomeUnknownAt: at,
      outcomeUnknownReason: text(input.reason).slice(0, 128) || 'provider_reconciliation_required',
      updatedAt: at
    });
    tx.update(located.activeQueueCounterRef, {
      ...located.activeQueueCounter,
      activeQueue: located.activeQueueCounter.activeQueue - 1,
      updatedAt: at
    });
    return transitionResult({
      located,
      state: USAGE_STATES.RESERVED,
      code: 'usage_outcome_unknown_recorded',
      applied: true,
      activeQueueDecremented: true
    });
  }

  async function reserveAndCreateQueueItems(input) {
    return db.runTransaction((tx) => reserveAndCreateQueueItemsInTransaction(tx, input));
  }

  async function reserveAndCreateQueueItem(input) {
    return db.runTransaction((tx) => reserveAndCreateQueueItemInTransaction(tx, input));
  }

  async function consumeReservation(input) {
    return db.runTransaction((tx) => consumeReservationInTransaction(tx, input));
  }

  async function releaseReservation(input) {
    return db.runTransaction((tx) => releaseReservationInTransaction(tx, input));
  }

  async function markOutcomeUnknown(input) {
    return db.runTransaction((tx) => markOutcomeUnknownInTransaction(tx, input));
  }

  async function getUsageSnapshot(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new UsageTruthError('A usage snapshot request is required.', {
        code: 'invalid_usage_request',
        status: 400
      });
    }
    const at = now();
    const workspaceId = requireText(input.workspaceId, 'workspaceId');
    const metric = requireScheduledPostsMetric(input.metric);
    const usageCycle = normalizeUsageCycle(input.usageCycle, at);
    const limits = normalizeLimits(input.limits);
    const counterId = deterministicId('counter', [workspaceId, metric, usageCycle.usageCycleId]);
    const activeQueueCounterId = buildActiveQueueCounterId({ workspaceId, metric });
    const [snapshot, activeQueueSnapshot] = await Promise.all([
      db.collection(collectionNames.counters).doc(counterId).get(),
      db.collection(collectionNames.activeQueueCounters).doc(activeQueueCounterId).get()
    ]);
    const counter = snapshot.exists
      ? validateCounter(snapshotData(snapshot), {
          workspaceId,
          metric,
          usageCycleId: usageCycle.usageCycleId,
          cycleStartAt: usageCycle.startAt,
          cycleEndAt: usageCycle.endAt
        })
      : buildEmptyCounter({ counterId, workspaceId, metric, usageCycle, now: at });
    const activeQueueCounter = activeQueueSnapshot.exists
      ? validateActiveQueueCounter(snapshotData(activeQueueSnapshot), {
          activeQueueCounterId,
          workspaceId,
          metric
        })
      : buildEmptyActiveQueueCounter({ activeQueueCounterId, workspaceId, metric, now: at });
    return {
      ok: true,
      workspaceId,
      counterId,
      activeQueueCounterId,
      initialized: snapshot.exists,
      activeQueueInitialized: activeQueueSnapshot.exists,
      ...usageSummary(counter, limits, activeQueueCounter.activeQueue)
    };
  }

  return Object.freeze({
    reserveAndCreateQueueItem,
    reserveAndCreateQueueItems,
    consumeReservation,
    releaseReservation,
    markOutcomeUnknown,
    getUsageSnapshot,
    transaction: Object.freeze({
      reserveAndCreateQueueItem: reserveAndCreateQueueItemInTransaction,
      reserveAndCreateQueueItems: reserveAndCreateQueueItemsInTransaction,
      consumeReservation: consumeReservationInTransaction,
      releaseReservation: releaseReservationInTransaction,
      markOutcomeUnknown: markOutcomeUnknownInTransaction
    })
  });
}

module.exports = {
  USAGE_METRIC_SCHEDULED_POSTS,
  USAGE_STATES,
  USAGE_SCHEMA_VERSION,
  DEFAULT_COLLECTIONS,
  UsageTruthError,
  UsageLimitError,
  UsageTransitionError,
  calendarMonthUsageCycle,
  normalizeUsageCycle,
  buildUsageIds,
  buildQueueDocumentId,
  buildActiveQueueCounterId,
  createUsageService
};
