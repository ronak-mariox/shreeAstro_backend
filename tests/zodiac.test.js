/**
 * sunSignFromDate — pure, no DB, no network, no credits. Every boundary date
 * is checked on both sides, since an off-by-one here silently gives a user
 * the wrong sign's horoscope forever.
 */

const { ZODIAC_SIGNS, sunSignFromDate } = require('../utils/zodiac');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** UTC midnight on month/day of a fixed non-leap year, so getUTCMonth/getUTCDate read back exactly what was asked. */
const d = (month, day) => new Date(Date.UTC(2023, month - 1, day));

section('ZODIAC_SIGNS');
check('exactly 12 signs, lowercase, aries first', ZODIAC_SIGNS.length === 12 && ZODIAC_SIGNS[0] === 'aries' && ZODIAC_SIGNS.every(s => s === s.toLowerCase()));

section('sunSignFromDate — every sign, both boundary edges');
const CASES = [
  ['aries', 3, 21], ['aries', 4, 19],
  ['taurus', 4, 20], ['taurus', 5, 20],
  ['gemini', 5, 21], ['gemini', 6, 20],
  ['cancer', 6, 21], ['cancer', 7, 22],
  ['leo', 7, 23], ['leo', 8, 22],
  ['virgo', 8, 23], ['virgo', 9, 22],
  ['libra', 9, 23], ['libra', 10, 22],
  ['scorpio', 10, 23], ['scorpio', 11, 21],
  ['sagittarius', 11, 22], ['sagittarius', 12, 21],
  ['capricorn', 12, 22], ['capricorn', 1, 19],
  ['aquarius', 1, 20], ['aquarius', 2, 18],
  ['pisces', 2, 19], ['pisces', 3, 20],
];
for (const [sign, month, day] of CASES) {
  check(`${month}/${day} -> ${sign}`, sunSignFromDate(d(month, day)) === sign);
}

section('sunSignFromDate — one day past every lower boundary lands on the PREVIOUS sign');
check('Mar 20 is still Pisces, not Aries', sunSignFromDate(d(3, 20)) === 'pisces');
check('Aug 22 is still Leo, not Virgo', sunSignFromDate(d(8, 22)) === 'leo');
check('Jan 19 is still Capricorn, not Aquarius', sunSignFromDate(d(1, 19)) === 'capricorn');

section('sunSignFromDate — input shapes');
check('accepts an ISO string, not just a Date', sunSignFromDate('1995-08-15T00:00:00.000Z') === 'leo');
check('accepts a Date directly', sunSignFromDate(new Date('1999-12-25T00:00:00.000Z')) === 'capricorn');
let threw = null;
try {
  sunSignFromDate('not a date');
} catch (error) {
  threw = error;
}
check('an unparseable date throws rather than silently returning a wrong sign', threw instanceof Error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
