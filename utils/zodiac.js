/**
 * Sun sign from a date of birth — computed locally, never from a provider
 * call. This is what lets a user who hasn't generated a kundli (no
 * BirthProfile, no lat/lon, no provider call at all) still get a daily
 * horoscope: a sun sign only ever needs the calendar month and day.
 *
 * Lowercase throughout, matching AstrologyAPI's own `zodiacName` path
 * segment (e.g. "leo") and this feature's own GET /horoscope/daily?sign=leo —
 * not the Title Case `ZODIAC_SIGNS` in models/constants.js, which is a
 * separate, display-oriented list used by the kundli side of the app.
 */

const ZODIAC_SIGNS = [
  'aries',
  'taurus',
  'gemini',
  'cancer',
  'leo',
  'virgo',
  'libra',
  'scorpio',
  'sagittarius',
  'capricorn',
  'aquarius',
  'pisces',
];

/** Standard tropical sun-sign date ranges. */
function sunSignFromMonthDay(month, day) {
  if ((month === 3 && day >= 21) || (month === 4 && day <= 19)) return 'aries';
  if ((month === 4 && day >= 20) || (month === 5 && day <= 20)) return 'taurus';
  if ((month === 5 && day >= 21) || (month === 6 && day <= 20)) return 'gemini';
  if ((month === 6 && day >= 21) || (month === 7 && day <= 22)) return 'cancer';
  if ((month === 7 && day >= 23) || (month === 8 && day <= 22)) return 'leo';
  if ((month === 8 && day >= 23) || (month === 9 && day <= 22)) return 'virgo';
  if ((month === 9 && day >= 23) || (month === 10 && day <= 22)) return 'libra';
  if ((month === 10 && day >= 23) || (month === 11 && day <= 21)) return 'scorpio';
  if ((month === 11 && day >= 22) || (month === 12 && day <= 21)) return 'sagittarius';
  if ((month === 12 && day >= 22) || (month === 1 && day <= 19)) return 'capricorn';
  if ((month === 1 && day >= 20) || (month === 2 && day <= 18)) return 'aquarius';
  return 'pisces'; // Feb 19 - Mar 20
}

/**
 * @param {Date|string} dateOfBirth A Date, or anything `new Date()` parses
 *   (an ISO string, e.g. what BirthProfile.birthDetails.dateOfBirth already
 *   is). Read with UTC getters, matching astrologyApi.client.js's own
 *   dateParts() — the time-of-day on this value is arbitrary/unused, so
 *   reading it in the server's local zone could shift the calendar day.
 */
function sunSignFromDate(dateOfBirth) {
  const date = dateOfBirth instanceof Date ? dateOfBirth : new Date(dateOfBirth);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`sunSignFromDate: "${dateOfBirth}" is not a valid date.`);
  }
  return sunSignFromMonthDay(date.getUTCMonth() + 1, date.getUTCDate());
}

module.exports = { ZODIAC_SIGNS, sunSignFromDate };
