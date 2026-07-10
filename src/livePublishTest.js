'use strict';

// Controlled Live Publish Test readiness.
//
// This module never calls TikTok, never touches Firestore, and never
// schedules anything on its own. It only (a) builds a small, explicit test
// plan from operator-supplied inputs and (b) renders the mandatory
// "LIVE PUBLISH APPROVAL REQUIRED" gate. The CLI wrapper
// (scripts/live-publish-test.js) is the only thing that may ever act on a
// plan, and only after the operator supplies the exact confirmation phrase.

const CONFIRMATION_PHRASE = 'I approve the controlled live publish test.';
const DEFAULT_BUFFER_MINUTES = 5;
const DEFAULT_OFFSET_MINUTES = 5;

function isConfirmed(value) {
  return String(value || '').trim() === CONFIRMATION_PHRASE;
}

/**
 * @param {object} options
 * @param {Array<{accountId:string, username?:string, connected?:boolean}>} options.channels - exactly the connected accounts under test
 * @param {string} options.assetDescription - e.g. "one small test video, chanter-smoke.mp4"
 * @param {string} options.caption
 * @param {string} options.tags
 * @param {number} [options.bufferMinutes] - minutes from now until the first scheduled release; default 5
 * @param {number} [options.offsetMinutes] - minutes between each channel's release; default 5
 * @param {Date} [options.now]
 */
function buildLivePublishPlan({
  channels,
  assetDescription,
  caption,
  tags,
  bufferMinutes,
  offsetMinutes,
  now
} = {}) {
  const targetChannels = Array.isArray(channels) ? channels.filter((channel) => channel && channel.accountId) : [];
  if (targetChannels.length === 0) {
    return { ok: false, reason: 'At least one connected TikTok account is required for a live publish test.' };
  }
  const disconnected = targetChannels.filter((channel) => channel.connected === false);
  if (disconnected.length > 0) {
    return {
      ok: false,
      reason: `Every test channel must already be connected. Not connected: ${disconnected.map((channel) => channel.username ? `@${channel.username}` : channel.accountId).join(', ')}.`
    };
  }
  if (!String(assetDescription || '').trim()) {
    return { ok: false, reason: 'Describe the exact test asset before building a live publish plan.' };
  }
  if (!String(caption || '').trim()) {
    return { ok: false, reason: 'A caption is required before building a live publish plan.' };
  }

  const resolvedBuffer = Number.isFinite(Number(bufferMinutes)) && Number(bufferMinutes) >= 0
    ? Number(bufferMinutes)
    : DEFAULT_BUFFER_MINUTES;
  const resolvedOffset = Number.isFinite(Number(offsetMinutes)) && Number(offsetMinutes) >= 0
    ? Number(offsetMinutes)
    : DEFAULT_OFFSET_MINUTES;
  const nowAt = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const firstScheduledAt = new Date(nowAt.getTime() + resolvedBuffer * 60000);

  const planChannels = targetChannels.map((channel, index) => ({
    accountId: channel.accountId,
    username: channel.username || '',
    order: index,
    offsetMinutes: index * resolvedOffset,
    scheduledAt: new Date(firstScheduledAt.getTime() + index * resolvedOffset * 60000).toISOString()
  }));

  return {
    ok: true,
    channels: planChannels,
    assetDescription: String(assetDescription).trim(),
    caption: String(caption).trim(),
    tags: String(tags || '').trim(),
    bufferMinutes: resolvedBuffer,
    offsetMinutes: resolvedOffset,
    firstScheduledAt: firstScheduledAt.toISOString(),
    expectedJobCount: planChannels.length
  };
}

/**
 * Render the mandatory approval gate. Only ever built from a successfully
 * validated plan — never from raw, unvalidated operator input — so nothing
 * here can print a token, secret, or credential: the plan shape has none.
 */
function renderLivePublishApprovalGate(plan) {
  const channelLines = plan.channels
    .map((channel) => `  * ${channel.username ? `@${channel.username}` : channel.accountId} — ${channel.scheduledAt} (offset +${channel.offsetMinutes}m)`)
    .join('\n');

  return [
    'LIVE PUBLISH APPROVAL REQUIRED',
    '',
    'This will create and/or execute real TikTok publish jobs.',
    '',
    'Planned test:',
    '',
    '* Channels:',
    channelLines,
    '* Asset:',
    `  * ${plan.assetDescription}`,
    '* Caption:',
    `  * ${plan.caption}`,
    '* Tags:',
    `  * ${plan.tags || '(none)'}`,
    '* First scheduled time:',
    `  * ${plan.firstScheduledAt} (UTC)`,
    '* Offset:',
    `  * ${plan.offsetMinutes} minutes between channels`,
    '* Expected jobs:',
    `  * ${plan.expectedJobCount}`,
    '',
    'Risks:',
    '',
    '* Real public posts may appear on selected TikTok accounts.',
    '* Wrong account assignment would be production-impacting.',
    '* TikTok API may accept, reject, or delay publishing.',
    '',
    'Validation before live publish:',
    '',
    '* Tests pass',
    '* Build passes',
    '* Queue shows correct per-channel ownership',
    '* No secrets visible',
    '* User approves exact test',
    '',
    'Do not proceed unless the user explicitly confirms:',
    `"${CONFIRMATION_PHRASE}"`
  ].join('\n');
}

module.exports = {
  CONFIRMATION_PHRASE,
  DEFAULT_BUFFER_MINUTES,
  DEFAULT_OFFSET_MINUTES,
  isConfirmed,
  buildLivePublishPlan,
  renderLivePublishApprovalGate
};
