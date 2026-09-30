/**
 * The rule-based life-area readings (services/kundliAnalysis.service.js),
 * run on the REAL captured AstrologyAPI fixtures and on hand-built charts —
 * pure functions, no DB, no network, no credits. The DB-backed path
 * (getKundliAnalysis over a seeded cache) is covered in kundli-read.test.js.
 */

const {
  buildAnalysisInput,
  analyzeCareer,
  analyzeFinance,
  analyzeHealth,
  analyzeMarriage,
  analyzeDomain,
  ordinal,
} = require('../services/kundliAnalysis.service');
const { TILE_LABELS, DOMAIN_NAMES, DISCLAIMER } = require('../config/kundliRules');

const astroDetails = require('./fixtures/astrologyapi/astro_details.json');
const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');
const chartD1 = require('./fixtures/astrologyapi/horo_chart_D1.json');
const majorVdasha = require('./fixtures/astrologyapi/major_vdasha.json');
const subVdasha = require('./fixtures/astrologyapi/sub_vdasha.json');
const shadbala = require('./fixtures/astrologyapi/shadbala.json');
const kalsarpa = require('./fixtures/astrologyapi/kalsarpa_details.json');
const sadhesati = require('./fixtures/astrologyapi/sadhesati_current_status.json');
const pitraDosha = require('./fixtures/astrologyapi/pitra_dosha_report.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** Fixed, not real "now" — 2026-01-01 sits inside Venus's real mahadasha (2011-2031) and its Saturn antardasha (2024-2027), so nothing here flips as time passes. */
const NOW = new Date('2026-01-01T00:00:00.000Z');
const DOB = '1995-08-15';

const fullSections = {
  astro_details: astroDetails,
  'planets/extended': planetsExtended,
  'horo_chart/D1': chartD1,
  major_vdasha: majorVdasha,
  shadbala,
  kalsarpa_details: kalsarpa,
  sadhesati_current_status: sadhesati,
  pitra_dosha_report: pitraDosha,
};

const ANALYZERS = { career: analyzeCareer, finance: analyzeFinance, health: analyzeHealth, marriage: analyzeMarriage };
const TONES = ['positive', 'caution', 'neutral'];
const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const sentencesOf = text => text.split(/(?<=[.!?])\s+/).filter(Boolean).length;
/** Case matters for NaN — "finance" contains it. */
const forbidden = text => /sample|coming soon|lorem|undefined|\[object/i.test(text) || /NaN/.test(text);

section('ordinal');
check('1st/2nd/3rd/4th/11th/12th', ['1st', '2nd', '3rd', '4th', '11th', '12th'].join() === [1, 2, 3, 4, 11, 12].map(ordinal).join());

section('buildAnalysisInput — real fixtures (Cancer lagna, Moon in Pisces)');
const input = buildAnalysisInput(fullSections, { dob: DOB, gender: 'male', now: NOW });
check('lagna Cancer, lord Moon; Moon sign Pisces, lord Jupiter', input.lagnaSign === 'Cancer' && input.lagnaLord === 'Moon' && input.moonSign === 'Pisces' && input.moonSignLord === 'Jupiter');
check('12 houses in lagna order, signs from horo_chart/D1', input.houses.length === 12 && input.houses[0].sign === 'Cancer' && input.houses[9].sign === 'Aries' && input.houses[9].lord === 'Mars');
check('house planets match the planet rows', input.houses[0].planets.join() === 'Sun,Venus' && input.houses[9].planets.join() === 'Ketu');
check('9 classical grahas, each scored 0-100', input.planets.length === 9 && input.planets.every(p => Number.isInteger(p.score) && p.score >= 0 && p.score <= 100));
const byName = Object.fromEntries(input.planets.map(p => [p.planet, p]));
check('Venus is combust (is_planet_set) and Saturn retrograde', byName.Venus.isCombust === true && byName.Saturn.isRetrograde === true && byName.Sun.isCombust === false);
check('Moon 125° from the Sun counts as benefic; Sun/Saturn/Mars/Rahu/Ketu malefic', byName.Moon.nature === 'benefic' && ['Sun', 'Saturn', 'Mars', 'Rahu', 'Ketu'].every(n => byName[n].nature === 'malefic'));
check('rulership from house signs: Mars rules 5 and 10, Saturn 7 and 8, Rahu nothing', byName.Mars.rules.join() === '5,10' && byName.Saturn.rules.join() === '7,8' && byName.Rahu.rules.length === 0);
check('aspects: Mars in 3 -> 6,9,10; Saturn in 8 -> 10,2,5; Jupiter in 5 -> 9,11,1', byName.Mars.aspects.join() === '6,9,10' && byName.Saturn.aspects.join() === '10,2,5' && byName.Jupiter.aspects.join() === '9,11,1');
/** Hand-computed from config/kundliRules.js PLANET_SCORE: Sun 50 +10 strong +5 kendra +5 Venus/Jupiter = 70; Saturn 50 +15 own +10 strong +5 viparita (8th lord in 8th) -5 Rahu aspect = 75; Ketu 50 +5 kendra -15 (Saturn, Rahu, Mars) = 40. */
check('planet scores match the hand-computed rule table (Sun 70, Saturn 75, Ketu 40)', byName.Sun.score === 70 && byName.Saturn.score === 75 && byName.Ketu.score === 40, [byName.Sun.score, byName.Saturn.score, byName.Ketu.score]);
check('current mahadasha Venus (2011-2031), no antardasha without sub_vdasha', input.currentDasha?.lord === 'Venus' && input.currentDasha.start.startsWith('2011-10') && input.antardashas.length === 0 && input.currentAntardasha === null);
check('age 30 at the fixed now', input.age === 30);
check('doshas: sade sati running Jul 2022 - Aug 2029 (middle), kalsarpa/pitra absent, Mangal absent (Mars in 3)', input.doshas.sadhesati.present === true && input.doshas.sadhesati.from === '2022-07' && input.doshas.sadhesati.to === '2029-08' && input.doshas.kalsarpa.present === false && input.doshas.pitra.present === false && input.doshas.mangal.present === false);
check('only sub_vdasha is missing', input.missing.join() === 'sub_vdasha');

section('every domain — shape, labels, tones, basis, ordering, no placeholder wording');
const responses = {};
for (const domain of DOMAIN_NAMES) {
  const response = analyzeDomain(input, domain, 'PROFILE');
  responses[domain] = response;
  const text = JSON.stringify(response);
  check(`${domain}: top-level keys`, ['profileId', 'domain', 'confidence', 'tiles', 'summary', 'factors', 'periods', 'scores', 'basedOn', 'disclaimer'].every(k => k in response) && response.domain === domain && response.profileId === 'PROFILE');
  check(`${domain}: confidence high with every section present`, response.confidence === 'high');
  check(`${domain}: exactly the 4 tile labels, in order`, response.tiles.map(t => t.label).join('|') === TILE_LABELS[domain].join('|'), response.tiles.map(t => t.label));
  check(`${domain}: every tile has a non-empty value`, response.tiles.every(t => typeof t.value === 'string' && t.value.trim().length > 0));
  check(`${domain}: summary is 2-4 sentences`, sentencesOf(response.summary) >= 2 && sentencesOf(response.summary) <= 4, response.summary);
  check(`${domain}: 3-6 factors, each with title/text/tone/basis`, response.factors.length >= 3 && response.factors.length <= 6 && response.factors.every(f => f.title && f.text && TONES.includes(f.tone) && typeof f.basis === 'string' && f.basis.trim().length > 0));
  check(`${domain}: every basis names a planet or house`, response.factors.every(f => /Sun|Moon|Mars|Mercury|Jupiter|Venus|Saturn|Rahu|Ketu|house|Lagna|Sade Sati/.test(f.basis)));
  check(`${domain}: at most 4 periods, YYYY-MM, from <= to, ascending`, response.periods.length <= 4 && response.periods.every(p => YEAR_MONTH.test(p.from) && YEAR_MONTH.test(p.to) && p.from <= p.to && TONES.includes(p.tone) && p.reason && p.label) && response.periods.every((p, i) => i === 0 || response.periods[i - 1].from <= p.from));
  check(`${domain}: periods start no earlier than now`, response.periods.every(p => p.from >= '2026-01'));
  check(`${domain}: scores are integers 0-100`, Object.values(response.scores).length >= 4 && Object.values(response.scores).every(v => Number.isInteger(v) && v >= 0 && v <= 100));
  check(`${domain}: basedOn names lagna, Moon and the running mahadasha`, response.basedOn.some(b => b.startsWith('Lagna Cancer')) && response.basedOn.some(b => b.startsWith('Moon in Pisces')) && response.basedOn.some(b => b.includes('Current mahadasha: Venus (2011–2031)')));
  check(`${domain}: disclaimer is the rule-engine one`, response.disclaimer === DISCLAIMER);
  check(`${domain}: no "sample", "coming soon" or leaked undefined/NaN anywhere`, !forbidden(text));
  check(`${domain}: deterministic — same input, identical JSON twice`, JSON.stringify(analyzeDomain(input, domain, 'PROFILE')) === text);
  check(`${domain}: analyzeX alone returns the same body`, JSON.stringify(ANALYZERS[domain](input)) === JSON.stringify(ANALYZERS[domain](input)));
}

section('career — real chart: Mars-ruled 10th with Ketu in it, Saturn aspecting');
const career = responses.career;
check('10th lord Mars in the 3rd is the opening factor', career.factors[0].basis === 'Mars in the 3rd house (Virgo, neutral)');
check('Best Career Fields lead with Mars (engineering) then Saturn', career.tiles[0].value.startsWith('Engineering') && /Manufacturing/.test(career.tiles[0].value), career.tiles[0].value);
check('direction from the 10th lord (Mars -> South)', career.tiles[2].value.startsWith('South'));
check('lucky days: 10th lord Tuesday + lagna lord Monday', career.tiles[3].value === 'Tuesday & Monday');
check('7th (Saturn, own sign) stronger than 6th -> business favoured', career.factors.some(f => f.title === 'Business over service') && career.scores.seventhHouse > career.scores.sixthHouse);
check('the Sun mahadasha (strong career karaka) is the favourable window', career.periods.find(p => p.label === 'Sun mahadasha')?.tone === 'positive' && career.tiles[1].value.includes('Sun mahadasha'));
check('scores expose the 10th house/lord and the karakas', ['tenthHouse', 'tenthLord', 'sun', 'saturn', 'mercury', 'jupiter'].every(k => k in career.scores));

section('finance — real chart: 2nd and 11th lords together in the lagna');
const finance = responses.finance;
check('Dhana yoga factor from Sun (2nd lord) + Venus (11th lord) in the 1st', finance.factors.some(f => f.title === 'Dhana yoga' && f.basis.includes('Sun in the 1st house') && f.basis.includes('Venus in the 1st house')));
check('Venus mahadasha (11th lord) is a gain period', finance.periods.find(p => p.label === 'Venus mahadasha')?.tone === 'positive' && finance.tiles[3].value.startsWith('Now – Oct 2031'));
check('no caution dasha in 12 years -> Sade Sati is the caution period', finance.tiles[2].value.includes('Sade Sati') && finance.tiles[2].value.includes('Aug 2029'));
check('Saturn in the 8th flagged as expense pressure', finance.factors.some(f => f.title === 'Expense pressure' && f.basis.startsWith('Saturn in the 8th house')));
check('investment type from the strongest wealth planet (Saturn)', finance.tiles[1].value.startsWith('Long-term fixed assets'));

section('health — real chart: water lagna + water Moon, Saturn in the 8th, Sade Sati running');
const health = responses.health;
check('constitution Kapha–Vata', health.tiles[0].value === 'Kapha–Vata');
check('sensitive areas start with the 8th house (Saturn)', health.tiles[1].value.startsWith('Reproductive and excretory organs'));
check('precaution is Saturn\'s note', /joints/.test(health.tiles[3].value));
check('Sade Sati factor with its dates', health.factors.some(f => f.title === 'Sade Sati running' && f.text.includes('Jul 2022 – Aug 2029')));
check('never diagnoses — phrased as areas to take care of', health.factors.some(f => f.title === 'Areas to take care of') && !/diagnos|disease you have|you will suffer/i.test(JSON.stringify(health)));

section('marriage — real chart: Saturn-ruled 7th, Saturn in the 8th, male');
const marriage = responses.marriage;
check('spouse direction from the 7th sign (Capricorn -> South)', marriage.tiles[1].value.startsWith('South'));
check('compatibility: Pisces trines + Jupiter\'s friends\' signs', marriage.tiles[2].value === 'Pisces, Cancer, Scorpio, Aries and Leo Moon signs', marriage.tiles[2].value);
check('no Mangal dosha (Mars in the 3rd)', marriage.factors.some(f => f.title === 'No Mangal dosha' && f.tone === 'positive'));
check('7th lord in the 8th flagged as a dusthana placement, capping Marriage Life', marriage.factors.some(f => f.title === '7th lord in a dusthana') && marriage.tiles[3].value === 'Steady, with adjustments');
check('male -> Venus is the karaka', marriage.basedOn.some(b => b === 'Marriage karaka: Venus (male)') && marriage.factors.some(f => f.title === 'Venus, karaka of marriage'));
check('timing windows are year ranges, earliest first, the running one clipped to now', marriage.tiles[0].value.startsWith('2026–2031 (Venus, running)') && /2031–2033 \(Sun\)/.test(marriage.tiles[0].value), marriage.tiles[0].value);

const female = analyzeDomain(buildAnalysisInput(fullSections, { dob: DOB, gender: 'female', now: NOW }), 'marriage', 'PROFILE');
check('female -> Jupiter is the karaka', female.basedOn.some(b => b === 'Marriage karaka: Jupiter (female)') && female.factors.some(f => f.title === 'Jupiter, karaka of marriage'));
const unknownGender = analyzeDomain(buildAnalysisInput(fullSections, { dob: DOB, now: NOW }), 'marriage', 'PROFILE');
check('gender unknown -> both karakas', unknownGender.basedOn.some(b => b === 'Marriage karakas: Venus and Jupiter (gender not recorded)'));

section('antardasha cached for the running mahadasha -> finer windows');
const withAd = buildAnalysisInput({ ...fullSections, sub_vdasha: subVdasha }, { dob: DOB, gender: 'male', now: NOW });
check('current antardasha Saturn (Aug 2024 - Oct 2027)', withAd.currentAntardasha?.lord === 'Saturn' && withAd.missing.length === 0);
const careerAd = analyzeDomain(withAd, 'career', 'PROFILE');
check('periods are Venus–X antardashas first, then the Sun mahadasha', careerAd.periods[0].label === 'Venus–Saturn period' && careerAd.periods.at(-1).label === 'Sun mahadasha' && careerAd.periods.length === 4);
check('Career Period is the running Venus–Saturn window', careerAd.tiles[1].value === 'Now – Oct 2027 (Venus–Saturn period)', careerAd.tiles[1].value);
check('running-period factor names the antardasha', careerAd.factors.at(-1).text.includes('Saturn antardasha (Aug 2024 – Oct 2027)'));
const marriageAd = analyzeDomain(withAd, 'marriage', 'PROFILE');
check('marriage timing uses the 7th lord\'s antardasha', marriageAd.tiles[0].value.startsWith('2026–2027 (Venus–Saturn, running)'), marriageAd.tiles[0].value);

section('missing optional sections -> still answers, confidence medium');
const partial = buildAnalysisInput({ astro_details: astroDetails, 'planets/extended': planetsExtended, major_vdasha: majorVdasha }, { dob: DOB, now: NOW });
check('missing lists shadbala, the three doshas and sub_vdasha', partial.missing.join() === 'shadbala,kalsarpa_details,sadhesati_current_status,pitra_dosha_report,sub_vdasha');
check('houses derived from the lagna sign match horo_chart/D1 exactly', partial.houses.map(h => h.sign).join() === input.houses.map(h => h.sign).join());
check('doshas null when not cached, Mangal still computed', partial.doshas.sadhesati === null && partial.doshas.kalsarpa === null && partial.doshas.mangal.present === false);
check('scores without shadbala are 10 lower for a strong graha (Sun 60)', partial.planets.find(p => p.planet === 'Sun').score === 60);
for (const domain of DOMAIN_NAMES) {
  const response = analyzeDomain(partial, domain, 'PROFILE');
  check(`${domain}: confidence medium, still 4 tiles / 3+ factors, no placeholder wording`, response.confidence === 'medium' && response.tiles.length === 4 && response.factors.length >= 3 && !forbidden(JSON.stringify(response)));
}
check('health without sade sati has no Sade Sati factor or caution tile', !analyzeDomain(partial, 'health', 'PROFILE').factors.some(f => f.title === 'Sade Sati running') && !analyzeDomain(partial, 'finance', 'PROFILE').tiles[2].value.includes('Sade Sati'));

section('hand-built charts — exalted vs debilitated 10th lord, Mangal dosha');
/** Same chart with only Mars moved: rows are the real planets/extended shape, houses are re-derived from the lagna (no D1 passed), and shadbala is left out so dignity alone drives the difference. */
const moveMars = (sign, house) => planetsExtended.map(row => (row.name === 'MARS' ? { ...row, sign, house } : row));
const handBuilt = planets => buildAnalysisInput({ ...fullSections, 'horo_chart/D1': undefined, shadbala: undefined, 'planets/extended': planets }, { dob: DOB, gender: 'male', now: NOW });
const exalted = handBuilt(moveMars('Capricorn', 7));
const debilitated = handBuilt(moveMars('Cancer', 1));
const exMars = exalted.planets.find(p => p.planet === 'Mars');
const debMars = debilitated.planets.find(p => p.planet === 'Mars');
check('Mars exalted in Capricorn (7th) vs debilitated in Cancer (1st)', exMars.dignity === 'Exalted' && debMars.dignity === 'Debilitated');
check('exalted 10th lord scores far higher than the debilitated one', exMars.score - debMars.score >= 40, [exMars.score, debMars.score]);
const exCareer = analyzeDomain(exalted, 'career', 'PROFILE');
const debCareer = analyzeDomain(debilitated, 'career', 'PROFILE');
check('the 10th-lord factor is positive when exalted, caution when debilitated', exCareer.factors[0].tone === 'positive' && debCareer.factors[0].tone === 'caution');
check('basis names the dignity', exCareer.factors[0].basis === 'Mars in the 7th house (Capricorn, exalted)' && debCareer.factors[0].basis === 'Mars in the 1st house (Cancer, debilitated)');
check('summary wording follows the score', /strong/.test(exCareer.summary) && /under pressure/.test(debCareer.summary));
check('the two readings differ', JSON.stringify(exCareer) !== JSON.stringify(debCareer));
check('tenthLord score is the moved Mars', exCareer.scores.tenthLord === exMars.score && debCareer.scores.tenthLord === debMars.score);
check('Mars in the 7th -> Mangal dosha present; in the 1st too', exalted.doshas.mangal.present === true && debilitated.doshas.mangal.present === true);
const exMarriage = analyzeDomain(exalted, 'marriage', 'PROFILE');
check('Mangal dosha becomes a caution factor citing Mars', exMarriage.factors.some(f => f.title === 'Mangal dosha' && f.tone === 'caution' && f.basis.startsWith('Mars in the 7th house')));
check('a malefic in the 7th shows up as an occupancy caution', exMarriage.factors.some(f => f.title === 'Influences on the 7th house' && f.basis.includes('Mars in the 7th house')));

section('no birth date -> timing falls back to upcoming windows');
const noDob = analyzeDomain(buildAnalysisInput(fullSections, { now: NOW }), 'marriage', 'PROFILE');
check('age null, timing still non-empty', noDob.tiles[0].value.length > 0 && !/undefined/.test(noDob.tiles[0].value), noDob.tiles[0].value);

section('guards');
let threw;
try { buildAnalysisInput({}, { now: NOW }); } catch (error) { threw = error; }
check('astro_details is required', threw instanceof Error);
threw = undefined;
try { analyzeDomain(input, 'luck', 'PROFILE'); } catch (error) { threw = error; }
check('an unknown domain throws (the validator refuses it before this point over HTTP)', threw instanceof Error);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
