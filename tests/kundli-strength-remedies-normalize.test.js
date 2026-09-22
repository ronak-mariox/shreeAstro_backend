/**
 * normalizeShadbala / normalizeRemedies, proven against the REAL captured
 * responses in tests/fixtures/astrologyapi/ — pure functions, no DB, no
 * network, no credits.
 */

const { normalizeShadbala, normalizeRemedies } = require('../services/kundliNormalize');

const shadbala = require('./fixtures/astrologyapi/shadbala.json');
const gemSuggestion = require('./fixtures/astrologyapi/basic_gem_suggestion.json');
const pujaSuggestion = require('./fixtures/astrologyapi/puja_suggestion.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

section('normalizeShadbala — real shadbala.json');
const strength = normalizeShadbala(shadbala);
check('exactly 7 rows, in the fixed Sun..Saturn order', strength.length === 7 && strength.map(r => r.planet).join(',') === 'Sun,Moon,Mars,Mercury,Jupiter,Venus,Saturn');
check('every row carries a symbol', strength.every(r => typeof r.symbol === 'string' && r.symbol.length > 0));
const sunRow = strength.find(r => r.planet === 'Sun');
check('Sun percentage is the rounded real strength_percent_of_minimum (116%), not clamped to 100', sunRow.percentage === 116);
check('Sun rupas is the rounded-to-2dp real total_shadbala_rupa', sunRow.rupas === 7.57);
check('percentages can legitimately exceed 100 — every planet in this reference chart clears its own minimum', strength.every(r => r.percentage >= 100));
check('re-ordering the raw array does not change the output order', JSON.stringify(normalizeShadbala([...shadbala].reverse())) === JSON.stringify(strength));
check('a missing planet still gets a placeholder row instead of shifting the order', normalizeShadbala(shadbala.filter(r => r.name !== 'Moon')).find(r => r.planet === 'Moon').percentage === 0);
check('an empty/garbage input never throws', JSON.stringify(normalizeShadbala(null)) === JSON.stringify(normalizeShadbala([])));

section('normalizeRemedies — real basic_gem_suggestion.json + puja_suggestion.json');
const remedies = normalizeRemedies(gemSuggestion, pujaSuggestion);
check('3 gemstones + 1 puja = 4 entries, puja first', remedies.length === 4 && remedies[0].type === 'puja');
const puja = remedies.find(r => r.type === 'puja');
check('puja title/description come from title/one_line', puja.title === 'Nakshatra Pujan' && puja.description === pujaSuggestion.suggestions[0].one_line);
check('puja has no frequency/planet — the endpoint genuinely has none, not invented', puja.frequency === undefined && puja.planet === undefined);
const gems = remedies.filter(r => r.type === 'gemstone');
check('all 3 gemstones present', gems.length === 3 && gems.map(g => g.title).sort().join(',') === 'Pearl,Red Coral,Yellow Sapphire');
const pearl = gems.find(g => g.title === 'Pearl');
check('gemstone frequency/planet come from wear_day/gem_deity', pearl.frequency === 'Monday' && pearl.planet === 'Moon');
check('gemstone description mentions the finger and metal', pearl.description.includes('Ring or Little') && pearl.description.includes('Silver'));
check('no suggestions at all still returns an empty list, never throws', normalizeRemedies({}, { suggestions: [] }).length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
