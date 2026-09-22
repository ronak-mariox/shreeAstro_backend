/**
 * Turns AstrologyAPI's real response shapes (captured once, live, into
 * tests/fixtures/astrologyapi/*.json) into this API's own contract. The app
 * never sees a provider field name — everything below is pure and tested
 * against those fixtures, no network or DB involved.
 *
 * Deliberately semantic, not display-ready: "Sun", "Cancer", house 1, not a
 * pre-formatted "Sun ☀" string or "1st" ordinal. Every other service in this
 * codebase (see services/api.ts's header comment on the frontend) does that
 * translation in its own adapter layer, closest to the screen that needs a
 * specific string — this stays consistent with that split rather than baking
 * presentation into the API.
 */

/** "SUN" -> "Sun", "RAHU" -> "Rahu". */
function titleCasePlanet(name) {
  const value = String(name || '');
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Classical, chart-independent dignity rules — not something the provider
 * returns. Rahu/Ketu have no universally agreed own-sign/exaltation rule in
 * Vedic astrology, so both are left without a dignity, matching how the
 * frontend's own design fixture (user_app/src/data/kundli.ts's
 * planetaryPositions) already omits it for both.
 */
const OWN_SIGNS = {
  Sun: ['Leo'],
  Moon: ['Cancer'],
  Mars: ['Aries', 'Scorpio'],
  Mercury: ['Gemini', 'Virgo'],
  Jupiter: ['Sagittarius', 'Pisces'],
  Venus: ['Taurus', 'Libra'],
  Saturn: ['Capricorn', 'Aquarius'],
};
const EXALTATION_SIGN = { Sun: 'Aries', Moon: 'Taurus', Mars: 'Capricorn', Mercury: 'Virgo', Jupiter: 'Cancer', Venus: 'Pisces', Saturn: 'Libra' };
const DEBILITATION_SIGN = { Sun: 'Libra', Moon: 'Scorpio', Mars: 'Cancer', Mercury: 'Pisces', Jupiter: 'Capricorn', Venus: 'Virgo', Saturn: 'Aries' };

function dignityOf(planet, sign) {
  if (planet === 'Rahu' || planet === 'Ketu') {
    return undefined;
  }
  if (EXALTATION_SIGN[planet] === sign) return 'Exalted';
  if (DEBILITATION_SIGN[planet] === sign) return 'Debilitated';
  if (OWN_SIGNS[planet]?.includes(sign)) return 'Own Sign';
  return 'Neutral';
}

/**
 * Real /astro_details shape (tests/fixtures/astrologyapi/astro_details.json):
 *   { ascendant, ascendant_lord, sign, Naksahtra, NaksahtraLord, Charan, ... }
 * `sign` here is the MOON sign (rashi), not the sun sign — confirmed by
 * cross-referencing its nakshatra against /planets/extended's MOON row, which
 * carries the exact same nakshatra/nakshatraLord. `ascendant` is the lagna.
 * (Yes, the provider's own field is misspelled "Naksahtra" — that typo is
 * real, not ours; it's fixed here.)
 */
function normalizeAstroDetails(raw) {
  return {
    lagna: raw?.ascendant,
    lagnaLord: raw?.ascendant_lord,
    moonSign: raw?.sign,
    nakshatra: raw?.Naksahtra,
    nakshatraLord: raw?.NaksahtraLord,
    nakshatraPada: raw?.Charan,
  };
}

/** The nine classical grahas a Vedic planetary-positions table shows — everything normalizePlanets keeps. */
const CLASSICAL_PLANETS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];

/**
 * Real /planets/extended shape (tests/fixtures/astrologyapi/planets_extended.json):
 *   [{ name: "SUN", sign, house, isRetro: "false" (a STRING, not a boolean), nakshatra, nakshatraLord, ... }, ...]
 * The real response has 13 rows, not 9 — Uranus/Neptune/Pluto (no place in
 * classical Vedic astrology) and a 13th "Ascendant" pseudo-row (redundant
 * with astro_details' own `ascendant`) come back alongside the nine grahas.
 * Those four are dropped here; nothing downstream needs to know they existed.
 */
function normalizePlanets(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(row => {
      const planet = titleCasePlanet(row.name);
      return {
        planet,
        sign: row.sign,
        house: row.house,
        isRetrograde: row.isRetro === 'true' || row.isRetro === true,
        nakshatra: row.nakshatra,
        nakshatraLord: row.nakshatraLord,
        dignity: dignityOf(planet, row.sign),
      };
    })
    .filter(row => CLASSICAL_PLANETS.includes(row.planet));
}

/**
 * "25-10-1987  2:43" (note: not zero-padded, and a double space) -> an ISO
 * string. These are the birth's own local clock time (IST here, whatever the
 * birth's tzone was), not re-expressed in true UTC — treating the numbers as
 * UTC-as-written is a few hours off from the real instant, which doesn't
 * matter for a display that only ever shows the year (and, worst case, would
 * never be off by more than a day).
 */
function parseVdashaDate(value) {
  const match = /^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) {
    return null;
  }
  const [, day, month, year, hour, minute] = match;
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))).toISOString();
}

/**
 * Real /major_vdasha and /sub_vdasha/:lord shape (both identical — tests/fixtures/astrologyapi/major_vdasha.json, sub_vdasha.json):
 *   [{ planet: "Mercury", planet_id, start: "25-10-1987  2:43", end: "24-10-2004  8:43" }]
 * `currentLord`, when given, marks whichever row it names as `current` — see
 * `findCurrentLord` below for how that's worked out ourselves, from this same
 * list, instead of trusting a live /current_vdasha_all call.
 */
function normalizeDashaPeriods(raw, currentLord) {
  return (Array.isArray(raw) ? raw : []).map(row => ({
    lord: row.planet,
    start: parseVdashaDate(row.start),
    end: parseVdashaDate(row.end),
    current: currentLord ? row.planet === currentLord : undefined,
  }));
}

/**
 * Which lord's period contains `now` — the one piece of information
 * /current_vdasha_all used to answer live. `periods` is a `normalizeDashaPeriods`
 * result (already-parsed ISO `start`/`end` strings), so this is a plain
 * lexicographic range check, not date parsing: ISO 8601 UTC strings of the
 * same shape sort exactly like the instants they name.
 *
 * The underlying start/end values are the birth's own local clock time
 * reinterpreted as UTC (see `parseVdashaDate`) — up to a few hours, worst
 * case under a day, off from the true instant. Dasha periods run for years,
 * so this only matters on the literal day a period turns over, and even then
 * only decides which of two adjacent (still both real) lords "just started."
 *
 * @param {Array<{ lord: string, start: string|null, end: string|null }>} periods
 * @param {Date} [now]
 * @returns {string|undefined} The current lord, or undefined if `periods` is
 *   empty or `now` falls outside every period (shouldn't happen for a real
 *   Vimshottari timeline, which is continuous and covers 120 years).
 */
function findCurrentLord(periods, now = new Date()) {
  const nowIso = now.toISOString();
  const current = periods.find(period => period.start && period.end && period.start <= nowIso && nowIso < period.end);
  return current?.lord;
}

/** Real /kalsarpa_details shape when absent (tests/fixtures/astrologyapi/kalsarpa_details.json): { present: false, one_line }. The "present: true" shape is unverified — no chart on hand triggers it. */
function normalizeKalsarpa(raw) {
  return { present: Boolean(raw?.present), description: raw?.one_line ?? '' };
}

/** Real /sadhesati_current_status shape (tests/fixtures/astrologyapi/sadhesati_current_status.json): { sadhesati_status, sadhesati_phase, is_undergoing_sadhesati, what_is_sadhesati, ... }. */
function normalizeSadhesati(raw) {
  return {
    present: Boolean(raw?.sadhesati_status),
    /** Only sadhesati naturally has a severity-like dimension (which of its three phases); kalsarpa/pitra don't. */
    severity: raw?.sadhesati_status ? raw?.sadhesati_phase : undefined,
    description: raw?.sadhesati_status ? raw?.is_undergoing_sadhesati : raw?.what_is_sadhesati,
  };
}

/** Real /pitra_dosha_report shape (tests/fixtures/astrologyapi/pitra_dosha_report.json): { is_pitri_dosha_present, conclusion, what_is_pitri_dosha, ... }. */
function normalizePitraDosha(raw) {
  return {
    present: Boolean(raw?.is_pitri_dosha_present),
    description: raw?.conclusion || raw?.what_is_pitri_dosha || '',
  };
}

/** Display glyph per graha — shadbala only covers the seven classical grahas (no Rahu/Ketu, they have no shadbala). */
const PLANET_SYMBOLS = { Sun: '☀', Moon: '☽', Mars: '♂', Mercury: '☿', Jupiter: '♃', Venus: '♀', Saturn: '♄' };

/** Fixed render order the frontend expects, independent of whatever order the provider happens to return. */
const SHADBALA_ORDER = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn'];

/**
 * Real /shadbala shape (tests/fixtures/astrologyapi/shadbala.json):
 *   [{ name: "Sun", total_shadbala_rupa, total_shadbala_virupa,
 *      required_minimum_virupa, strength_percent_of_minimum, is_strong,
 *      components: {...} }, ...]
 * `strength_percent_of_minimum` is percent OF THE CLASSICAL MINIMUM a graha
 * needs to give full results — not a 0-100 "how strong overall" scale. In a
 * real chart every planet routinely clears 100% of its own minimum (this
 * project's reference chart: 105%-130% across all seven, all `is_strong`).
 * Passed through as-is rather than rescaled to a made-up ceiling — a bar
 * rendering `percentage` should clamp its own width at 100%, but the number
 * itself stays the real, comparable value (116% vs 130% is meaningful; both
 * clamped to "100" would erase that).
 */
function normalizeShadbala(raw) {
  const byName = new Map((Array.isArray(raw) ? raw : []).map(row => [titleCasePlanet(row.name), row]));
  return SHADBALA_ORDER.map(planet => {
    const row = byName.get(planet);
    return {
      planet,
      symbol: PLANET_SYMBOLS[planet],
      percentage: row ? Math.round(row.strength_percent_of_minimum) : 0,
      rupas: row ? Math.round(row.total_shadbala_rupa * 100) / 100 : undefined,
    };
  });
}

/**
 * Real /basic_gem_suggestion shape (tests/fixtures/astrologyapi/basic_gem_suggestion.json):
 *   { LIFE: { name, gem_key, wear_finger, weight_caret, wear_metal, wear_day, gem_deity }, BENEFIC: {...}, LUCKY: {...} }
 * No description field exists on this endpoint at all — built here from the
 * structured wear/deity fields, the same way a jeweller's note would read it.
 */
function normalizeGemRemedies(raw) {
  return Object.values(raw || {})
    .filter(Boolean)
    .map(gem => ({
      type: 'gemstone',
      title: gem.name,
      description: `Wear a ${gem.weight_caret ? `${String(gem.weight_caret).trim()} carat ` : ''}${gem.name} set in ${gem.wear_metal} on your ${gem.wear_finger} finger to strengthen ${gem.gem_deity}.`,
      frequency: gem.wear_day,
      planet: gem.gem_deity,
    }));
}

/**
 * Real /puja_suggestion shape (tests/fixtures/astrologyapi/puja_suggestion.json):
 *   { summary, suggestions: [{ status, priority, title, puja_id, summary, one_line }] }
 * Genuinely chart-specific (0-N entries, e.g. this project's reference chart
 * returned exactly one "Nakshatra Pujan") — unlike the gemstone endpoint,
 * there is no frequency ("every Sunday") or planet field here at all, so both
 * are left undefined rather than invented. `one_line` is used for
 * `description` since it's the short, user-facing summary; `summary` is the
 * long technical justification underneath it.
 */
function normalizePujaRemedies(raw) {
  return (raw?.suggestions ?? []).map(row => ({
    type: 'puja',
    title: row.title,
    description: row.one_line || row.summary,
    frequency: undefined,
    planet: undefined,
  }));
}

/** Both remedy sources merged into the one list the UI renders — puja entries first, matching the app's own example ordering. */
function normalizeRemedies(gemRaw, pujaRaw) {
  return [...normalizePujaRemedies(pujaRaw), ...normalizeGemRemedies(gemRaw)];
}

module.exports = {
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
  normalizeShadbala,
  normalizeRemedies,
};
