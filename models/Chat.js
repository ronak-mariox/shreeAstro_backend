/**
 * Chat — one conversation, and its messages.
 *
 * Flow: the seeker fills the intake and requests a chat → the astrologer
 * accepts from the incoming-request popup → the session goes active and bills
 * per minute → either side leaves → the seeker rates it.
 *
 * Every message is `{ chatId, senderId, type, content }`. The shape of
 * `content` is decided by `type` alone (see CONTENT_RULES), so a new kind of
 * message is one rule, not a schema change. Only `text` is switched on today;
 * `image`, `audio`, `video` and `file` are described but refused until the
 * upload pipeline is approved — enable one by adding it to ENABLED_TYPES.
 *
 * Socket.io: client emits SEND → server calls Message.send() → server emits NEW
 * to roomFor(chatId) with message.toSocketPayload(). `seq` orders the
 * transcript and is the cursor a reconnecting client resumes from;
 * `clientMessageId` makes a retried send safe. Typing indicators and socket ids
 * are not stored — they belong in memory, not in a document.
 *
 * Retention: the AI assistant's own messages carry a 7-day MongoDB TTL index
 * (see `chatType` and the index below) — a paid consultation's transcript
 * never does. The assistant's memory of anything that ages out of that
 * window lives separately, in models/AssistantMemory.js, with its own TTL —
 * see that file for why it isn't just a field on ChatSession.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const env = require('../config/env');
const { birthDetailsSchema } = require('./common');
const { TOPICS, CHANNELS } = require('./constants');

/** Event names in one place, so the server and both apps cannot drift. */
const CHAT_EVENTS = {
  JOIN: 'chat:join',
  LEAVE: 'chat:leave',
  SEND: 'message:send',
  NEW: 'message:new',
  DELIVERED: 'message:delivered',
  READ: 'message:read',
  TYPING: 'chat:typing',
  ENDED: 'session:ended',
  /** Server -> client only, from the live billing tick (services/chat.service.js / jobs/chatBilling.job.js). */
  TICK: 'chat:tick',
  LOW_BALANCE: 'chat:low_balance',
  /** Server -> client only, from the astrologer's own socket connecting/disconnecting while a session is active (services/chat.service.js's pauseSessionsForAstrologer/resumeSessionsForAstrologer). */
  ASTROLOGER_LEFT: 'chat:astrologer_left',
  ASTROLOGER_JOINED: 'chat:astrologer_joined',
  /** Server -> client only, package sessions (config/packages.js): ~30s left, time up (the extend prompt), extended, switched to per-minute. */
  PACKAGE_WARNING: 'chat:package_warning',
  PACKAGE_ENDED: 'chat:package_ended',
  PACKAGE_EXTENDED: 'chat:package_extended',
  PER_MINUTE_STARTED: 'chat:per_minute_started',
};

const roomFor = chatId => `chat:${chatId}`;

/* -------------------------------------------------------------------------- */
/* Message types                                                              */
/* -------------------------------------------------------------------------- */

const MESSAGE_TYPES = ['text', 'image', 'audio', 'file', 'system'];

/** What each type's `content` may hold — the whole extension point. */
const CONTENT_RULES = {
  text: { required: ['text'], optional: [] },
  image: { required: ['url'], optional: ['fileName', 'mimeType', 'size'] },
  audio: { required: ['url'], optional: ['duration', 'mimeType', 'size'] },
  video: { required: ['url'], optional: ['duration', 'fileName', 'mimeType', 'size'] },
  file: { required: ['url', 'fileName'], optional: ['mimeType', 'size'] },
  /** The server's own voice: started, low balance, ended. */
  system: { required: ['text'], optional: ['event'] },
};

/**
 * What may actually be sent. Media stays off until the picker, recorder and
 * upload pipeline are signed off; turning one on is exactly this:
 *
 *   const ENABLED_TYPES = ['text', 'system', 'image'];
 */
const ENABLED_TYPES = ['text', 'system'];

const SENDER_ROLES = ['user', 'astrologer', 'ai', 'system'];

/* -------------------------------------------------------------------------- */
/* Chat session                                                               */
/* -------------------------------------------------------------------------- */

const chatSessionSchema = new Schema(
  {
    /** `ai` threads have no astrologer on the other end. */
    type: { type: String, enum: ['consultation', 'ai'], default: 'consultation' },
    channel: { type: String, enum: CHANNELS, default: 'chat' },

    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    astrologer: { type: Schema.Types.ObjectId, ref: 'Astrologer', index: true },

    status: {
      type: String,
      /**
       * 'expired' is reserved for an idle `ai` thread — not currently set by
       * anything (there is no cron and no periodic sweep; the AI assistant's
       * own 7-day retention is a MongoDB TTL index instead, see Message's
       * `chatType` and models/AssistantMemory.js). A consultation never
       * reaches this value; it ends through the statuses above instead.
       */
      enum: ['requested', 'active', 'ended', 'rejected', 'missed', 'cancelled', 'expired'],
      default: 'requested',
      index: true,
    },

    /**
     * The AI assistant's own topic tag — unrelated to `intake.topic`'s
     * consultation-booking taxonomy below. Everything is 'general' today;
     * `services/assistant.service.js`'s `buildChartSummary` takes a matching
     * `focus` argument that will eventually read this to decide which chart
     * details to foreground (10th house for 'career', 7th for 'relationship',
     * etc.) — not implemented yet, so this is a placeholder for that.
     */
    topic: { type: String, trim: true, default: 'general' },

    /** What the seeker filled in before the request went out. */
    intake: {
      birthDetails: { type: birthDetailsSchema, default: () => ({}) },
      topic: { type: String, enum: TOPICS },
      question: { type: String, trim: true, maxlength: 1000 },
      minutesBooked: { type: Number, min: 0 },
    },

    /** Per-minute billing, kept on the session so a receipt needs no recompute. */
    billing: {
      /**
       * How the session was booked — never changes afterwards, so it stays
       * the record of what the seeker chose. A 'package' session that later
       * switches to per-minute keeps 'package' here; `packageState.perMinuteStartedAt`
       * is what marks the switch. The rate below is frozen at request time
       * and never re-read from the astrologer's live rate again — a rate
       * change mid-session must never affect a chat already in flight.
       */
      mode: { type: String, enum: ['per_minute', 'package'], default: 'per_minute' },
      ratePerMinute: { type: Number, default: 0, min: 0 },
      commissionPercent: { type: Number, default: 0, min: 0, max: 100 },
      amountCharged: { type: Number, default: 0, min: 0 },
      astrologerEarning: { type: Number, default: 0, min: 0 },
      isSettled: { type: Boolean, default: false },
      /** Package sessions only: the package asked for at request time — charged on accept, not before. */
      requestedPackageMinutes: { type: Number, min: 1 },
      /**
       * Package sessions only: every package bought on this session, initial
       * and extensions, in order. Mirrors ChatPackagePurchase (the ledger
       * that keeps them idempotent) so a receipt needs no join.
       */
      packages: {
        type: [
          new Schema(
            {
              seq: { type: Number, required: true, min: 1 },
              kind: { type: String, enum: ['initial', 'extension'], required: true },
              minutes: { type: Number, required: true, min: 1 },
              ratePerMinute: { type: Number, required: true, min: 0 },
              discountPercent: { type: Number, default: 0 },
              amount: { type: Number, required: true, min: 0 },
              walletTransaction: { type: Schema.Types.ObjectId, ref: 'WalletTransaction' },
              purchasedAt: { type: Date },
            },
            { _id: false },
          ),
        ],
        default: undefined,
      },
      /** Package sessions only: rupees charged for packages (a subset of amountCharged, which also includes any per-minute tail). */
      packageAmountCharged: { type: Number, default: 0, min: 0 },
      /**
       * Package sessions only: the astrologer's share of package money is
       * credited once, when the session ends (never per purchase), so a
       * future unused-minutes refund never has to claw back money they may
       * already have withdrawn. Set atomically before the credit so it can
       * never be paid twice.
       */
      packageEarningSettled: { type: Boolean, default: false },
      /** Package sessions only: what the refund policy hook returned at the end (config/packages.js's unusedPackageRefund). */
      packageRefundAmount: { type: Number, default: 0, min: 0 },
    },

    /**
     * Where a package session's clock stands. All server-side — the app only
     * displays `endsAt` against `serverTime` (see getSessionState).
     */
    packageState: {
      /** When the package time currently paid for runs out. */
      endsAt: { type: Date },
      /** Set once the ~30s "running out" warning has gone out for the current package. */
      warnedAt: { type: Date },
      /**
       * Set while the "Extend consultation?" prompt is open. The session is
       * frozen meanwhile (no messages, nothing charged); unanswered for
       * `packageExtensionResponseSeconds` it ends ('package_no_response').
       */
      promptedAt: { type: Date },
      /**
       * Set by the sweep the moment it claims an unanswered prompt for
       * ending — extend / continue-per-minute both refuse once this is set,
       * so an answer racing the timeout can never charge a session that is
       * being closed.
       */
      closingAt: { type: Date },
      /** Set when the seeker chose "Continue per-minute" — the normal per-minute meter runs from here. */
      perMinuteStartedAt: { type: Date },
      /** Package seconds paid for but not used when the session ended — the input to the refund policy. */
      unusedSeconds: { type: Number, min: 0 },
    },

    /**
     * How many minutes the live billing tick (services/chat.service.js's
     * billNextMinute, run by jobs/chatBilling.job.js) has already processed.
     * `endChat` bills anything beyond this up to the true elapsed time as one
     * final tick, so the total is always `minutesFor(actual elapsed
     * seconds)`, matching what a lump-sum settle-at-end would have charged —
     * just spread across the session instead of charged all at once when it
     * closes.
     */
    minutesBilled: { type: Number, default: 0, min: 0 },
    /** When the tick last ran for this session — a session with none yet is due immediately once active. */
    lastBilledAt: { type: Date },
    /** Set the moment a tick first can't afford the next minute — starts the grace period; cleared once the balance clears. */
    balanceExhaustedAt: { type: Date },
    /** Set once, so the proactive "2 minutes left" warning fires only once per session, not on every tick. */
    lowBalanceWarnedAt: { type: Date },
    /**
     * Set once the check-ahead phase (tickOneSession, `CHECK_AHEAD_SECONDS`
     * before the current minute is due) has already evaluated whether the
     * *next* minute is affordable — whichever way that came out — so the
     * sweep asks at most once per minute rather than on every 10-second pass
     * through the check-ahead window. Cleared every time a minute actually
     * bills (billOneMinute), so the following minute gets its own fresh check.
     */
    nextMinuteChecked: { type: Boolean, default: false },
    /**
     * Set the moment the astrologer's own socket drops entirely (their last
     * device, not just one of several — see socket/index.js) while this
     * session is active. Billing is paused the whole time this is set — the
     * tick job (runBillingSweep) skips a paused session rather than ticking
     * it — and cleared the moment they reconnect, which also pushes
     * `lastBilledAt` forward by exactly how long the pause lasted, so the
     * outage costs the seeker nothing. Never reconnecting within
     * `ASTROLOGER_RECONNECT_GRACE_SECONDS` ends the session instead (reason
     * 'astrologer_disconnected'), with the one minute in progress when they
     * dropped refunded — see chat.service.js's refundMinute.
     */
    astrologerDisconnectedAt: { type: Date },

    requestedAt: { type: Date, default: Date.now },
    startedAt: { type: Date },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0, min: 0 },
    endedBy: { type: String, enum: ['user', 'astrologer', 'system'] },
    endReason: { type: String, trim: true },

    /** The seeker's rating, and the astrologer's answer to it. */
    review: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true, maxlength: 1000 },
      ratedAt: { type: Date },
      reply: { type: String, trim: true, maxlength: 1000 },
      /** Raised by the astrologer as unfair, for an admin to look at. */
      flagged: { type: Boolean, default: false },
      flagReason: { type: String, trim: true },
      /** Held at the top of the astrologer's public profile. */
      pinned: { type: Boolean, default: false },
    },

    /** Counter handed to each message; ordering key and reconnect cursor. */
    messageSeq: { type: Number, default: 0, min: 0 },
    /** One line for the conversation list, without a join. */
    lastMessage: {
      preview: { type: String, trim: true, maxlength: 140 },
      type: { type: String, enum: MESSAGE_TYPES },
      senderRole: { type: String, enum: SENDER_ROLES },
      at: { type: Date },
    },
    /** Unread badge and read position, per side. */
    unread: {
      user: { type: Number, default: 0, min: 0 },
      astrologer: { type: Number, default: 0, min: 0 },
    },
    lastReadSeq: {
      user: { type: Number, default: 0, min: 0 },
      astrologer: { type: Number, default: 0, min: 0 },
    },
  },
  { timestamps: true },
);

/** History for either side, and the astrologer's pending-request queue. */
chatSessionSchema.index({ user: 1, createdAt: -1 });
chatSessionSchema.index({ astrologer: 1, status: 1, createdAt: -1 });

chatSessionSchema.statics.roomFor = roomFor;

/** Which side an account is on, or null when it is neither — the join gate. */
chatSessionSchema.methods.roleOf = function roleOf(accountId) {
  const id = String(accountId);
  if (String(this.user) === id) return 'user';
  if (this.astrologer && String(this.astrologer) === id) return 'astrologer';
  return null;
};

chatSessionSchema.methods.acceptsMessages = function acceptsMessages() {
  return this.status === 'active';
};

/**
 * Claims the next sequence number without reading first, so two sockets
 * sending at the same instant still get distinct, ordered numbers.
 *
 * Also hands back the chat's own `type` — Message.send needs it to stamp
 * the new message's `chatType` (see that field's own comment), and this
 * update already has the document in hand, so that's one lookup, not two.
 *
 * @returns {Promise<{ seq: number, chatType: 'consultation'|'ai' }>}
 */
chatSessionSchema.statics.reserveSeq = async function reserveSeq(chatId) {
  const chat = await this.findByIdAndUpdate(
    chatId,
    { $inc: { messageSeq: 1 } },
    { returnDocument: 'after', select: 'messageSeq type' },
  );
  if (!chat) throw new Error(`No chat ${chatId}`);
  return { seq: chat.messageSeq, chatType: chat.type };
};

const ChatSession =
  mongoose.models.ChatSession ||
  mongoose.model('ChatSession', chatSessionSchema);

/* -------------------------------------------------------------------------- */
/* Message                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The union of every type's payload. Mongoose casts and strips against this;
 * CONTENT_RULES then enforces which keys the message's own type may carry, so
 * an `image` can never arrive holding `text`. Media keys are declared now and
 * written later — nothing reads them yet.
 */
const contentSchema = new Schema(
  {
    text: { type: String, trim: true, maxlength: 5000 },
    url: { type: String, trim: true },
    fileName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    /** Bytes. */
    size: { type: Number, min: 0 },
    /** Seconds, for audio and video. */
    duration: { type: Number, min: 0 },
    /** system only — what happened, for the client to style the notice. */
    event: { type: String, trim: true },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    chatId: {
      type: Schema.Types.ObjectId,
      ref: 'ChatSession',
      required: true,
      index: true,
    },
    /** Unset on `system` turns; a User or Astrologer id otherwise. */
    senderId: { type: Schema.Types.ObjectId },
    senderRole: { type: String, enum: SENDER_ROLES, required: true },

    type: { type: String, enum: MESSAGE_TYPES, default: 'text', required: true },
    content: { type: contentSchema, required: true, default: () => ({}) },

    /** Position in the conversation. */
    seq: { type: Number, required: true, min: 1 },
    /** The bubble this one quotes. */
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message' },

    status: {
      type: String,
      enum: ['sent', 'delivered', 'read'],
      default: 'sent',
    },
    /** Client-generated id; the index below makes a retried send a no-op. */
    clientMessageId: { type: String, trim: true },
    isDeleted: { type: Boolean, default: false },

    /**
     * Set on the one message requestChat posts from the seeker's own filled-in
     * intake, the moment the request goes out (services/chat.service.js). Both
     * apps' chat screens use this to know which bubble may cast a chart —
     * astro_app's ConsultationChatScreen shows a "Generate Kundli" action on it.
     */
    isIntake: { type: Boolean, default: false },

    /**
     * Estimated once at write time (utils/tokens.js), for the AI assistant's
     * `getRecentMessages` to spend a token budget against without
     * re-tokenising the whole thread on every request. `undefined` on every
     * consultation message — only assistant turns ever set this.
     */
    tokenCount: { type: Number, min: 0 },

    /**
     * The parent ChatSession's own `type`, copied here at write time (see
     * ChatSession.reserveSeq) purely so the TTL index below can see it — a
     * partial-filter index can only test fields on the document it indexes,
     * never a joined parent, and a message never changes which chat it
     * belongs to, so this can never drift from the truth once set.
     */
    chatType: { type: String, enum: ['consultation', 'ai'], required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

/** The transcript read and the reconnect replay both run on this. */
messageSchema.index({ chatId: 1, seq: 1 }, { unique: true });
messageSchema.index(
  { chatId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);

/**
 * Retention for the AI assistant's own messages, and only those — a message
 * becomes eligible for automatic removal `env.assistant.messageRetentionDays`
 * (7) days after its own `createdAt`, regardless of anything else happening
 * in its thread. The `partialFilterExpression` scopes this to `chatType:
 * 'ai'` so a paid consultation's transcript (someone's own record of what
 * they were told and charged for) is never touched by it; a document
 * without a matching `chatType` at all (nothing today — see the field's own
 * comment — but relevant for any row written before this index existed) is
 * likewise left alone rather than silently swept up.
 *
 * No cron, no scheduled job: MongoDB's own TTL monitor does this by itself,
 * on its own internal schedule (roughly once a minute) — a message due at
 * 6:00:00pm is not guaranteed gone at exactly that instant, only sometime
 * after. Nothing that reads a Message should ever assume second-level
 * precision here.
 *
 * services/assistant.service.js's rolling summary is what keeps the *gist*
 * of anything this index removes — see models/AssistantMemory.js for why
 * that summary needs, and has, its own separate TTL.
 *
 * `expireAfterSeconds` is read from env at index-creation time only: it
 * becomes whatever this was when the index was first built, and changing
 * `CHAT_MESSAGE_RETENTION_DAYS` afterwards does not retroactively rewrite an
 * index Mongo already created with the old number — see this feature's own
 * migration note for how to change it on a running deployment.
 */
messageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: env.assistant.messageRetentionDays * 24 * 60 * 60, partialFilterExpression: { chatType: 'ai' } },
);

/** Keeps the union payload honest: right type, switched on, right keys. */
messageSchema.pre('validate', function validateContent() {
  const rule = CONTENT_RULES[this.type];
  if (!rule) {
    throw new Error(`Unknown message type "${this.type}".`);
  }
  if (!ENABLED_TYPES.includes(this.type)) {
    throw new Error(
      `Message type "${this.type}" is not enabled yet — add it to ENABLED_TYPES once its pipeline is ready.`,
    );
  }

  const content = this.content ? this.content.toObject() : {};
  const present = Object.keys(content).filter(key => content[key] != null);

  const missing = rule.required.filter(key => !present.includes(key));
  if (missing.length) {
    throw new Error(`A "${this.type}" message needs content.${missing.join(', content.')}.`);
  }

  const allowed = new Set([...rule.required, ...rule.optional]);
  const extra = present.filter(key => !allowed.has(key));
  if (extra.length) {
    throw new Error(`A "${this.type}" message cannot carry content.${extra.join(', content.')}.`);
  }
});

/** One line for the conversation list; media gets a glyph, not a URL. */
messageSchema.methods.preview = function preview() {
  const glyphs = { image: '📷 Photo', audio: '🎤 Voice message', video: '🎬 Video' };
  if (this.type === 'file') return `📎 ${this.content.fileName || 'Attachment'}`;
  return glyphs[this.type] || (this.content.text || '').slice(0, 140);
};

/** Exactly what goes over the wire. */
messageSchema.methods.toSocketPayload = function toSocketPayload() {
  return {
    id: String(this._id),
    chatId: String(this.chatId),
    senderId: this.senderId ? String(this.senderId) : null,
    senderRole: this.senderRole,
    type: this.type,
    content: this.content ? this.content.toObject() : {},
    seq: this.seq,
    replyTo: this.replyTo ? String(this.replyTo) : null,
    status: this.status,
    clientMessageId: this.clientMessageId,
    isIntake: this.isIntake,
    createdAt: this.createdAt,
  };
};

/** Whether a client may send this type — media is off, system is ours. */
messageSchema.statics.canSend = function canSend(type) {
  return ENABLED_TYPES.includes(type) && type !== 'system';
};

/**
 * The one write path a socket handler should call: stores the turn, then rolls
 * the chat's last message and the other side's unread badge forward. A resent
 * clientMessageId returns what is already stored instead of a duplicate.
 *
 *   const message = await Message.send({ chatId, senderId, senderRole: 'user',
 *     type: 'text', content: { text: 'Hello' }, clientMessageId });
 *   io.to(roomFor(chatId)).emit(CHAT_EVENTS.NEW, message.toSocketPayload());
 */
messageSchema.statics.send = async function send({
  chatId,
  senderId,
  senderRole,
  type = 'text',
  content,
  replyTo,
  clientMessageId,
  /** Only ever passed by services/assistant.service.js — see the schema field's own comment. */
  tokenCount,
  /** Only ever passed by requestChat, for the seeker's own opening message — see the schema field's own comment. */
  isIntake,
}) {
  if (clientMessageId) {
    const existing = await this.findOne({ chatId, clientMessageId });
    if (existing) return existing;
  }

  const { seq, chatType } = await ChatSession.reserveSeq(chatId);

  let message;
  try {
    message = await this.create({
      chatId, senderId, senderRole, type, content, replyTo, clientMessageId, seq, tokenCount, chatType, isIntake,
    });
  } catch (error) {
    /** Two sockets raced on the same clientMessageId; the first one wins. */
    if (error.code === 11000 && clientMessageId) {
      return this.findOne({ chatId, clientMessageId });
    }
    throw error;
  }

  const update = {
    $set: {
      lastMessage: {
        preview: message.preview(),
        type: message.type,
        senderRole: message.senderRole,
        at: message.createdAt,
      },
    },
  };
  /** The badge belongs to the other side; a system notice raises neither. */
  if (senderRole !== 'system') {
    const recipient = senderRole === 'user' ? 'astrologer' : 'user';
    update.$inc = { [`unread.${recipient}`]: 1 };
  }
  await ChatSession.updateOne({ _id: chatId }, update);

  return message;
};

/** A notice in the server's own voice, on the same event as any other message. */
messageSchema.statics.system = function system(chatId, text, event) {
  return this.send({ chatId, senderRole: 'system', type: 'system', content: { text, event } });
};

/** The reconnect replay: everything the client has not seen, in order. */
messageSchema.statics.since = function since(chatId, seq = 0, limit = 200) {
  return this.find({ chatId, seq: { $gt: seq }, isDeleted: false })
    .sort({ seq: 1 })
    .limit(limit);
};

/** One page of history, walking backwards from a cursor. */
messageSchema.statics.history = function history(chatId, beforeSeq, limit = 30) {
  const query = { chatId, isDeleted: false };
  if (beforeSeq) query.seq = { $lt: beforeSeq };
  return this.find(query).sort({ seq: -1 }).limit(limit);
};

/**
 * Moves the other side's ticks up to `seq`. Idempotent, so a replayed ack after
 * a reconnect costs nothing. `read` also clears that side's unread badge.
 */
messageSchema.statics.markSeen = async function markSeen(chatId, upToSeq, role, state = 'read') {
  await this.updateMany(
    { chatId, seq: { $lte: upToSeq }, senderRole: { $ne: role }, status: { $ne: 'read' } },
    { $set: { status: state } },
  );

  const update = { $set: { [`lastReadSeq.${role}`]: upToSeq } };
  if (state === 'read') update.$set[`unread.${role}`] = 0;
  return ChatSession.updateOne({ _id: chatId }, update);
};

const Message =
  mongoose.models.Message || mongoose.model('Message', messageSchema);

module.exports = {
  ChatSession,
  Message,
  CHAT_EVENTS,
  roomFor,
  MESSAGE_TYPES,
  ENABLED_TYPES,
  CONTENT_RULES,
  SENDER_ROLES,
};
