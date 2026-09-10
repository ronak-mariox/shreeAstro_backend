/**
 * The AI assistant's rolling summary — split out of ChatSession specifically
 * so it can carry its own 7-day MongoDB TTL index.
 *
 * ChatSession is the AI thread's permanent identity (chat.service.js's
 * getOrCreateAiChat finds-or-creates by it, every Message references it, the
 * transcript API pages through it) and must never itself expire. A TTL index
 * always deletes the *whole* document it's on — there is no way to expire
 * just one field of a document that otherwise has to survive — so the only
 * way to give the rolling summary its own 7-day lifecycle without also
 * wiping the thread underneath it is to keep it in a document of its own.
 *
 * TTL semantics here are "expires after 7 days with no new fold", not "each
 * chunk of the summary ages out on its own clock" — the latter would need a
 * timestamp per chunk, turning this from a single string into a much bigger
 * structural change than the retention requirement calls for. Mongoose's
 * `timestamps: true` bumps `updatedAt` on every write, which is exactly what
 * resets the TTL clock: a thread being actively summarised (see
 * services/assistant.service.js's `maybeSummarise`) never lets this go
 * stale, because it is not stale data; one nobody has added to in 7 days is
 * removed by MongoDB itself, with no cron and no app code ever having to
 * notice or run.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const env = require('../config/env');

const assistantMemorySchema = new Schema(
  {
    /** One row per AI thread — findOne({ chatSession }) is the only lookup this is ever read by. */
    chatSession: { type: Schema.Types.ObjectId, ref: 'ChatSession', required: true, unique: true },
    /** Appended to, never replaced wholesale and never re-summarised — see services/assistant.service.js's maybeSummarise. */
    summary: { type: String, required: true },
    /** The Message.seq already folded in — anything after this is still in getRecentMessages' own raw window. */
    summarisedUptoSeq: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

/**
 * The entire retention mechanism for this collection — see the file header
 * for why `updatedAt` (not `createdAt`) is the right clock to use here.
 * Shares `env.assistant.messageRetentionDays` with models/Chat.js's own TTL
 * index — one number governs how long "the AI assistant's conversation
 * context" lives, in both of its forms. Same migration caveat as that index:
 * this is read once, when the index is first built; changing the env var
 * later does not retroactively rewrite an index Mongo already created.
 */
assistantMemorySchema.index({ updatedAt: 1 }, { expireAfterSeconds: env.assistant.messageRetentionDays * 24 * 60 * 60 });

module.exports =
  mongoose.models.AssistantMemory || mongoose.model('AssistantMemory', assistantMemorySchema);
