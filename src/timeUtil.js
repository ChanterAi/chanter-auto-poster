'use strict';

const { DateTime, IANAZone } = require('luxon');

// Shared local-time parsing for anything that accepts a browser
// datetime-local style value plus either an IANA timezone name or the
// browser's numeric timezone offset (Date.prototype.getTimezoneOffset()).
// The named-zone path is required for recurring schedules because a fixed
// offset cannot preserve the same local wall-clock time across DST changes.

/**
 * Convert a `YYYY-MM-DDTHH:MM` local value + timezoneOffsetMinutes into an
 * ISO UTC string. Falls back to plain `Date` parsing when no offset is
 * supplied (keeps existing callers that never sent one working unchanged).
 */
function parseDateTimeLocal(value, timezoneOffsetMinutes) {
  if (!value) return null;
  const fallback = () => { const d = new Date(value); return isNaN(d.getTime()) ? null : d.toISOString(); };
  if (timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === null || timezoneOffsetMinutes === '') return fallback();
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return fallback();
  const [, year, month, day, hour, minute] = match;
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset)) return fallback();
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) + offset * 60000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

function normalizeTimeZoneName(value) {
  const zone = String(value || '').trim();
  if (!zone || zone.length > 100 || !IANAZone.isValidZone(zone)) return '';
  return zone;
}

/**
 * Parse one local wall-clock value in an IANA timezone. This preserves a
 * recurring campaign's local posting time when the UTC offset changes. A
 * nonexistent local time (for example, during a DST spring-forward gap) is
 * rejected instead of being silently shifted by the date library.
 */
function parseDateTimeInZone(value, timezoneName, timezoneOffsetMinutes) {
  const localValue = String(value || '').trim();
  const rawZone = String(timezoneName || '').trim();
  const zone = normalizeTimeZoneName(rawZone);
  if (rawZone && !zone) return null;
  if (!zone) return parseDateTimeLocal(localValue, timezoneOffsetMinutes);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(localValue)) return null;

  const dateTime = DateTime.fromISO(localValue, { zone, setZone: true });
  if (!dateTime.isValid) return null;
  if (dateTime.toFormat("yyyy-MM-dd'T'HH:mm") !== localValue) return null;
  return dateTime.toUTC().toISO({ suppressMilliseconds: false });
}

/**
 * Combine a `YYYY-MM-DD` date and `HH:MM` time into the `datetime-local`
 * shape the parsers expect.
 */
function combineDateAndTime(date, time) {
  const cleanDate = String(date || '').trim();
  const cleanTime = String(time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate) || !/^\d{2}:\d{2}$/.test(cleanTime)) return '';
  return `${cleanDate}T${cleanTime}`;
}

module.exports = {
  parseDateTimeLocal,
  parseDateTimeInZone,
  normalizeTimeZoneName,
  combineDateAndTime
};
