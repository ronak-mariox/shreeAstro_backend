/**
 * The AI assistant's tools — the four things worth fetching on demand rather
 * than inlining into every request's chart summary (see
 * services/assistant.service.js's `buildChartSummary`): a specific dasha
 * lord's sub-periods, today's horoscope, remedies, and one planet's full
 * detail.
 *
 * Every handler is cache-only, the same way `buildChartSummary` is — through
 * `getCachedKundliSection`/`getCachedHoroscope`, which cannot reach the
 * AstrologyAPI provider even by mistake. A cache miss is answered as
 * `{ available: false, reason }`, never thrown: a single missing section
 * should end that one tool call, not the whole turn, and the assistant's own
 * system prompt is what turns `available: false` into an honest "not
 * available yet" instead of a guess.
 *
 * SECURITY: every handler takes `(args, userContext)` — `args` is only ever
 * the narrow, validated shape each tool's own JSON schema below describes
 * (a planet name, a dasha lord), and `userContext` (`{ userId, birthProfile
 * }`) is resolved by services/assistant.service.js from the authenticated
 * session before the model is ever called. The model is never given a
 * `user_id` or `profile_id` parameter to fill in — there is nothing in any
 * tool's schema it could hallucinate its way into someone else's data with.
 */

const { getCachedKundliSection } = require('./kundliCache.service');
const { getCachedHoroscope } = require('./horoscopeCache.service');
const {
  normalizePlanets,
  normalizeDashaPeriods,
  findCurrentLord,
  normalizeRemedies,
} = require('./kundliNormalize');
const { normalizeHoroscope } = require('./horoscopeNormalize');
const { istDateString } = require('../utils/istDate');
const UserProfile = require('../models/UserProfile');

/** Mirrors kundliNormalize.js's own CLASSICAL_PLANETS — duplicated rather than exported from a file that is otherwise pure/no-DB, purely to validate a tool argument. */
const CLASSICAL_PLANETS = ['Sun', 'Moon', 'Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];

/** What services/llm/index.js's `chat(messages, tools)` is given — native tool-calling schemas, nothing framework-specific about them. */
const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_antardasha',
      description:
        "The sub-periods (antardasha) within one of the user's mahadasha lords, with their own start/end dates. " +
        'The chart summary you already have includes the CURRENTLY running mahadasha and antardasha — only call ' +
        'this for a lord, or a level of detail, beyond that.',
      parameters: {
        type: 'object',
        properties: {
          mahadasha_lord: {
            type: 'string',
            description: 'Which mahadasha lord to look up sub-periods for.',
            enum: CLASSICAL_PLANETS,
          },
        },
        required: ['mahadasha_lord'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_horoscope',
      description: "Today's horoscope reading for the user's own sun sign. Only call this if they actually ask about today's horoscope or transits.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_remedies',
      description: "Gemstone and puja/chant remedy suggestions already generated for the user's own chart. Only call this if they actually ask for remedies or upay.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_planet_detail',
      description:
        "Full placement detail for one specific planet in the user's chart — sign, house, nakshatra, dignity, " +
        'retrograde status. The chart summary already gives a short line for most planets; call this when the ' +
        'user wants more detail on one specific graha.',
      parameters: {
        type: 'object',
        properties: {
          planet_name: {
            type: 'string',
            description: 'The planet to look up.',
            enum: CLASSICAL_PLANETS,
          },
        },
        required: ['planet_name'],
      },
    },
  },
];

async function getAntardasha(args, { birthProfile }) {
  const lord = String(args?.mahadasha_lord || '');
  if (!CLASSICAL_PLANETS.includes(lord)) {
    return { available: false, reason: `"${lord || '(none given)'}" is not one of the nine classical planets.` };
  }
  if (!birthProfile) {
    return { available: false, reason: 'No birth chart is on file for this user yet.' };
  }

  try {
    const [subRaw, majorRaw] = await Promise.all([
      getCachedKundliSection(birthProfile, 'sub_vdasha', lord),
      getCachedKundliSection(birthProfile, 'major_vdasha'),
    ]);
    /** Only the currently-running mahadasha has a "current antardasha" at all — mirrors kundliRead.service.js's own getKundliAntardasha exactly. */
    const currentMajorLord = findCurrentLord(normalizeDashaPeriods(majorRaw));
    const currentMinorLord = lord === currentMajorLord ? findCurrentLord(normalizeDashaPeriods(subRaw)) : undefined;
    return { available: true, mahadasha_lord: lord, antardasha: normalizeDashaPeriods(subRaw, currentMinorLord) };
  } catch {
    return { available: false, reason: `The antardasha breakdown for ${lord} has not been generated for this chart yet.` };
  }
}

async function getDailyHoroscope(args, { userId }) {
  const profile = await UserProfile.findOne({ user: userId }).select('zodiac');
  const sunSign = profile?.zodiac?.sunSign;
  if (!sunSign) {
    return { available: false, reason: "This user's sun sign has not been resolved yet." };
  }

  const lowerSign = sunSign.toLowerCase();
  const today = istDateString();
  try {
    const { payload, derived } = await getCachedHoroscope(lowerSign, 'daily', today);
    return { available: true, ...normalizeHoroscope(payload, derived, lowerSign, today) };
  } catch {
    return { available: false, reason: `Today's horoscope for ${sunSign} has not been generated yet.` };
  }
}

async function getRemedies(args, { birthProfile }) {
  if (!birthProfile) {
    return { available: false, reason: 'No birth chart is on file for this user yet.' };
  }

  try {
    const [gemRaw, pujaRaw] = await Promise.all([
      getCachedKundliSection(birthProfile, 'basic_gem_suggestion'),
      getCachedKundliSection(birthProfile, 'puja_suggestion'),
    ]);
    return { available: true, remedies: normalizeRemedies(gemRaw, pujaRaw) };
  } catch {
    return { available: false, reason: 'Remedy suggestions have not been generated for this chart yet.' };
  }
}

async function getPlanetDetail(args, { birthProfile }) {
  const planet = String(args?.planet_name || '');
  if (!CLASSICAL_PLANETS.includes(planet)) {
    return { available: false, reason: `"${planet || '(none given)'}" is not one of the nine classical planets.` };
  }
  if (!birthProfile) {
    return { available: false, reason: 'No birth chart is on file for this user yet.' };
  }

  try {
    const raw = await getCachedKundliSection(birthProfile, 'planets/extended');
    const detail = normalizePlanets(raw).find(row => row.planet === planet);
    if (!detail) {
      return { available: false, reason: `${planet} was not found in this chart's planetary table.` };
    }
    return { available: true, ...detail };
  } catch {
    return { available: false, reason: 'The planetary table has not been generated for this chart yet.' };
  }
}

const TOOL_HANDLERS = {
  get_antardasha: getAntardasha,
  get_daily_horoscope: getDailyHoroscope,
  get_remedies: getRemedies,
  get_planet_detail: getPlanetDetail,
};

/**
 * Runs one tool call by name. Never throws — an unknown tool (the model
 * hallucinating a name) or a handler's own cache miss both come back as
 * `{ available: false, reason }`, exactly like any other "not available"
 * answer the model already knows how to relay.
 *
 * @param {string} name
 * @param {object} args Already-parsed arguments — see services/llm/groq.js's `chat`.
 * @param {{ userId: string, birthProfile: object|null }} userContext
 */
async function runTool(name, args, userContext) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    return { available: false, reason: `Unknown tool "${name}".` };
  }
  return handler(args || {}, userContext);
}

module.exports = { TOOL_DEFINITIONS, runTool };
