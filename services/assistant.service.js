/**
 * The AI astrology assistant's own intelligence layer, on top of the generic
 * ChatSession/Message primitives in services/chat.service.js (an `ai`-typed
 * thread is still a ChatSession; this file is what makes one actually smart).
 *
 * Chart data is read-only against what is already on file — no planetary
 * position, dasha date, or dosha status is ever computed or guessed here.
 * `buildChartSummary` reads only from KundliCache, through
 * `getCachedKundliSection` (services/kundliCache.service.js's cache-only
 * door), which cannot reach the AstrologyAPI provider even by mistake — it
 * simply doesn't import anything that could. A birth chart missing from the
 * cache is reported back as a clear error, never quietly fetched.
 *
 * `generateReply` always grounds an answer in the user's own "self"
 * BirthProfile — there is one AI thread per user (chat.service.js's
 * getOrCreateAiChat), not one per chart, so there is no place in the
 * conversation for the user to pick a different one. Answering about a
 * partner's or family member's chart instead is a real feature, just not
 * this one — it would need the thread itself to carry which BirthProfile
 * it's about, which `chat_sessions`/`ChatSession` deliberately doesn't yet.
 */

const { loadOwnedBirthProfile } = require('./kundliRead.service');
const { getCachedKundliSection } = require('./kundliCache.service');
const {
  normalizeAstroDetails,
  normalizePlanets,
  normalizeDashaPeriods,
  findCurrentLord,
  normalizeKalsarpa,
  normalizeSadhesati,
  normalizePitraDosha,
  normalizeShadbala,
} = require('./kundliNormalize');
const { systemPromptFor } = require('./assistantPrompt');
/**
 * Both below are property accesses, not destructured — services/llm/index.js
 * resolves the real provider fresh per call, and tests monkey-patch
 * `llm.chat`/`assistantTools.runTool` directly (see tests/assistant.test.js),
 * the same way tests/kundli-read.test.js patches `client.callProvider`.
 * Destructuring here would freeze in today's function, immune to either.
 */
const llm = require('./llm');
const assistantTools = require('./assistantTools');
const BirthProfile = require('../models/BirthProfile');
const { ChatSession, Message } = require('../models/Chat');
const AssistantMemory = require('../models/AssistantMemory');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { estimateTokens } = require('../utils/tokens');

/** Duplicate-key error code shared with services/kundliCache.service.js's own race handling. */
const MONGO_DUPLICATE_KEY = 11000;

/* -------------------------------------------------------------------------- */
/* Small formatting helpers — display only, no calculation                    */
/* -------------------------------------------------------------------------- */

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4..20 -> "4th".."20th". */
function ordinal(n) {
  const value = Number(n);
  if (!Number.isFinite(value)) {
    return String(n);
  }
  const mod100 = value % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${value}th`;
  }
  switch (value % 10) {
    case 1: return `${value}st`;
    case 2: return `${value}nd`;
    case 3: return `${value}rd`;
    default: return `${value}th`;
  }
}

/** "2027-11-01T00:00:00.000Z" -> "Nov 2027". */
function monthYear(iso) {
  if (!iso) return undefined;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * "8 yrs 5 mo remaining" from now until `endIso` — printed, never used to
 * decide anything, so a rough whole-month figure is exactly right: precise
 * enough to be useful, not so precise it implies a calculation the data
 * doesn't actually support.
 */
function remainingDuration(endIso, now = new Date()) {
  if (!endIso) return undefined;
  const end = new Date(endIso);
  const totalMonths = (end.getFullYear() - now.getFullYear()) * 12 + (end.getMonth() - now.getMonth());
  if (totalMonths <= 0) {
    return 'ending soon';
  }
  const years = Math.floor(totalMonths / 12);
  const months = totalMonths % 12;
  const parts = [];
  if (years > 0) parts.push(`${years} yr${years === 1 ? '' : 's'}`);
  if (months > 0) parts.push(`${months} mo`);
  return `${parts.join(' ')} remaining`;
}

/* -------------------------------------------------------------------------- */
/* Chart summary                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything cached for one birth chart, compressed into the 12-15 line
 * digest the assistant is given as context on every request — never the raw
 * provider JSON, which is both expensive to send and confuses the model with
 * field names it doesn't need.
 *
 * Whatever isn't cached yet for this birth is simply left out of the digest
 * (the assistant's own system prompt is what tells it to say "not available"
 * rather than guess) — except the chart's basic identity (ascendant and
 * planetary table), without which there is nothing to summarise at all.
 *
 * @param {string} profileId
 * @param {string} userId Scopes the lookup — see loadOwnedBirthProfile.
 * @param {string|null} [focus] Reserved for a future topic-specific emphasis
 *   (e.g. 'career' weighting the 10th house, Saturn, Mercury more heavily).
 *   Not implemented yet — only `null` is accepted today.
 * @returns {Promise<string>} The compact, plain-text digest.
 */
async function buildChartSummary(profileId, userId, focus = null) {
  if (focus !== null) {
    throw new Error(`buildChartSummary: focus "${focus}" is not implemented yet — only null is supported.`);
  }

  const birthProfile = await loadOwnedBirthProfile(profileId, userId);

  const sections = await Promise.allSettled([
    getCachedKundliSection(birthProfile, 'astro_details'),
    getCachedKundliSection(birthProfile, 'planets/extended'),
    getCachedKundliSection(birthProfile, 'major_vdasha'),
    getCachedKundliSection(birthProfile, 'kalsarpa_details'),
    getCachedKundliSection(birthProfile, 'sadhesati_current_status'),
    getCachedKundliSection(birthProfile, 'pitra_dosha_report'),
    getCachedKundliSection(birthProfile, 'shadbala'),
  ]);
  const [astroR, planetsR, majorR, kalsarpaR, sadhesatiR, pitraR, shadbalaR] = sections;

  /** Without lagna/planets there is no chart to summarise at all — the two calls a full kundli always has, if it has anything. */
  if (astroR.status === 'rejected' || planetsR.status === 'rejected') {
    throw ApiError.notFound(
      'This kundli has not finished generating yet — try again in a moment, or generate it first.',
      'chart_summary_not_ready',
    );
  }

  const astro = normalizeAstroDetails(astroR.value);
  const planets = normalizePlanets(planetsR.value);
  const planetByName = new Map(planets.map(row => [row.planet, row]));

  const lines = [];

  const sun = planetByName.get('Sun');
  const moon = planetByName.get('Moon');
  const headline = [`Lagna: ${astro.lagna}`];
  if (sun) headline.push(`Sun: ${sun.sign} (${ordinal(sun.house)} house)`);
  if (moon) headline.push(`Moon: ${moon.sign} (${ordinal(moon.house)} house)`);
  lines.push(headline.join(' | '));

  if (astro.nakshatra) {
    lines.push(`Nakshatra: ${astro.nakshatra}`);
  }

  if (majorR.status === 'fulfilled') {
    const mahadasha = normalizeDashaPeriods(majorR.value);
    const currentMajorLord = findCurrentLord(mahadasha);
    const currentMaha = mahadasha.find(period => period.lord === currentMajorLord);
    if (currentMaha) {
      const fromYear = currentMaha.start ? new Date(currentMaha.start).getUTCFullYear() : '?';
      const toYear = currentMaha.end ? new Date(currentMaha.end).getUTCFullYear() : '?';
      const remaining = remainingDuration(currentMaha.end);
      lines.push(`Mahadasha: ${currentMaha.lord} (${fromYear}-${toYear})${remaining ? `, ${remaining}` : ''}`);
    }

    /**
     * Cache-only, same as everything else here — never live. Unlike the
     * mahadasha above, this isn't guaranteed to be cached yet: /sub_vdasha
     * for the current lord is only ever fetched lazily, the first time a
     * screen (or this summary) asks for that specific lord. A miss just
     * means the summary omits this line, same tolerance as every other
     * `Promise.allSettled` section above.
     */
    if (currentMaha) {
      const subRaw = await getCachedKundliSection(birthProfile, 'sub_vdasha', currentMaha.lord).catch(() => null);
      if (subRaw) {
        const currentAntardasha = normalizeDashaPeriods(subRaw);
        const currentAntar = currentAntardasha.find(period => period.lord === findCurrentLord(currentAntardasha));
        if (currentAntar) {
          lines.push(
            `Antardasha: ${currentMaha.lord}-${currentAntar.lord} (${monthYear(currentAntar.start)} - ${monthYear(currentAntar.end)})`,
          );
        }
      }
    }
  }

  const OTHER_PLANETS = ['Mars', 'Mercury', 'Jupiter', 'Venus', 'Saturn', 'Rahu', 'Ketu'];
  const otherPlanetEntries = OTHER_PLANETS.map(name => planetByName.get(name))
    .filter(Boolean)
    .map(row => {
      /** 'Neutral' is the common case and adds nothing worth a model's attention — only a genuinely notable placement is called out. */
      const notable = row.dignity && row.dignity !== 'Neutral' ? `, ${row.dignity.toLowerCase()}` : '';
      return `${row.planet} ${row.sign} (${ordinal(row.house)}${notable})`;
    });
  if (otherPlanetEntries.length > 0) {
    lines.push(`Planets: ${otherPlanetEntries.join(', ')}`);
  }

  const doshaEntries = [];
  if (kalsarpaR.status === 'fulfilled') {
    const { present } = normalizeKalsarpa(kalsarpaR.value);
    doshaEntries.push(`Kaal Sarp ${present ? 'present' : 'absent'}`);
  }
  if (sadhesatiR.status === 'fulfilled') {
    const { present, severity } = normalizeSadhesati(sadhesatiR.value);
    doshaEntries.push(`Sade Sati ${present ? `present (${severity})` : 'absent'}`);
  }
  if (pitraR.status === 'fulfilled') {
    const { present } = normalizePitraDosha(pitraR.value);
    doshaEntries.push(`Pitra ${present ? 'present' : 'absent'}`);
  }
  if (doshaEntries.length > 0) {
    lines.push(`Doshas: ${doshaEntries.join(' | ')}`);
  }

  if (shadbalaR.status === 'fulfilled') {
    const strength = normalizeShadbala(shadbalaR.value);
    lines.push(`Shadbala: ${strength.map(row => `${row.planet} ${row.percentage}%`).join(', ')}`);
  }

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Context window — recent messages, capped by a token budget                 */
/* -------------------------------------------------------------------------- */

/**
 * The tail of one thread's transcript, oldest-first, capped by a token
 * budget rather than a plain count — `Message.tokenCount` (estimated once at
 * send time, see utils/tokens.js) is trusted as-is; nothing here re-tokenises
 * the whole thread on every request.
 *
 * Walks the DB query newest-first while spending the budget, then reverses
 * once at the end — walking oldest-first would risk spending the whole
 * budget on the *oldest* messages in the window and dropping the newest one,
 * which is exactly the question just asked.
 *
 * Always keeps at least the single newest message, even if its own token
 * count alone exceeds the budget — an empty context is worse than a slightly
 * over-budget one.
 *
 * @param {string} chatId
 * @param {{ tokenBudget?: number, maxCount?: number }} [options]
 * @returns {Promise<Array<{ role: 'user'|'assistant', content: string, tokenCount: number }>>}
 */
async function getRecentMessages(chatId, options = {}) {
  const {
    tokenBudget = env.assistant.contextTokenBudget,
    maxCount = 13,
  } = options;

  const rows = await Message.find({ chatId, isDeleted: false })
    .sort({ seq: -1 })
    .limit(maxCount)
    .select('senderRole content tokenCount seq')
    .lean();

  const kept = [];
  let spent = 0;
  for (const row of rows) {
    const cost = row.tokenCount ?? 0;
    if (kept.length > 0 && spent + cost > tokenBudget) {
      break;
    }
    kept.push(row);
    spent += cost;
  }

  return kept.reverse().map(row => ({
    role: row.senderRole === 'user' ? 'user' : 'assistant',
    content: row.content?.text ?? '',
    tokenCount: row.tokenCount ?? 0,
  }));
}

/* -------------------------------------------------------------------------- */
/* Answering a question                                                       */
/* -------------------------------------------------------------------------- */

/** One system message carrying the prompt, the chart digest (or a clear note that there isn't one), and this thread's rolling memory. */
function buildSystemMessage(systemPrompt, chartSummary, rollingSummary) {
  const sections = [systemPrompt];

  sections.push(
    chartSummary
      ? `Birth chart summary (this is the only chart data you have — do not go beyond it):\n${chartSummary}`
      : 'No birth chart is on file for this user yet. If they ask anything about their chart, tell them to generate their kundli first (the Kundli tab) — do not answer as if you had one.',
  );

  if (rollingSummary) {
    sections.push(`Summary of earlier turns in this conversation:\n${rollingSummary}`);
  }

  return sections.join('\n\n');
}

/**
 * Resolves the birth chart this reply (and its tool calls) should be
 * grounded in: the user's own "self" BirthProfile, the one built at sign-up
 * — never one picked by the conversation itself (see the module's own header
 * comment on why a multi-chart picker is deliberately out of scope for now).
 *
 * `birthProfile` is `null`, and `summary` is `null`, when there is nothing
 * usable yet — either no self profile exists or its kundli batch never
 * finished. `buildSystemMessage` turns a `null` summary into an explicit "no
 * chart yet" instruction rather than a silent gap; the tools in
 * assistantTools.js each do the same with a `null` birthProfile.
 *
 * @param {string} userId
 * @returns {Promise<{ birthProfile: object|null, summary: string|null }>}
 */
async function ownChartFor(userId) {
  const birthProfile = await BirthProfile.findOne({ user: userId, relation: 'self', status: 'ready' }).sort({ createdAt: -1 });
  if (!birthProfile) {
    return { birthProfile: null, summary: null };
  }

  try {
    const summary = await buildChartSummary(String(birthProfile._id), userId);
    return { birthProfile, summary };
  } catch (error) {
    /** A "ready" profile whose cache is still incomplete, or a transient read hiccup — answered as "no chart yet" rather than failing the whole turn. */
    console.error('[assistant] chart summary unavailable:', error.message);
    return { birthProfile: null, summary: null };
  }
}

/**
 * The assistant's own turn feeding a round of tool calls back into the
 * conversation, in the shape the wire format needs: the model's own
 * tool-call request first (so the tool results that follow have something to
 * respond to), then one `role: 'tool'` message per call, matched by id.
 */
function toolRoundMessages(toolCalls, toolResults) {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    },
    ...toolCalls.map((call, index) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify(toolResults[index]),
    })),
  ];
}

/**
 * The tool-calling loop: ask the model, run whatever tools it asks for,
 * hand the results back, repeat — capped at `env.assistant.maxToolCallsPerMessage`
 * total tool calls across the whole exchange (not per round; the check runs
 * before each new round starts, so one round asking for several tools at
 * once is never truncated mid-batch — a dangling tool call with no matching
 * result is a malformed request to most providers, worse than a slightly
 * generous round).
 *
 * A model that is still asking for a tool once the cap is hit gets one final
 * completion with no tools offered at all — it must answer from whatever the
 * conversation already holds, the "jo mila usi se jawab do" the cap exists for.
 */
async function runWithTools(messages, userContext) {
  const working = [...messages];
  let totalToolCalls = 0;

  let result = await llm.chat(working, assistantTools.TOOL_DEFINITIONS);

  while (result.type === 'tool_calls') {
    if (totalToolCalls >= env.assistant.maxToolCallsPerMessage) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const toolResults = await Promise.all(result.toolCalls.map(call => assistantTools.runTool(call.name, call.arguments, userContext)));
    totalToolCalls += result.toolCalls.length;
    working.push(...toolRoundMessages(result.toolCalls, toolResults));

    // eslint-disable-next-line no-await-in-loop
    result = await llm.chat(working, assistantTools.TOOL_DEFINITIONS);
  }

  if (result.type === 'tool_calls') {
    result = await llm.chat(working);
  }

  return result.type === 'text' ? result.text : '';
}

/**
 * Generates the assistant's answer to whatever the user just asked — the
 * whole point of this feature. `chat`'s new user message must already be
 * saved before this runs (getRecentMessages reads it back as the newest
 * turn in the window); this function only ever reads and assembles, it
 * never decides what belongs in the transcript.
 *
 * @param {{ _id: unknown, topic?: string }} chat
 * @param {string} userId
 * @returns {Promise<{ text: string, tokenCount: number }>}
 */
async function generateReply({ chat, userId }) {
  const [{ birthProfile, summary: chartSummary }, recentMessages, memory] = await Promise.all([
    ownChartFor(userId),
    getRecentMessages(String(chat._id)),
    /** Lives in its own collection, not on `chat` — see models/AssistantMemory.js. `null` for a thread that has never crossed the summarisation threshold, same as a fresh one that already expired off the back of 7 days idle. */
    AssistantMemory.findOne({ chatSession: chat._id }).select('summary').lean(),
  ]);

  const messages = [
    { role: 'system', content: buildSystemMessage(systemPromptFor(chat.topic), chartSummary, memory?.summary) },
    ...recentMessages.map(({ role, content }) => ({ role, content })),
  ];

  const text = await runWithTools(messages, { userId, birthProfile });
  return { text, tokenCount: estimateTokens(text) };
}

/* -------------------------------------------------------------------------- */
/* Rolling summary — folding old turns into memory as a thread grows          */
/* -------------------------------------------------------------------------- */

/**
 * How many of the oldest unsummarised messages get folded into
 * `rollingSummary` per round, once `env.assistant.summariseAfterMessages`
 * (15) is crossed. Deliberately less than the trigger, not equal to it: the
 * newest few messages are left raw a little longer as a buffer, so a
 * question about something said just a couple of turns ago is still
 * answered from the verbatim transcript, not an already-compressed summary
 * of it. `getRecentMessages`'s own token-budget window is a separate,
 * independent cap on top of this — this only decides what falls out of the
 * *raw* history entirely.
 */
const SUMMARISE_CHUNK_SIZE = 10;

/**
 * Checked inline, right after a turn is saved — no cron, no periodic scan of
 * idle threads: an AI thread only ever grows while someone is actually
 * talking to it, so there is nothing to summarise between messages that a
 * scheduled sweep would ever catch sooner. Always called detached from the
 * request that triggered it (see chat.service.js's sendAiMessage) — folding
 * old turns into memory is a second LLM call, and the seeker waiting on
 * their own answer must never be made to wait on it too.
 *
 * The summary itself lives in its own AssistantMemory document, not on
 * `chat` — see models/AssistantMemory.js for why (its own 7-day TTL,
 * independent of the ChatSession it belongs to, which must never expire).
 * This is the only place that document is ever created or updated.
 *
 * Race-safe two different ways, matched to the two states a thread can be
 * in: the *first* fold for a thread creates the AssistantMemory document,
 * guarded by its own unique index on `chatSession` (a losing concurrent
 * create's duplicate-key error is swallowed — the winner's write already
 * stands); every fold after that is a compare-and-swap update conditioned on
 * `summarisedUptoSeq` still being what this call read it as, so two
 * overlapping calls (in principle; in practice a single user's own thread is
 * never actually written to concurrently) can never fold the same messages
 * in twice — the loser's write simply matches nothing and is silently
 * skipped.
 *
 * Never re-summarises the existing summary text itself — only ever the raw
 * messages still sitting past `summarisedUptoSeq` — so detail never
 * compounds away over a long thread.
 *
 * @param {string} chatId
 */
async function maybeSummarise(chatId) {
  const [chat, memory] = await Promise.all([
    ChatSession.findById(chatId).select('messageSeq'),
    AssistantMemory.findOne({ chatSession: chatId }).select('summary summarisedUptoSeq'),
  ]);
  if (!chat) {
    return;
  }

  const summarisedUptoSeq = memory?.summarisedUptoSeq ?? 0;
  const unsummarised = chat.messageSeq - summarisedUptoSeq;
  if (unsummarised < env.assistant.summariseAfterMessages) {
    return;
  }

  const uptoSeq = summarisedUptoSeq + SUMMARISE_CHUNK_SIZE;
  const rows = await Message.find({ chatId: chat._id, seq: { $gt: summarisedUptoSeq, $lte: uptoSeq } })
    .sort({ seq: 1 })
    .select('senderRole content')
    .lean();

  if (rows.length === 0) {
    return;
  }

  const chunkSummary = await llm.summarise(rows.map(row => ({
    role: row.senderRole === 'user' ? 'user' : 'assistant',
    content: row.content?.text ?? '',
  })));

  if (!memory) {
    try {
      await AssistantMemory.create({ chatSession: chat._id, summary: chunkSummary, summarisedUptoSeq: uptoSeq });
    } catch (error) {
      /** Someone else's concurrent first fold already won the unique-index race; its write stands, so this one is simply dropped rather than duplicated. */
      if (error?.code !== MONGO_DUPLICATE_KEY) {
        throw error;
      }
    }
    return;
  }

  const combined = `${memory.summary}\n\n${chunkSummary}`;
  await AssistantMemory.updateOne(
    { _id: memory._id, summarisedUptoSeq },
    { $set: { summary: combined, summarisedUptoSeq: uptoSeq } },
  );
}

module.exports = {
  buildChartSummary,
  getRecentMessages,
  buildSystemMessage,
  runWithTools,
  generateReply,
  maybeSummarise,
};
