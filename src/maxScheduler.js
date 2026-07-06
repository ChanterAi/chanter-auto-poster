'use strict';

// Max Scheduler: pure, side-effect-free calculation of a multi-channel
// release plan from an explicit campaign start date/time plus a per-channel
// offset. The same function backs both the server-side job-creation path
// (routes.js /upload) and is mirrored by client-side preview math in
// index.ejs, so "what the preview showed" and "what got scheduled" can
// never drift apart.
//
// This module never touches Firestore, never mutates a Loop/post, and never
// picks a default when required inputs are missing — it returns a typed
// failure instead so the caller can show a clear preflight reason.

const { parseDateTimeLocal, combineDateAndTime } = require('./timeUtil');

const DEFAULT_OFFSET_MINUTES = 5;
const MAX_OFFSET_MINUTES = 24 * 60; // one day; guards against fat-fingered input, not a product limit

function normalizeOffsetMinutes(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OFFSET_MINUTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

/**
 * @param {object} options
 * @param {string} options.startDate - `YYYY-MM-DD`
 * @param {string} options.startTime - `HH:MM`
 * @param {number|string} [options.timezoneOffsetMinutes] - `Date.prototype.getTimezoneOffset()` from the submitting browser
 * @param {number|string} [options.offsetMinutes] - minutes between each channel's release time; default 5
 * @param {Array<{accountId:string, tiktokOpenId?:string, username?:string, connected?:boolean}>} options.channels - in publishing order
 * @returns {{ok:true, baseAt:string, offsetMinutes:number, jobCount:number, summary:string, channels:Array}|{ok:false, reason:string, blockedChannels?:Array}}
 */
function computeMaxSchedulePlan({
  startDate,
  startTime,
  timezoneOffsetMinutes,
  offsetMinutes,
  channels
} = {}) {
  const targetChannels = Array.isArray(channels) ? channels.filter((channel) => channel && channel.accountId) : [];
  if (targetChannels.length === 0) {
    return { ok: false, reason: 'Select at least one publishing channel to build a schedule plan.' };
  }

  const disconnected = targetChannels.filter((channel) => channel.connected === false);
  if (disconnected.length > 0) {
    return {
      ok: false,
      reason: `${disconnected.length === 1 ? 'A selected channel is' : 'Selected channels are'} disconnected and cannot be scheduled: ${disconnected.map((channel) => channel.username ? `@${channel.username}` : channel.accountId).join(', ')}.`,
      blockedChannels: disconnected.map((channel) => channel.accountId)
    };
  }

  const combined = combineDateAndTime(startDate, startTime);
  if (!combined) {
    return { ok: false, reason: 'Set a campaign start date and start time.' };
  }

  const baseAt = parseDateTimeLocal(combined, timezoneOffsetMinutes);
  if (!baseAt) {
    return { ok: false, reason: 'The campaign start date/time could not be parsed.' };
  }

  const resolvedOffset = normalizeOffsetMinutes(offsetMinutes);
  if (resolvedOffset === null || resolvedOffset < 0 || resolvedOffset > MAX_OFFSET_MINUTES) {
    return { ok: false, reason: `Offset must be a number of minutes between 0 and ${MAX_OFFSET_MINUTES}.` };
  }

  const baseMillis = new Date(baseAt).getTime();
  const planChannels = targetChannels.map((channel, index) => {
    const channelOffsetMinutes = index * resolvedOffset;
    return {
      accountId: channel.accountId,
      tiktokOpenId: channel.tiktokOpenId || channel.accountId,
      username: channel.username || '',
      connected: channel.connected !== false,
      order: index,
      offsetMinutes: channelOffsetMinutes,
      scheduledAt: new Date(baseMillis + channelOffsetMinutes * 60000).toISOString(),
      ready: true,
      blockedReason: ''
    };
  });

  const jobCount = planChannels.length;
  return {
    ok: true,
    baseAt,
    offsetMinutes: resolvedOffset,
    jobCount,
    summary: `This campaign will create ${jobCount} release ${jobCount === 1 ? 'job' : 'jobs'} across ${jobCount} selected ${jobCount === 1 ? 'channel' : 'channels'}.`,
    channels: planChannels
  };
}

module.exports = { computeMaxSchedulePlan, DEFAULT_OFFSET_MINUTES, MAX_OFFSET_MINUTES };
