'use strict';

// V1.2 scheduling modes: computeBatchSchedulePlan is a pure, channel-agnostic
// per-source-video planner (maxScheduler.js). It underlies Mode 1 (interval),
// Mode 2 (date-range distribution), and Mode 3 (explicit daily slots) from
// the batch intake surface. No I/O, no destination/account concept here —
// multi-account fan-out just applies the same slots to every selected
// destination (covered in platform-batch-fanout.test.js).

const assert = require('node:assert/strict');
const test = require('node:test');
const { computeBatchSchedulePlan } = require('../src/maxScheduler');

// ── Mode 1: interval ─────────────────────────────────────────────────────

test('interval mode: fixed spacing, unbounded capacity, bad stagger rejected', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'interval',
    startDate: '2026-07-11',
    startTime: '09:00',
    timezoneOffsetMinutes: 0,
    staggerMinutes: 20,
    sourceCount: 3
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.availableSlots, null, 'interval mode has no capacity ceiling');
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-07-11T09:00:00.000Z',
    '2026-07-11T09:20:00.000Z',
    '2026-07-11T09:40:00.000Z'
  ]);

  const badStagger = computeBatchSchedulePlan({
    mode: 'interval', startDate: '2026-07-11', startTime: '09:00',
    timezoneOffsetMinutes: 0, staggerMinutes: 0, sourceCount: 2
  });
  assert.equal(badStagger.ok, false);

  const noDate = computeBatchSchedulePlan({ mode: 'interval', sourceCount: 2 });
  assert.equal(noDate.ok, false);
  assert.match(noDate.reason, /start date and start time/);
});

// ── Mode 2: date-range distribution ─────────────────────────────────────

test('dateRange mode: distributes sources across days at N posts/day, in order', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dateRange',
    firstDay: '2026-08-01',
    lastDay: '2026-08-02',
    postsPerDay: 2,
    dailyStartTime: '10:00',
    dailyEndTime: '14:00',
    timezoneOffsetMinutes: 0,
    sourceCount: 4
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.daysInRange, 2);
  assert.equal(plan.slotsPerDay, 2);
  assert.equal(plan.availableSlots, 4);
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T14:00:00.000Z',
    '2026-08-02T10:00:00.000Z',
    '2026-08-02T14:00:00.000Z'
  ]);
});

test('dateRange mode: same-day range is valid (first day === last day)', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dateRange',
    firstDay: '2026-08-01',
    lastDay: '2026-08-01',
    postsPerDay: 3,
    dailyStartTime: '09:00',
    timezoneOffsetMinutes: 0,
    intraDayIntervalMinutes: 60,
    sourceCount: 3
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.daysInRange, 1);
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-08-01T09:00:00.000Z',
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T11:00:00.000Z'
  ]);
});

test('dateRange mode: last day before first day is rejected', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dateRange', firstDay: '2026-08-05', lastDay: '2026-08-01',
    postsPerDay: 1, dailyStartTime: '09:00', timezoneOffsetMinutes: 0, sourceCount: 1
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /on or after the first day/);
});

test('dateRange mode: insufficient capacity fails closed with exact required/available counts, never overflows the range', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dateRange',
    firstDay: '2026-08-01',
    lastDay: '2026-08-02',
    postsPerDay: 1,
    dailyStartTime: '09:00',
    timezoneOffsetMinutes: 0,
    sourceCount: 5 // only 2 days x 1/day = 2 slots available
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.requiredSlots, 5);
  assert.equal(plan.availableSlots, 2);
  assert.match(plan.reason, /Not enough schedule capacity/);
});

test('dateRange mode: exact capacity never overflows beyond the last day', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dateRange',
    firstDay: '2026-08-01',
    lastDay: '2026-08-03',
    postsPerDay: 2,
    dailyStartTime: '09:00',
    dailyEndTime: '11:00',
    timezoneOffsetMinutes: 0,
    sourceCount: 6 // exactly 3 days x 2/day
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.slots.length, 6);
  assert.ok(plan.slots.every((slot) => slot.scheduledAt <= '2026-08-03T23:59:59.999Z'));
  assert.ok(plan.slots.every((slot) => slot.scheduledAt >= '2026-08-01T00:00:00.000Z'));
});

test('dateRange mode: deterministic replay — identical input always yields identical slots', () => {
  const input = {
    mode: 'dateRange', firstDay: '2026-08-01', lastDay: '2026-08-04',
    postsPerDay: 2, dailyStartTime: '09:00', dailyEndTime: '17:00',
    timezoneOffsetMinutes: 0, sourceCount: 5
  };
  const a = computeBatchSchedulePlan(input);
  const b = computeBatchSchedulePlan(input);
  assert.deepEqual(a.slots, b.slots);
});

// ── Mode 3: explicit daily slots ────────────────────────────────────────

test('dailySlots mode: duplicate and unsorted slots are deduped and sorted deterministically', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dailySlots',
    firstDay: '2026-08-01',
    lastDay: '2026-08-01',
    dailySlots: ['22:00', '10:00', '10:00', '16:00'],
    timezoneOffsetMinutes: 0,
    sourceCount: 3
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.slotsPerDay, 3, 'duplicate 10:00 collapses to one slot');
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T16:00:00.000Z',
    '2026-08-01T22:00:00.000Z'
  ]);
});

test('dailySlots mode: invalid time format is rejected', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dailySlots', firstDay: '2026-08-01', lastDay: '2026-08-01',
    dailySlots: ['25:00'], timezoneOffsetMinutes: 0, sourceCount: 1
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /valid daily times/);
});

test('dailySlots mode: assigns sources across days x slots in deterministic chronological order', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dailySlots',
    firstDay: '2026-08-01',
    lastDay: '2026-08-02',
    dailySlots: ['10:00', '22:00'],
    timezoneOffsetMinutes: 0,
    sourceCount: 3
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.availableSlots, 4);
  assert.deepEqual(plan.slots.map((slot) => slot.scheduledAt), [
    '2026-08-01T10:00:00.000Z',
    '2026-08-01T22:00:00.000Z',
    '2026-08-02T10:00:00.000Z'
  ]);
});

test('dailySlots mode: insufficient capacity fails closed', () => {
  const plan = computeBatchSchedulePlan({
    mode: 'dailySlots', firstDay: '2026-08-01', lastDay: '2026-08-01',
    dailySlots: ['10:00'], timezoneOffsetMinutes: 0, sourceCount: 2
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.requiredSlots, 2);
  assert.equal(plan.availableSlots, 1);
});

// ── Timezone / DST ───────────────────────────────────────────────────────

test('dailySlots mode: a nonexistent local time in a DST spring-forward gap is rejected, not silently shifted', () => {
  // Europe/Nicosia springs forward on 2026-03-29: 03:00-03:59 local does not
  // exist that day (clocks jump 03:00 -> 04:00 EEST).
  const plan = computeBatchSchedulePlan({
    mode: 'dailySlots',
    firstDay: '2026-03-29',
    lastDay: '2026-03-29',
    dailySlots: ['03:30'],
    timezoneName: 'Europe/Nicosia',
    sourceCount: 1
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /could not be resolved/);
});

test('dailySlots mode: a valid local time either side of the DST gap resolves correctly', () => {
  const before = computeBatchSchedulePlan({
    mode: 'dailySlots', firstDay: '2026-03-29', lastDay: '2026-03-29',
    dailySlots: ['02:30'], timezoneName: 'Europe/Nicosia', sourceCount: 1
  });
  assert.equal(before.ok, true);
  const after = computeBatchSchedulePlan({
    mode: 'dailySlots', firstDay: '2026-03-29', lastDay: '2026-03-29',
    dailySlots: ['05:00'], timezoneName: 'Europe/Nicosia', sourceCount: 1
  });
  assert.equal(after.ok, true);
});

// ── Unsupported mode ─────────────────────────────────────────────────────

test('an unsupported scheduling mode is rejected', () => {
  const plan = computeBatchSchedulePlan({ mode: 'weekly', sourceCount: 1 });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /Unsupported batch scheduling mode/);
});
