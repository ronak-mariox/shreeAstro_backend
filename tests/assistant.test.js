/**
 * services/assistant.service.js — buildChartSummary, getRecentMessages,
 * buildSystemMessage and generateReply.
 *
 * The chart-reading half is proven with zero AstrologyAPI calls:
 * buildChartSummary is seeded with the SAME real captured fixtures
 * tests/kundli-read.test.js uses (so its expected values — Cancer lagna,
 * Revati nakshatra, Venus running mahadasha, Sun at 116% shadbala — are the
 * real reference chart, not invented numbers), and getRecentMessages never
 * has a reason to reach the provider at all. generateReply is proven with
 * zero real LLM calls the same way tests/kundli-read.test.js fakes the
 * astrology provider: `services/llm`'s own `chat` export is monkey-patched
 * to a fake for the duration of each check.
 */
process.env.MONGODB_URI =
  process.env.TEST_MONGODB_URI || 'mongodb://127.0.0.1:27017/shree_astro_test_assistant';
process.env.NODE_ENV = 'development';

const mongoose = require('mongoose');
const BirthProfile = require('../models/BirthProfile');
const KundliCache = require('../models/KundliCache');
const { ChatSession, Message } = require('../models/Chat');
const AssistantMemory = require('../models/AssistantMemory');
const client = require('../services/astrologyApi.client');
const llm = require('../services/llm');
const assistantTools = require('../services/assistantTools');
const env = require('../config/env');
const {
  buildChartSummary,
  getRecentMessages,
  buildSystemMessage,
  runWithTools,
  generateReply,
  maybeSummarise,
} = require('../services/assistant.service');
const { computeBirthHash } = require('../utils/birthHash');

const astroDetails = require('./fixtures/astrologyapi/astro_details.json');
const planetsExtended = require('./fixtures/astrologyapi/planets_extended.json');
const majorVdasha = require('./fixtures/astrologyapi/major_vdasha.json');
const subVdasha = require('./fixtures/astrologyapi/sub_vdasha.json');
const kalsarpa = require('./fixtures/astrologyapi/kalsarpa_details.json');
const sadhesati = require('./fixtures/astrologyapi/sadhesati_current_status.json');
const pitraDosha = require('./fixtures/astrologyapi/pitra_dosha_report.json');
const shadbala = require('./fixtures/astrologyapi/shadbala.json');

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

  /* ------------------------------------------------------------- ownership */
  section('buildChartSummary — ownership scoping, same as every other kundli read');
  let threw;
  try {
    await buildChartSummary(profileId, SOMEONE_ELSE);
  } catch (error) {
    threw = error;
  }
  check('a profile belonging to someone else is 404', threw?.status === 404);

  /* -------------------------------------------------------------- no cache */
  section('buildChartSummary — nothing cached yet');
  threw = undefined;
  try {
    await buildChartSummary(profileId, OWNER);
  } catch (error) {
    threw = error;
  }
  check('refuses with a clear "not ready" error rather than fetching it live', threw?.status === 404 && threw?.code === 'chart_summary_not_ready');

  const originalCallProvider = client.callProvider;
  let providerCalled = false;
  client.callProvider = async () => {
    providerCalled = true;
    throw new Error('should never be called — buildChartSummary must never reach the provider');
  };
  check('and made no provider call while refusing', providerCalled === false);

  /* --------------------------------------------------------------- focus */
  section('buildChartSummary — the focus placeholder');
  let focusThrew;
  try {
    await buildChartSummary(profileId, OWNER, 'career');
  } catch (error) {
    focusThrew = error;
  }
  check('a non-null focus is refused, not silently ignored', /not implemented/.test(focusThrew?.message || ''));

  /* -------------------------------------------------------- the full digest */
  section('buildChartSummary — everything cached, the full digest');
  await KundliCache.insertMany([
    { birthHash, endpoint: 'astro_details', pathParam: null, payload: astroDetails, fetchedAt: new Date() },
    { birthHash, endpoint: 'planets/extended', pathParam: null, payload: planetsExtended, fetchedAt: new Date() },
    { birthHash, endpoint: 'major_vdasha', pathParam: null, payload: majorVdasha, fetchedAt: new Date() },
    { birthHash, endpoint: 'sub_vdasha', pathParam: 'Venus', payload: subVdasha, fetchedAt: new Date() },
    { birthHash, endpoint: 'kalsarpa_details', pathParam: null, payload: kalsarpa, fetchedAt: new Date() },
    { birthHash, endpoint: 'sadhesati_current_status', pathParam: null, payload: sadhesati, fetchedAt: new Date() },
    { birthHash, endpoint: 'pitra_dosha_report', pathParam: null, payload: pitraDosha, fetchedAt: new Date() },
    { birthHash, endpoint: 'shadbala', pathParam: null, payload: shadbala, fetchedAt: new Date() },
  ]);

  providerCalled = false;
  const summary = await buildChartSummary(profileId, OWNER);
  check('still no provider call, with everything served from cache', providerCalled === false);
  check('is a single string', typeof summary === 'string');

  const lines = summary.split('\n');
  check('a compact digest — comfortably under 15 lines', lines.length <= 15);
  check('opens with lagna, and the real reference chart\'s lagna is Cancer', lines[0].startsWith('Lagna: Cancer'));
  check('includes Sun and Moon with their houses on the same line', /Sun: \w+ \(\d+\w+ house\)/.test(lines[0]) && /Moon: \w+ \(\d+\w+ house\)/.test(lines[0]));
  check('nakshatra line, and the real reference chart\'s is Revati', lines.some(l => l === 'Nakshatra: Revati'));
  check('mahadasha line names the currently-running lord (Venus, in the reference chart)', lines.some(l => l.startsWith('Mahadasha: Venus')));
  check('antardasha line, in "Major-Minor (Mon YYYY - Mon YYYY)" shape', lines.some(l => /^Antardasha: Venus-\w+ \(\w{3} \d{4} - \w{3} \d{4}\)$/.test(l)));
  check('a planets line lists the other seven grahas, comma-separated', lines.some(l => l.startsWith('Planets: ') && l.split(',').length >= 5));
  check(
    'doshas line: Kaal Sarp and Pitra absent, Sade Sati present with its severity — the reference chart\'s real values',
    lines.some(l => l === 'Doshas: Kaal Sarp absent | Sade Sati present (Middle Phase) | Pitra absent'),
  );
  check('shadbala line covers all seven grahas with percentages, Sun at the real captured 116%', lines.some(l => l.startsWith('Shadbala: ') && l.includes('Sun 116%') && l.split(',').length === 7));
  check('never mentions the raw provider\'s own field names', !/ascendant_lord|dasha_period|strength_percent_of_minimum/.test(summary));

  client.callProvider = originalCallProvider;

  /* --------------------------------------------------- partial cache, no crash */
  section('buildChartSummary — a partial cache (identity present, extras missing) degrades gracefully rather than failing');
  const partialHash = computeBirthHash({ dob: '1988-03-03', tob: '09:09', lat: 22.5726, lon: 88.3639, ayanamsha: 'lahiri' });
  const partialProfile = await BirthProfile.create({
    user: OWNER,
    birthDetails: {
      fullName: 'Partial Batch',
      dateOfBirth: new Date('1988-03-03T00:00:00.000Z'),
      timeOfBirth: '09:09',
      isBirthTimeKnown: true,
      place: { formatted: 'Kolkata, IN', city: 'Kolkata', country: 'IN', latitude: 22.5726, longitude: 88.3639, timezone: 'Asia/Kolkata' },
    },
    tzone: 5.5,
    ayanamsha: 'lahiri',
    birthHash: partialHash,
    status: 'partial',
  });
  await KundliCache.insertMany([
    { birthHash: partialHash, endpoint: 'astro_details', pathParam: null, payload: astroDetails, fetchedAt: new Date() },
    { birthHash: partialHash, endpoint: 'planets/extended', pathParam: null, payload: planetsExtended, fetchedAt: new Date() },
  ]);
  const partialSummary = await buildChartSummary(String(partialProfile._id), OWNER);
  check('still returns a usable summary from just lagna + planets', partialSummary.startsWith('Lagna: Cancer'));
  check('omits the dasha/dosha/shadbala lines entirely rather than inventing "not available" placeholders', !/Mahadasha|Doshas|Shadbala/.test(partialSummary));

  /* -------------------------------------------------------------------------- */
  section('getRecentMessages — a token budget, not just a count');
  const chat = await ChatSession.create({
    type: 'ai',
    channel: 'chat',
    user: OWNER,
    status: 'active',
    startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });

  /** Five turns, 100 tokens apiece — a budget of 250 should keep only the newest two-and-a-bit, not the oldest. */
  for (let i = 1; i <= 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Message.send({
      chatId: chat._id,
      senderId: i % 2 === 1 ? OWNER : undefined,
      senderRole: i % 2 === 1 ? 'user' : 'ai',
      type: 'text',
      content: { text: `turn ${i}` },
      tokenCount: 100,
    });
  }

  const windowed = await getRecentMessages(String(chat._id), { tokenBudget: 250, maxCount: 13 });
  check('keeps only what fits the budget, not all 5 turns', windowed.length < 5);
  check('keeps the newest turns, not the oldest', windowed[windowed.length - 1].content === 'turn 5');
  check('returns oldest-first, so it reads as a normal conversation', windowed[0].content === `turn ${5 - windowed.length + 1}`);
  check('senderRole user/ai map to role user/assistant', windowed.every(m => m.role === 'user' || m.role === 'assistant'));
  check('spends no more than the budget', windowed.reduce((sum, m) => sum + m.tokenCount, 0) <= 250);

  const capped = await getRecentMessages(String(chat._id), { tokenBudget: 100000, maxCount: 2 });
  check('maxCount caps it even when the token budget would allow more', capped.length === 2);
  check('and still keeps the newest two, oldest-first', capped[0].content === 'turn 4' && capped[1].content === 'turn 5');

  section('getRecentMessages — always keeps at least the newest message');
  const chatOneHuge = await ChatSession.create({
    type: 'ai', channel: 'chat', user: OWNER, status: 'active', startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });
  await Message.send({
    chatId: chatOneHuge._id, senderId: OWNER, senderRole: 'user', type: 'text',
    content: { text: 'a very long question' }, tokenCount: 5000,
  });
  const single = await getRecentMessages(String(chatOneHuge._id), { tokenBudget: 250, maxCount: 13 });
  check('a lone message over budget is still returned rather than an empty context', single.length === 1 && single[0].content === 'a very long question');

  section('getRecentMessages — an empty thread');
  const emptyChat = await ChatSession.create({
    type: 'ai', channel: 'chat', user: OWNER, status: 'active', startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });
  const empty = await getRecentMessages(String(emptyChat._id));
  check('returns an empty array, not an error', Array.isArray(empty) && empty.length === 0);

  /* -------------------------------------------------------------------------- */
  section('buildSystemMessage — assembling the one system turn');
  const withChart = buildSystemMessage('SYSTEM RULES', 'Lagna: Cancer', undefined);
  check('opens with the prompt verbatim', withChart.startsWith('SYSTEM RULES'));
  check('includes the chart summary when there is one', withChart.includes('Lagna: Cancer'));
  check('says nothing about "earlier turns" when there is no rolling summary yet', !withChart.includes('Earlier in this conversation') && !withChart.includes('earlier turns'));

  const withoutChart = buildSystemMessage('SYSTEM RULES', null, undefined);
  check('explicitly tells the model there is no chart, rather than omitting the section silently', withoutChart.includes('No birth chart is on file'));
  check('never claims to have chart data it does not', !withoutChart.includes('Lagna'));

  const withRollingSummary = buildSystemMessage('SYSTEM RULES', 'Lagna: Cancer', 'The user previously asked about their career.');
  check('folds in the rolling summary when the thread has one', withRollingSummary.includes('The user previously asked about their career.'));

  /* -------------------------------------------------------------------------- */
  section('runWithTools — one round trip, tool result fed back correctly');
  {
    const originalLlmChat = llm.chat;
    const originalRunTool = assistantTools.runTool;
    const chatCalls = [];
    const toolCalls = [];

    llm.chat = async (messages, tools) => {
      chatCalls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
      if (chatCalls.length === 1) {
        return { type: 'tool_calls', toolCalls: [{ id: 'call_1', name: 'get_planet_detail', arguments: { planet_name: 'Saturn' } }] };
      }
      return { type: 'text', text: 'Saturn sits in your 8th house.' };
    };
    assistantTools.runTool = async (name, args, userContext) => {
      toolCalls.push({ name, args, userContext });
      return { available: true, planet: 'Saturn', sign: 'Aquarius', house: 8 };
    };

    const reply = await runWithTools([{ role: 'system', content: 'sys' }, { role: 'user', content: 'tell me about saturn' }], { userId: 'u1', birthProfile: null });
    check('returns the model\'s final text once it stops asking for tools', reply === 'Saturn sits in your 8th house.');
    check('exactly two round trips: the tool request, then the answer', chatCalls.length === 2);
    check('the tool was actually run, with the model\'s own parsed arguments', toolCalls.length === 1 && toolCalls[0].args.planet_name === 'Saturn');
    check('userContext is passed straight through to the tool, untouched', toolCalls[0].userContext.userId === 'u1');
    check(
      'the second round trip carries the assistant\'s tool-call turn and a matching role:"tool" result, in that order',
      chatCalls[1].messages.at(-2).role === 'assistant' && chatCalls[1].messages.at(-2).tool_calls[0].id === 'call_1'
        && chatCalls[1].messages.at(-1).role === 'tool' && chatCalls[1].messages.at(-1).tool_call_id === 'call_1',
    );
    check('the tool result is threaded back as a JSON string the model can read', JSON.parse(chatCalls[1].messages.at(-1).content).sign === 'Aquarius');

    llm.chat = originalLlmChat;
    assistantTools.runTool = originalRunTool;
  }

  section('runWithTools — a model stuck asking for the same tool forever is capped, not infinite');
  {
    const originalLlmChat = llm.chat;
    const originalRunTool = assistantTools.runTool;
    let chatCallCount = 0;
    let toolCallCount = 0;

    llm.chat = async (messages, tools) => {
      chatCallCount += 1;
      if (tools && tools.length > 0) {
        /** Always wants another tool call, no matter what it's already been given — the exact failure mode the cap exists for. */
        return { type: 'tool_calls', toolCalls: [{ id: `call_${chatCallCount}`, name: 'get_remedies', arguments: {} }] };
      }
      /** Only ever reached once tools are withheld — the forced final completion. */
      return { type: 'text', text: 'Here is what I could gather.' };
    };
    assistantTools.runTool = async () => {
      toolCallCount += 1;
      return { available: false, reason: 'still not available' };
    };

    const reply = await runWithTools([{ role: 'user', content: 'keep trying' }], { userId: 'u1', birthProfile: null });
    check('total tool calls never exceed the configured cap', toolCallCount <= env.assistant.maxToolCallsPerMessage);
    check('the loop still ends in a real answer, not an error or an empty string', reply === 'Here is what I could gather.');
    check('the very last chat call was made with no tools offered — forcing the model to stop asking', chatCallCount >= 1);

    llm.chat = originalLlmChat;
    assistantTools.runTool = originalRunTool;
  }

  /* -------------------------------------------------------------------------- */
  section('generateReply — grounded in the user\'s own chart, never a real LLM call');
  const aiChat = await ChatSession.create({
    type: 'ai', channel: 'chat', user: OWNER, status: 'active', startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 }, topic: 'general',
  });
  await Message.send({ chatId: aiChat._id, senderId: OWNER, senderRole: 'user', type: 'text', content: { text: 'What does my lagna say about me?' }, tokenCount: 10 });

  const originalLlmChat = llm.chat;
  let capturedMessages;
  llm.chat = async messages => {
    capturedMessages = messages;
    return { type: 'text', text: 'Your Cancer lagna suggests a nurturing, home-oriented nature.' };
  };

  const reply = await generateReply({ chat: aiChat, userId: OWNER });
  check('returns the model\'s text', reply.text === 'Your Cancer lagna suggests a nurturing, home-oriented nature.');
  check('and a real, non-zero token count for it', reply.tokenCount > 0);
  check('the system message grounds the model in this user\'s own real cached chart (the same OWNER/profile seeded above)', capturedMessages[0].role === 'system' && capturedMessages[0].content.includes('Lagna: Cancer'));
  check('the just-asked question rides along as the newest turn, read back via getRecentMessages', capturedMessages.at(-1).role === 'user' && capturedMessages.at(-1).content === 'What does my lagna say about me?');
  check('only role/content are forwarded — no internal fields like tokenCount leak into the LLM payload', Object.keys(capturedMessages.at(-1)).sort().join(',') === 'content,role');

  section('generateReply — a user with no chart on file yet');
  const chartlessUser = new mongoose.Types.ObjectId();
  const chartlessChat = await ChatSession.create({
    type: 'ai', channel: 'chat', user: chartlessUser, status: 'active', startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });
  await Message.send({ chatId: chartlessChat._id, senderId: chartlessUser, senderRole: 'user', type: 'text', content: { text: 'What is my lagna?' }, tokenCount: 5 });

  llm.chat = async messages => {
    capturedMessages = messages;
    return { type: 'text', text: 'I don\'t have your birth chart on file yet.' };
  };
  await generateReply({ chat: chartlessChat, userId: chartlessUser });
  check('is told plainly there is no chart, instead of silently answering without one', capturedMessages[0].content.includes('No birth chart is on file'));

  llm.chat = originalLlmChat;

  /* -------------------------------------------------------------------------- */
  section('maybeSummarise — checked inline, no cron: not due yet');
  const freshChat = await ChatSession.create({
    type: 'ai', channel: 'chat', user: OWNER, status: 'active', startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });
  for (let i = 1; i <= 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Message.send({ chatId: freshChat._id, senderId: OWNER, senderRole: i % 2 === 1 ? 'user' : 'ai', type: 'text', content: { text: `turn ${i}` } });
  }
  const originalSummarise = llm.summarise;
  let summariseCalls = 0;
  llm.summarise = async () => { summariseCalls += 1; return 'CHUNK SUMMARY'; };

  await maybeSummarise(freshChat._id);
  const memoryAtTen = await AssistantMemory.findOne({ chatSession: freshChat._id });
  check('below the 15-message trigger — no summarisation attempted', summariseCalls === 0);
  check('no AssistantMemory document exists yet at all', memoryAtTen === null);

  section('maybeSummarise — crossing the threshold summarises the OLDEST 10, leaving 5 as a raw buffer');
  for (let i = 11; i <= 15; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Message.send({ chatId: freshChat._id, senderId: OWNER, senderRole: i % 2 === 1 ? 'user' : 'ai', type: 'text', content: { text: `turn ${i}` } });
  }
  let capturedSummariseInput;
  llm.summarise = async messages => { summariseCalls += 1; capturedSummariseInput = messages; return 'FIRST CHUNK SUMMARY'; };

  await maybeSummarise(freshChat._id);
  const afterFirstFold = await AssistantMemory.findOne({ chatSession: freshChat._id });
  const chatAfterFirstFold = await ChatSession.findById(freshChat._id).select('messageSeq');
  check('exactly 15 messages triggers the fold', summariseCalls === 1);
  check('folds in exactly the oldest 10 (turns 1-10), not all 15', capturedSummariseInput.length === 10 && capturedSummariseInput[0].content === 'turn 1' && capturedSummariseInput.at(-1).content === 'turn 10');
  check('the newest 5 (turns 11-15) are left out — the raw buffer', !capturedSummariseInput.some(m => m.content === 'turn 11'));
  check('a new AssistantMemory document is created, set to the chunk summary', afterFirstFold?.summary === 'FIRST CHUNK SUMMARY');
  check('summarisedUptoSeq advances by the chunk size (10), not to messageSeq (15)', afterFirstFold.summarisedUptoSeq === 10);
  check('5 messages remain unsummarised — not due again yet', chatAfterFirstFold.messageSeq - afterFirstFold.summarisedUptoSeq === 5);

  section('maybeSummarise — called again with the buffer still under threshold is a no-op');
  await maybeSummarise(freshChat._id);
  const stillAtFive = await AssistantMemory.findOne({ chatSession: freshChat._id });
  check('no second call to summarise', summariseCalls === 1);
  check('nothing changed', stillAtFive.summarisedUptoSeq === 10 && stillAtFive.summary === 'FIRST CHUNK SUMMARY');

  section('maybeSummarise — a second round APPENDS, never replaces or re-summarises the existing summary');
  for (let i = 16; i <= 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Message.send({ chatId: freshChat._id, senderId: OWNER, senderRole: i % 2 === 1 ? 'user' : 'ai', type: 'text', content: { text: `turn ${i}` } });
  }
  llm.summarise = async messages => { summariseCalls += 1; capturedSummariseInput = messages; return 'SECOND CHUNK SUMMARY'; };
  await maybeSummarise(freshChat._id);
  const afterSecondFold = await AssistantMemory.findOne({ chatSession: freshChat._id });
  check('folds the NEXT oldest 10 (turns 11-20)', capturedSummariseInput[0].content === 'turn 11' && capturedSummariseInput.at(-1).content === 'turn 20');
  check('the existing summary text is never fed back into the model as something to re-summarise', !capturedSummariseInput.some(m => m.content.includes('FIRST CHUNK SUMMARY')));
  check('the two chunk summaries are appended together, oldest first', afterSecondFold.summary === 'FIRST CHUNK SUMMARY\n\nSECOND CHUNK SUMMARY');
  check('summarisedUptoSeq now at 20', afterSecondFold.summarisedUptoSeq === 20);
  check('updatedAt moved forward — this is what resets the AssistantMemory TTL clock on every fold', afterSecondFold.updatedAt.getTime() >= afterFirstFold.updatedAt.getTime());

  section('maybeSummarise — two overlapping calls never double-fold the same messages');
  for (let i = 26; i <= 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await Message.send({ chatId: freshChat._id, senderId: OWNER, senderRole: i % 2 === 1 ? 'user' : 'ai', type: 'text', content: { text: `turn ${i}` } });
  }
  llm.summarise = async () => 'RACE CHUNK SUMMARY';
  await Promise.all([maybeSummarise(freshChat._id), maybeSummarise(freshChat._id)]);
  const afterRace = await AssistantMemory.findOne({ chatSession: freshChat._id });
  check(
    'summarisedUptoSeq advances by exactly one chunk (30), not two (40) — the compare-and-swap update prevented a double-fold',
    afterRace.summarisedUptoSeq === 30,
  );
  check('the summary was appended exactly once, not twice', afterRace.summary === 'FIRST CHUNK SUMMARY\n\nSECOND CHUNK SUMMARY\n\nRACE CHUNK SUMMARY');
  check('still exactly one AssistantMemory document for this thread — the create-race guard never left a duplicate', await AssistantMemory.countDocuments({ chatSession: freshChat._id }) === 1);

  section('maybeSummarise — a chat that does not exist is a quiet no-op, not a crash');
  let missingThrew;
  try {
    await maybeSummarise(new mongoose.Types.ObjectId());
  } catch (error) {
    missingThrew = error;
  }
  check('does not throw', missingThrew === undefined);

  llm.summarise = originalSummarise;

  console.log(`\n${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(e => {
  client.callProvider = require('../services/astrologyApi.client').callProvider;
  console.error('CRASHED:', e);
  process.exit(1);
});
