/**
 * normalizeHoroscope, proven against the REAL captured responses in
 * tests/fixtures/astrologyapi/ — pure, no DB, no network, no credits.
 */

const { normalizeHoroscope } = require('../services/horoscopeNormalize');

const daily = require('./fixtures/astrologyapi/sun_sign_daily.json');
const dailyNext = require('./fixtures/astrologyapi/sun_sign_daily_next.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const derived = { luckyNumber: 7, luckyColor: 'Gold', energy: 'High' };

section('normalizeHoroscope — real sun_sign_daily.json');
const result = normalizeHoroscope(daily, derived, 'leo', '2026-09-07');
check('sign/date come from the caller\'s own inputs, not the provider\'s echoed fields', result.sign === 'leo' && result.date === '2026-09-07');
check('summary is the luck section', result.summary === daily.prediction.luck && result.summary.length > 0);
check('all 6 sections are present, verbatim', ['personal_life', 'profession', 'health', 'emotions', 'travel', 'luck'].every(key => result.sections[key] === daily.prediction[key]));
check('derived values pass through untouched', result.lucky_number === 7 && result.lucky_color === 'Gold' && result.energy === 'High');
check('the provider\'s own status/sun_sign/prediction_date fields never leak through', !('status' in result) && !('sun_sign' in result) && !('prediction_date' in result) && !('prediction' in result));

section('normalizeHoroscope — real sun_sign_daily_next.json, a different target date');
const nextResult = normalizeHoroscope(dailyNext, derived, 'leo', '2026-09-08');
check('date reflects the caller\'s target date, not "today"', nextResult.date === '2026-09-08');
check('content differs from the daily fixture (a real, distinct reading)', nextResult.summary !== result.summary);

section('normalizeHoroscope — missing/malformed input never throws');
const empty = normalizeHoroscope({}, derived, 'leo', '2026-09-07');
check('every section falls back to an empty string', Object.values(empty.sections).every(v => v === ''));
check('summary falls back to an empty string', empty.summary === '');
const withoutDerived = normalizeHoroscope(daily, undefined, 'leo', '2026-09-07');
check('missing derived values come through as undefined, not a crash', withoutDerived.lucky_number === undefined && withoutDerived.lucky_color === undefined && withoutDerived.energy === undefined);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
