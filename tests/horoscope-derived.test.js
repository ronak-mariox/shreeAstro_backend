/**
 * deriveHoroscopeExtras — pure, no DB, no network, no credits. The one
 * property that matters most: the SAME (sign, date) always gives the SAME
 * lucky number/colour/energy — a user reopening the app must never see it
 * change mid-day.
 */

const { ZODIAC_SIGNS } = require('../utils/zodiac');
const {
  RULING_PLANET,
  PLANET_LUCKY,
  ENERGY_LEVELS,
  seedFor,
  deriveHoroscopeExtras,
} = require('../utils/horoscopeDerived');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

section('every zodiac sign has a ruling planet, and every ruling planet has a classical number/colours');
check('all 12 signs are covered', ZODIAC_SIGNS.every(sign => RULING_PLANET[sign] !== undefined));
check('every ruling planet used has an entry in PLANET_LUCKY', Object.values(RULING_PLANET).every(planet => PLANET_LUCKY[planet] !== undefined));

section('determinism — the same sign+date always derives the same values');
const first = deriveHoroscopeExtras('leo', '2026-09-07');
const again = deriveHoroscopeExtras('leo', '2026-09-07');
check('identical input gives an identical result, called twice', JSON.stringify(first) === JSON.stringify(again));
check('...and a third time, freshly required', JSON.stringify(deriveHoroscopeExtras('leo', '2026-09-07')) === JSON.stringify(first));

section('the same sign varies across dates — including the lucky number, not just colour/energy');
const day1 = deriveHoroscopeExtras('leo', '2026-09-07');
const day2 = deriveHoroscopeExtras('leo', '2026-09-08');
check('different dates can pick a different colour or energy for the same sign', day1.luckyColor !== day2.luckyColor || day1.energy !== day2.energy);
const leoNumbersAcrossAYear = Array.from({ length: 30 }, (_, i) => deriveHoroscopeExtras('leo', `2026-01-${String(i + 1).padStart(2, '0')}`).luckyNumber);
check('lucky number is not pinned to one constant value across many different dates', new Set(leoNumbersAcrossAYear).size > 1);

section('lucky number wraps around the sign\'s ruling planet\'s classical number, not a totally unrelated one');
check('Leo\'s own anchor (Sun -> 1) still turns up somewhere across a month of dates', leoNumbersAcrossAYear.includes(1));
check('every sign\'s lucky number always stays in the 1-9 wheel', ZODIAC_SIGNS.every(sign => {
  const n = deriveHoroscopeExtras(sign, '2026-09-07').luckyNumber;
  return Number.isInteger(n) && n >= 1 && n <= 9;
}));

section('every derived value is drawn from its own allowed set, for every sign');
for (const sign of ZODIAC_SIGNS) {
  const { colors } = PLANET_LUCKY[RULING_PLANET[sign]];
  const derived = deriveHoroscopeExtras(sign, '2026-09-07');
  check(`${sign}: lucky number is within 1-9`, derived.luckyNumber >= 1 && derived.luckyNumber <= 9);
  check(`${sign}: lucky colour is one of [${colors}]`, colors.includes(derived.luckyColor));
  check(`${sign}: energy is one of [${ENERGY_LEVELS}]`, ENERGY_LEVELS.includes(derived.energy));
}

section('seedFor');
check('is a non-negative integer', Number.isInteger(seedFor('leo', '2026-09-07')) && seedFor('leo', '2026-09-07') >= 0);
check('two different signs on the same date get different seeds (in general)', seedFor('leo', '2026-09-07') !== seedFor('aries', '2026-09-07'));

section('unknown sign refuses rather than silently returning garbage');
let threw = null;
try {
  deriveHoroscopeExtras('not-a-sign', '2026-09-07');
} catch (error) {
  threw = error;
}
check('throws', threw instanceof Error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
