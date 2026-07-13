'use strict';

// Max Scheduler: pure, side-effect-free calculation of one-time and daily
// multi-channel release plans. The server is authoritative; index.ejs mirrors
// this math only for preview.

const { parseDateTimeInZone, normalizeTimeZoneName, combineDateAndTime } = require('./timeUtil');

const DEFAULT_OFFSET_MINUTES = 5;
const MAX_OFFSET_MINUTES = 24 * 60;
const MAX_DAILY_OCCURRENCES = 365;
const MAX_RECURRING_JOBS = 200;
const MAX_SOURCE_COUNT = 100;

function normalizeOffsetMinutes(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OFFSET_MINUTES;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function normalizeChannels(channels) {
  const targetChannels = Array.isArray(channels)
    ? channels.filter((channel) => channel && channel.accountId)
    : [];
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

  return { ok: true, channels: targetChannels };
}

function normalizeSourceCount(value) {
  if (value === undefined || value === null || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SOURCE_COUNT) return null;
  return parsed;
}

function normalizeBase({ startDate, startTime, timezoneName, timezoneOffsetMinutes, offsetMinutes, sourceCount, channels }) {
  const channelResult = normalizeChannels(channels);
  if (!channelResult.ok) return channelResult;

  const combined = combineDateAndTime(startDate, startTime);
  if (!combined) {
    return { ok: false, reason: 'Set a campaign start date and start time.' };
  }

  const baseAt = parseDateTimeInZone(combined, timezoneName, timezoneOffsetMinutes);
  if (!baseAt) {
    return { ok: false, reason: 'The campaign start date/time could not be parsed.' };
  }

  const resolvedOffset = normalizeOffsetMinutes(offsetMinutes);
  const resolvedSourceCount = normalizeSourceCount(sourceCount);
  if (resolvedOffset === null || resolvedOffset < 0 || resolvedOffset > MAX_OFFSET_MINUTES) {
    return { ok: false, reason: `Offset must be a number of minutes between 0 and ${MAX_OFFSET_MINUTES}.` };
  }
  if (resolvedSourceCount === null) {
    return { ok: false, reason: `A campaign can contain between 1 and ${MAX_SOURCE_COUNT} video sources.` };
  }

  return {
    ok: true,
    channels: channelResult.channels,
    baseAt,
    timezone: normalizeTimeZoneName(timezoneName),
    offsetMinutes: resolvedOffset,
    sourceCount: resolvedSourceCount
  };
}

function buildChannelPlan(channels, baseAt, offsetMinutes, occurrenceIndex = 0, occurrenceDate = '') {
  const baseMillis = new Date(baseAt).getTime();
  return channels.map((channel, index) => {
    const channelOffsetMinutes = index * offsetMinutes;
    return {
      accountId: channel.accountId,
      tiktokOpenId: channel.tiktokOpenId || channel.accountId,
      username: channel.username || '',
      connected: channel.connected !== false,
      order: index,
      offsetMinutes: channelOffsetMinutes,
      occurrenceIndex,
      occurrenceDate,
      scheduledAt: new Date(baseMillis + channelOffsetMinutes * 60000).toISOString(),
      ready: true,
      blockedReason: ''
    };
  });
}

function parseDateOnly(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return { year, month, day, ms };
}

function formatDateOnly(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Build a one-time multi-channel release plan. */
function computeMaxSchedulePlan(options = {}) {
  const normalized = normalizeBase(options);
  if (!normalized.ok) return normalized;

  const planChannels = buildChannelPlan(
    normalized.channels,
    normalized.baseAt,
    normalized.offsetMinutes
  );
  const channelCount = planChannels.length;
  const jobCount = channelCount * normalized.sourceCount;
  return {
    ok: true,
    baseAt: normalized.baseAt,
    timezone: normalized.timezone,
    offsetMinutes: normalized.offsetMinutes,
    sourceCount: normalized.sourceCount,
    jobCount,
    summary: normalized.sourceCount === 1
      ? `This campaign will create ${jobCount} release ${jobCount === 1 ? 'job' : 'jobs'} across ${channelCount} selected ${channelCount === 1 ? 'channel' : 'channels'}.`
      : `This campaign will create ${jobCount} release jobs: ${normalized.sourceCount} videos × ${channelCount} channels.`,
    channels: planChannels
  };
}

/**
 * Build an inclusive daily series. Each day keeps the same local wall-clock
 * input and channel offset contract. The returned jobs are flattened so the
 * storage layer can create every queue item atomically with usage metering.
 */
function computeDailySchedulePlan(options = {}) {
  const normalized = normalizeBase(options);
  if (!normalized.ok) return normalized;

  const start = parseDateOnly(options.startDate);
  const end = parseDateOnly(options.endDate);
  if (!end) return { ok: false, reason: 'Set a valid campaign end date.' };
  if (!start) return { ok: false, reason: 'Set a valid campaign start date.' };
  if (end.ms < start.ms) {
    return { ok: false, reason: 'The campaign end date must be on or after the start date.' };
  }

  const occurrenceCount = Math.floor((end.ms - start.ms) / 86400000) + 1;
  if (occurrenceCount > MAX_DAILY_OCCURRENCES) {
    return {
      ok: false,
      reason: `A daily campaign can contain at most ${MAX_DAILY_OCCURRENCES} days.`
    };
  }

  const projectedJobCount = occurrenceCount * normalized.channels.length * normalized.sourceCount;
  if (projectedJobCount > MAX_RECURRING_JOBS) {
    return {
      ok: false,
      reason: `A recurring campaign can create at most ${MAX_RECURRING_JOBS} release jobs.`
    };
  }

  const occurrences = [];
  const jobs = [];
  for (let occurrenceIndex = 0; occurrenceIndex < occurrenceCount; occurrenceIndex += 1) {
    const occurrenceDate = formatDateOnly(start.ms + occurrenceIndex * 86400000);
    const combined = combineDateAndTime(occurrenceDate, options.startTime);
    const baseAt = parseDateTimeInZone(combined, options.timezoneName, options.timezoneOffsetMinutes);
    if (!baseAt) {
      return { ok: false, reason: `The posting time could not be parsed for ${occurrenceDate}.` };
    }
    const channels = buildChannelPlan(
      normalized.channels,
      baseAt,
      normalized.offsetMinutes,
      occurrenceIndex,
      occurrenceDate
    );
    occurrences.push({ occurrenceIndex, occurrenceDate, baseAt, channels });
    jobs.push(...channels);
  }

  const jobCount = projectedJobCount;
  const channelCount = normalized.channels.length;
  const sourceCount = normalized.sourceCount;
  return {
    ok: true,
    baseAt: occurrences[0].baseAt,
    endAt: occurrences[occurrences.length - 1].baseAt,
    timezone: normalized.timezone,
    offsetMinutes: normalized.offsetMinutes,
    sourceCount,
    occurrenceCount,
    jobCount,
    summary: sourceCount === 1
      ? `This daily campaign will create ${jobCount} release ${jobCount === 1 ? 'job' : 'jobs'}: ${occurrenceCount} ${occurrenceCount === 1 ? 'day' : 'days'} × ${channelCount} ${channelCount === 1 ? 'channel' : 'channels'}.`
      : `This daily campaign will create ${jobCount} release jobs: ${sourceCount} videos × ${occurrenceCount} days × ${channelCount} channels.`,
    channels: occurrences[0].channels,
    occurrences,
    jobs,
    series: {
      frequency: 'daily',
      startDate: String(options.startDate),
      endDate: String(options.endDate),
      occurrenceCount,
      sourceCount,
      timezone: normalized.timezone
    }
  };
}

module.exports = {
  computeMaxSchedulePlan,
  computeDailySchedulePlan,
  DEFAULT_OFFSET_MINUTES,
  MAX_OFFSET_MINUTES,
  MAX_DAILY_OCCURRENCES,
  MAX_RECURRING_JOBS,
  MAX_SOURCE_COUNT
};
