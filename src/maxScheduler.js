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

/**
 * Build a per-item staggered release plan on ONE publishing channel: item i
 * releases at baseAt + i * staggerMinutes. Used by the Platform batch intake
 * so a large upload never fires every item at the same instant. Pure and
 * side-effect-free like the other planners; the server is authoritative.
 */
function computeBatchStaggerPlan(options = {}) {
  const channelResult = normalizeChannels(options.channels);
  if (!channelResult.ok) return channelResult;
  if (channelResult.channels.length !== 1) {
    return { ok: false, reason: 'A staggered batch targets exactly one publishing channel.' };
  }

  const combined = combineDateAndTime(options.startDate, options.startTime);
  if (!combined) {
    return { ok: false, reason: 'Set a batch start date and start time.' };
  }
  const baseAt = parseDateTimeInZone(combined, options.timezoneName, options.timezoneOffsetMinutes);
  if (!baseAt) {
    return { ok: false, reason: 'The batch start date/time could not be parsed.' };
  }

  const sourceCount = normalizeSourceCount(options.sourceCount);
  if (sourceCount === null) {
    return { ok: false, reason: `A batch can contain between 1 and ${MAX_SOURCE_COUNT} videos.` };
  }

  const staggerMinutes = options.staggerMinutes === undefined || options.staggerMinutes === null || options.staggerMinutes === ''
    ? DEFAULT_BATCH_STAGGER_MINUTES
    : Number(options.staggerMinutes);
  if (
    !Number.isFinite(staggerMinutes)
    || staggerMinutes < 1
    || staggerMinutes > MAX_OFFSET_MINUTES
  ) {
    return { ok: false, reason: `The stagger interval must be between 1 and ${MAX_OFFSET_MINUTES} minutes.` };
  }

  const channel = channelResult.channels[0];
  const baseMillis = new Date(baseAt).getTime();
  const slots = [];
  for (let index = 0; index < sourceCount; index += 1) {
    slots.push({
      index,
      offsetMinutes: index * staggerMinutes,
      scheduledAt: new Date(baseMillis + index * staggerMinutes * 60000).toISOString()
    });
  }

  return {
    ok: true,
    baseAt,
    timezone: normalizeTimeZoneName(options.timezoneName),
    staggerMinutes,
    sourceCount,
    jobCount: sourceCount,
    accountId: channel.accountId,
    slots,
    summary: `This batch will schedule ${sourceCount} ${sourceCount === 1 ? 'video' : 'videos'} ${staggerMinutes} minutes apart on one channel.`
  };
}

const DEFAULT_BATCH_STAGGER_MINUTES = 30;
const MAX_POSTS_PER_DAY = 20;

function parseDailyTimeToMinutes(value) {
  const match = String(value || '').trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function minutesToHHMM(totalMinutes) {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Build a per-source-video release plan, independent of destination/channel
 * count. Multi-account fan-out (batchService) applies the SAME slot to every
 * destination copy of a source video by default — no artificial per-account
 * delay. Three modes:
 *  - 'interval': base date/time + fixed minutes between consecutive sources.
 *    Unbounded capacity; a channel-count-agnostic generalization of the
 *    existing computeBatchStaggerPlan math (kept separately, unchanged, for
 *    backward compatibility with its single-channel callers/tests).
 *  - 'dateRange': first day..last day, N posts per day, starting at a daily
 *    time (evenly spread across an optional daily end-time window, else
 *    spaced by intraDayIntervalMinutes).
 *  - 'dailySlots': first day..last day, explicit HH:MM slots per day
 *    (deduped + sorted for deterministic replay).
 * 'dateRange'/'dailySlots' are capacity-bounded (days x slots-per-day) and
 * fail closed with the exact required/available counts before any queue
 * item is created.
 */
function computeBatchSchedulePlan(options = {}) {
  const mode = String(options.mode || 'interval').trim();
  const sourceCount = normalizeSourceCount(options.sourceCount);
  if (sourceCount === null) {
    return { ok: false, reason: `A batch can contain between 1 and ${MAX_SOURCE_COUNT} videos.` };
  }
  const timezone = normalizeTimeZoneName(options.timezoneName);

  if (mode === 'interval') {
    const combined = combineDateAndTime(options.startDate, options.startTime);
    if (!combined) return { ok: false, reason: 'Set a batch start date and start time.' };
    const baseAt = parseDateTimeInZone(combined, options.timezoneName, options.timezoneOffsetMinutes);
    if (!baseAt) return { ok: false, reason: 'The batch start date/time could not be parsed.' };

    const staggerMinutes = options.staggerMinutes === undefined || options.staggerMinutes === null || options.staggerMinutes === ''
      ? DEFAULT_BATCH_STAGGER_MINUTES
      : Number(options.staggerMinutes);
    if (!Number.isFinite(staggerMinutes) || staggerMinutes < 1 || staggerMinutes > MAX_OFFSET_MINUTES) {
      return { ok: false, reason: `The stagger interval must be between 1 and ${MAX_OFFSET_MINUTES} minutes.` };
    }

    const baseMillis = new Date(baseAt).getTime();
    const slots = [];
    for (let index = 0; index < sourceCount; index += 1) {
      slots.push({ index, scheduledAt: new Date(baseMillis + index * staggerMinutes * 60000).toISOString() });
    }
    return {
      ok: true,
      mode,
      baseAt,
      timezone,
      staggerMinutes,
      sourceCount,
      jobCount: sourceCount,
      slots,
      requiredSlots: sourceCount,
      availableSlots: null,
      summary: `This batch will schedule ${sourceCount} ${sourceCount === 1 ? 'video' : 'videos'} ${staggerMinutes} minutes apart.`
    };
  }

  if (mode === 'dateRange' || mode === 'dailySlots') {
    const start = parseDateOnly(options.firstDay);
    const end = parseDateOnly(options.lastDay);
    if (!start) return { ok: false, reason: 'Set a valid first day.' };
    if (!end) return { ok: false, reason: 'Set a valid last day.' };
    if (end.ms < start.ms) return { ok: false, reason: 'The last day must be on or after the first day.' };
    const daysInRange = Math.floor((end.ms - start.ms) / 86400000) + 1;
    if (daysInRange > MAX_DAILY_OCCURRENCES) {
      return { ok: false, reason: `A batch date range can span at most ${MAX_DAILY_OCCURRENCES} days.` };
    }

    // Minute-of-day offsets, sorted ascending, applied identically each day.
    let dayMinutes;
    if (mode === 'dailySlots') {
      const rawSlots = Array.isArray(options.dailySlots) ? options.dailySlots : [];
      const parsed = rawSlots.map(parseDailyTimeToMinutes);
      if (rawSlots.length === 0 || parsed.some((value) => value === null)) {
        return { ok: false, reason: 'Enter one or more valid daily times (HH:MM).' };
      }
      dayMinutes = [...new Set(parsed)].sort((a, b) => a - b);
    } else {
      const postsPerDay = Number(options.postsPerDay);
      if (!Number.isInteger(postsPerDay) || postsPerDay < 1 || postsPerDay > MAX_POSTS_PER_DAY) {
        return { ok: false, reason: `Posts per day must be an integer between 1 and ${MAX_POSTS_PER_DAY}.` };
      }
      const startMinutes = parseDailyTimeToMinutes(options.dailyStartTime);
      if (startMinutes === null) return { ok: false, reason: 'Set a valid daily start time (HH:MM).' };
      const endMinutes = options.dailyEndTime ? parseDailyTimeToMinutes(options.dailyEndTime) : null;
      if (options.dailyEndTime && endMinutes === null) {
        return { ok: false, reason: 'The daily end time could not be parsed.' };
      }
      dayMinutes = [];
      if (endMinutes !== null && postsPerDay > 1) {
        if (endMinutes < startMinutes) {
          return { ok: false, reason: 'The daily end time must be on or after the daily start time.' };
        }
        const span = endMinutes - startMinutes;
        for (let k = 0; k < postsPerDay; k += 1) {
          dayMinutes.push(startMinutes + Math.round((span * k) / (postsPerDay - 1)));
        }
      } else {
        const intraDayIntervalMinutes = Number.isFinite(Number(options.intraDayIntervalMinutes)) && Number(options.intraDayIntervalMinutes) > 0
          ? Number(options.intraDayIntervalMinutes)
          : 60;
        for (let k = 0; k < postsPerDay; k += 1) {
          dayMinutes.push(startMinutes + k * intraDayIntervalMinutes);
        }
      }
    }

    const slotsPerDay = dayMinutes.length;
    const availableSlots = daysInRange * slotsPerDay;
    if (sourceCount > availableSlots) {
      return {
        ok: false,
        reason: `Not enough schedule capacity: ${sourceCount} videos need ${sourceCount} slots, but only ${availableSlots} are available (${daysInRange} day${daysInRange === 1 ? '' : 's'} x ${slotsPerDay} per day).`,
        requiredSlots: sourceCount,
        availableSlots
      };
    }

    const slots = [];
    for (let index = 0; index < sourceCount; index += 1) {
      const dayIndex = Math.floor(index / slotsPerDay);
      const slotIndex = index % slotsPerDay;
      const dateOnly = formatDateOnly(start.ms + dayIndex * 86400000);
      const timeOnly = minutesToHHMM(dayMinutes[slotIndex]);
      const combined = combineDateAndTime(dateOnly, timeOnly);
      const scheduledAt = parseDateTimeInZone(combined, options.timezoneName, options.timezoneOffsetMinutes);
      if (!scheduledAt) {
        return { ok: false, reason: `The local time ${dateOnly} ${timeOnly} could not be resolved (invalid or ambiguous local time).` };
      }
      slots.push({ index, scheduledAt });
    }

    return {
      ok: true,
      mode,
      baseAt: slots[0].scheduledAt,
      timezone,
      sourceCount,
      jobCount: sourceCount,
      slots,
      requiredSlots: sourceCount,
      availableSlots,
      daysInRange,
      slotsPerDay,
      summary: `This batch will schedule ${sourceCount} ${sourceCount === 1 ? 'video' : 'videos'} across ${daysInRange} day${daysInRange === 1 ? '' : 's'} (${slotsPerDay} per day).`
    };
  }

  return { ok: false, reason: `Unsupported batch scheduling mode: ${mode}.` };
}

module.exports = {
  computeMaxSchedulePlan,
  computeDailySchedulePlan,
  computeBatchStaggerPlan,
  computeBatchSchedulePlan,
  DEFAULT_BATCH_STAGGER_MINUTES,
  DEFAULT_OFFSET_MINUTES,
  MAX_OFFSET_MINUTES,
  MAX_DAILY_OCCURRENCES,
  MAX_RECURRING_JOBS,
  MAX_SOURCE_COUNT,
  MAX_POSTS_PER_DAY
};
