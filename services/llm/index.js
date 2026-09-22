/**
 * The swappable door every LLM call in the app goes through.
 *
 * services/assistant.service.js never imports a specific provider file
 * directly — it calls `chat`/`summarise` here, and `LLM_PROVIDER` decides
 * which real file answers. Adding a provider later (e.g. 'openai', once the
 * plan moves off Groq's free tier — see services/llm/groq.js's own header
 * comment) is one new file plus one line in PROVIDERS below; nothing that
 * calls this module ever needs to change.
 */

const env = require('../../config/env');

const PROVIDERS = {
  groq: () => require('./groq'),
};

/** Resolved on every call, not once at import — so a test can flip `env.assistant.llmProvider` and see it take effect immediately, and the app never gets stuck on whatever provider happened to be configured at boot. */
function resolveProvider() {
  const name = env.assistant.llmProvider;
  const load = PROVIDERS[name];
  if (!load) {
    throw new Error(
      `LLM_PROVIDER "${name}" is not configured — set it to one of: ${Object.keys(PROVIDERS).join(', ') || '(none built yet)'}.`,
    );
  }
  return load();
}

async function chat(...args) {
  return resolveProvider().chat(...args);
}

async function summarise(...args) {
  return resolveProvider().summarise(...args);
}

module.exports = { chat, summarise };
