'use strict';

// Max Scheduler: pure calculation tests for computeMaxSchedulePlan().
// Mirrors the mission's worked example exactly:
//   start 2026-07-07 09:00, offset 5m, channels [@__chanter, @_cdwarrior]
//   -> @__chanter 09:00, @_cdwarrior 09:05.

const assert = require('node:assert/strict');
const test = require('node:test');

const { computeMaxSchedulePlan, DEFAULT_OFFSET_MINUTES } = require('../src/maxScheduler');

// timezoneOffsetMinutes=0 means the browser is UTC, so the resulting UTC
// instant equals the entered local wall-clock time exactly, making test
// assertions on the ISO string trivial and unambiguous.
const UTC_OFFSET = 0;

test('single-channel campaign scheduled at the exact chosen start date/time creates one job at that exact time', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    timezoneOffsetMinutes: UTC_OFFSET,
    offsetMinutes: 5,
    channels: [{ accountId: 'chanter-open-id', username: '__chanter', connected: true }]
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.jobCount, 1);
  assert.equal(plan.baseAt, '2026-07-07T09:00:00.000Z');
  assert.equal(plan.channels[0].scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(plan.channels[0].offsetMinutes, 0);
  assert.equal(plan.summary, 'This campaign will create 1 release job across 1 selected channel.');
});

test('two-channel campaign creates two jobs: base time and base + 5 minutes (default offset)', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    timezoneOffsetMinutes: UTC_OFFSET,
    channels: [
      { accountId: 'chanter-open-id', username: '__chanter', connected: true },
      { accountId: 'cdwarrior-open-id', username: '_cdwarrior', connected: true }
    ]
  });

  assert.equal(plan.ok, true);
  assert.equal(plan.offsetMinutes, DEFAULT_OFFSET_MINUTES);
  assert.equal(plan.jobCount, 2);
  assert.equal(plan.channels[0].accountId, 'chanter-open-id');
  assert.equal(plan.channels[0].scheduledAt, '2026-07-07T09:00:00.000Z');
  assert.equal(plan.channels[1].accountId, 'cdwarrior-open-id');
  assert.equal(plan.channels[1].scheduledAt, '2026-07-07T09:05:00.000Z');
  assert.equal(plan.summary, 'This campaign will create 2 release jobs across 2 selected channels.');
});

test('custom offset (+10 minutes) is honored for every following channel', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    timezoneOffsetMinutes: UTC_OFFSET,
    offsetMinutes: 10,
    channels: [
      { accountId: 'a', connected: true },
      { accountId: 'b', connected: true },
      { accountId: 'c', connected: true }
    ]
  });

  assert.equal(plan.ok, true);
  assert.deepEqual(plan.channels.map((channel) => channel.scheduledAt), [
    '2026-07-07T09:00:00.000Z',
    '2026-07-07T09:10:00.000Z',
    '2026-07-07T09:20:00.000Z'
  ]);
});

test('channel ordering is preserved exactly as submitted, not resorted', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    timezoneOffsetMinutes: UTC_OFFSET,
    offsetMinutes: 5,
    channels: [
      { accountId: 'z-account', connected: true },
      { accountId: 'a-account', connected: true }
    ]
  });

  assert.equal(plan.ok, true);
  // z-account was submitted first, so it gets the base time even though it
  // would sort after a-account alphabetically.
  assert.equal(plan.channels[0].accountId, 'z-account');
  assert.equal(plan.channels[0].offsetMinutes, 0);
  assert.equal(plan.channels[1].accountId, 'a-account');
  assert.equal(plan.channels[1].offsetMinutes, 5);
});

test('preflight blocks when no channels are selected', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    channels: []
  });

  assert.equal(plan.ok, false);
  assert.match(plan.reason, /at least one publishing channel/i);
});

test('preflight blocks a disconnected/unauthorized channel', () => {
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    channels: [
      { accountId: 'chanter-open-id', username: '__chanter', connected: true },
      { accountId: 'retired-open-id', username: 'retired', connected: false }
    ]
  });

  assert.equal(plan.ok, false);
  assert.match(plan.reason, /disconnected/i);
  assert.deepEqual(plan.blockedChannels, ['retired-open-id']);
});

test('preflight blocks a missing start date or start time', () => {
  const missingDate = computeMaxSchedulePlan({
    startTime: '09:00',
    channels: [{ accountId: 'a', connected: true }]
  });
  assert.equal(missingDate.ok, false);
  assert.match(missingDate.reason, /start date and start time/i);

  const missingTime = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    channels: [{ accountId: 'a', connected: true }]
  });
  assert.equal(missingTime.ok, false);
});

test('preflight blocks a negative or out-of-range offset', () => {
  const negative = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    offsetMinutes: -1,
    channels: [{ accountId: 'a', connected: true }]
  });
  assert.equal(negative.ok, false);
  assert.match(negative.reason, /offset/i);
});

test('a non-UTC browser offset still produces the correct UTC instant', () => {
  // A browser in UTC-5 (e.g. US Eastern) reports getTimezoneOffset() = 300.
  const plan = computeMaxSchedulePlan({
    startDate: '2026-07-07',
    startTime: '09:00',
    timezoneOffsetMinutes: 300,
    offsetMinutes: 5,
    channels: [{ accountId: 'a', connected: true }]
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.baseAt, '2026-07-07T14:00:00.000Z');
});
