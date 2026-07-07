'use strict';

// Controlled Live Publish Test readiness: the plan builder and the
// mandatory approval gate never execute anything, never accept an
// unconfirmed go-ahead, and never render a secret (there is nothing
// secret-shaped in the plan's inputs to begin with).

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CONFIRMATION_PHRASE,
  buildLivePublishPlan,
  renderLivePublishApprovalGate,
  isConfirmed
} = require('../src/livePublishTest');

const NOW = new Date('2026-07-07T09:00:00.000Z');

function twoChannelPlan(overrides = {}) {
  return buildLivePublishPlan({
    channels: [
      { accountId: 'chanter-open-id', username: '__chanter', connected: true },
      { accountId: 'cdwarrior-open-id', username: '_cdwarrior', connected: true }
    ],
    assetDescription: 'One small test image, chanter-logo.png',
    caption: 'Live publish test',
    tags: '#chantertest',
    bufferMinutes: 5,
    offsetMinutes: 5,
    now: NOW,
    ...overrides
  });
}

test('builds a plan with the first scheduled time now + buffer and +offset per following channel', () => {
  const plan = twoChannelPlan();
  assert.equal(plan.ok, true);
  assert.equal(plan.expectedJobCount, 2);
  assert.equal(plan.firstScheduledAt, '2026-07-07T09:05:00.000Z');
  assert.equal(plan.channels[0].scheduledAt, '2026-07-07T09:05:00.000Z');
  assert.equal(plan.channels[1].scheduledAt, '2026-07-07T09:10:00.000Z');
});

test('blocks when no channels are supplied', () => {
  const plan = buildLivePublishPlan({ assetDescription: 'a', caption: 'b', now: NOW });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /at least one connected TikTok account/i);
});

test('blocks when a channel under test is not connected', () => {
  const plan = buildLivePublishPlan({
    channels: [{ accountId: 'retired-open-id', username: 'retired', connected: false }],
    assetDescription: 'a', caption: 'b', now: NOW
  });
  assert.equal(plan.ok, false);
  assert.match(plan.reason, /must already be connected/i);
});

test('blocks when the asset or caption is missing', () => {
  const missingAsset = buildLivePublishPlan({
    channels: [{ accountId: 'a', connected: true }], caption: 'b', now: NOW
  });
  assert.equal(missingAsset.ok, false);
  assert.match(missingAsset.reason, /test asset/i);

  const missingCaption = buildLivePublishPlan({
    channels: [{ accountId: 'a', connected: true }], assetDescription: 'a', now: NOW
  });
  assert.equal(missingCaption.ok, false);
  assert.match(missingCaption.reason, /caption is required/i);
});

test('renders the exact required LIVE PUBLISH APPROVAL REQUIRED gate', () => {
  const plan = twoChannelPlan();
  const rendered = renderLivePublishApprovalGate(plan);

  assert.match(rendered, /^LIVE PUBLISH APPROVAL REQUIRED/);
  assert.match(rendered, /This will create and\/or execute real TikTok publish jobs\./);
  assert.match(rendered, /\* Channels:/);
  assert.match(rendered, /@__chanter/);
  assert.match(rendered, /@_cdwarrior/);
  assert.match(rendered, /\* Asset:/);
  assert.match(rendered, /One small test image, chanter-logo\.png/);
  assert.match(rendered, /\* Caption:/);
  assert.match(rendered, /Live publish test/);
  assert.match(rendered, /\* Tags:/);
  assert.match(rendered, /#chantertest/);
  assert.match(rendered, /\* First scheduled time:/);
  assert.match(rendered, /2026-07-07T09:05:00\.000Z/);
  assert.match(rendered, /\* Offset:/);
  assert.match(rendered, /5 minutes between channels/);
  assert.match(rendered, /\* Expected jobs:/);
  assert.match(rendered, /\n {2}\* 2\n/);
  assert.match(rendered, /Real public posts may appear on selected TikTok accounts\./);
  assert.match(rendered, /Wrong account assignment would be production-impacting\./);
  assert.match(rendered, /TikTok API may accept, reject, or delay publishing\./);
  assert.match(rendered, /Tests pass/);
  assert.match(rendered, /Build passes/);
  assert.match(rendered, /Queue shows correct per-channel ownership/);
  assert.match(rendered, /No secrets visible/);
  assert.match(rendered, /User approves exact test/);
  assert.match(rendered, /Do not proceed unless the user explicitly confirms:/);
  assert.match(rendered, new RegExp(CONFIRMATION_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('the approval gate never renders a token/secret-shaped string', () => {
  const plan = twoChannelPlan();
  const rendered = renderLivePublishApprovalGate(plan);
  assert.doesNotMatch(rendered, /access_token/i);
  assert.doesNotMatch(rendered, /refresh_token/i);
  assert.doesNotMatch(rendered, /client_secret/i);
  assert.doesNotMatch(rendered, /api[_-]?key/i);
});

test('confirmation requires the exact phrase, nothing looser', () => {
  assert.equal(isConfirmed(CONFIRMATION_PHRASE), true);
  assert.equal(isConfirmed(`  ${CONFIRMATION_PHRASE}  `), true, 'surrounding whitespace is trimmed');
  assert.equal(isConfirmed('i approve the controlled live publish test.'), false, 'case must match');
  assert.equal(isConfirmed('I approve the controlled live publish test'), false, 'missing trailing period');
  assert.equal(isConfirmed(''), false);
  assert.equal(isConfirmed(undefined), false);
});
