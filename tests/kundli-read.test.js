/**
 * The four read endpoints (services/kundliRead.service.js), seeded with the
 * REAL captured fixtures directly into KundliCache — so this proves the
 * whole read path (ownership scoping, cache reuse, lazy antardasha) without
 * spending a single credit or needing the provider at all.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_kundli_read';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const BirthProfile = require('../models/BirthProfile');
const KundliCache = require('../models/KundliCache');
const client = require('../services/astrologyApi.client');
const kundliReadService = require('../services/kundliRead.service');
const kundliAnalysisService = require('../services/kundliAnalysis.service');
const { computeBirthHash } = require('../utils/birthHash');

const astroDetails = require('./fixtures/astrologyapi/astro_details.json');
const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');
const chartImage = require('./fixtures/astrologyapi/horo_chart_image_D1.json');
const majorVdasha = require('./fixtures/astrologyapi/major_vdasha.json');
const subVdasha = require('./fixtures/astrologyapi/sub_vdasha.json');
const kalsarpa = require('./fixtures/astrologyapi/kalsarpa_details.json');
const sadhesati = require('./fixtures/astrologyapi/sadhesati_current_status.json');
const pitraDosha = require('./fixtures/astrologyapi/pitra_dosha_report.json');
const shadbala = require('./fixtures/astrologyapi/shadbala.json');
const gemSuggestion = require('./fixtures/astrologyapi/basic_gem_suggestion.json');
const pujaSuggestion = require('./fixtures/astrologyapi/puja_suggestion.json');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

const OWNER = new mongoose.Types.ObjectId();
const SOMEONE_ELSE = new mongoose.Types.ObjectId();

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();

  const birthHash = computeBirthHash({ dob: '1995-08-15', tob: '06:30', lat: 19.07283, lon: 72.88261, ayanamsha: 'lahiri' });

  const profile = await BirthProfile.create({
    user: OWNER,
    label: 'Self',
    relation: 'self',
    birthDetails: {
      fullName: 'Arjun Sharma',
      gender: 'male',
      dateOfBirth: new Date('1995-08-15T00:00:00.000Z'),
      timeOfBirth: '06:30',
      isBirthTimeKnown: true,
      place: { formatted: 'Mumbai, IN', city: 'Mumbai', country: 'IN', latitude: 19.07283, longitude: 72.88261, timezone: 'Asia/Kolkata' },
    },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash,
    status: 'ready',
  });
  const profileId = String(profile._id);

  /** As if the 11-call batch had already completed successfully. */
  const seed = [
    ['astro_details', null, astroDetails],
    ['planets/extended', null, planetsExtended],
    ['horo_chart_image/D1', null, chartImage],
    ['horo_chart/D1', null, require('./fixtures/astrologyapi/horo_chart_D1.json')],
    ['major_vdasha', null, majorVdasha],
    ['kalsarpa_details', null, kalsarpa],
    ['sadhesati_current_status', null, sadhesati],
    ['pitra_dosha_report', null, pitraDosha],
    ['shadbala', null, shadbala],
    ['basic_gem_suggestion', null, gemSuggestion],
    ['puja_suggestion', null, pujaSuggestion],
  ];
  await KundliCache.insertMany(seed.map(([endpoint, pathParam, payload]) => ({ birthHash, endpoint, pathParam, payload, fetchedAt: new Date() })));

  /* ------------------------------------------------------------- ownership */
  section('ownership scoping — a profile belonging to someone else is 404, not 403');
  let threw;
  try {
    await kundliReadService.getKundliOverview(profileId, SOMEONE_ELSE);
  } catch (error) {
    threw = error;
  }
  check('refuses with 404', threw?.status === 404);

  threw = undefined;
  try {
    await kundliReadService.getKundliOverview(new mongoose.Types.ObjectId(), OWNER);
  } catch (error) {
    threw = error;
  }
  check('a well-formed but nonexistent profileId is also 404', threw?.status === 404);

  /* --------------------------------------------------------------- overview */
  section('GET /kundli/:profileId — everything served from cache, no provider call');
  const originalCallProvider = client.callProvider;
  let providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — everything is already cached');
  };

  const overview = await kundliReadService.getKundliOverview(profileId, OWNER, 'http://127.0.0.1:5000');
  check('no provider call was made — the chart SVG came from KundliCache, not a fresh fetch', providerCalled === false);
  check('lagna and nakshatra come through', overview.lagna === 'Cancer' && overview.nakshatra === 'Revati');
  check('the chart is a stored URL, not raw SVG markup', typeof overview.chart.url === 'string' && !overview.chart.url.includes('<svg'));
  check('the overview carries the birth the chart was cast for', overview.birth && overview.birth.dateOfBirth && typeof overview.birth.timeOfBirth === 'string' && typeof overview.birth.place?.formatted === 'string', overview.birth);
  check(
    'keyPositions has exactly the 6 tiles the screen renders, in order',
    overview.keyPositions.map(p => p.label).join(',') === 'Lagna,Sun,Moon,Mars,Mercury,Jupiter',
  );
  check('Moon key position uses astro_details\' sign, matching the planetary table\'s Moon row', overview.keyPositions[2].sign === overview.planetaryPositions.find(p => p.planet === 'Moon').sign);
  check('planetaryPositions has exactly the 9 classical grahas', overview.planetaryPositions.length === 9);

  const profileAfterUpload = await BirthProfile.findById(profileId).lean();
  check('the chart URL is now cached on the profile, so a second read never re-uploads it', profileAfterUpload.chartUrl === overview.chart.url);

  providerCalled = false;
  const secondOverview = await kundliReadService.getKundliOverview(profileId, OWNER, 'http://127.0.0.1:5000');
  check('a second read still makes no provider call', providerCalled === false);
  check('and returns the identical, already-cached URL', secondOverview.chart.url === overview.chart.url);

  client.callProvider = originalCallProvider;

  /* --------------------------------------------------------- chart resilience */
  section('GET /kundli/:profileId — a chart storage failure (e.g. a misconfigured S3 region) never takes down the rest of the overview');
  const brokenChartBirthHash = computeBirthHash({ dob: '1988-03-03', tob: '09:09', lat: 22.5726, lon: 88.3639, ayanamsha: 'lahiri' });
  const brokenChartProfile = await BirthProfile.create({
    user: OWNER,
    birthDetails: {
      fullName: 'Someone Else',
      dateOfBirth: new Date('1988-03-03T00:00:00.000Z'),
      timeOfBirth: '09:09',
      isBirthTimeKnown: true,
      place: { formatted: 'Kolkata, IN', city: 'Kolkata', country: 'IN', latitude: 22.5726, longitude: 88.3639, timezone: 'Asia/Kolkata' },
    },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash: brokenChartBirthHash,
    status: 'ready',
  });
  await KundliCache.insertMany([
    { birthHash: brokenChartBirthHash, endpoint: 'astro_details', pathParam: null, payload: astroDetails, fetchedAt: new Date() },
    { birthHash: brokenChartBirthHash, endpoint: 'planets/extended', pathParam: null, payload: planetsExtended, fetchedAt: new Date() },
  ]);
  client.callProvider = async (birthProfileArg, endpoint) => {
    if (endpoint === 'horo_chart_image/D1') {
      throw new Error('Region not accepted: not a valid hostname component.');
    }
    throw new Error(`unexpected call to ${endpoint}`);
  };
  let overviewWithBrokenChart;
  let overviewThrew;
  try {
    overviewWithBrokenChart = await kundliReadService.getKundliOverview(String(brokenChartProfile._id), OWNER, 'http://127.0.0.1:5000');
  } catch (error) {
    overviewThrew = error;
  }
  check('the request still succeeds — it does not throw', overviewThrew === undefined && overviewWithBrokenChart !== undefined);
  check('the chart url is null rather than a broken value', overviewWithBrokenChart?.chart.url === null);
  check('lagna/planetary data is still correct despite the chart failing', overviewWithBrokenChart?.lagna === 'Cancer' && overviewWithBrokenChart?.planetaryPositions.length === 9);

  client.callProvider = originalCallProvider;

  /* ------------------------------------------------------------------ dasha */
  section('GET /kundli/:profileId/dasha — mahadasha from major_vdasha alone, no live /current_vdasha_all call');
  /**
   * major_vdasha is already cached (seeded above); getKundliDasha works out
   * "which mahadasha is running now" itself (findCurrentLord, real today's
   * date — Venus's real 2011-2031 window covers any date this test actually
   * runs on), then lazily fetches sub_vdasha for that lord — the one call
   * this section still needs to serve itself, exactly like the dedicated
   * lazy-antardasha section further down does for getKundliAntardasha.
   */
  const dashaCalls = [];
  client.callProvider = async (birthProfileArg, endpoint, pathParam) => {
    dashaCalls.push({ endpoint, pathParam });
    return subVdasha;
  };
  const dasha = await kundliReadService.getKundliDasha(profileId, OWNER);
  check('the only call made was sub_vdasha for the current mahadasha lord — no /current_vdasha_all', dashaCalls.length === 1 && dashaCalls[0].endpoint === 'sub_vdasha');
  check('9 mahadasha periods', dasha.mahadasha.length === 9);
  check('exactly one is flagged current (Venus)', dasha.mahadasha.filter(p => p.current).length === 1 && dasha.mahadasha.find(p => p.current).lord === 'Venus');
  check('currentAntardasha is the antardasha breakdown of the running mahadasha', dasha.currentAntardasha.length === 9 && dasha.currentAntardasha.some(p => p.current));
  client.callProvider = originalCallProvider;

  /* ------------------------------------------------------------------ doshas */
  section('GET /kundli/:profileId/doshas');
  const doshas = await kundliReadService.getKundliDoshas(profileId, OWNER);
  check('3 doshas, in a stable order', doshas.doshas.map(d => d.name).join(',') === 'Kaal Sarp Dosha,Sade Sati,Pitra Dosha');
  check('kaal sarp: absent in this chart', doshas.doshas[0].present === false);
  check('sade sati: present, with a severity', doshas.doshas[1].present === true && typeof doshas.doshas[1].severity === 'string');
  check('pitra: absent', doshas.doshas[2].present === false);

  client.callProvider = originalCallProvider;

  /* ----------------------------------------------------------------- strength */
  section('GET /kundli/:profileId/strength — served from cache, no provider call');
  providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — already cached');
  };
  const strength = await kundliReadService.getKundliStrength(profileId, OWNER);
  check('no provider call was made', providerCalled === false);
  check('7 rows, in the fixed Sun..Saturn order', strength.strength.length === 7 && strength.strength.map(r => r.planet).join(',') === 'Sun,Moon,Mars,Mercury,Jupiter,Venus,Saturn');
  check('Sun percentage matches the real captured value', strength.strength.find(r => r.planet === 'Sun').percentage === 116);
  client.callProvider = originalCallProvider;

  /* ----------------------------------------------------------------- remedies */
  section('GET /kundli/:profileId/remedies — gemstone + puja merged, served from cache');
  providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — already cached');
  };
  const remedies = await kundliReadService.getKundliRemedies(profileId, OWNER);
  check('no provider call was made', providerCalled === false);
  check('3 gemstones + 1 puja = 4 entries, puja first', remedies.remedies.length === 4 && remedies.remedies[0].type === 'puja');
  check('gemstone entries carry frequency/planet', remedies.remedies.filter(r => r.type === 'gemstone').every(r => typeof r.frequency === 'string' && typeof r.planet === 'string'));
  check('the puja entry has no frequency/planet, since the real endpoint has none', remedies.remedies[0].frequency === undefined && remedies.remedies[0].planet === undefined);
  client.callProvider = originalCallProvider;

  /* ---------------------------------------------------------- lazy antardasha */
  section('GET /kundli/:profileId/dasha/:lord — lazy: first tap costs a call, the next is free');
  /** sub_vdasha/Venus is already cached — the dasha section above already made this exact lazy call for itself. Tapping into the same (currently-running) lord from this screen costs nothing new. */
  const calls = [];
  client.callProvider = async (birthProfile, endpoint, pathParam) => {
    calls.push({ endpoint, pathParam });
    return subVdasha;
  };

  const venusTap = await kundliReadService.getKundliAntardasha(profileId, OWNER, 'Venus');
  check('already cached from the dasha screen\'s own lazy fetch — no new call', calls.length === 0);
  check('9 antardasha periods within Venus\'s mahadasha', venusTap.antardasha.length === 9);
  check('Saturn (the real current antardasha) is flagged, since Venus is the currently-running mahadasha', venusTap.antardasha.find(p => p.lord === 'Saturn')?.current === true);

  const mercuryTap = await kundliReadService.getKundliAntardasha(profileId, OWNER, 'Mercury');
  check('a genuinely uncached lord still costs its own first call', calls.length === 1 && calls[0].endpoint === 'sub_vdasha' && calls[0].pathParam === 'Mercury');
  check('a non-current mahadasha has no antardasha flagged current', mercuryTap.antardasha.every(p => p.current === undefined));

  const secondTap = await kundliReadService.getKundliAntardasha(profileId, OWNER, 'Mercury');
  check('the second tap for the same lord is a cache hit — no new call', calls.length === 1);
  check('returns the identical result', JSON.stringify(secondTap) === JSON.stringify(mercuryTap));

  const otherLordCalls = [];
  client.callProvider = async (birthProfile, endpoint, pathParam) => {
    otherLordCalls.push(pathParam);
    return subVdasha;
  };
  const jupiterTap = await kundliReadService.getKundliAntardasha(profileId, OWNER, 'Jupiter');
  check('tapping a DIFFERENT (non-current) mahadasha lord is its own fresh call', otherLordCalls.length === 1 && otherLordCalls[0] === 'Jupiter');
  check('a non-current mahadasha has no antardasha flagged current at all', jupiterTap.antardasha.every(p => p.current === undefined));

  client.callProvider = originalCallProvider;

  /* ---------------------------------------------------------------- analysis */
  section('GET /kundli/:profileId/analysis/:domain — rule-based reading, entirely from cache, never a provider call');
  providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — a reading must never spend a credit');
  };
  const analysisByDomain = {};
  for (const domain of ['career', 'finance', 'health', 'marriage']) {
    analysisByDomain[domain] = await kundliAnalysisService.getKundliAnalysis(profileId, OWNER, domain);
  }
  check('no provider call was made for any of the four domains', providerCalled === false);
  check('each answers for its own domain and profile', Object.entries(analysisByDomain).every(([domain, r]) => r.domain === domain && r.profileId === profileId));
  check('4 tiles, a summary, 3-6 factors with a basis, <=4 periods, scores, basedOn, disclaimer', Object.values(analysisByDomain).every(r => r.tiles.length === 4 && r.summary && r.factors.length >= 3 && r.factors.length <= 6 && r.factors.every(f => f.basis) && r.periods.length <= 4 && Object.keys(r.scores).length > 0 && r.basedOn.length > 0 && r.disclaimer));
  check('confidence high — shadbala and all three dosha reports are cached', Object.values(analysisByDomain).every(r => r.confidence === 'high'));
  check('the profile\'s own birth details drive it: male -> Venus is the marriage karaka', analysisByDomain.marriage.basedOn.includes('Marriage karaka: Venus (male)'));
  /** sub_vdasha/Venus was lazily cached by the dasha section above — the reading picks it up as a cache-only peek, so periods are antardasha-fine. */
  check('the already-cached Venus antardasha refines the periods without any new call', analysisByDomain.career.periods.some(p => p.label.startsWith('Venus–')) && analysisByDomain.career.basedOn.some(b => b.includes('antardasha')));
  check('the same request twice is byte-identical', JSON.stringify(await kundliAnalysisService.getKundliAnalysis(profileId, OWNER, 'health')) === JSON.stringify(analysisByDomain.health));

  threw = undefined;
  try {
    await kundliAnalysisService.getKundliAnalysis(profileId, SOMEONE_ELSE, 'career');
  } catch (error) {
    threw = error;
  }
  check('someone else\'s profile is 404, same scoping as every other read', threw?.status === 404);

  /** A profile whose batch has not finished (or failed outright) is refused rather than answered from a half-empty chart. */
  const pendingProfile = await BirthProfile.create({
    user: OWNER,
    birthDetails: { fullName: 'Not Ready', dateOfBirth: new Date('1990-01-01T00:00:00.000Z'), timeOfBirth: '10:10', isBirthTimeKnown: true, place: { formatted: 'Pune, IN', city: 'Pune', country: 'IN', latitude: 18.5204, longitude: 73.8567, timezone: 'Asia/Kolkata' } },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash: computeBirthHash({ dob: '1990-01-01', tob: '10:10', lat: 18.5204, lon: 73.8567, ayanamsha: 'lahiri' }),
    status: 'pending',
  });
  threw = undefined;
  try {
    await kundliAnalysisService.getKundliAnalysis(String(pendingProfile._id), OWNER, 'career');
  } catch (error) {
    threw = error;
  }
  check('a pending profile is 409 kundli_not_ready, and nothing was fetched', threw?.status === 409 && threw?.code === 'kundli_not_ready' && providerCalled === false);

  /** A ready profile whose optional sections never made it into the cache still gets a reading — just a medium-confidence one, and still without a call. */
  const sparseBirthHash = computeBirthHash({ dob: '1992-02-02', tob: '02:02', lat: 28.6139, lon: 77.209, ayanamsha: 'lahiri' });
  const sparseProfile = await BirthProfile.create({
    user: OWNER,
    birthDetails: { fullName: 'Sparse Cache', gender: 'female', dateOfBirth: new Date('1992-02-02T00:00:00.000Z'), timeOfBirth: '02:02', isBirthTimeKnown: true, place: { formatted: 'Delhi, IN', city: 'Delhi', country: 'IN', latitude: 28.6139, longitude: 77.209, timezone: 'Asia/Kolkata' } },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash: sparseBirthHash,
    status: 'ready',
  });
  await KundliCache.insertMany([
    { birthHash: sparseBirthHash, endpoint: 'astro_details', pathParam: null, payload: astroDetails, fetchedAt: new Date() },
    { birthHash: sparseBirthHash, endpoint: 'planets/extended', pathParam: null, payload: planetsExtended, fetchedAt: new Date() },
    { birthHash: sparseBirthHash, endpoint: 'horo_chart/D1', pathParam: null, payload: require('./fixtures/astrologyapi/horo_chart_D1.json'), fetchedAt: new Date() },
    { birthHash: sparseBirthHash, endpoint: 'major_vdasha', pathParam: null, payload: majorVdasha, fetchedAt: new Date() },
  ]);
  const sparse = await kundliAnalysisService.getKundliAnalysis(String(sparseProfile._id), OWNER, 'marriage');
  check('optional sections missing -> still answers, confidence medium, no provider call for them', sparse.confidence === 'medium' && sparse.tiles.length === 4 && providerCalled === false);
  check('female -> Jupiter is the marriage karaka', sparse.basedOn.includes('Marriage karaka: Jupiter (female)'));

  client.callProvider = originalCallProvider;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.callProvider = require('../services/astrologyApi.client').callProvider;
  console.error('CRASHED:', e);
  process.exit(1);
});
