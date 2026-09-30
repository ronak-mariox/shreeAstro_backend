/**
 * Life-area readings (career, finance, health, marriage) computed from the
 * chart sections the kundli batch already caches — no provider call, no
 * language model, no randomness. The same chart always yields the same text,
 * and every statement names the chart factor it came from.
 *
 * Two layers, kept apart on purpose:
 *   - `buildAnalysisInput` turns raw cached sections into one scored,
 *     self-contained picture of the chart; `analyzeCareer` & co. are pure
 *     functions of that picture. tests/kundli-analysis.test.js runs them on
 *     the captured fixtures with no database at all.
 *   - `getKundliAnalysis` is the only thing that touches storage: it loads a
 *     seeker's own profile and reads its sections exactly the way
 *     services/kundliRead.service.js does.
 *
 * All rules and wording tables live in config/kundliRules.js.
 */

const ApiError = require('../utils/ApiError');
const rules = require('../config/kundliRules');
const { getKundliSection, getCachedKundliSection } = require('./kundliCache.service');
const { loadOwnedBirthProfile } = require('./kundliRead.service');
const {
  titleCasePlanet,
  normalizeAstroDetails,
  normalizePlanets,
  normalizeDashaPeriods,
  findCurrentLord,
} = require('./kundliNormalize');

/* ------------------------------------------------------------------ helpers */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th';
  return `${n}${suffix}`;
}

/** Counting `offset` houses from `house` (offset 1 = the house itself), wrapping at 12. */
const houseFrom = (house, offset) => ((house - 1 + offset - 1) % 12) + 1;

/** Natural house of a sign — Aries 1 … Pisces 12. */
const naturalHouseOf = sign => rules.SIGNS.indexOf(sign) + 1;

const strengthWord = score => rules.STRENGTH_BANDS.find(band => score >= band.min).word;

/** "a, b and c" — Oxford-free, the way the rest of the API's prose reads. */
function joinList(items) {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2031-10" -> "Oct 2031". */
const formatMonth = yearMonth => `${MONTHS[Number(yearMonth.slice(5, 7)) - 1]} ${yearMonth.slice(0, 4)}`;
/** An ISO instant -> "YYYY-MM". */
const yearMonthOf = iso => String(iso).slice(0, 7);
const yearOf = iso => String(iso).slice(0, 4);

/** `dob` + `years`, as an ISO string — for "between ages 20 and 38". */
function dateAtAge(dobIso, years) {
  const date = new Date(dobIso);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString();
}

function ageAt(dobIso, nowIso) {
  if (!dobIso) return null;
  const dob = new Date(dobIso);
  const now = new Date(nowIso);
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth()
    || (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/* ----------------------------------------------------------- chart picture */

/** Houses 1–12 from /horo_chart/D1 (row 0 = lagna), or counted from the lagna sign when that section is missing. */
function buildHouses(chartRaw, lagnaSign, planets) {
  const rows = Array.isArray(chartRaw) && chartRaw.length === 12 ? chartRaw : null;
  const lagnaIndex = rules.SIGNS.indexOf(lagnaSign);

  return Array.from({ length: 12 }, (_, index) => {
    const house = index + 1;
    const sign = rows ? rows[index].sign_name : rules.SIGNS[(lagnaIndex + index) % 12];
    return {
      house,
      sign,
      lord: rules.SIGN_LORDS[sign],
      planets: planets.filter(planet => planet.house === house).map(planet => planet.planet),
    };
  });
}

/** Angular separation, 0–180. */
function separation(a, b) {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Benefic or malefic, for this chart. Moon is benefic unless dark (close to
 * the Sun); Mercury is benefic unless it shares a house with a malefic and no
 * other benefic; everyone else is fixed.
 */
function natureOf(planet, planets) {
  const { planet: name } = planet;
  if (name === 'Moon') {
    const sun = planets.find(p => p.planet === 'Sun');
    if (sun && typeof sun.degree === 'number' && typeof planet.degree === 'number') {
      return separation(sun.degree, planet.degree) <= rules.MOON_DARK_ORB_DEGREES ? 'malefic' : 'benefic';
    }
    return 'benefic';
  }
  if (name === 'Mercury') {
    const housemates = planets.filter(p => p.house === planet.house && p.planet !== 'Mercury');
    const withMalefic = housemates.some(p => rules.NATURAL_MALEFICS.includes(p.planet));
    const withBenefic = housemates.some(p => ['Jupiter', 'Venus'].includes(p.planet));
    return withMalefic && !withBenefic ? 'malefic' : 'benefic';
  }
  return rules.NATURAL_MALEFICS.includes(name) ? 'malefic' : 'benefic';
}

/** Which houses a planet's drishti falls on, from its own house. */
const aspectedHouses = (planet, house) => rules.ASPECTS[planet].map(offset => houseFrom(house, offset));

/** The 0–100 strength of one graha — see config/kundliRules.js PLANET_SCORE. Returns the score and the adjustments that made it, for the reading's `basis`. */
function scorePlanet(planet, planets, houses, shadbala) {
  const S = rules.PLANET_SCORE;
  let score = S.BASE;

  if (planet.dignity) score += S.DIGNITY[planet.dignity] ?? 0;

  const bala = shadbala?.[planet.planet];
  if (bala) score += bala.isStrong ? S.SHADBALA_STRONG : S.SHADBALA_WEAK;

  if (planet.isRetrograde) score += planet.nature === 'benefic' ? S.RETROGRADE_BENEFIC : S.RETROGRADE_MALEFIC;
  if (planet.isCombust) score += S.COMBUST;

  const { house } = planet;
  if (rules.KENDRA_HOUSES.includes(house)) score += S.IN_KENDRA;
  else if (rules.TRIKONA_HOUSES.includes(house)) score += S.IN_TRIKONA;
  else if (rules.DUSTHANA_HOUSES.includes(house)) {
    const rulesADusthana = planet.rules.some(ruled => rules.DUSTHANA_HOUSES.includes(ruled));
    score += rulesADusthana ? S.VIPARITA : S.IN_DUSTHANA;
  }

  /** Who touches this planet — sharing its house, or throwing an aspect on it. */
  const influencers = planets.filter(
    other => other.planet !== planet.planet && (other.house === house || other.aspects.includes(house)),
  );
  if (influencers.some(other => ['Jupiter', 'Venus'].includes(other.planet))) score += S.BENEFIC_INFLUENCE;
  const maleficHits = influencers.filter(other => ['Saturn', 'Mars', 'Rahu', 'Ketu'].includes(other.planet)).length;
  score += Math.max(S.MALEFIC_INFLUENCE_CAP, maleficHits * S.MALEFIC_INFLUENCE_EACH);

  return clamp(Math.round(score), S.MIN, S.MAX);
}

/** The 0–100 strength of one bhava — its lord's score adjusted by who sits in or looks at it. */
function scoreHouse(house, planets) {
  const H = rules.HOUSE_SCORE;
  const lord = planets.find(p => p.planet === house.lord);
  const occupants = planets.filter(p => p.house === house.house);
  const aspecting = planets.filter(p => p.house !== house.house && p.aspects.includes(house.house));

  /** The Sun is only a mild malefic — it costs a house less than Saturn or Mars would, and its aspect costs nothing. */
  const weightOf = (p, each) => (p.planet === 'Sun' ? Math.trunc(each / 2) : each);
  let adjust = 0;
  if ([...occupants, ...aspecting].some(p => p.nature === 'benefic')) adjust += H.BENEFIC_PRESENT;
  for (const p of occupants.filter(o => o.nature === 'malefic')) adjust += weightOf(p, H.MALEFIC_OCCUPANT_EACH);
  /** A lord looking at its own house protects it, so it is never also counted as a malefic aspect. */
  for (const p of aspecting.filter(o => o.nature === 'malefic' && o.planet !== house.lord)) adjust += weightOf(p, H.MALEFIC_ASPECT_EACH);
  if (lord && lord.aspects.includes(house.house)) adjust += H.LORD_ASPECTS_OWN;

  const base = lord ? lord.score : rules.PLANET_SCORE.BASE;
  return clamp(Math.round(base + clamp(adjust, -H.ADJUST_CAP, H.ADJUST_CAP)), 0, 100);
}

/** /shadbala rows keyed by graha — `{ Sun: { isStrong, percent } }` — or null when the section is missing. */
function buildShadbala(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const byPlanet = {};
  for (const row of raw) {
    byPlanet[titleCasePlanet(row.name)] = {
      isStrong: Boolean(row.is_strong),
      percent: Math.round(Number(row.strength_percent_of_minimum) || 0),
    };
  }
  return byPlanet;
}

/** "12-7-2022" (the sadhesati endpoint's own D-M-YYYY) -> "2022-07". */
function yearMonthOfProviderDate(value) {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(value || '').trim());
  if (!match) return null;
  return `${match[3]}-${String(match[2]).padStart(2, '0')}`;
}

/**
 * The one scored picture of a chart every analyzer reads. `sections` is keyed
 * by provider endpoint name, exactly as the cache files them; a missing
 * optional section (shadbala, the three dosha reports, the current
 * antardasha) is worked around and listed in `missing`, which is what lowers
 * the response's `confidence`.
 *
 * @param {Record<string, unknown>} sections Raw cached payloads by endpoint.
 * @param {{ dob?: Date|string|null, gender?: string|null, now?: Date }} [context]
 */
function buildAnalysisInput(sections, { dob = null, gender = null, now = new Date() } = {}) {
  const astro = normalizeAstroDetails(sections.astro_details);
  if (!astro.lagna || !rules.SIGN_LORDS[astro.lagna]) {
    throw new Error('buildAnalysisInput needs astro_details with an ascendant.');
  }
  const rawPlanets = Array.isArray(sections['planets/extended']) ? sections['planets/extended'] : [];
  const normalized = normalizePlanets(rawPlanets);
  if (normalized.length === 0) {
    throw new Error('buildAnalysisInput needs planets/extended.');
  }
  const rawByName = new Map(rawPlanets.map(row => [titleCasePlanet(row.name), row]));

  const nowIso = new Date(now).toISOString();
  const dobIso = dob ? new Date(dob).toISOString() : null;

  /** Signs first, since rulership is needed before scoring. */
  const houses = buildHouses(sections['horo_chart/D1'], astro.lagna, normalized);
  const rulesOf = planet => houses.filter(h => h.lord === planet).map(h => h.house);

  const planets = normalized.map(row => {
    const raw = rawByName.get(row.planet) || {};
    return {
      planet: row.planet,
      sign: row.sign,
      house: row.house,
      dignity: row.dignity,
      isRetrograde: row.isRetrograde,
      isCombust: raw.is_planet_set === true || raw.is_planet_set === 'true',
      awastha: raw.planet_awastha,
      degree: typeof raw.fullDegree === 'number' ? raw.fullDegree : undefined,
      rules: rulesOf(row.planet),
      aspects: aspectedHouses(row.planet, row.house),
    };
  });
  for (const planet of planets) planet.nature = natureOf(planet, planets);

  const shadbala = buildShadbala(sections.shadbala);
  for (const planet of planets) planet.score = scorePlanet(planet, planets, houses, shadbala);
  for (const house of houses) house.score = scoreHouse(house, planets);

  const dashas = normalizeDashaPeriods(sections.major_vdasha).map(({ lord, start, end }) => ({ lord, start, end }));
  const currentLord = findCurrentLord(dashas, new Date(nowIso));
  const currentDasha = dashas.find(d => d.lord === currentLord) || null;
  const antardashas = normalizeDashaPeriods(sections.sub_vdasha).map(({ lord, start, end }) => ({ lord, start, end }));
  const currentAntardashaLord = findCurrentLord(antardashas, new Date(nowIso));
  const currentAntardasha = antardashas.find(d => d.lord === currentAntardashaLord) || null;

  const kalsarpaRaw = sections.kalsarpa_details;
  const sadhesatiRaw = sections.sadhesati_current_status;
  const pitraRaw = sections.pitra_dosha_report;
  const mars = planets.find(p => p.planet === 'Mars');

  const missing = [];
  if (!shadbala) missing.push('shadbala');
  if (!kalsarpaRaw) missing.push('kalsarpa_details');
  if (!sadhesatiRaw) missing.push('sadhesati_current_status');
  if (!pitraRaw) missing.push('pitra_dosha_report');
  if (antardashas.length === 0) missing.push('sub_vdasha');

  return {
    now: nowIso,
    dob: dobIso,
    age: ageAt(dobIso, nowIso),
    gender: gender || null,
    lagnaSign: astro.lagna,
    lagnaLord: rules.SIGN_LORDS[astro.lagna],
    moonSign: astro.moonSign,
    moonSignLord: rules.SIGN_LORDS[astro.moonSign],
    nakshatra: astro.nakshatra,
    houses,
    planets,
    dashas,
    currentDasha,
    antardashas,
    currentAntardasha,
    shadbala,
    doshas: {
      kalsarpa: kalsarpaRaw ? { present: Boolean(kalsarpaRaw.present) } : null,
      sadhesati: sadhesatiRaw
        ? {
            present: Boolean(sadhesatiRaw.sadhesati_status),
            phase: sadhesatiRaw.sadhesati_phase,
            from: yearMonthOfProviderDate(sadhesatiRaw.start_date),
            to: yearMonthOfProviderDate(sadhesatiRaw.end_date),
          }
        : null,
      pitra: pitraRaw ? { present: Boolean(pitraRaw.is_pitri_dosha_present) } : null,
      mangal: { present: Boolean(mars && rules.MANGAL_DOSHA_HOUSES.includes(mars.house)), house: mars?.house },
    },
    missing,
  };
}

/* ------------------------------------------------------- shared reading bits */

const planetOf = (input, name) => input.planets.find(p => p.planet === name);
const houseOf = (input, n) => input.houses[n - 1];
const occupantsOf = (input, n) => input.planets.filter(p => p.house === n);
const aspectorsOf = (input, n) => input.planets.filter(p => p.house !== n && p.aspects.includes(n));

/** "Mars in the 3rd house (Virgo, neutral)" — the `basis` every factor cites. */
function placement(planet) {
  const dignity = planet.dignity ? `, ${planet.dignity.toLowerCase()}` : '';
  const flags = [planet.isCombust ? 'combust' : null, planet.isRetrograde ? 'retrograde' : null].filter(Boolean);
  const extra = flags.length ? `, ${flags.join(', ')}` : '';
  return `${planet.planet} in the ${ordinal(planet.house)} house (${planet.sign}${dignity}${extra})`;
}

/** "7th house (Capricorn, lord Saturn)". */
const houseLabel = house => `${ordinal(house.house)} house (${house.sign}, lord ${house.lord})`;

/** The houses a planet rules, as "2nd and 11th houses" / "10th house" — empty for Rahu/Ketu. */
function rulershipPhrase(planet) {
  if (planet.rules.length === 0) return '';
  const names = planet.rules.map(ordinal);
  return `${joinList(names)} house${planet.rules.length > 1 ? 's' : ''}`;
}

const toneOfScore = score => (score >= 60 ? 'positive' : score < 45 ? 'caution' : 'neutral');

/** The factor line for a house lord's placement — every domain opens with one. */
function lordFactor(input, houseNo, title) {
  const house = houseOf(input, houseNo);
  const lord = planetOf(input, house.lord);
  const word = strengthWord(lord.score);
  const where = `${ordinal(lord.house)} house`;
  const dignity = lord.dignity ? lord.dignity.toLowerCase() : 'no fixed dignity';
  const flags = [lord.isCombust ? 'combust' : null, lord.isRetrograde ? 'retrograde' : null].filter(Boolean);
  const text = `${lord.planet}, lord of your ${ordinal(houseNo)} house (${house.sign}), sits in the ${where} in ${lord.sign} (${dignity}${flags.length ? `, ${flags.join(' and ')}` : ''}) — ${word}, so the ${rules.HOUSES[lord.house].keywords} of the ${where} shape this area.`;
  return { title, text, tone: toneOfScore(lord.score), basis: placement(lord) };
}

/** Who sits in and who looks at a house, as one factor — or null when nobody does. */
function occupancyFactor(input, houseNo, title, meaning) {
  const occupants = occupantsOf(input, houseNo);
  const aspecting = aspectorsOf(input, houseNo);
  if (occupants.length === 0 && aspecting.length === 0) return null;

  const parts = [];
  if (occupants.length) parts.push(`${joinList(occupants.map(p => p.planet))} occup${occupants.length > 1 ? 'y' : 'ies'} the ${ordinal(houseNo)} house`);
  if (aspecting.length) parts.push(`${joinList(aspecting.map(p => p.planet))} aspect${aspecting.length > 1 ? '' : 's'} ${occupants.length ? 'it' : `the ${ordinal(houseNo)} house`}`);

  const malefics = [...occupants, ...aspecting].filter(p => p.nature === 'malefic');
  const benefics = [...occupants, ...aspecting].filter(p => p.nature === 'benefic');
  let tone = 'neutral';
  let reading;
  if (benefics.length > 0 && malefics.length === 0) {
    tone = 'positive';
    reading = `Only benefic influence on the house of ${meaning} — support comes easily here.`;
  } else if (malefics.length > 0 && benefics.length === 0) {
    tone = 'caution';
    reading = `Malefic influence alone on the house of ${meaning} — progress here is earned through effort and patience.`;
  } else {
    reading = `A mix of benefic and malefic influence on the house of ${meaning} — gains come with periods of pressure.`;
  }
  const basis = joinList([
    ...occupants.map(placement),
    ...aspecting.map(p => `${p.planet} aspecting from the ${ordinal(p.house)} house`),
  ]);
  return { title, text: `${joinList(parts)}. ${reading}`, tone, basis };
}

/* ------------------------------------------------------------------ periods */

/** Lord-of / karaka status of one dasha lord for a domain — the same three-way call for every domain. */
function classifyLord(input, domain, lord) {
  const config = rules.DOMAINS[domain];
  const planet = planetOf(input, lord);
  if (!planet) return { kind: 'mixed', reason: `${lord} is not placed in this chart.` };

  const R = rules.PERIOD_RULES;
  const primaryRuled = planet.rules.filter(h => config.primaryHouses.includes(h));
  const drainRuled = planet.rules.filter(h => config.drainHouses.includes(h));
  const isKaraka = config.karakas.includes(lord);
  const where = `placed in the ${ordinal(planet.house)} house (${planet.sign}${planet.dignity ? `, ${planet.dignity.toLowerCase()}` : ''})`;

  if (primaryRuled.length > 0) {
    if (planet.score >= R.PRIMARY_MIN_SCORE) {
      return {
        kind: 'favourable',
        reason: `${lord} rules your ${joinList(primaryRuled.map(ordinal))} house (${rules.HOUSES[primaryRuled[0]].keywords}) and is ${where}, ${strengthWord(planet.score)}.`,
      };
    }
    return {
      kind: 'mixed',
      reason: `${lord} rules your ${joinList(primaryRuled.map(ordinal))} house but is ${where} and under pressure — results come, with effort.`,
    };
  }
  if (isKaraka && planet.score >= R.KARAKA_FAVOURABLE_SCORE) {
    return { kind: 'favourable', reason: `${lord}, a natural significator of this area, is ${where} and ${strengthWord(planet.score)}.` };
  }
  const touched = (config.influenceHouses || []).find(h => planet.house === h || planet.aspects.includes(h));
  if (touched && planet.score >= R.KARAKA_FAVOURABLE_SCORE) {
    return {
      kind: 'favourable',
      reason: `${lord} ${planet.house === touched ? 'occupies' : 'aspects'} your ${ordinal(touched)} house (${rules.HOUSES[touched].keywords}) and is ${strengthWord(planet.score)}, ${where}.`,
    };
  }
  if (planet.nature === 'malefic' && planet.score < R.MALEFIC_CAUTION_SCORE) {
    return { kind: 'caution', reason: `${lord} is a malefic ${where} and under pressure — a period for consolidation, not risk.` };
  }
  if (drainRuled.length > 0 && !isKaraka) {
    return {
      kind: 'caution',
      reason: `${lord} rules your ${joinList(drainRuled.map(ordinal))} house (${rules.HOUSES[drainRuled[0]].keywords}) — a period that asks for care and patience.`,
    };
  }
  const role = planet.rules.length ? `rules your ${rulershipPhrase(planet)}` : 'has no rulership';
  return { kind: 'mixed', reason: `${lord} ${role} and is ${where} — a mixed period, with results depending on effort.` };
}

const TONE_OF_KIND = { favourable: 'positive', mixed: 'neutral', caution: 'caution' };

/**
 * The dasha timeline from now: the running mahadasha's remaining antardashas
 * (when they are cached) followed by the mahadashas after it, or the
 * mahadashas alone. Each entry carries the lord whose nature decides the
 * period's classification.
 */
function timelineFrom(input) {
  const { now, dashas, currentDasha, antardashas } = input;
  const entries = [];
  const upcoming = dashas.filter(d => d.end && d.end > now);

  if (currentDasha && antardashas.length > 0) {
    for (const ad of antardashas) {
      if (!ad.end || ad.end <= now) continue;
      entries.push({ lord: ad.lord, label: `${currentDasha.lord}–${ad.lord} period`, start: ad.start, end: ad.end });
    }
    for (const md of upcoming) {
      if (md.lord === currentDasha.lord) continue;
      entries.push({ lord: md.lord, label: `${md.lord} mahadasha`, start: md.start, end: md.end });
    }
  } else {
    for (const md of upcoming) entries.push({ lord: md.lord, label: `${md.lord} mahadasha`, start: md.start, end: md.end });
  }
  return entries.filter(e => e.start && e.end).sort((a, b) => a.start.localeCompare(b.start));
}

/** The next PERIOD_RULES.HORIZON_YEARS years, classified for `domain`, at most MAX_WINDOWS entries. */
function buildPeriods(input, domain) {
  const R = rules.PERIOD_RULES;
  const horizon = new Date(input.now);
  horizon.setUTCFullYear(horizon.getUTCFullYear() + R.HORIZON_YEARS);
  const horizonIso = horizon.toISOString();

  return timelineFrom(input)
    .filter(entry => entry.start < horizonIso)
    .slice(0, R.MAX_WINDOWS)
    .map(entry => {
      const { kind, reason } = classifyLord(input, domain, entry.lord);
      return {
        label: entry.label,
        from: yearMonthOf(entry.start < input.now ? input.now : entry.start),
        to: yearMonthOf(entry.end),
        tone: TONE_OF_KIND[kind],
        reason,
      };
    });
}

/** "Now – Oct 2031 (Venus mahadasha)" — a period as a tile value. */
function periodTile(period, now) {
  const from = period.from === yearMonthOf(now) ? 'Now' : formatMonth(period.from);
  return `${from} – ${formatMonth(period.to)} (${period.label})`;
}

/** The current dasha as one factor — every domain closes with it. */
function dashaFactor(input, domain) {
  const { currentDasha, currentAntardasha } = input;
  if (!currentDasha) return null;
  const { kind, reason } = classifyLord(input, domain, currentDasha.lord);
  const sub = currentAntardasha ? `, currently in its ${currentAntardasha.lord} antardasha (${formatMonth(yearMonthOf(currentAntardasha.start))} – ${formatMonth(yearMonthOf(currentAntardasha.end))})` : '';
  return {
    title: 'Running period',
    text: `You are in the ${currentDasha.lord} mahadasha (${yearOf(currentDasha.start)}–${yearOf(currentDasha.end)})${sub}. ${reason}`,
    tone: TONE_OF_KIND[kind],
    basis: `Current mahadasha: ${currentDasha.lord} (${yearOf(currentDasha.start)}–${yearOf(currentDasha.end)})`,
  };
}

/** "Current mahadasha: Venus (2011–2031)" for `basedOn`. */
function dashaLine(input) {
  const { currentDasha, currentAntardasha } = input;
  if (!currentDasha) return null;
  const sub = currentAntardasha ? `, ${currentAntardasha.lord} antardasha` : '';
  return `Current mahadasha: ${currentDasha.lord} (${yearOf(currentDasha.start)}–${yearOf(currentDasha.end)})${sub}`;
}

function commonBasedOn(input) {
  return [
    `Lagna ${input.lagnaSign} (lord ${input.lagnaLord})`,
    `Moon in ${input.moonSign}${input.nakshatra ? `, ${input.nakshatra} nakshatra` : ''}`,
    dashaLine(input),
    input.shadbala ? 'Shadbala strengths' : null,
  ].filter(Boolean);
}

/* ------------------------------------------------------------------ career */

/**
 * Who influences the 10th house, weighted by how directly — lord, occupant,
 * aspect, then the 10th from the Moon's lord — ranked by strength. The
 * ranking picks the career fields.
 */
function careerInfluences(input) {
  const tenth = houseOf(input, 10);
  const moon = planetOf(input, 'Moon');
  const tenthFromMoon = houseOf(input, houseFrom(moon.house, 10));
  const weights = new Map();
  const add = (name, weight) => weights.set(name, Math.max(weights.get(name) || 0, weight));

  add(tenth.lord, 1);
  for (const p of occupantsOf(input, 10)) add(p.planet, 0.9);
  for (const p of aspectorsOf(input, 10)) add(p.planet, 0.6);
  add(tenthFromMoon.lord, 0.5);
  for (const p of occupantsOf(input, tenthFromMoon.house)) add(p.planet, 0.4);

  return [...weights.entries()]
    .map(([name, weight]) => ({ planet: planetOf(input, name), influence: planetOf(input, name).score * weight }))
    .sort((a, b) => b.influence - a.influence || a.planet.planet.localeCompare(b.planet.planet));
}

function analyzeCareer(input) {
  const tenth = houseOf(input, 10);
  const tenthLord = planetOf(input, tenth.lord);
  const sixth = houseOf(input, 6);
  const seventh = houseOf(input, 7);
  const sun = planetOf(input, 'Sun');
  const saturn = planetOf(input, 'Saturn');
  const mercury = planetOf(input, 'Mercury');
  const jupiter = planetOf(input, 'Jupiter');
  const moon = planetOf(input, 'Moon');
  const tenthFromMoon = houseOf(input, houseFrom(moon.house, 10));

  const influences = careerInfluences(input);
  const [first, second] = influences;
  const fields = [
    ...rules.CAREER_FIELDS[first.planet.planet].slice(0, 2),
    ...(second ? rules.CAREER_FIELDS[second.planet.planet].slice(0, 2) : []),
  ];

  const periods = buildPeriods(input, 'career');
  const bestPeriod = periods.find(p => p.tone === 'positive') || periods[0] || null;
  const businessFavoured = seventh.score > sixth.score;
  const direction = rules.DIRECTION_BY_PLANET[tenth.lord];
  const luckyDays = [...new Set([rules.WEEKDAY_BY_PLANET[tenth.lord], rules.WEEKDAY_BY_PLANET[input.lagnaLord]])];

  const factors = [lordFactor(input, 10, '10th house lord')];

  const occupancy = occupancyFactor(input, 10, 'Influences on the 10th house', 'career');
  if (occupancy) factors.push(occupancy);

  factors.push({
    title: 'Career fields',
    text: `${first.planet.planet} is the strongest influence on your 10th house${second ? `, with ${second.planet.planet} next` : ''}, which points to ${joinList(fields.map(f => f.toLowerCase()))}.`,
    tone: toneOfScore(first.planet.score),
    basis: joinList(influences.slice(0, 2).map(i => placement(i.planet))),
  });

  factors.push({
    title: businessFavoured ? 'Business over service' : 'Service over business',
    text: businessFavoured
      ? `Your 7th house of partnerships (${seventh.sign}, lord ${seventh.lord}) is stronger than your 6th house of service (${sixth.sign}, lord ${sixth.lord}) — independent work, business and partnerships suit you better than a purely salaried role.`
      : `Your 6th house of service (${sixth.sign}, lord ${sixth.lord}) is stronger than your 7th house of partnerships (${seventh.sign}, lord ${seventh.lord}) — structured employment and service roles suit you better than solo business.`,
    tone: 'neutral',
    basis: `${houseLabel(seventh)} against ${houseLabel(sixth)}`,
  });

  const rahu = planetOf(input, 'Rahu');
  if (rahu && rahu.house === 10) {
    factors.push({
      title: 'Rahu in the 10th',
      text: 'Rahu in your 10th house pulls the career towards technology, foreign connections and unconventional paths — ambitious, with sudden rises.',
      tone: 'neutral',
      basis: placement(rahu),
    });
  }

  const authority = sun.score >= saturn.score ? sun : saturn;
  factors.push({
    title: authority === sun ? 'Authority (Sun)' : 'Work ethic (Saturn)',
    text:
      authority === sun
        ? `Sun, the karaka of authority, is ${strengthWord(sun.score)} in your chart — recognition and positions of responsibility come more readily than for most.`
        : `Saturn, the karaka of work and discipline, is ${strengthWord(saturn.score)} in your chart — steady, patient effort is rewarded, and the career builds over time rather than overnight.`,
    tone: toneOfScore(authority.score),
    basis: placement(authority),
  });

  const running = dashaFactor(input, 'career');
  if (running) factors.push(running);

  const summary = [
    `Your 10th house of career is ${tenth.sign}, and its lord ${tenthLord.planet} sits in the ${ordinal(tenthLord.house)} house in ${tenthLord.sign} — ${strengthWord(tenthLord.score)}, with ${first.planet.planet} the strongest influence on the house.`,
    `That inclines you towards ${joinList(fields.slice(0, 3).map(f => f.toLowerCase()))}, and ${businessFavoured ? 'business or partnerships over a purely salaried role' : 'structured employment over solo business'}.`,
    bestPeriod
      ? `${bestPeriod.tone === 'positive' ? 'The most supportive stretch ahead is' : 'The period ahead is'} the ${bestPeriod.label} (${formatMonth(bestPeriod.from)} – ${formatMonth(bestPeriod.to)}).`
      : null,
  ].filter(Boolean).join(' ');

  return {
    tiles: [
      { label: 'Best Career Fields', value: fields.join(', ') },
      { label: 'Career Period', value: bestPeriod ? periodTile(bestPeriod, input.now) : 'No dasha data available' },
      { label: 'Favorable Direction', value: `${direction} (${tenth.lord}, your 10th lord)` },
      { label: 'Lucky Days', value: luckyDays.join(' & ') },
    ],
    summary,
    factors: factors.slice(0, 6),
    periods,
    scores: {
      tenthHouse: tenth.score,
      tenthLord: tenthLord.score,
      tenthFromMoon: tenthFromMoon.score,
      sun: sun.score,
      saturn: saturn.score,
      mercury: mercury.score,
      jupiter: jupiter.score,
      sixthHouse: sixth.score,
      seventhHouse: seventh.score,
    },
    basedOn: [
      ...commonBasedOn(input),
      `10th house ${tenth.sign}, lord ${tenth.lord} in the ${ordinal(tenthLord.house)} house`,
      `10th from the Moon: ${tenthFromMoon.sign} (lord ${tenthFromMoon.lord})`,
    ],
  };
}

/* ----------------------------------------------------------------- finance */

function analyzeFinance(input) {
  const second = houseOf(input, 2);
  const eleventh = houseOf(input, 11);
  const fifth = houseOf(input, 5);
  const ninth = houseOf(input, 9);
  const secondLord = planetOf(input, second.lord);
  const eleventhLord = planetOf(input, eleventh.lord);
  const jupiter = planetOf(input, 'Jupiter');
  const venus = planetOf(input, 'Venus');

  const wealthScore = Math.round((second.score + eleventh.score + jupiter.score + ninth.score) / 4);
  const outlook = wealthScore >= 65 ? 'Strong and steady' : wealthScore >= 50 ? 'Steady, grows with effort' : 'Needs careful planning';

  const ranked = rules.INVESTMENT_PLANETS.map(name => planetOf(input, name))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.planet.localeCompare(b.planet));
  const investmentPlanets = ranked.slice(0, 2);
  const investmentValue = investmentPlanets
    .map((p, index) => (index === 0 ? rules.INVESTMENT_TYPES[p.planet] : rules.INVESTMENT_TYPES[p.planet].toLowerCase()))
    .join('; ');

  const periods = buildPeriods(input, 'finance');
  const gainPeriod = periods.find(p => p.tone === 'positive') || null;
  const cautionPeriod = periods.find(p => p.tone === 'caution') || null;
  const sade = input.doshas.sadhesati;
  const sadeRunning = Boolean(sade?.present && sade.from && sade.to);

  let cautionValue;
  if (cautionPeriod) cautionValue = periodTile(cautionPeriod, input.now);
  else if (sadeRunning) cautionValue = `${sade.from <= yearMonthOf(input.now) ? 'Now' : formatMonth(sade.from)} – ${formatMonth(sade.to)} (Sade Sati, ${String(sade.phase || '').toLowerCase() || 'running'})`;
  else cautionValue = `None flagged until ${yearOf(periods[periods.length - 1]?.to || input.now)}`;

  const factors = [
    lordFactor(input, 2, '2nd house lord (savings)'),
    lordFactor(input, 11, '11th house lord (income)'),
  ];

  /** Dhana yoga hints: the 2nd and 11th lords in kendra/trikona, or together. */
  const goodHouses = [...rules.KENDRA_HOUSES, ...rules.TRIKONA_HOUSES];
  const together = secondLord.house === eleventhLord.house;
  const wellPlaced = [secondLord, eleventhLord].filter(p => goodHouses.includes(p.house));
  if (together || wellPlaced.length > 0) {
    const parts = [];
    if (together) parts.push(`${secondLord.planet} (2nd lord) and ${eleventhLord.planet} (11th lord) are together in the ${ordinal(secondLord.house)} house`);
    else parts.push(...wellPlaced.map(p => `${p.planet} (${p.rules.includes(2) ? '2nd' : '11th'} lord) is in the ${ordinal(p.house)} house, a ${rules.KENDRA_HOUSES.includes(p.house) ? 'kendra' : 'trikona'}`));
    factors.push({
      title: 'Dhana yoga',
      text: `${joinList(parts)} — a classical wealth combination that links what you earn with what you keep.`,
      tone: 'positive',
      basis: joinList([...new Set([secondLord, eleventhLord])].map(placement)),
    });
  }

  const speculators = occupantsOf(input, 5).filter(p => ['Rahu', 'Ketu', 'Saturn'].includes(p.planet));
  if (fifth.score < 45 || speculators.length > 0) {
    factors.push({
      title: 'Speculation caution',
      text: speculators.length
        ? `${joinList(speculators.map(p => p.planet))} in your 5th house of speculation makes quick trades and tips unreliable — keep speculative money small.`
        : `Your 5th house of speculation (${fifth.sign}, lord ${fifth.lord}) is under pressure — favour planned investments over speculation.`,
      tone: 'caution',
      basis: speculators.length ? joinList(speculators.map(placement)) : houseLabel(fifth),
    });
  } else {
    const fifthOccupancy = occupancyFactor(input, 5, 'Investments (5th house)', 'speculation and investments');
    factors.push(
      fifthOccupancy
        ? { ...fifthOccupancy, text: `${fifthOccupancy.text} Considered investments are supported.` }
        : {
            title: 'Investments (5th house)',
            text: `Your 5th house of investments (${fifth.sign}, lord ${fifth.lord}) is ${strengthWord(fifth.score)} — considered investments are supported.`,
            tone: toneOfScore(fifth.score),
            basis: houseLabel(fifth),
          },
    );
  }

  factors.push({
    title: 'Jupiter, karaka of wealth',
    text: `Jupiter, the natural significator of wealth, is ${strengthWord(jupiter.score)} in your chart — ${jupiter.score >= 55 ? 'wealth tends to accumulate through knowledge, fair dealing and long-term holdings' : 'wealth needs deliberate discipline, and windfalls should be treated with care'}.`,
    tone: toneOfScore(jupiter.score),
    basis: placement(jupiter),
  });

  const drains = [...occupantsOf(input, 8), ...occupantsOf(input, 12)].filter(p => p.nature === 'malefic');
  if (drains.length > 0) {
    factors.push({
      title: 'Expense pressure',
      text: `${joinList(drains.map(p => `${p.planet} in the ${ordinal(p.house)} house`))} can bring sudden or hidden expenses — keep an emergency reserve.`,
      tone: 'caution',
      basis: joinList(drains.map(placement)),
    });
  }

  const running = dashaFactor(input, 'finance');
  if (running) factors.push(running);

  const summary = [
    `Your 2nd house of savings is ${second.sign} (lord ${secondLord.planet}, ${strengthWord(secondLord.score)}) and your 11th house of income is ${eleventh.sign} (lord ${eleventhLord.planet}, ${strengthWord(eleventhLord.score)}), giving a ${outlook.toLowerCase()} financial picture.`,
    `${investmentPlanets[0].planet} is the strongest of your wealth-giving planets, so ${rules.INVESTMENT_TYPES[investmentPlanets[0].planet].toLowerCase()} suit you best.`,
    gainPeriod
      ? `Gains are best pursued during the ${gainPeriod.label} (${formatMonth(gainPeriod.from)} – ${formatMonth(gainPeriod.to)}).`
      : `No strongly favourable dasha falls in the next ${rules.PERIOD_RULES.HORIZON_YEARS} years, so steady saving matters more than timing.`,
  ].join(' ');

  return {
    tiles: [
      { label: 'Financial Outlook', value: outlook },
      { label: 'Investment Type', value: investmentValue },
      { label: 'Caution Period', value: cautionValue },
      { label: 'Gain Period', value: gainPeriod ? periodTile(gainPeriod, input.now) : 'Steady effort over timing' },
    ],
    summary,
    factors: factors.slice(0, 6),
    periods,
    scores: {
      secondHouse: second.score,
      eleventhHouse: eleventh.score,
      secondLord: secondLord.score,
      eleventhLord: eleventhLord.score,
      fifthHouse: fifth.score,
      ninthHouse: ninth.score,
      jupiter: jupiter.score,
      venus: venus.score,
    },
    basedOn: [
      ...commonBasedOn(input),
      `2nd house ${second.sign}, lord ${second.lord} in the ${ordinal(secondLord.house)} house`,
      `11th house ${eleventh.sign}, lord ${eleventh.lord} in the ${ordinal(eleventhLord.house)} house`,
      sadeRunning ? 'Sade Sati status' : null,
    ].filter(Boolean),
  };
}

/* ------------------------------------------------------------------ health */

function constitutionOf(input) {
  const doshas = [
    ...rules.ELEMENT_DOSHAS[rules.SIGN_ELEMENTS[input.lagnaSign]],
    ...(rules.ELEMENT_DOSHAS[rules.SIGN_ELEMENTS[input.moonSign]] || []),
  ];
  const unique = [...new Set(doshas)];
  return unique.length === 3 ? `Tridoshic (${unique.join('–')})` : unique.join('–');
}

/** Body areas as one phrase — each area already contains commas, so they are separated by semicolons: "chest and heart; arms, shoulders and lungs". */
const areasPhrase = areas => areas.map(a => a.body).join('; ');

/** How much a graha bears on health — sitting in 1/6/8/12 counts most, then aspecting the lagna or the Moon. */
function afflictionWeight(input, planet) {
  const moon = planetOf(input, 'Moon');
  if ([1, 6, 8, 12].includes(planet.house)) return 2;
  if (planet.aspects.includes(1) || planet.aspects.includes(moon.house)) return 1;
  return 0.5;
}

function analyzeHealth(input) {
  const lagna = houseOf(input, 1);
  const lagnaLord = planetOf(input, input.lagnaLord);
  const sixth = houseOf(input, 6);
  const eighth = houseOf(input, 8);
  const sun = planetOf(input, 'Sun');
  const moon = planetOf(input, 'Moon');

  const malefics = ['Saturn', 'Mars', 'Rahu', 'Ketu'].map(name => planetOf(input, name)).filter(Boolean);
  const areas = [];
  const seen = new Set();
  const addArea = (houseNo, why) => {
    const body = rules.HOUSES[houseNo].body;
    if (seen.has(body)) return;
    seen.add(body);
    areas.push({ body, why });
  };
  for (const p of malefics) addArea(p.house, `${p.planet} in the ${ordinal(p.house)} house`);
  for (const p of malefics) addArea(naturalHouseOf(p.sign), `${p.planet} in ${p.sign}`);
  addArea(naturalHouseOf(sixth.sign), `6th house sign ${sixth.sign}`);
  addArea(naturalHouseOf(eighth.sign), `8th house sign ${eighth.sign}`);

  const ranked = [...malefics].sort(
    (a, b) => afflictionWeight(input, b) - afflictionWeight(input, a) || a.score - b.score || a.planet.localeCompare(b.planet),
  );
  const primary = ranked[0];

  const periods = buildPeriods(input, 'health');
  const goodPeriod = periods.find(p => p.tone === 'positive') || periods.find(p => p.tone === 'neutral') || null;
  const sade = input.doshas.sadhesati;
  const sadeRunning = Boolean(sade?.present && sade.from && sade.to);

  const factors = [
    {
      title: 'Vitality (lagna lord)',
      text: `${lagnaLord.planet}, lord of your ${input.lagnaSign} lagna, is ${strengthWord(lagnaLord.score)} in the ${ordinal(lagnaLord.house)} house (${lagnaLord.dignity ? lagnaLord.dignity.toLowerCase() : 'no fixed dignity'}) — ${lagnaLord.score >= 55 ? 'a sound constitution that recovers well' : 'a constitution that needs rest and routine to stay resilient'}.`,
      tone: toneOfScore(lagnaLord.score),
      basis: placement(lagnaLord),
    },
    {
      title: 'Constitution',
      text: `A ${input.lagnaSign} lagna (${rules.SIGN_ELEMENTS[input.lagnaSign]}) with the Moon in ${input.moonSign} (${rules.SIGN_ELEMENTS[input.moonSign]}) gives a ${constitutionOf(input)} constitution.`,
      tone: 'neutral',
      basis: `Lagna ${input.lagnaSign}, Moon in ${input.moonSign}`,
    },
    {
      title: 'Areas to take care of',
      text: `Take particular care of the ${areasPhrase(areas.slice(0, 4))} — the areas ruled by the houses and signs your malefics occupy.`,
      tone: 'caution',
      basis: joinList(areas.slice(0, 4).map(a => a.why)),
    },
    {
      title: `${primary.planet}'s influence`,
      text: rules.HEALTH_NOTES[primary.planet].text,
      tone: 'caution',
      basis: placement(primary),
    },
  ];

  const weakLights = [sun, moon].filter(p => p.score < 50 || (p.planet === 'Moon' && p.nature === 'malefic'));
  for (const light of weakLights.slice(0, 1)) {
    factors.push({
      title: light.planet === 'Sun' ? 'Sun and vitality' : 'Moon and the mind',
      text: rules.HEALTH_NOTES[light.planet].text,
      tone: 'caution',
      basis: placement(light),
    });
  }

  if (sadeRunning) {
    factors.push({
      title: 'Sade Sati running',
      text: `Saturn's Sade Sati over your Moon sign is in its ${String(sade.phase || 'current').toLowerCase()} (${formatMonth(sade.from)} – ${formatMonth(sade.to)}) — a stretch for rest, routine and not ignoring small complaints.`,
      tone: 'caution',
      basis: `Sade Sati ${sade.phase || ''} (${formatMonth(sade.from)} – ${formatMonth(sade.to)}), Moon in ${input.moonSign}`.replace('  ', ' '),
    });
  }

  const running = dashaFactor(input, 'health');
  if (running) factors.push(running);

  const summary = [
    `With a ${input.lagnaSign} lagna and the Moon in ${input.moonSign}, your constitution is ${constitutionOf(input)}, and your lagna lord ${lagnaLord.planet} is ${strengthWord(lagnaLord.score)} in the ${ordinal(lagnaLord.house)} house.`,
    `${primary.planet} in the ${ordinal(primary.house)} house is the main influence to watch; the ${areasPhrase(areas.slice(0, 3))} deserve regular care.`,
    sadeRunning
      ? `Sade Sati is running until ${formatMonth(sade.to)}, which asks for rest and routine.`
      : goodPeriod
        ? `The ${goodPeriod.label} (${formatMonth(goodPeriod.from)} – ${formatMonth(goodPeriod.to)}) is the steadier stretch ahead.`
        : null,
  ].filter(Boolean).join(' ');

  return {
    tiles: [
      { label: 'Body Constitution', value: constitutionOf(input) },
      { label: 'Sensitive Areas', value: areasPhrase(areas.slice(0, 3)).replace(/^./, c => c.toUpperCase()) },
      { label: 'Favorable Period', value: goodPeriod ? periodTile(goodPeriod, input.now) : 'Keep routines steady' },
      { label: 'Precaution', value: rules.HEALTH_NOTES[primary.planet].short },
    ],
    summary,
    factors: factors.slice(0, 6),
    periods,
    scores: {
      lagna: lagna.score,
      lagnaLord: lagnaLord.score,
      sixthHouse: sixth.score,
      eighthHouse: eighth.score,
      sun: sun.score,
      moon: moon.score,
    },
    basedOn: [
      ...commonBasedOn(input),
      `Malefics: ${joinList(malefics.map(p => `${p.planet} in the ${ordinal(p.house)} house`))}`,
      `6th house ${sixth.sign}, 8th house ${eighth.sign}`,
      sadeRunning ? 'Sade Sati status' : null,
    ].filter(Boolean),
  };
}

/* ---------------------------------------------------------------- marriage */

/** Moon signs that suit this native: the Moon sign's trines, plus the signs whose lords are friends of the Moon-sign lord. */
function compatibleMoonSigns(input) {
  const index = rules.SIGNS.indexOf(input.moonSign);
  const trines = [0, 4, 8].map(offset => rules.SIGNS[(index + offset) % 12]);
  const friends = rules.PLANET_FRIENDS[input.moonSignLord] || [];
  const friendly = rules.SIGNS.filter(sign => friends.includes(rules.SIGN_LORDS[sign]));
  return [...new Set([...trines, ...friendly])];
}

/** The lords whose periods bring marriage: 7th lord, the gender's karaka(s), and whoever occupies or aspects the 7th. */
function marriageLords(input) {
  const seventh = houseOf(input, 7);
  const karakas = rules.MARRIAGE_KARAKA_BY_GENDER[input.gender] || rules.MARRIAGE_KARAKA_BY_GENDER.other;
  return [...new Set([seventh.lord, ...karakas, ...occupantsOf(input, 7).map(p => p.planet), ...aspectorsOf(input, 7).map(p => p.planet)])];
}

/** Favourable marriage windows: qualifying dasha periods within the age band, else the next one after it. */
function marriageWindows(input) {
  const lords = marriageLords(input);
  const timeline = timelineFrom(input);
  const past = input.dashas
    .filter(d => d.start && d.end && d.end <= input.now)
    .map(d => ({ lord: d.lord, label: `${d.lord} mahadasha`, start: d.start, end: d.end }));
  const all = [...past, ...timeline].filter(e => lords.includes(e.lord));

  if (!input.dob) {
    return all.filter(e => e.end > input.now).slice(0, 2);
  }
  const bandStart = dateAtAge(input.dob, rules.MARRIAGE_AGE_BAND.from);
  const bandEnd = dateAtAge(input.dob, rules.MARRIAGE_AGE_BAND.to);
  const inBand = all
    .filter(e => e.start < bandEnd && e.end > bandStart)
    .map(e => ({ ...e, start: e.start < bandStart ? bandStart : e.start, end: e.end > bandEnd ? bandEnd : e.end }));
  const stillOpen = inBand.filter(e => e.end > input.now);
  if (stillOpen.length > 0) return stillOpen.slice(0, 3);
  const later = all.filter(e => e.end > input.now && e.end > bandStart);
  return later.slice(0, 2);
}

function analyzeMarriage(input) {
  const seventh = houseOf(input, 7);
  const seventhLord = planetOf(input, seventh.lord);
  const venus = planetOf(input, 'Venus');
  const jupiter = planetOf(input, 'Jupiter');
  const moon = planetOf(input, 'Moon');
  const mars = planetOf(input, 'Mars');
  const karakaNames = rules.MARRIAGE_KARAKA_BY_GENDER[input.gender] || rules.MARRIAGE_KARAKA_BY_GENDER.other;
  const karakas = karakaNames.map(name => planetOf(input, name));

  const occupants = occupantsOf(input, 7);
  const maleficsIn7 = occupants.filter(p => p.nature === 'malefic');
  const beneficsIn7 = occupants.filter(p => p.nature === 'benefic');
  const nodesOnAxis = input.planets.filter(p => ['Rahu', 'Ketu'].includes(p.planet) && [1, 7].includes(p.house));
  const lordInDusthana = rules.DUSTHANA_HOUSES.includes(seventhLord.house);

  const lifeScore = Math.round((seventh.score + seventhLord.score + karakas.reduce((sum, p) => sum + p.score, 0) / karakas.length) / 3);
  let life;
  if (lifeScore >= 62 && maleficsIn7.length === 0 && !lordInDusthana) life = 'Harmonious and supportive';
  else if (lifeScore >= 50) life = 'Steady, with adjustments';
  else life = 'Needs patience and understanding';

  const windows = marriageWindows(input);
  const windowText = windows
    .map(w => `${yearOf(w.start < input.now ? input.now : w.start)}–${yearOf(w.end)} (${w.label.replace(' mahadasha', '').replace(' period', '')}${w.start < input.now ? ', running' : ''})`)
    .join(', ');
  const periods = buildPeriods(input, 'marriage');

  const factors = [lordFactor(input, 7, '7th house lord')];
  const occupancy = occupancyFactor(input, 7, 'Influences on the 7th house', 'marriage');
  if (occupancy) factors.push(occupancy);

  for (const karaka of karakas) {
    factors.push({
      title: `${karaka.planet}, karaka of marriage`,
      text: `${karaka.planet}, the natural significator of ${karaka.planet === 'Venus' ? 'love and the spouse' : 'the husband and married dharma'}, is ${strengthWord(karaka.score)} in the ${ordinal(karaka.house)} house${karaka.isCombust ? ' though combust' : ''} — ${karaka.score >= 55 ? 'affection and commitment come naturally' : 'affection needs conscious nurturing'}.`,
      tone: toneOfScore(karaka.score),
      basis: placement(karaka),
    });
  }

  factors.push({
    title: input.doshas.mangal.present ? 'Mangal dosha' : 'No Mangal dosha',
    text: input.doshas.mangal.present
      ? `Mars in your ${ordinal(mars.house)} house from the lagna forms Mangal dosha — matching with a partner of similar Mars placement, or the usual remedies, is advised before marriage.`
      : `Mars in your ${ordinal(mars.house)} house does not fall in the 1st, 2nd, 4th, 7th, 8th or 12th from the lagna — no Mangal dosha.`,
    tone: input.doshas.mangal.present ? 'caution' : 'positive',
    basis: placement(mars),
  });

  if (lordInDusthana) {
    factors.push({
      title: '7th lord in a dusthana',
      text: `${seventhLord.planet}, your 7th lord, sits in the ${ordinal(seventhLord.house)} house — the marriage asks for adjustments, distance or health-related care at times, and rewards patience.`,
      tone: 'caution',
      basis: placement(seventhLord),
    });
  }
  if (nodesOnAxis.length > 0) {
    factors.push({
      title: 'Rahu–Ketu on the 1st–7th axis',
      text: `${joinList(nodesOnAxis.map(p => `${p.planet} in the ${ordinal(p.house)} house`))} puts the nodes on your self–partner axis — an unconventional or karmic bond, often with a partner from a different background.`,
      tone: 'neutral',
      basis: joinList(nodesOnAxis.map(placement)),
    });
  }

  factors.push({
    title: 'Emotional needs (Moon)',
    text: `Moon in ${moon.sign} in the ${ordinal(moon.house)} house is ${strengthWord(moon.score)} — ${moon.score >= 55 ? 'emotional steadiness that holds a relationship through rough patches' : 'moods that need a patient, reassuring partner'}. Moon signs in ${joinList(compatibleMoonSigns(input).slice(0, 5))} suit you best.`,
    tone: toneOfScore(moon.score),
    basis: placement(moon),
  });

  const running = dashaFactor(input, 'marriage');
  if (running) factors.push(running);

  const summary = [
    `Your 7th house of marriage is ${seventh.sign}, and its lord ${seventhLord.planet} sits in the ${ordinal(seventhLord.house)} house — ${strengthWord(seventhLord.score)}${beneficsIn7.length ? `, with ${joinList(beneficsIn7.map(p => p.planet))} in the 7th adding harmony` : maleficsIn7.length ? `, with ${joinList(maleficsIn7.map(p => p.planet))} in the 7th bringing friction to work through` : ''}.`,
    `${joinList(karakas.map(p => p.planet))}, the karaka${karakas.length > 1 ? 's' : ''} of marriage, ${karakas.length > 1 ? 'are' : 'is'} ${joinList(karakas.map(p => `${strengthWord(p.score)} in the ${ordinal(p.house)} house`))}, ${input.doshas.mangal.present ? 'and Mars forms Mangal dosha' : 'and there is no Mangal dosha'}.`,
    windows.length
      ? `Marriage is favoured in ${windowText}, with a partner from the ${rules.SPOUSE_DIRECTION_BY_SIGN[seventh.sign].toLowerCase()}.`
      : `No dasha of the marriage-giving planets falls in the usual age band, so timing rests on transits — a consultation can refine it.`,
  ].join(' ');

  return {
    tiles: [
      { label: 'Marriage Timing', value: windows.length ? windowText : 'Guided by transits — consult for timing' },
      { label: 'Spouse Direction', value: `${rules.SPOUSE_DIRECTION_BY_SIGN[seventh.sign]} (7th house ${seventh.sign})` },
      { label: 'Compatibility', value: `${joinList(compatibleMoonSigns(input).slice(0, 5))} Moon signs` },
      { label: 'Marriage Life', value: life },
    ],
    summary,
    factors: factors.slice(0, 6),
    periods,
    scores: {
      seventhHouse: seventh.score,
      seventhLord: seventhLord.score,
      venus: venus.score,
      jupiter: jupiter.score,
      moon: moon.score,
      mars: mars.score,
    },
    basedOn: [
      ...commonBasedOn(input),
      `7th house ${seventh.sign}, lord ${seventh.lord} in the ${ordinal(seventhLord.house)} house`,
      `Marriage karaka${karakas.length > 1 ? 's' : ''}: ${joinList(karakaNames)}${input.gender ? ` (${input.gender})` : ' (gender not recorded)'}`,
      `Mars in the ${ordinal(mars.house)} house (Mangal dosha ${input.doshas.mangal.present ? 'present' : 'absent'})`,
    ],
  };
}

/* ----------------------------------------------------------------- wrapper */

const ANALYZERS = { career: analyzeCareer, finance: analyzeFinance, health: analyzeHealth, marriage: analyzeMarriage };

/** The optional sections whose absence lowers confidence — the current antardasha is a lazy cache and does not count. */
const CONFIDENCE_SECTIONS = ['shadbala', 'kalsarpa_details', 'sadhesati_current_status', 'pitra_dosha_report'];

/** One domain's full response body from a prepared input — the shape GET /kundli/:profileId/analysis/:domain returns. */
function analyzeDomain(input, domain, profileId) {
  const analyze = ANALYZERS[domain];
  if (!analyze) {
    throw new Error(`Unknown analysis domain "${domain}".`);
  }
  const { tiles, summary, factors, periods, scores, basedOn } = analyze(input);
  const confidence = CONFIDENCE_SECTIONS.some(section => input.missing.includes(section)) ? 'medium' : 'high';
  return {
    profileId,
    domain,
    confidence,
    tiles,
    summary,
    factors,
    periods,
    scores,
    basedOn,
    disclaimer: rules.DISCLAIMER,
  };
}

/**
 * GET /kundli/:profileId/analysis/:domain — the seeker's own profile only,
 * the same 404-not-403 scoping as every other kundli read.
 *
 * Sections come from the cache: the chart-defining ones (astro_details,
 * planets/extended, horo_chart/D1, major_vdasha) through getKundliSection,
 * exactly as the overview reads them, so a section a partial batch is missing
 * is retried the same way the overview would retry it. Everything optional —
 * shadbala, the three dosha reports and the running mahadasha's antardasha —
 * is a cache-only peek (getCachedKundliSection), so asking for a reading
 * never spends a credit on a section the batch did not already store; a miss
 * just lowers `confidence`.
 */
async function getKundliAnalysis(profileId, userId, domain) {
  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  if (birthProfile.status === 'pending' || birthProfile.status === 'failed') {
    throw ApiError.conflict(
      birthProfile.status === 'pending'
        ? 'Your kundli is still being generated — try again in a moment.'
        : 'Your kundli could not be generated — open the chart to retry it first.',
      undefined,
      'kundli_not_ready',
    );
  }

  const peek = (endpoint, pathParam) =>
    getCachedKundliSection(birthProfile, endpoint, pathParam).catch(error => {
      if (error?.code !== 'kundli_section_not_cached') throw error;
      return undefined;
    });

  const [astroDetails, planets, chartD1, majorVdasha, shadbala, kalsarpa, sadhesati, pitra] = await Promise.all([
    getKundliSection(birthProfile, 'astro_details'),
    getKundliSection(birthProfile, 'planets/extended'),
    getKundliSection(birthProfile, 'horo_chart/D1'),
    getKundliSection(birthProfile, 'major_vdasha'),
    peek('shadbala'),
    peek('kalsarpa_details'),
    /** A stale (past its 30-day TTL) sadhesati row is still served here — this is a peek, and a reading must not trigger the refresh call. */
    peek('sadhesati_current_status'),
    peek('pitra_dosha_report'),
  ]);

  const currentLord = findCurrentLord(normalizeDashaPeriods(majorVdasha));
  const subVdasha = currentLord ? await peek('sub_vdasha', currentLord) : undefined;

  const input = buildAnalysisInput(
    {
      astro_details: astroDetails,
      'planets/extended': planets,
      'horo_chart/D1': chartD1,
      major_vdasha: majorVdasha,
      sub_vdasha: subVdasha,
      shadbala,
      kalsarpa_details: kalsarpa,
      sadhesati_current_status: sadhesati,
      pitra_dosha_report: pitra,
    },
    {
      dob: birthProfile.birthDetails?.dateOfBirth || null,
      gender: birthProfile.birthDetails?.gender || null,
    },
  );

  return analyzeDomain(input, domain, profileId);
}

module.exports = {
  buildAnalysisInput,
  analyzeCareer,
  analyzeFinance,
  analyzeHealth,
  analyzeMarriage,
  analyzeDomain,
  getKundliAnalysis,
  /** Exported for tests — the arithmetic every reading rests on. */
  scorePlanet,
  scoreHouse,
  classifyLord,
  buildPeriods,
  ordinal,
};
