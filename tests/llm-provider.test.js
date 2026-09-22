/**
 * services/llm/index.js (the swappable door) and services/llm/groq.js (the
 * one provider built so far), proven entirely against a fake SDK client —
 * no real Groq/OpenAI call happens anywhere in this file, and none of it
 * needs a database either.
 */
process.env.NODE_ENV = 'development';

const env = require('../config/env');
const llm = require('../services/llm');
const groq = require('../services/llm/groq');

let pass = 0, fail = 0;
const check = (l, ok, extra) => {
  if (ok) { pass += 1; console.log(`  ok   ${l}`); }
  else { fail += 1; console.log(`  FAIL ${l}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`); }
};
const section = t => console.log(`\n=== ${t} ===`);

/** A fake OpenAI-SDK-shaped client — the seam both groq.chat/summarise and llm.chat/summarise accept as their last argument. */
function fakeClient(reply) {
  const calls = [];
  const fn = async request => {
    calls.push(request);
    return typeof reply === 'function' ? reply(request) : reply;
  };
  return { chat: { completions: { create: fn } }, calls };
}

const textReply = text => ({ choices: [{ message: { role: 'assistant', content: text, tool_calls: undefined } }] });
const toolCallReply = calls => ({
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((c, i) => ({ id: `call_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })),
    },
  }],
});

(async () => {
  const originalProvider = env.assistant.llmProvider;
  const originalKey = env.assistant.llmApiKey;
  const originalModel = env.assistant.llmModel;

  /* -------------------------------------------------------------------------- */
  section('services/llm/index.js — provider selection');
  env.assistant.llmProvider = '';
  let threw;
  try {
    await llm.chat([{ role: 'user', content: 'hi' }]);
  } catch (error) {
    threw = error;
  }
  check('an unset LLM_PROVIDER refuses with a clear error', /not configured/.test(threw?.message || ''));

  env.assistant.llmProvider = 'chatgpt-5-pro-max';
  threw = undefined;
  try {
    await llm.chat([{ role: 'user', content: 'hi' }]);
  } catch (error) {
    threw = error;
  }
  check('an unknown LLM_PROVIDER also refuses, naming what is actually configured', /chatgpt-5-pro-max/.test(threw?.message || ''));

  env.assistant.llmProvider = 'groq';
  env.assistant.llmModel = 'llama-3.3-70b-versatile';
  const client = fakeClient(textReply('Namaste! Your lagna is Cancer.'));
  const viaIndex = await llm.chat([{ role: 'user', content: 'what is my lagna' }], [], client);
  check('LLM_PROVIDER=groq routes llm.chat through services/llm/groq.js', viaIndex.type === 'text' && viaIndex.text === 'Namaste! Your lagna is Cancer.');
  check('the request actually reached the fake client (proves the wiring, not just a mock returning early)', client.calls.length === 1);

  /* -------------------------------------------------------------------------- */
  section('groq.chat — a plain text reply');
  env.assistant.llmModel = 'llama-3.3-70b-versatile';
  const textClient = fakeClient(textReply('Your Jupiter mahadasha runs until 2031.'));
  const textResult = await groq.chat([{ role: 'system', content: 'sys' }, { role: 'user', content: 'when does my mahadasha end' }], [], textClient);
  check('returns type: text', textResult.type === 'text');
  check('carries the model\'s content through unchanged', textResult.text === 'Your Jupiter mahadasha runs until 2031.');
  check('the model name from env was sent', textClient.calls[0].model === 'llama-3.3-70b-versatile');
  check('no tools key is sent when none are given', !('tools' in textClient.calls[0]));

  section('groq.chat — a tool-call reply');
  const toolClient = fakeClient(toolCallReply([{ name: 'get_daily_horoscope', arguments: {} }, { name: 'get_planet_detail', arguments: { planet: 'Saturn' } }]));
  const tools = [{ type: 'function', function: { name: 'get_daily_horoscope', description: 'Today\'s horoscope for the user\'s sun sign.' } }];
  const toolResult = await groq.chat([{ role: 'user', content: 'how is saturn placed, and what does today look like' }], tools, toolClient);
  check('returns type: tool_calls', toolResult.type === 'tool_calls');
  check('one entry per tool call, in order', toolResult.toolCalls.length === 2 && toolResult.toolCalls[0].name === 'get_daily_horoscope' && toolResult.toolCalls[1].name === 'get_planet_detail');
  check('arguments are parsed from the JSON string into a real object', toolResult.toolCalls[1].arguments.planet === 'Saturn');
  check('the tools list was actually forwarded to the client', Array.isArray(toolClient.calls[0].tools) && toolClient.calls[0].tools[0].function.name === 'get_daily_horoscope');

  section('groq.chat — a tool call with malformed arguments never crashes the turn');
  const badJsonClient = fakeClient({
    choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_remedies', arguments: 'not valid json{{' } }] } }],
  });
  const badJsonResult = await groq.chat([{ role: 'user', content: 'remedies please' }], [], badJsonClient);
  check('falls back to an empty object rather than throwing', JSON.stringify(badJsonResult.toolCalls[0].arguments) === '{}');

  section('groq.summarise');
  const summariseClient = fakeClient(textReply('The user asked about their career house and Saturn placement.'));
  const summary = await groq.summarise(
    [{ role: 'user', content: 'tell me about my career' }, { role: 'assistant', content: 'Your 10th house...' }],
    summariseClient,
  );
  check('returns the model\'s summary text, trimmed', summary === 'The user asked about their career house and Saturn placement.');
  check('sends a system instruction plus the transcript as one user turn — never re-summarising a prior summary, only ever raw turns passed in', summariseClient.calls[0].messages.length === 2 && summariseClient.calls[0].messages[0].role === 'system');

  section('groq — missing configuration fails before ever touching the client');
  const untouchedClient = fakeClient(textReply('should never be reached'));
  const realCreate = untouchedClient.chat.completions.create;
  let callCountBefore = 0;
  untouchedClient.chat.completions.create = async (...a) => { callCountBefore += 1; return realCreate(...a); };

  env.assistant.llmModel = '';
  let modelThrew;
  try {
    await groq.chat([{ role: 'user', content: 'hi' }], [], untouchedClient);
  } catch (error) {
    modelThrew = error;
  }
  check('a missing LLM_MODEL throws a clear error', /LLM_MODEL/.test(modelThrew?.message || ''));
  check('and never calls the client at all', callCountBefore === 0);

  env.assistant.llmModel = originalModel;
  env.assistant.llmApiKey = originalKey;
  env.assistant.llmProvider = originalProvider;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('CRASHED:', e);
  process.exit(1);
});
