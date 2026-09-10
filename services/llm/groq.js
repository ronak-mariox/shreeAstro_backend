/**
 * Groq — free-tier, OpenAI-wire-compatible chat completions. This is the
 * provider services/llm/index.js hands back for `LLM_PROVIDER=groq`.
 *
 * Built on the official `openai` SDK rather than a hand-rolled fetch client
 * (contrast services/astrologyApi.client.js): Groq's endpoint speaks the
 * exact same request/response shape OpenAI's does, so this file is also
 * almost exactly what services/llm/openai.js will look like once
 * `LLM_PROVIDER` moves to 'openai' later — that swap should mean deleting
 * the one `baseURL` override below, not a rewrite.
 *
 * `chat`/`summarise` both take an optional last `client` argument — the seam
 * tests use to inject a fake SDK-shaped object instead of a real one, playing
 * the same role `callProvider` does in services/kundliCache.service.js.
 */

const env = require('../../config/env');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';

let cachedClient = null;
/** Built lazily, and only once — so importing this file never requires a key to already be set; only actually calling it does. */
function defaultClient() {
  if (!cachedClient) {
    if (!env.assistant.llmApiKey) {
      throw new Error('LLM_API_KEY must be set to use the groq provider.');
    }
    // eslint-disable-next-line global-require
    const OpenAI = require('openai');
    cachedClient = new OpenAI({ apiKey: env.assistant.llmApiKey, baseURL: GROQ_BASE_URL });
  }
  return cachedClient;
}

function requireModel() {
  if (!env.assistant.llmModel) {
    throw new Error('LLM_MODEL must be set to use the groq provider.');
  }
  return env.assistant.llmModel;
}

/**
 * One turn: the assistant's system prompt, chart summary, rolling summary,
 * and recent messages in (assembled by the caller — this file knows nothing
 * about any of that shape, only the wire format) — either a plain text reply
 * or the tool call(s) the model wants run out.
 *
 * @param {Array<{role: 'system'|'user'|'assistant', content: string}>} messages
 * @param {Array<{type: 'function', function: {name: string, description?: string, parameters?: object}}>} [tools]
 * @param {object} [client] Overrides the real SDK client — the test seam.
 * @returns {Promise<
 *   | { type: 'text', text: string }
 *   | { type: 'tool_calls', toolCalls: Array<{ id: string, name: string, arguments: object }> }
 * >}
 */
async function chat(messages, tools = [], client = defaultClient()) {
  const model = requireModel();

  const response = await client.chat.completions.create({
    model,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
  });

  const message = response?.choices?.[0]?.message;
  if (!message) {
    throw new Error('groq: the completion came back with no message.');
  }

  if (message.tool_calls && message.tool_calls.length > 0) {
    return {
      type: 'tool_calls',
      toolCalls: message.tool_calls.map(call => ({
        id: call.id,
        name: call.function.name,
        /** The model's own arguments are a JSON string, not always valid — an empty object is a safer failure than a thrown parse error mid-reply. */
        arguments: safeParseJson(call.function.arguments),
      })),
    };
  }

  return { type: 'text', text: message.content || '' };
}

function safeParseJson(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

/**
 * Folds a chunk of raw messages into a short summary — used by
 * services/assistant.service.js's `maybeSummarise`. Never re-summarises an
 * existing summary (see models/AssistantMemory.js) — this only ever sees
 * raw turns, never a previous summary's own text.
 *
 * @param {Array<{role: 'user'|'assistant', content: string}>} messages
 * @param {object} [client] Overrides the real SDK client — the test seam.
 * @returns {Promise<string>}
 */
async function summarise(messages, client = defaultClient()) {
  const model = requireModel();

  const transcript = messages.map(m => `${m.role}: ${m.content}`).join('\n');
  const response = await client.chat.completions.create({
    model,
    messages: [
      {
        role: 'system',
        content:
          'Summarise the following conversation chunk in a few concise sentences. ' +
          'Keep concrete facts — names, dates, numbers, decisions — and drop pleasantries. ' +
          'Do not add commentary or a preamble.',
      },
      { role: 'user', content: transcript },
    ],
  });

  return response?.choices?.[0]?.message?.content?.trim() || '';
}

module.exports = { chat, summarise };
