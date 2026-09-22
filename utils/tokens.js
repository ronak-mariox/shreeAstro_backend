/**
 * A cheap, provider-agnostic token estimate.
 *
 * This is not a real tokenizer — it doesn't know Claude's or GPT's actual
 * vocabulary — and it doesn't need to. It exists purely so
 * services/assistant.service.js's `getRecentMessages` can spend a *budget*
 * against message history without a network round trip or a heavy
 * dependency, and without re-estimating the same stored message twice (see
 * `Message.tokenCount`, computed once at send time). Being off by 20% here
 * only ever costs a slightly smaller or larger context window, never a wrong
 * answer — so a rough heuristic is the right tool, not a real tokenizer.
 *
 * ~4 characters per token is the commonly-cited average for English text
 * across both GPT and Claude's tokenizers; this rounds up so the estimate
 * errs toward "spends more budget than it needs to" rather than the reverse.
 */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  const value = String(text ?? '');
  if (value.length === 0) {
    return 0;
  }
  return Math.ceil(value.length / CHARS_PER_TOKEN);
}

module.exports = { estimateTokens };
