/**
 * kundliNormalize's parsing, proven against the REAL captured responses in
 * tests/fixtures/astrologyapi/ — pure functions, no DB, no network, no
 * credits. This is the file every field-name assumption should be verified
 * in before it's trusted anywhere else.
 */

const {
  titleCasePlanet,
  dignityOf,
  normalizeAstroDetails,
  normalizePlanets,
  parseVdashaDate,
  normalizeDashaPeriods,
  findCurrentLord,
  normalizeKalsarpa,
  normalizeSadhesati,
  normalizePitraDosha,
} = require('../services/kundliNormalize');

const astroDetails = require('./fixtures/astrologyapi/astro_details.json');
const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');
const majorVdasha = require('./fixtures/astrologyapi/major_vdasha.json');
const subVdasha = require('./fixtures/astrologyapi/sub_vdasha.json');
const kalsarpa = require('./fixtures/astrologyapi/kalsarpa_details.json');
const sadhesati = require('./fixtures/astrologyapi/sadhesati_current_status.json');
const pitraDosha = require('./fixtures/astrologyapi/pitra_dosha_report.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

section('titleCasePlanet / dignityOf');
check('"SUN" -> "Sun"', titleCasePlanet('SUN') === 'Sun');
check('"RAHU" -> "Rahu"', titleCasePlanet('RAHU') === 'Rahu');
check('Sun in Leo is Own Sign', dignityOf('Sun', 'Leo') === 'Own Sign');
check('Sun in Aries is Exalted', dignityOf('Sun', 'Aries') === 'Exalted');
check('Sun in Libra is Debilitated', dignityOf('Sun', 'Libra') === 'Debilitated');
check('Sun in Gemini is Neutral', dignityOf('Sun', 'Gemini') === 'Neutral');
check('Mars has two own signs (Aries and Scorpio)', dignityOf('Mars', 'Aries') === 'Own Sign' && dignityOf('Mars', 'Scorpio') === 'Own Sign');
check('Rahu never gets a dignity', dignityOf('Rahu', 'Leo') === undefined);
check('Ketu never gets a dignity', dignityOf('Ketu', 'Leo') === undefined);

section('normalizeAstroDetails — real astro_details.json');
const astro = normalizeAstroDetails(astroDetails);
check('lagna comes from ascendant', astro.lagna === 'Cancer');
check('moonSign comes from the (misleadingly named) "sign" field', astro.moonSign === 'Pisces');
check('nakshatra fixes the provider\'s own "Naksahtra" typo', astro.nakshatra === 'Revati');
check('nakshatraPada comes from Charan', astro.nakshatraPada === 2);

section('normalizePlanets — real planets_extended.json, cross-checked against astro_details');
check('the real response actually has 13 rows, not 9 — confirms this fixture still needs the filter below', planetsExtended.length === 13);
const planets = normalizePlanets(planetsExtended);
check('drops Uranus/Neptune/Pluto/Ascendant, keeping exactly the 9 classical grahas', planets.length === 9);
check('none of the dropped rows survive', !planets.some(p => ['Uranus', 'Neptune', 'Pluto', 'Ascendant'].includes(p.planet)));
const moonRow = planets.find(p => p.planet === 'Moon');
check(
  'astro_details\' "sign" really is the Moon\'s sign — same nakshatra as planets/extended\'s MOON row',
  moonRow.sign === astro.moonSign && moonRow.nakshatra === astro.nakshatra,
);
const sunRow = planets.find(p => p.planet === 'Sun');
check('Sun row: sign/house/dignity', sunRow.sign === 'Cancer' && sunRow.house === 1 && sunRow.dignity === 'Neutral');
check('isRetro "false" (a string) normalises to boolean false', planets.every(p => typeof p.isRetrograde === 'boolean'));
const rahuRow = planets.find(p => p.planet === 'Rahu');
check('Rahu carries no dignity', rahuRow.dignity === undefined);

section('parseVdashaDate');
check('"25-10-1987  2:43" (double space, no zero-padding) parses', parseVdashaDate('25-10-1987  2:43') === new Date(Date.UTC(1987, 9, 25, 2, 43)).toISOString());
check('a single-digit day/month/hour also parses', parseVdashaDate('4-9-2026  1:11') === new Date(Date.UTC(2026, 8, 4, 1, 11)).toISOString());
check('garbage returns null instead of throwing', parseVdashaDate('not a date') === null);

section('normalizeDashaPeriods — real major_vdasha.json');
const mahadasha = normalizeDashaPeriods(majorVdasha, 'Venus');
check('9 mahadasha periods, in order', mahadasha.length === 9 && mahadasha[0].lord === 'Mercury' && mahadasha[8].lord === 'Saturn');
check('the given currentLord is flagged, and only that one', mahadasha.filter(p => p.current === true).length === 1 && mahadasha.find(p => p.lord === 'Venus').current === true);
check('every period has ISO start/end', mahadasha.every(p => typeof p.start === 'string' && typeof p.end === 'string'));
check('without a currentLord, nothing is flagged', normalizeDashaPeriods(majorVdasha).every(p => p.current === undefined));

section('findCurrentLord — replaces the live /current_vdasha_all call, real major_vdasha.json + sub_vdasha.json');
/** Fixed, not real "now" — 2026-01-01 falls inside both Venus's real mahadasha window (2011-2031) and Saturn's real antardasha window within it (2024-2027), so this never flips answer as time passes. */
const fixedNow = new Date('2026-01-01T00:00:00.000Z');
const mahadashaPlain = normalizeDashaPeriods(majorVdasha);
const currentMajorLord = findCurrentLord(mahadashaPlain, fixedNow);
check('the currently running mahadasha is Venus, worked out locally from major_vdasha + a fixed date', currentMajorLord === 'Venus');
check('normalizeDashaPeriods flags exactly that lord when told', normalizeDashaPeriods(majorVdasha, currentMajorLord).filter(p => p.current).length === 1);
check('nothing is flagged when findCurrentLord has no periods to search', findCurrentLord([], fixedNow) === undefined);

const antardashaPlain = normalizeDashaPeriods(subVdasha);
const currentMinorLord = findCurrentLord(antardashaPlain, fixedNow);
check('the currently running antardasha within Venus is Saturn, worked out locally from sub_vdasha + the same fixed date', currentMinorLord === 'Saturn');

section('normalizeDashaPeriods — real sub_vdasha.json (the lazy antardasha call)');
const venusAntardasha = normalizeDashaPeriods(subVdasha, 'Saturn');
check('9 antardasha periods within the Venus mahadasha', venusAntardasha.length === 9);
check('Saturn (the actual currently-running antardasha) is flagged', venusAntardasha.find(p => p.lord === 'Saturn').current === true);

section('doshas — real kalsarpa_details.json / sadhesati_current_status.json / pitra_dosha_report.json');
check('kalsarpa: not present in this chart', normalizeKalsarpa(kalsarpa).present === false);
const sade = normalizeSadhesati(sadhesati);
check('sadhesati: present, with its phase as severity', sade.present === true && sade.severity === 'Middle Phase');
check('sadhesati description is the "currently undergoing" line, not the generic explainer, while present', sade.description === sadhesati.is_undergoing_sadhesati);
const pitra = normalizePitraDosha(pitraDosha);
check('pitra: not present, description falls back to the conclusion line', pitra.present === false && pitra.description === pitraDosha.conclusion);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
