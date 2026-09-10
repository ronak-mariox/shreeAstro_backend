/**
 * Calendar-date helpers for a feature that is inherently IST-scoped (the
 * horoscope prefetch cron fires at a fixed IST wall-clock time, and "today"
 * for a sign's reading means the IST calendar day, not the server's).
 */

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** "YYYY-MM-DD" for the IST calendar date a given instant falls on. */
function istDateString(instant = new Date()) {
  return new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * `offsetDays` away from a "YYYY-MM-DD" calendar date. Plain date-only
 * arithmetic — once a value is already a bare calendar date (not an instant),
 * shifting it by whole days needs no further timezone conversion.
 */
function dateOffset(dateString, offsetDays) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  return new Date(base.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The instant IST midnight begins for a "YYYY-MM-DD" IST calendar date — the
 * boundary for "today"/"this month" queries that must mean the astrologer's
 * own calendar day, not whatever timezone the server process happens to run
 * in (e.g. UTC on most cloud hosts, which would put the cutover at 5:30am IST).
 */
function startOfIstDay(dateString) {
  return new Date(`${dateString}T00:00:00.000+05:30`);
}

module.exports = { istDateString, dateOffset, startOfIstDay };
