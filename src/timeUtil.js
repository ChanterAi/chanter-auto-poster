'use strict';

// Shared local-time parsing for anything that accepts a browser
// datetime-local style value plus the browser's timezone offset
// (Date.prototype.getTimezoneOffset()). Used by the per-post release-window
// edit form (routes.js) and the Max Scheduler campaign start date/time
// (maxScheduler.js) so both compute the identical UTC instant from the
// identical local-time contract.

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

/**
 * Combine a `YYYY-MM-DD` date and `HH:MM` time into the `datetime-local`
 * shape `parseDateTimeLocal` expects.
 */
function combineDateAndTime(date, time) {
  const cleanDate = String(date || '').trim();
  const cleanTime = String(time || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanDate) || !/^\d{2}:\d{2}$/.test(cleanTime)) return '';
  return `${cleanDate}T${cleanTime}`;
}

module.exports = { parseDateTimeLocal, combineDateAndTime };
