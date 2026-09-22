/**
 * Consultations: the whole life of one chat.
 *
 *   request   the seeker fills the intake and asks for a chat
 *   accept    the astrologer takes it (or rejects it, or lets it time out)
 *   active    messages flow, and the meter runs
 *   end       either side leaves; the wallet is charged and the astrologer paid
 *   rate      the seeker scores it
 *
 * Messages themselves are handled by the Message model (models/Chat.js). Every
 * message is `{ type, content }`, and only `text` is switched on today — see
 * ENABLED_TYPES there to turn on images or audio later.
 *
 * The socket handlers in socket/chat.handlers.js are only a transport over this
 * file, and the REST routes call the very same functions.
 */

const mongoose = require('mongoose');

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession, Message, CHAT_EVENTS, roomFor } = require('../models/Chat');
const ChatBillingTick = require('../models/ChatBillingTick');
const ChatPackagePurchase = require('../models/ChatPackagePurchase');
const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const walletService = require('./wallet.service');
const settingsService = require('./settings.service');
const notificationService = require('./notification.service');
const assistantService = require('./assistant.service');
const { parseBirthDate, parseBirthTime } = require('./auth.service');
const { minutesFor } = require('../utils/billing');
const {
  findPackage,
  originalPackagePrice,
  packagePrice,
  packageQuotes,
  unusedPackageSeconds,
  unusedPackageRefund,
} = require('../config/packages');
const { estimateTokens } = require('../utils/tokens');

const MONGO_DUPLICATE_KEY = 11000;

/** How long an unanswered request stays open, in seconds — config/env.js's `consultation.astrologerJoinTimeoutSeconds`. */
const REQUEST_TIMEOUT_SECONDS = env.consultation.astrologerJoinTimeoutSeconds;
/** A session may not start unless the seeker can afford at least this many minutes — pay-as-you-go billing only needs enough for the one minute charged upfront on accept. config/env.js's `consultation.minBalanceMinutes`. */
const MIN_SESSION_MINUTES = env.consultation.minBalanceMinutes;
/** "1 minute", "3 minutes" — never "1 minutes". */
const pluralMinutes = (count) => `${count} minute${count === 1 ? '' : 's'}`;
/** How often a session's meter turns — services/chat.service.js's runBillingSweep bills whichever active sessions are at least this overdue; see jobs/chatBilling.job.js for the real scheduler. Not itself a tunable — a "minute" is what "per-minute billing" means. */
const TICK_INTERVAL_MS = 60 * 1000;
/** Below this many minutes still affordable, the seeker is warned once (not on every tick) so they can top up before being cut off. */
const LOW_BALANCE_WARNING_MINUTES = 2;
/**
 * More than this much of a gap since the session's last successful tick means
 * the job (or the whole server) was down, not just running a little late —
 * end the session rather than silently charging a large catch-up amount the
 * seeker never agreed to and may not even have the balance for. Not itself a
 * tunable — this is crash-recovery slack, not a billing-behaviour knob.
 */
const MAX_TICK_GAP_MS = 5 * 60 * 1000;

/**
 * Emits to a room if the socket server is running.
 *
 * Required lazily because socket/index.js requires this file — taking the
 * require out to the top would be a cycle.
 */
function emit(target, event, payload) {
  try {
    const { getIO } = require('../socket');
    getIO().to(target).emit(event, payload);
  } catch (error) {
    /** No socket server (a script or a test) is the expected case; anything else here is why a live push silently never arrived. */
    if (error?.message !== 'Socket.io is not initialised yet.') {
      console.error(`[chat.service] emit(${event}) to ${target} failed:`, error);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Access                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads a chat and checks the caller is one of its two sides.
 * @returns [chat, 'user' | 'astrologer']
 */
async function participantChat(chatId, accountId) {
  if (!chatId) {
    throw ApiError.badRequest('chatId is required.');
  }

  const chat = await ChatSession.findById(chatId).catch(() => null);
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }

  const role = chat.roleOf(accountId);
  if (!role) {
    throw ApiError.forbidden('You are not part of this chat.');
  }

  return [chat, role];
}

/* -------------------------------------------------------------------------- */
/* Packages — shared helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * True while a package session is still on package time — i.e. booked as a
 * package and not (yet) switched to per-minute. Every package branch in this
 * file is gated on this, so a per-minute session never enters one.
 */
function isPackagePhase(chat) {
  return chat.billing?.mode === 'package' && !chat.packageState?.perMinuteStartedAt;
}

/**
 * Prices a package server-side from `ratePerMinute` (never from the client)
 * and checks the wallet covers it. `quotedPrice` is what the seeker's screen
 * showed them: if it no longer matches — the astrologer changed their rate
 * after the form was opened — the request is refused with `price_changed`
 * and the new price, so the seeker confirms the real figure rather than being
 * charged something they never saw. The same goes for the admin changing a
 * package's discount (`discounts`, from Settings) in the meantime.
 */
function quotePackage({ packageMinutes, quotedPrice, ratePerMinute, balance, discounts }) {
  const pkg = findPackage(packageMinutes, discounts);
  if (!pkg) {
    throw ApiError.badRequest('Choose one of the offered packages.', { packageMinutes: 'Unknown package.' }, 'invalid_package');
  }
  const price = packagePrice(ratePerMinute, pkg);

  if (quotedPrice !== undefined && quotedPrice !== null && Number(quotedPrice) !== price) {
    throw ApiError.conflict(
      `The price of the ${pkg.minutes}-minute package is now ₹${price}. Please confirm to continue.`,
      undefined,
      'price_changed',
    ).withDetails({
      packageMinutes: pkg.minutes,
      price,
      originalPrice: originalPackagePrice(ratePerMinute, pkg),
      discountPercent: pkg.discountPercent,
      ratePerMinute,
    });
  }

  if (balance < price) {
    const shortfallAmount = price - balance;
    throw ApiError.badRequest(
      `You need ₹${shortfallAmount} more in your wallet for the ${pkg.minutes}-minute package (₹${price}).`,
      undefined,
      'insufficient_balance',
    ).withDetails({ packageMinutes: pkg.minutes, price, balance, shortfallAmount });
  }

  return { pkg, price };
}

/** The admin's current per-package discounts (Settings → Platform), read through the settings cache. */
async function currentPackageDiscounts() {
  const settings = await settingsService.get();
  return settings?.packageDiscounts || [];
}

/**
 * Runs `work(session)` in one Mongo transaction and returns its result. An
 * {@link AbortBilling} thrown inside rolls everything back and comes out as
 * its plain `outcome` instead of an exception — the same convention
 * billNextMinute and acceptChat use.
 */
async function inTransaction(work) {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = await work(session);
    });
  } catch (error) {
    if (error instanceof AbortBilling) {
      outcome = error.outcome;
    } else {
      throw error;
    }
  } finally {
    await session.endSession();
  }
  return outcome;
}

/** A notice in the server's own voice, stored AND pushed live — both sides see it arrive. */
async function announce(chatId, text, event) {
  const message = await Message.system(chatId, text, event);
  emit(roomFor(chatId), CHAT_EVENTS.NEW, message.toSocketPayload());
}

/* -------------------------------------------------------------------------- */
/* Starting a consultation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many minutes of `channel` this seeker could start right now with this
 * astrologer — purely what the wallet covers at the current rate; this
 * platform has no free minutes of any kind. Shared by requestChat and
 * precheckSession so a client is never told "you can start" by one and then
 * refused by the other.
 */
async function affordabilityFor(user, astrologer, channel) {
  const ratePerMinute = astrologer.rateFor(channel);
  const affordablePaidMinutes = ratePerMinute > 0 ? Math.floor(user.wallet.balance / ratePerMinute) : Infinity;

  return {
    ratePerMinute,
    affordablePaidMinutes,
    totalAffordableMinutes: affordablePaidMinutes,
  };
}

/**
 * The intake form sends birth details in whatever display format its own
 * picker produces ("15 August 1999", "10 : 30 PM") — the same shapes
 * registerUser/saveKundli already normalise for the profile and kundli
 * endpoints (see parseBirthDate/parseBirthTime in services/auth.service.js).
 * Chat's own birthDetailsSchema (models/common.js) is strict about both, so
 * this has to happen before it ever reaches ChatSession.create. Anything not
 * supplied is left alone — the schema itself decides what is required.
 */
function normalizeIntakeBirthDetails(birthDetails) {
  if (!birthDetails) {
    return birthDetails;
  }
  try {
    return {
      ...birthDetails,
      dateOfBirth: birthDetails.dateOfBirth ? parseBirthDate(birthDetails.dateOfBirth) : birthDetails.dateOfBirth,
      timeOfBirth: birthDetails.timeOfBirth ? parseBirthTime(birthDetails.timeOfBirth) : birthDetails.timeOfBirth,
    };
  } catch {
    throw ApiError.badRequest('Could not read the birth details on this request.', undefined);
  }
}

/**
 * The seeker asks an astrologer for a chat.
 *
 * Checks in order: the astrologer can take work, the seeker can afford the
 * MIN_SESSION_MINUTES the meter will charge upfront, and there is not
 * already a request in flight between these two.
 */
async function requestChat({ userId, astrologerId, channel = 'chat', intake = {}, billing: requestedBilling }) {
  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('That astrologer is not available.');
  }
  if (!astrologer.canAcceptRequest(channel)) {
    throw ApiError.badRequest('That astrologer is not available right now.', undefined);
  }

  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }

  const { ratePerMinute, totalAffordableMinutes } = await affordabilityFor(user, astrologer, channel);

  /**
   * A package is priced here from the astrologer's live rate and checked
   * against the wallet — but charged only on accept (acceptChat), in the same
   * transaction that starts the session, so a reject/miss/cancel never needs
   * a refund. Anything but an explicit package is the per-minute flow, as always.
   */
  const mode = requestedBilling?.mode === 'package' ? 'package' : 'per_minute';
  let pkg = null;
  let pkgPrice;
  if (mode === 'package') {
    ({ pkg, price: pkgPrice } = quotePackage({
      packageMinutes: requestedBilling.packageMinutes,
      quotedPrice: requestedBilling.quotedPrice,
      ratePerMinute,
      balance: user.wallet.balance,
      discounts: await currentPackageDiscounts(),
    }));
  } else if (totalAffordableMinutes < MIN_SESSION_MINUTES) {
    /** Less than MIN_SESSION_MINUTES affordable means the wallet can't even cover the minute billed upfront on accept. */
    const minutesShort = MIN_SESSION_MINUTES - totalAffordableMinutes;
    throw ApiError.badRequest(
      `You need at least ₹${minutesShort * ratePerMinute} more in your wallet to start this chat (minimum ${pluralMinutes(MIN_SESSION_MINUTES)}).`,
      undefined,
      'insufficient_balance',
    );
  }

  const alreadyOpen = await ChatSession.findOne({
    user: userId,
    astrologer: astrologerId,
    status: { $in: ['requested', 'active'] },
  });
  if (alreadyOpen) {
    throw ApiError.conflict('You already have a chat open with this astrologer.');
  }

  const chat = await ChatSession.create({
    type: 'consultation',
    channel,
    user: userId,
    astrologer: astrologerId,
    status: 'requested',
    intake: {
      birthDetails: normalizeIntakeBirthDetails(intake.birthDetails),
      topic: intake.topic,
      question: intake.question,
      minutesBooked: intake.minutes ?? pkg?.minutes,
    },
    billing: {
      mode,
      ratePerMinute,
      commissionPercent: astrologer.commissionPercent,
      requestedPackageMinutes: pkg?.minutes,
      /**
       * The discount and price the seeker saw and confirmed, locked here so
       * acceptChat charges exactly this even if the admin changes the
       * discount while the request waits for the astrologer.
       */
      requestedPackageDiscountPercent: pkg?.discountPercent,
      requestedPackagePrice: pkgPrice,
    },
  });

  /**
   * The `alreadyOpen` check above is a read-then-write, so two requests
   * landing at the same instant (a double-tapped Connect) can both pass it.
   * Settle that here, before anyone is notified: of all the open requests
   * between these two, the earliest one stands and any later duplicate
   * cancels itself — so the astrologer can never accept (and charge for) the
   * same booking twice. Whichever order the inserts and reads interleave,
   * the earliest always survives, and only later ones ever withdraw.
   */
  const earliestOpen = await ChatSession.findOne({
    user: userId,
    astrologer: astrologerId,
    status: { $in: ['requested', 'active'] },
  }).sort({ _id: 1 }).select('_id');
  if (earliestOpen && String(earliestOpen._id) !== String(chat._id)) {
    await ChatSession.updateOne(
      { _id: chat._id, status: 'requested' },
      { $set: { status: 'cancelled', endedAt: new Date(), endedBy: 'system', endReason: 'duplicate_request' } },
    );
    throw ApiError.conflict('You already have a chat open with this astrologer.');
  }

  /**
   * The seeker's own filled-in intake, posted as the opening message of the
   * transcript itself — not just a popup the astrologer sees once and loses,
   * so it is there on both sides for the whole life of the chat, exactly as
   * the seeker's own screen shows it before the astrologer has even answered.
   */
  if (intake.summary) {
    await Message.send({
      chatId: chat._id,
      senderId: userId,
      senderRole: 'user',
      type: 'text',
      content: { text: intake.summary },
      isIntake: true,
    });
  }

  /** Every request counts towards the acceptance rate, answered or not. */
  await Astrologer.updateOne({ _id: astrologerId }, { $inc: { 'metrics.requestsReceived': 1 } });

  /** The astrologer's app shows the incoming-request popup off this. */
  emit(`astrologer:${astrologerId}`, 'chat:requested', {
    chatId: String(chat._id),
    channel,
    user: { id: String(user._id), name: user.name, avatarUrl: user.avatarUrl },
    intake: chat.intake,
    ratePerMinute,
    billingMode: mode,
    packageMinutes: pkg?.minutes,
    packagePrice: pkgPrice,
    expiresInSeconds: REQUEST_TIMEOUT_SECONDS,
  });

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologerId,
    type: 'consultation_request',
    title: 'New chat request',
    body: `${user.name} wants to chat with you.`,
    action: { screen: 'consultation', id: String(chat._id) },
  });

  return chat;
}

/**
 * Read-only balance check before requesting — creates nothing, so the client
 * can show "you need more balance" (and an add-money button) without
 * spending anything. Mirrors requestChat's own eligibility check exactly.
 */
async function precheckSession({ userId, astrologerId, channel = 'chat' }) {
  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('That astrologer is not available.');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }

  const { ratePerMinute, totalAffordableMinutes } = await affordabilityFor(user, astrologer, channel);
  const astrologerAvailable = astrologer.canAcceptRequest(channel);

  return {
    ok: astrologerAvailable && totalAffordableMinutes >= MIN_SESSION_MINUTES,
    astrologerAvailable,
    ratePerMinute,
    minSessionMinutes: MIN_SESSION_MINUTES,
    minutesAffordable: totalAffordableMinutes,
    shortfallAmount: Math.max(0, (MIN_SESSION_MINUTES - totalAffordableMinutes) * ratePerMinute),
    /** The package options (config/packages.js), priced at this astrologer's real rate for this channel. */
    balance: user.wallet.balance,
    packages: Number.isFinite(ratePerMinute) && ratePerMinute !== null
      ? packageQuotes(ratePerMinute, user.wallet.balance, await currentPackageDiscounts())
      : [],
  };
}

/**
 * The astrologer takes the request. The meter starts here — the first minute
 * is billed upfront, before the session goes active, so a seeker cannot
 * connect and disconnect for free and cost the astrologer their time. If
 * even the first minute can no longer be afforded (the wallet was spent
 * elsewhere while the request sat waiting), the request is left exactly as
 * it was rather than starting a session that cannot pay for itself.
 */
async function acceptChat({ chatId, astrologerId }) {
  const chat = await ChatSession.findOne({ _id: chatId, astrologer: astrologerId });
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (chat.status !== 'requested') {
    throw ApiError.badRequest(`This request is already ${chat.status}.`);
  }

  /** A package session is charged the whole package here instead of minute 1 — same transaction, same all-or-nothing guarantee. */
  const offered = chat.billing.mode === 'package' ? findPackage(chat.billing.requestedPackageMinutes) : null;
  if (chat.billing.mode === 'package' && !offered) {
    throw ApiError.badRequest('This request has no valid package.');
  }
  /** Charged at the discount locked onto the request (see requestChat), never whatever the admin has set since. */
  const pkg = offered
    ? { minutes: offered.minutes, discountPercent: chat.billing.requestedPackageDiscountPercent ?? 0 }
    : null;

  /**
   * The minute-1 debit and the session actually going active live in one
   * transaction — a crash between the two must never leave the seeker
   * charged for a chat that never started (or, the other way round, a chat
   * marked active that nobody ever paid the astrologer for).
   */
  const now = new Date();
  const session = await mongoose.startSession();
  let firstMinute;
  try {
    await session.withTransaction(async () => {
      firstMinute = pkg
        ? await purchasePackage(chat, pkg, 'initial', now, session)
        : await billOneMinute(chat, now, session);
      if (!firstMinute.billed) {
        return;
      }
      chat.status = 'active';
      chat.startedAt = now;
      await chat.save({ session });
    });
  } catch (error) {
    if (error instanceof AbortBilling) {
      firstMinute = error.outcome;
    } else {
      throw error;
    }
  } finally {
    await session.endSession();
  }

  if (!firstMinute.billed) {
    throw ApiError.badRequest('The seeker no longer has enough balance to start this chat.');
  }

  await Astrologer.updateOne(
    { _id: astrologerId },
    {
      $inc: { 'presence.activeSessions': 1, 'metrics.requestsAccepted': 1 },
      $set: { 'presence.isBusy': true },
    },
  );

  /** The opening line of every transcript, in the server's own voice. */
  await Message.system(
    chat._id,
    pkg ? `Consultation started — ${pluralMinutes(pkg.minutes)} package.` : 'Consultation started.',
    'started',
  );

  emit(roomFor(chat._id), 'chat:started', {
    chatId: String(chat._id),
    startedAt: chat.startedAt,
    ratePerMinute: chat.billing.ratePerMinute,
    billingMode: chat.billing.mode,
    packageEndsAt: chat.packageState?.endsAt,
  });
  emit(`user:${chat.user}`, 'chat:accepted', { chatId: String(chat._id) });

  await notificationService.notify({
    ownerRole: 'user',
    ownerId: chat.user,
    type: 'consultation_started',
    title: 'Your astrologer is ready',
    body: 'Your consultation has started.',
    action: { screen: 'consultationChat', id: String(chat._id) },
  });

  return chat;
}

/** The astrologer turns the request down. */
async function rejectChat({ chatId, astrologerId, reason }) {
  const chat = await ChatSession.findOne({ _id: chatId, astrologer: astrologerId });
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (chat.status !== 'requested') {
    throw ApiError.badRequest(`This request is already ${chat.status}.`);
  }

  chat.status = 'rejected';
  chat.endedAt = new Date();
  chat.endedBy = 'astrologer';
  chat.endReason = reason || 'Declined by astrologer';
  await chat.save();

  emit(`user:${chat.user}`, 'chat:rejected', {
    chatId: String(chat._id),
    reason: chat.endReason,
  });

  return chat;
}

/** The seeker gives up waiting before it was answered. */
async function cancelChat({ chatId, userId }) {
  const chat = await ChatSession.findOne({ _id: chatId, user: userId });
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (chat.status !== 'requested') {
    throw ApiError.badRequest(`This request is already ${chat.status}.`);
  }

  chat.status = 'cancelled';
  chat.endedAt = new Date();
  chat.endedBy = 'user';
  await chat.save();

  emit(`astrologer:${chat.astrologer}`, 'chat:cancelled', { chatId: String(chat._id) });
  return chat;
}

/* -------------------------------------------------------------------------- */
/* Live billing tick                                                          */
/* -------------------------------------------------------------------------- */

/** The seeker's current wallet balance, read fresh — the one number every low-balance/tick signal reports back. */
async function balanceFor(userId, session) {
  const query = User.findById(userId).select('wallet.balance');
  const user = await (session ? query.session(session) : query);
  return user.wallet.balance;
}

/**
 * How many more minutes of an ACTIVE session's own frozen rate the seeker's
 * current wallet balance covers. Shared by the tick's own low-balance check
 * and getSessionState (what a client polls/loads-on-reconnect to know where
 * the meter stands) — the client is never trusted to compute this itself.
 */
async function remainingMinutesFor(chat) {
  const user = await User.findById(chat.user).select('wallet');
  return chat.billing.ratePerMinute > 0 ? Math.floor(user.wallet.balance / chat.billing.ratePerMinute) : Infinity;
}

/**
 * Whether the seeker could pay for the *one specific* minute coming up next
 * — the wallet covering the frozen rate — read without changing anything.
 * This is the check-ahead phase's own question
 * (`env.consultation.checkAheadSeconds` before the current minute is due):
 * not "how much runway is left" (that's `remainingMinutesFor`,
 * `LOW_BALANCE_WARNING_MINUTES`'s own concern), but "will the debit at the
 * actual due time succeed if nothing changes."
 */
async function canAffordNextMinute(chat) {
  const balance = await balanceFor(chat.user);
  return { affordable: balance >= chat.billing.ratePerMinute, balance };
}

/**
 * Thrown from inside {@link billOneMinute} to force the Mongo transaction
 * wrapped around it to abort — never a real error, just the only way to make
 * `session.withTransaction()` roll back a write it already made (the debit)
 * once a *later* step in the same minute turns out to be a duplicate. See
 * the call sites below for how it's turned back into a plain `{ billed:
 * false, ... }` result rather than escaping as an exception.
 */
class AbortBilling extends Error {
  constructor(outcome) {
    super('billing aborted — not a real error, see AbortBilling.outcome');
    this.outcome = outcome;
  }
}

/**
 * The actual work of billing one minute — every write in it takes `session`,
 * so a caller can either let it run in its own transaction ({@link
 * billNextMinute}) or fold it into a larger one (acceptChat, which also
 * needs the session to go active in the very same all-or-nothing unit as
 * the minute-1 debit that pays for it).
 *
 * Idempotent: a duplicate call for the same minute (a racing sweep, a retry
 * after a crash) is caught by ChatBillingTick's unique index on
 * (chatSession, minuteNumber) — since the debit above it lives in the same
 * transaction, throwing here aborts it too, so a minute is never charged
 * without the tick that proves it, or the other way round.
 */
async function billOneMinute(chat, now, session) {
  const minuteNumber = chat.minutesBilled + 1;
  const amount = chat.billing.ratePerMinute;

  let walletTransactionId;
  /** Reported back so the tick's own socket event can push the new balance straight to the client — no separate fetch for it to make. */
  let balanceRemaining;
  if (amount > 0) {
    try {
      const txn = await walletService.post({
        ownerRole: 'user',
        ownerId: chat.user,
        direction: 'debit',
        type: 'consultation_charge',
        amount,
        title: `${chat.channel === 'call' ? 'Call' : 'Chat'} consultation — minute ${minuteNumber}`,
        chatSession: chat._id,
        session,
      });
      walletTransactionId = txn._id;
      balanceRemaining = txn.balanceAfter;
    } catch (error) {
      if (error instanceof ApiError) {
        /** Nothing was written — safe to just say so; the transaction commits empty. */
        return { billed: false, reason: 'insufficient_balance' };
      }
      throw error;
    }
  } else {
    /** A zero-rate chat (the AI thread type, never a real consultation) moves no money, but the client still needs a number to show — read it as-is. */
    balanceRemaining = await balanceFor(chat.user, session);
  }

  try {
    await ChatBillingTick.create(
      [{ chatSession: chat._id, minuteNumber, amount, walletTransaction: walletTransactionId, billedAt: now }],
      { session },
    );
  } catch (error) {
    if (error?.code === MONGO_DUPLICATE_KEY) {
      /** Someone else already billed this exact minute — abort so the debit just taken above never commits, rather than double-charge and have to reverse it after the fact. */
      throw new AbortBilling({ billed: false, reason: 'already_billed' });
    }
    throw error;
  }

  let earning = 0;
  if (amount > 0) {
    const commission = Math.round((amount * chat.billing.commissionPercent) / 100);
    earning = amount - commission;
    if (earning > 0) {
      await walletService.post({
        ownerRole: 'astrologer',
        ownerId: chat.astrologer,
        direction: 'credit',
        type: 'consultation_earning',
        amount: earning,
        title: `${chat.channel === 'call' ? 'Call' : 'Chat'} consultation — minute ${minuteNumber}`,
        chatSession: chat._id,
        session,
      });
    }
  }

  await ChatSession.updateOne(
    { _id: chat._id },
    {
      $inc: {
        minutesBilled: 1,
        'billing.amountCharged': amount,
        'billing.astrologerEarning': earning,
      },
      $set: { lastBilledAt: now, balanceExhaustedAt: null, nextMinuteChecked: false },
    },
    { session },
  );
  /** Kept in sync in memory too, so a caller chaining more logic off the same object (endChat's true-up loop, a test) sees the update without a re-fetch. */
  chat.minutesBilled += 1;
  chat.billing.amountCharged += amount;
  chat.billing.astrologerEarning += earning;
  chat.lastBilledAt = now;
  chat.balanceExhaustedAt = null;
  chat.nextMinuteChecked = false;

  return { billed: true, minuteNumber, amount, balanceRemaining };
}

/**
 * Buys one package on a session: debits the seeker the package price (at the
 * session's own frozen rate), records it in the ChatPackagePurchase ledger,
 * and moves `packageState.endsAt` to `now + minutes`. Every write takes
 * `session`, so it lives or dies with the caller's transaction — acceptChat
 * (the initial package, together with going active) or extendPackage.
 *
 * The astrologer is NOT credited here; their share of package money is
 * settled once at the end (settlePackageEarning), so a future unused-minutes
 * refund never has to claw anything back.
 *
 * Idempotent the same way billOneMinute is: a second purchase for the same
 * `seq` (a double-tapped Extend, a racing accept) hits the ledger's unique
 * index and aborts the whole transaction, debit included. An extension also
 * refuses once the prompt is gone or being closed by the timeout, so an
 * answer racing the auto-end can never charge a closing session.
 */
async function purchasePackage(chat, pkg, kind, now, session) {
  const seq = (chat.billing.packages?.length || 0) + 1;
  const { ratePerMinute } = chat.billing;
  const amount = packagePrice(ratePerMinute, pkg);
  const originalAmount = originalPackagePrice(ratePerMinute, pkg);
  const title = `${chat.channel === 'call' ? 'Call' : 'Chat'} consultation — ${pkg.minutes}-min package${pkg.discountPercent ? ` (${pkg.discountPercent}% off)` : ''}${kind === 'extension' ? ' (extension)' : ''}`;

  let walletTransactionId;
  let balanceRemaining;
  if (amount > 0) {
    try {
      const txn = await walletService.post({
        ownerRole: 'user',
        ownerId: chat.user,
        direction: 'debit',
        type: 'consultation_charge',
        amount,
        title,
        chatSession: chat._id,
        session,
      });
      walletTransactionId = txn._id;
      balanceRemaining = txn.balanceAfter;
    } catch (error) {
      if (error instanceof ApiError) {
        return { billed: false, reason: 'insufficient_balance' };
      }
      throw error;
    }
  } else {
    balanceRemaining = await balanceFor(chat.user, session);
  }

  try {
    await ChatPackagePurchase.create(
      [{
        chatSession: chat._id,
        seq,
        kind,
        minutes: pkg.minutes,
        ratePerMinute,
        discountPercent: pkg.discountPercent,
        originalAmount,
        amount,
        walletTransaction: walletTransactionId,
        purchasedAt: now,
      }],
      { session },
    );
  } catch (error) {
    if (error?.code === MONGO_DUPLICATE_KEY) {
      throw new AbortBilling({ billed: false, reason: 'already_billed' });
    }
    throw error;
  }

  const endsAt = new Date(now.getTime() + pkg.minutes * 60 * 1000);
  const entry = {
    seq,
    kind,
    minutes: pkg.minutes,
    ratePerMinute,
    discountPercent: pkg.discountPercent,
    originalAmount,
    amount,
    walletTransaction: walletTransactionId,
    purchasedAt: now,
  };

  const filter = { _id: chat._id };
  if (kind === 'extension') {
    Object.assign(filter, {
      status: 'active',
      'packageState.promptedAt': { $ne: null },
      'packageState.closingAt': null,
      'packageState.perMinuteStartedAt': null,
    });
  }
  const updated = await ChatSession.updateOne(
    filter,
    {
      $push: { 'billing.packages': entry },
      $inc: { 'billing.amountCharged': amount, 'billing.packageAmountCharged': amount },
      $set: { 'packageState.endsAt': endsAt, 'packageState.warnedAt': null, 'packageState.promptedAt': null },
    },
    { session },
  );
  if (updated.matchedCount === 0) {
    throw new AbortBilling({ billed: false, reason: 'not_awaiting_extension' });
  }

  /** Kept in sync in memory too — acceptChat saves this same object right after. */
  chat.billing.packages = [...(chat.billing.packages || []), entry];
  chat.billing.amountCharged += amount;
  chat.billing.packageAmountCharged = (chat.billing.packageAmountCharged || 0) + amount;
  chat.packageState.endsAt = endsAt;
  chat.packageState.warnedAt = null;
  chat.packageState.promptedAt = null;

  return { billed: true, seq, amount, balanceRemaining, endsAt };
}

/**
 * Bills exactly the next unbilled minute for a session, free or paid, in its
 * own atomic transaction: the debit, the idempotency tick, the astrologer's
 * earning, and the session's own running totals either all land or none do.
 *
 * @returns {Promise<{billed: true, minuteNumber: number, amount: number} | {billed: false, reason: 'insufficient_balance'|'already_billed'}>}
 */
async function billNextMinute(chat, now = new Date()) {
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = await billOneMinute(chat, now, session);
    });
  } catch (error) {
    if (error instanceof AbortBilling) {
      outcome = error.outcome;
    } else {
      throw error;
    }
  } finally {
    await session.endSession();
  }
  return outcome;
}

/**
 * One active session's turn at the tick: bills its next minute if due,
 * proactively warns once when barely anything is left, starts (or checks) a
 * grace period once nothing more can be afforded, and force-ends a session
 * whose last tick is impossibly old (the job, or the whole server, was down
 * — not just running a little late) rather than charging a large silent
 * catch-up the seeker never agreed to.
 *
 * Before any of that, a session not yet due for its next minute gets one
 * more chance to be looked at: the check-ahead phase, `checkAheadSeconds`
 * before the actual due time, asks whether the debit that will be attempted
 * *then* would succeed right now — and if not, warns immediately rather than
 * waiting for the real cutoff to surprise the seeker. This is deliberately a
 * warning only; the due-time debit below is still what actually decides
 * anything; a top-up in between just makes that debit succeed normally.
 */
async function tickOneSession(chat, now) {
  /** Package time is prepaid — never the per-minute meter below (see tickPackageSession). */
  if (isPackagePhase(chat)) {
    return tickPackageSession(chat, now);
  }

  /**
   * Paused indefinitely for insufficient balance — never re-enter the normal
   * due/gap math below, or a long-paused session reads as a crash-recovery
   * timeout (`MAX_TICK_GAP_MS`) instead of staying paused. Only
   * resumePausedSessionsForUser clears this.
   */
  if (chat.balanceExhaustedAt) {
    return { chatId: String(chat._id), action: 'balance_paused' };
  }

  const since = chat.lastBilledAt ?? chat.startedAt;
  const dueAt = new Date(since.getTime() + TICK_INTERVAL_MS);

  if (now < dueAt) {
    const checkAheadAt = new Date(dueAt.getTime() - env.consultation.checkAheadSeconds * 1000);
    if (now < checkAheadAt || chat.nextMinuteChecked) {
      return { chatId: String(chat._id), action: 'not_due' };
    }

    const { affordable, balance } = await canAffordNextMinute(chat);
    chat.nextMinuteChecked = true;
    await ChatSession.updateOne({ _id: chat._id }, { $set: { nextMinuteChecked: true } });

    if (!affordable) {
      emit(roomFor(chat._id), CHAT_EVENTS.LOW_BALANCE, {
        chatId: String(chat._id),
        exhausted: false,
        secondsUntilCut: Math.max(0, Math.round((dueAt.getTime() - now.getTime()) / 1000)),
        requiredAmount: chat.billing.ratePerMinute,
        balanceRemaining: balance,
      });
      return { chatId: String(chat._id), action: 'check_ahead_warned' };
    }
    return { chatId: String(chat._id), action: 'check_ahead_ok' };
  }

  const gapMs = now.getTime() - since.getTime();
  if (gapMs > MAX_TICK_GAP_MS) {
    await endChat({ chatId: chat._id, accountId: chat.astrologer, endedBy: 'system', reason: 'timeout' });
    return { chatId: String(chat._id), action: 'ended_timeout' };
  }

  const result = await billNextMinute(chat, now);

  if (!result.billed) {
    if (result.reason === 'already_billed') {
      return { chatId: String(chat._id), action: 'already_billed' };
    }

    /**
     * insufficient_balance — pause indefinitely rather than end the session.
     * Nothing here times out: `runBillingSweep` skips a paused session
     * entirely (see its own `balanceExhaustedAt` check), so no further minute
     * is ever attempted until `resumePausedSessionsForUser` explicitly clears
     * this — which only a wallet top-up ever calls (wallet.controller.js's
     * confirmTopUp). The seeker can leave this paused as long as they like;
     * only they (ending the chat themselves) or the astrologer can close it
     * from here.
     */
    if (!chat.balanceExhaustedAt) {
      chat.balanceExhaustedAt = now;
      await ChatSession.updateOne({ _id: chat._id }, { $set: { balanceExhaustedAt: now } });
      emit(roomFor(chat._id), CHAT_EVENTS.LOW_BALANCE, {
        chatId: String(chat._id),
        exhausted: true,
        paused: true,
        balanceRemaining: await balanceFor(chat.user),
      });
    }
    return { chatId: String(chat._id), action: 'balance_paused' };
  }

  /** Billed fine — proactively warn once if what's left won't cover much more. */
  const minutesRemaining = await remainingMinutesFor(chat);

  if (minutesRemaining < LOW_BALANCE_WARNING_MINUTES && !chat.lowBalanceWarnedAt) {
    chat.lowBalanceWarnedAt = now;
    await ChatSession.updateOne({ _id: chat._id }, { $set: { lowBalanceWarnedAt: now } });
    emit(roomFor(chat._id), CHAT_EVENTS.LOW_BALANCE, {
      chatId: String(chat._id),
      exhausted: false,
      minutesRemaining,
      balanceRemaining: result.balanceRemaining,
    });
  }

  emit(roomFor(chat._id), CHAT_EVENTS.TICK, {
    chatId: String(chat._id),
    minutesBilled: chat.minutesBilled,
    minutesRemaining,
    balanceRemaining: result.balanceRemaining,
  });

  return { chatId: String(chat._id), action: 'billed', minuteNumber: result.minuteNumber };
}

/**
 * One package session's turn at the sweep. Nothing is ever charged here:
 *
 *   - `packageWarningSeconds` before the package runs out, warn once;
 *   - once it has run out, open the "Extend consultation?" prompt (the
 *     session freezes — sendMessage refuses — and nothing is charged);
 *   - left unanswered for `packageExtensionResponseSeconds`, end it.
 *
 * Every transition is a conditional update, so two overlapping sweeps can't
 * warn twice or prompt twice, and a prompt being answered at the same moment
 * it times out resolves to exactly one of the two (see `closingAt`).
 */
async function tickPackageSession(chat, now) {
  const chatId = String(chat._id);
  const state = chat.packageState || {};
  if (!state.endsAt) {
    return { chatId, action: 'package_not_started' };
  }

  if (state.promptedAt) {
    const waitedMs = now.getTime() - state.promptedAt.getTime();
    if (waitedMs < env.consultation.packageExtensionResponseSeconds * 1000) {
      return { chatId, action: 'awaiting_extension' };
    }
    const claimed = await ChatSession.updateOne(
      { _id: chat._id, status: 'active', 'packageState.promptedAt': state.promptedAt, 'packageState.closingAt': null },
      { $set: { 'packageState.closingAt': now } },
    );
    if (claimed.modifiedCount === 0) {
      /** Answered (or already being closed) in the meantime — the next sweep sees the new state. */
      return { chatId, action: 'awaiting_extension' };
    }
    await endChat({ chatId: chat._id, accountId: chat.user, endedBy: 'system', reason: 'package_no_response' });
    return { chatId, action: 'ended_no_response' };
  }

  const msLeft = state.endsAt.getTime() - now.getTime();

  if (msLeft <= 0) {
    const claimed = await ChatSession.updateOne(
      { _id: chat._id, status: 'active', 'packageState.promptedAt': null, 'packageState.endsAt': state.endsAt },
      { $set: { 'packageState.promptedAt': now } },
    );
    if (claimed.modifiedCount === 0) {
      return { chatId, action: 'awaiting_extension' };
    }
    chat.packageState.promptedAt = now;

    const balance = await balanceFor(chat.user);
    const rate = chat.billing.ratePerMinute;
    emit(roomFor(chat._id), CHAT_EVENTS.PACKAGE_ENDED, {
      chatId,
      promptedAt: now,
      serverTime: now,
      respondWithinSeconds: env.consultation.packageExtensionResponseSeconds,
      ratePerMinute: rate,
      balanceRemaining: balance,
      perMinuteAffordable: balance >= rate,
      packages: packageQuotes(rate, balance, await currentPackageDiscounts()),
    });
    await announce(chat._id, 'Package time is over. Waiting for the seeker to extend or end the consultation.', 'package_ended');
    return { chatId, action: 'extension_prompted' };
  }

  if (msLeft <= env.consultation.packageWarningSeconds * 1000 && !state.warnedAt) {
    const claimed = await ChatSession.updateOne(
      { _id: chat._id, 'packageState.warnedAt': null, 'packageState.endsAt': state.endsAt },
      { $set: { 'packageState.warnedAt': now } },
    );
    if (claimed.modifiedCount === 0) {
      return { chatId, action: 'package_running' };
    }
    chat.packageState.warnedAt = now;
    emit(roomFor(chat._id), CHAT_EVENTS.PACKAGE_WARNING, {
      chatId,
      endsAt: state.endsAt,
      serverTime: now,
      secondsLeft: Math.ceil(msLeft / 1000),
    });
    return { chatId, action: 'package_warned' };
  }

  return { chatId, action: 'package_running' };
}

/* -------------------------------------------------------------------------- */
/* Package sessions: the seeker's answer to "Extend consultation?"           */
/* -------------------------------------------------------------------------- */

/** Loads a package session that is waiting on the seeker's extend/continue/end answer, or refuses. */
async function awaitingExtensionChat(chatId, userId) {
  const [chat, role] = await participantChat(chatId, userId);
  if (role !== 'user') {
    throw ApiError.forbidden('Only the seeker can extend a consultation.');
  }
  if (chat.status !== 'active') {
    throw ApiError.badRequest(`This chat is already ${chat.status}.`);
  }
  if (!isPackagePhase(chat) || !chat.packageState?.promptedAt || chat.packageState?.closingAt) {
    throw ApiError.conflict('This consultation is not waiting for an extension.', undefined, 'not_awaiting_extension');
  }
  return chat;
}

/**
 * "Extend with another package": priced at the session's frozen rate,
 * wallet re-checked, then charged in one transaction. The new package starts
 * now — the prompt froze the session, so no time was lost while deciding.
 */
async function extendPackage({ chatId, userId, packageMinutes, quotedPrice }) {
  const chat = await awaitingExtensionChat(chatId, userId);
  const { pkg } = quotePackage({
    packageMinutes,
    quotedPrice,
    ratePerMinute: chat.billing.ratePerMinute,
    balance: await balanceFor(chat.user),
    discounts: await currentPackageDiscounts(),
  });

  const now = new Date();
  const outcome = await inTransaction(session => purchasePackage(chat, pkg, 'extension', now, session));

  if (!outcome.billed) {
    if (outcome.reason === 'insufficient_balance') {
      throw ApiError.badRequest('Not enough balance for this package.', undefined, 'insufficient_balance');
    }
    throw ApiError.conflict('This consultation was already extended or has ended.', undefined, 'not_awaiting_extension');
  }

  emit(roomFor(chat._id), CHAT_EVENTS.PACKAGE_EXTENDED, {
    chatId: String(chat._id),
    packageMinutes: pkg.minutes,
    amount: outcome.amount,
    endsAt: outcome.endsAt,
    serverTime: now,
    balanceRemaining: outcome.balanceRemaining,
  });
  await announce(chat._id, `Consultation extended by ${pluralMinutes(pkg.minutes)}.`, 'package_extended');

  return {
    chatId: String(chat._id),
    packageMinutes: pkg.minutes,
    amount: outcome.amount,
    endsAt: outcome.endsAt,
    serverTime: now,
    balanceRemaining: outcome.balanceRemaining,
  };
}

/**
 * "Continue per-minute": from this instant the ordinary per-minute meter
 * runs, exactly as for a per-minute session — its first minute is charged
 * upfront (as acceptChat does), in the same transaction that flips the
 * session over, so the switch and the charge land together or not at all.
 */
async function continuePerMinute({ chatId, userId }) {
  const chat = await awaitingExtensionChat(chatId, userId);
  const rate = chat.billing.ratePerMinute;
  const balance = await balanceFor(chat.user);
  if (balance < rate) {
    throw ApiError.badRequest(
      `You need ₹${rate - balance} more in your wallet to continue per-minute (₹${rate}/min).`,
      undefined,
      'insufficient_balance',
    ).withDetails({ price: rate, balance, shortfallAmount: rate - balance });
  }

  const now = new Date();
  const outcome = await inTransaction(async session => {
    const claimed = await ChatSession.updateOne(
      {
        _id: chat._id,
        status: 'active',
        'packageState.promptedAt': { $ne: null },
        'packageState.closingAt': null,
        'packageState.perMinuteStartedAt': null,
      },
      { $set: { 'packageState.perMinuteStartedAt': now, 'packageState.promptedAt': null } },
      { session },
    );
    if (claimed.modifiedCount === 0) {
      throw new AbortBilling({ billed: false, reason: 'not_awaiting_extension' });
    }
    const minute = await billOneMinute(chat, now, session);
    if (!minute.billed) {
      /** Roll the switch back too — never "per-minute" without the minute that pays for it. */
      throw new AbortBilling(minute);
    }
    return minute;
  });

  if (!outcome.billed) {
    if (outcome.reason === 'insufficient_balance') {
      throw ApiError.badRequest('Not enough balance to continue per-minute.', undefined, 'insufficient_balance');
    }
    throw ApiError.conflict('This consultation was already extended or has ended.', undefined, 'not_awaiting_extension');
  }

  chat.packageState.perMinuteStartedAt = now;
  chat.packageState.promptedAt = null;

  emit(roomFor(chat._id), CHAT_EVENTS.PER_MINUTE_STARTED, {
    chatId: String(chat._id),
    perMinuteStartedAt: now,
    serverTime: now,
    ratePerMinute: rate,
    balanceRemaining: outcome.balanceRemaining,
  });
  await announce(chat._id, `Consultation continues at ₹${rate}/min.`, 'per_minute_started');

  return {
    chatId: String(chat._id),
    perMinuteStartedAt: now,
    ratePerMinute: rate,
    balanceRemaining: outcome.balanceRemaining,
  };
}

/* -------------------------------------------------------------------------- */
/* The astrologer's own connection dropping mid-session                       */
/* -------------------------------------------------------------------------- */

/**
 * Pauses billing on every active session this astrologer is the other side
 * of — called once their *last* socket disconnects (see socket/index.js).
 * `astrologerDisconnectedAt` is what `runBillingSweep` reads to route a
 * session to `tickAstrologerDisconnectGrace` instead of the normal tick.
 */
async function pauseSessionsForAstrologer(astrologerId, now = new Date()) {
  const sessions = await ChatSession.find({
    astrologer: astrologerId,
    status: 'active',
    type: 'consultation',
    astrologerDisconnectedAt: null,
  });

  for (const chat of sessions) {
    chat.astrologerDisconnectedAt = now;
    // eslint-disable-next-line no-await-in-loop
    await chat.save();
    emit(roomFor(chat._id), CHAT_EVENTS.ASTROLOGER_LEFT, {
      chatId: String(chat._id),
      reconnectSeconds: env.consultation.astrologerReconnectGraceSeconds,
    });
  }
}

/**
 * Resumes whatever this astrologer's own disconnect paused — called once
 * they reconnect (any device; see socket/index.js). `lastBilledAt` (or
 * `startedAt`, for a session paused before its first minute ever ticked) is
 * pushed forward by exactly how long the pause lasted, so the outage costs
 * the seeker nothing: the next minute is due exactly as many seconds from
 * now as it would have been had the astrologer never left.
 */
async function resumeSessionsForAstrologer(astrologerId, now = new Date()) {
  const sessions = await ChatSession.find({
    astrologer: astrologerId,
    status: 'active',
    type: 'consultation',
    astrologerDisconnectedAt: { $ne: null },
  });

  for (const chat of sessions) {
    const pausedMs = now.getTime() - chat.astrologerDisconnectedAt.getTime();
    const anchorField = chat.lastBilledAt ? 'lastBilledAt' : 'startedAt';
    const anchor = chat[anchorField];

    const set = {
      [anchorField]: new Date(anchor.getTime() + pausedMs),
      astrologerDisconnectedAt: null,
      /** A fresh check-ahead window for whatever minute is now due, since the one before the pause is moot. */
      nextMinuteChecked: false,
    };
    /** A package's clock (and an open extend prompt's) is pushed forward by the outage too — the seeker keeps every paid second. */
    if (isPackagePhase(chat)) {
      if (chat.packageState?.endsAt) set['packageState.endsAt'] = new Date(chat.packageState.endsAt.getTime() + pausedMs);
      if (chat.packageState?.promptedAt) set['packageState.promptedAt'] = new Date(chat.packageState.promptedAt.getTime() + pausedMs);
    }

    // eslint-disable-next-line no-await-in-loop
    await ChatSession.updateOne({ _id: chat._id }, { $set: set });
    emit(roomFor(chat._id), CHAT_EVENTS.ASTROLOGER_JOINED, {
      chatId: String(chat._id),
      packageEndsAt: set['packageState.endsAt'],
      serverTime: now,
    });
  }
}

/**
 * Reverses exactly one already-billed minute — both the seeker's debit and
 * the astrologer's matching earning from it — because the service that
 * minute paid for never happened. The only caller today is
 * `tickAstrologerDisconnectGrace`, for the one minute that was in progress
 * when the astrologer dropped and never came back. Never partial: the
 * platform bills in whole minutes (`PARTIAL_MINUTE_ROUNDING`), so this only
 * ever reverses one whole minute, the most recently billed one.
 */
async function refundMinute(chat, title) {
  const tick = await ChatBillingTick.findOne({ chatSession: chat._id, minuteNumber: chat.minutesBilled });
  if (!tick || tick.amount <= 0) {
    /** Free minute, or nothing billed yet — nothing to reverse. */
    return;
  }

  await walletService.post({
    ownerRole: 'user',
    ownerId: chat.user,
    direction: 'credit',
    type: 'refund',
    amount: tick.amount,
    title,
    chatSession: chat._id,
  });

  const commission = Math.round((tick.amount * chat.billing.commissionPercent) / 100);
  const earning = tick.amount - commission;
  if (earning > 0) {
    try {
      await walletService.post({
        ownerRole: 'astrologer',
        ownerId: chat.astrologer,
        direction: 'debit',
        type: 'adjustment',
        amount: earning,
        title: `${title} (earning reversed)`,
        chatSession: chat._id,
      });
    } catch (error) {
      if (!(error instanceof ApiError)) {
        throw error;
      }
      /**
       * The astrologer's balance doesn't cover clawing this back (they may
       * already have withdrawn it) — the same gap services/admin.service.js's
       * own refundTransaction has today. The seeker is made whole either
       * way; this side becomes a manual reconciliation until that's
       * addressed platform-wide.
       */
    }
  }

  await ChatSession.updateOne(
    { _id: chat._id },
    {
      $inc: {
        minutesBilled: -1,
        'billing.amountCharged': -tick.amount,
        'billing.astrologerEarning': -earning,
      },
    },
  );
}

/**
 * One paused session's turn at the tick: still within
 * `ASTROLOGER_RECONNECT_GRACE_SECONDS` of the astrologer's disconnect, this
 * does nothing (billing stays frozen); past it, the session ends — the one
 * minute that was running when they dropped is refunded first, since the
 * seeker never actually got it.
 */
async function tickAstrologerDisconnectGrace(chat, now) {
  const disconnectedMs = now.getTime() - chat.astrologerDisconnectedAt.getTime();
  if (disconnectedMs < env.consultation.astrologerReconnectGraceSeconds * 1000) {
    return { chatId: String(chat._id), action: 'astrologer_disconnect_grace' };
  }

  await refundMinute(chat, 'Astrologer disconnected — last minute refunded');
  await endChat({ chatId: chat._id, accountId: chat.user, endedBy: 'system', reason: 'astrologer_disconnected' });
  return { chatId: String(chat._id), action: 'ended_astrologer_disconnected' };
}

/* -------------------------------------------------------------------------- */
/* The seeker's own balance running out mid-session                          */
/* -------------------------------------------------------------------------- */

/**
 * Resumes whatever a wallet top-up just unblocked — every one of this
 * seeker's own sessions paused on `balanceExhaustedAt` (see the
 * insufficient-balance branch in `tickOneSession`) that the new balance now
 * covers for at least one more minute. Called right after a top-up lands
 * (wallet.controller.js's confirmTopUp) rather than polled by the sweep —
 * an indefinite pause has nothing to time out, only a deposit ever ends it.
 *
 * Mirrors resumeSessionsForAstrologer: `lastBilledAt` (or `startedAt`, if
 * paused before ever ticking) is pushed forward by exactly how long the
 * pause lasted, so the next minute is due exactly as many seconds from now
 * as it would have been had the balance never run out — the pause itself
 * costs the seeker nothing extra, same guarantee as the astrologer-dropped
 * case.
 */
async function resumePausedSessionsForUser(userId, now = new Date()) {
  const sessions = await ChatSession.find({
    user: userId,
    status: 'active',
    type: 'consultation',
    balanceExhaustedAt: { $ne: null },
  });

  const resumed = [];
  for (const chat of sessions) {
    // eslint-disable-next-line no-await-in-loop
    const { affordable } = await canAffordNextMinute(chat);
    if (!affordable) {
      /** Topped up, but still not enough for even one more minute — stays paused. */
      continue;
    }

    const pausedMs = now.getTime() - chat.balanceExhaustedAt.getTime();
    const anchorField = chat.lastBilledAt ? 'lastBilledAt' : 'startedAt';
    const anchor = chat[anchorField];

    // eslint-disable-next-line no-await-in-loop
    await ChatSession.updateOne(
      { _id: chat._id },
      {
        $set: {
          [anchorField]: new Date(anchor.getTime() + pausedMs),
          balanceExhaustedAt: null,
          /** A fresh check-ahead window for whatever minute is now due, since the one before the pause is moot. */
          nextMinuteChecked: false,
        },
      },
    );
    // eslint-disable-next-line no-await-in-loop
    emit(roomFor(chat._id), CHAT_EVENTS.LOW_BALANCE, {
      chatId: String(chat._id),
      exhausted: false,
      paused: false,
      balanceRemaining: await balanceFor(userId),
    });
    resumed.push(String(chat._id));
  }
  return resumed;
}

/**
 * The live billing tick: bills every active session that is due, handles
 * low-balance warnings, grace, and crash recovery, and ages out any join
 * request that has sat unanswered too long. `now` is injectable so tests run
 * against a fake clock instead of waiting on real time — see
 * jobs/chatBilling.job.js for the real recurring scheduler.
 */
async function runBillingSweep(now = new Date()) {
  /**
   * `type: 'consultation'` only — an `ai` thread (getOrCreateAiChat) is also
   * `status: 'active'`, forever, with no astrologer and nothing ever billed
   * against it. Ticking one here found it long overdue (its startedAt is
   * whenever the thread was first opened, possibly weeks ago, since nothing
   * else ever advances lastBilledAt) and tried to timeout-end it with
   * `accountId: chat.astrologer` — undefined, since an AI thread has none —
   * which participantChat rightly refuses, crashing the sweep every run.
   */
  const active = await ChatSession.find({ status: 'active', type: 'consultation' });
  const results = [];
  for (const chat of active) {
    /**
     * Paused for an astrologer-disconnect grace — never ticked; see
     * tickAstrologerDisconnectGrace. A balance pause needs no such routing:
     * tickOneSession itself returns 'balance_paused' immediately whenever
     * `balanceExhaustedAt` is set, since it has no timeout to poll for either.
     */
    // eslint-disable-next-line no-await-in-loop
    results.push(
      chat.astrologerDisconnectedAt
        ? await tickAstrologerDisconnectGrace(chat, now)
        : await tickOneSession(chat, now),
    );
  }

  await expireStaleRequests(undefined, now);

  return results;
}

/* -------------------------------------------------------------------------- */
/* Ending, and paying for it                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ends an active chat.
 *
 * The live tick (runBillingSweep, above) may not have caught up to this exact
 * instant — before closing, this bills whatever is still outstanding up to
 * now, so the total charged always equals `minutesFor(actual elapsed
 * seconds)`, exactly what the old lump-sum settle-at-end used to compute in
 * one shot, just spread across the session instead of charged all at once
 * when it closes. If a minute genuinely cannot be afforded, the loop stops —
 * the same "charge what was actually there" grace the old code had.
 */
async function endChat({ chatId, accountId, endedBy, reason }) {
  const [chat, role] = await participantChat(chatId, accountId);

  if (chat.status !== 'active') {
    throw ApiError.badRequest(`This chat is already ${chat.status}.`);
  }

  const now = new Date();
  const seconds = Math.max(Math.round((now.getTime() - chat.startedAt.getTime()) / 1000), 0);
  /**
   * Neither a crash-recovery timeout (tickOneSession, when a session's last
   * tick is older than MAX_TICK_GAP_MS) nor an astrologer-disconnect grace
   * running out (tickAstrologerDisconnectGrace, whose caller already
   * refunded the one minute that was interrupted) may true up to the full
   * elapsed time — that elapsed span IS the outage, and charging for it
   * would bill the seeker for time nobody was there to answer, not for
   * service received. Every other end reason trues up normally, to exactly
   * minutesFor(actual elapsed seconds).
   */
  const isPackage = chat.billing.mode === 'package';
  const perMinuteSince = chat.packageState?.perMinuteStartedAt;
  let minutesOwed;
  if (!isPackage) {
    minutesOwed =
      reason === 'timeout' || reason === 'astrologer_disconnected' ? chat.minutesBilled : minutesFor(seconds);
  } else if (!perMinuteSince) {
    /** Package time is prepaid — there is no per-minute meter to true up. */
    minutesOwed = chat.minutesBilled;
  } else {
    /** Switched to per-minute: true up only the per-minute tail, measured from the switch — never the package time before it. */
    const perMinuteSeconds = Math.max(Math.round((now.getTime() - perMinuteSince.getTime()) / 1000), 0);
    minutesOwed =
      reason === 'timeout' || reason === 'astrologer_disconnected' ? chat.minutesBilled : minutesFor(perMinuteSeconds);
  }

  while (chat.minutesBilled < minutesOwed) {
    // eslint-disable-next-line no-await-in-loop
    const result = await billNextMinute(chat, now);
    if (!result.billed) {
      break;
    }
  }

  const packageMinutesTotal = isPackage ? (chat.billing.packages || []).reduce((sum, entry) => sum + entry.minutes, 0) : 0;
  if (isPackage) {
    await settlePackageEnd(chat, { now, endedBy: endedBy || role, reason });
  }
  /** Minutes for the astrologer's/seeker's stats: what was billed per-minute, plus any package minutes bought. */
  const consultedMinutes = minutesOwed + packageMinutesTotal;

  chat.status = 'ended';
  chat.durationSeconds = seconds;
  chat.billing.isSettled = true;
  chat.endedAt = now;
  chat.endedBy = endedBy || role;
  chat.endReason = reason;
  await chat.save();

  await Astrologer.updateOne(
    { _id: chat.astrologer },
    {
      $inc: {
        'presence.activeSessions': -1,
        'metrics.totalConsultations': 1,
        [chat.channel === 'call' ? 'metrics.callMinutes' : 'metrics.chatMinutes']: consultedMinutes,
      },
    },
  );
  /** Busy only while there is still something running. */
  await Astrologer.updateOne(
    { _id: chat.astrologer, 'presence.activeSessions': { $lte: 0 } },
    { $set: { 'presence.isBusy': false, 'presence.activeSessions': 0 } },
  );

  await User.updateOne(
    { _id: chat.user },
    { $inc: { 'stats.consultations': 1, 'stats.chatMinutes': consultedMinutes } },
  );

  await Message.system(chat._id, 'Consultation ended.', 'ended');

  emit(roomFor(chat._id), CHAT_EVENTS.ENDED, {
    chatId: String(chat._id),
    endedBy: chat.endedBy,
    reason: chat.endReason,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing.amountCharged,
    billingMode: chat.billing.mode,
    packageRefundAmount: isPackage ? chat.billing.packageRefundAmount : undefined,
  });

  return chat;
}

/**
 * The package side of ending a session: works out how much paid package time
 * went unused, asks the refund policy hook what (if anything) to give back —
 * config/packages.js's unusedPackageRefund, a no-op until that policy is
 * decided — posts that refund, then pays the astrologer their share of what
 * the seeker actually kept paying for. Runs before endChat's own save, so
 * everything it sets on `chat` in memory is persisted with it.
 */
async function settlePackageEnd(chat, { now, endedBy, reason }) {
  const unusedSeconds = unusedPackageSeconds(chat.packageState, now);
  chat.packageState.unusedSeconds = unusedSeconds;

  const policyRefund = Math.round(
    Number(unusedPackageRefund({ unusedSeconds, ratePerMinute: chat.billing.ratePerMinute, endedBy, reason })) || 0,
  );
  const refund = Math.min(Math.max(policyRefund, 0), chat.billing.packageAmountCharged || 0);
  if (refund > 0) {
    await walletService.post({
      ownerRole: 'user',
      ownerId: chat.user,
      direction: 'credit',
      type: 'refund',
      amount: refund,
      title: 'Unused package time refunded',
      chatSession: chat._id,
    });
    chat.billing.packageRefundAmount = refund;
    chat.billing.amountCharged -= refund;
  }

  await settlePackageEarning(chat);
}

/**
 * Credits the astrologer their share of package money — once per session,
 * ever: the `packageEarningSettled` flag is claimed atomically before the
 * credit, so two concurrent ends can't both pay.
 */
/**
 * The share is taken from what the seeker actually paid — i.e. after any
 * admin package discount — so a discount is borne by platform and astrologer
 * in proportion to the commission split.
 */
async function settlePackageEarning(chat) {
  const base = (chat.billing.packageAmountCharged || 0) - (chat.billing.packageRefundAmount || 0);
  const claimed = await ChatSession.updateOne(
    { _id: chat._id, 'billing.packageEarningSettled': { $ne: true } },
    { $set: { 'billing.packageEarningSettled': true } },
  );
  chat.billing.packageEarningSettled = true;
  if (claimed.modifiedCount === 0 || base <= 0) {
    return 0;
  }

  const earning = base - Math.round((base * chat.billing.commissionPercent) / 100);
  if (earning > 0) {
    await walletService.post({
      ownerRole: 'astrologer',
      ownerId: chat.astrologer,
      direction: 'credit',
      type: 'consultation_earning',
      amount: earning,
      title: `${chat.channel === 'call' ? 'Call' : 'Chat'} consultation — package earnings`,
      chatSession: chat._id,
    });
    await ChatSession.updateOne({ _id: chat._id }, { $inc: { 'billing.astrologerEarning': earning } });
    chat.billing.astrologerEarning += earning;
  }
  return earning;
}

/** The seeker scores the consultation. One rating per chat. */
async function rateChat({ chatId, userId, rating, comment }) {
  const chat = await ChatSession.findOne({ _id: chatId, user: userId });
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (chat.status !== 'ended') {
    throw ApiError.badRequest('You can rate a consultation once it has ended.');
  }
  if (chat.review?.rating) {
    throw ApiError.conflict('You have already rated this consultation.');
  }

  const stars = Number(rating);
  if (!(stars >= 1 && stars <= 5)) {
    throw ApiError.badRequest('Give a rating between 1 and 5.', { rating: 'Pick 1 to 5 stars.' });
  }

  chat.review = { rating: stars, comment, ratedAt: new Date() };
  await chat.save();

  /** Rolls the astrologer's average and its histogram forward. */
  const astrologer = await Astrologer.findById(chat.astrologer);
  if (astrologer) {
    astrologer.applyRating(stars);
    await astrologer.save();
  }

  await User.updateOne({ _id: userId }, { $inc: { 'stats.reviewsGiven': 1 } });

  return chat;
}

/* -------------------------------------------------------------------------- */
/* The AI assistant                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The seeker's AI thread (user_app's AI Astrology screen).
 *
 * One thread per seeker, kept forever, so the conversation is still there when
 * they come back. It is an ordinary ChatSession with `type: 'ai'` and no
 * astrologer on the other end, which means the same Message model, the same
 * `seq` ordering and the same transcript endpoint all work unchanged.
 *
 * It is free — `ratePerMinute` is zero and nothing is ever billed.
 */
async function getOrCreateAiChat(userId) {
  const existing = await ChatSession.findOne({ user: userId, type: 'ai' });
  if (existing) {
    return existing;
  }

  const chat = await ChatSession.create({
    type: 'ai',
    channel: 'chat',
    user: userId,
    status: 'active',
    startedAt: new Date(),
    billing: { ratePerMinute: 0, commissionPercent: 0 },
  });

  const greeting =
    'Namaste! 🙏 I am your AI Astrology Assistant. I can answer questions about ' +
    'your birth chart, planetary transits, compatibility, and more. How may I ' +
    'guide you today?';
  await Message.send({
    chatId: chat._id,
    senderRole: 'ai',
    type: 'text',
    content: { text: greeting },
    tokenCount: estimateTokens(greeting),
  });

  return chat;
}

/**
 * Posts a question to the assistant and stores its answer.
 *
 * The actual reply is assistantService.generateReply's job — building the
 * system prompt, the seeker's own chart summary, this thread's rolling
 * memory, and its recent turns into one call to services/llm/index.js. This
 * function only owns the ChatSession/Message bookkeeping around that: the
 * question must be saved *before* generateReply runs (it reads the
 * transcript back as context, the new question included), and the answer
 * saved after, with its own real token count.
 *
 * Whether this turn also crosses the rolling-summary threshold is checked
 * right here (assistantService.maybeSummarise is a no-op unless it does) —
 * but fired detached from this response, never awaited: folding old turns
 * into memory is a second LLM call, and answering the seeker's own question
 * must never be made to wait on it too.
 *
 * Returns both turns, so the screen can append them together.
 */
async function sendAiMessage({ userId, text, clientMessageId }) {
  if (!text || !String(text).trim()) {
    throw ApiError.badRequest('Type a question first.', { text: 'Ask something.' });
  }

  const chat = await getOrCreateAiChat(userId);
  const trimmed = String(text).trim();

  const question = await Message.send({
    chatId: chat._id,
    senderId: userId,
    senderRole: 'user',
    type: 'text',
    content: { text: trimmed },
    clientMessageId,
    tokenCount: estimateTokens(trimmed),
  });

  const reply = await assistantService.generateReply({ chat, userId });

  const answer = await Message.send({
    chatId: chat._id,
    senderRole: 'ai',
    type: 'text',
    content: { text: reply.text },
    tokenCount: reply.tokenCount,
  });

  assistantService.maybeSummarise(chat._id).catch(error => {
    console.error('[assistant] rolling summary failed:', error.message);
  });

  return {
    chatId: String(chat._id),
    question: question.toSocketPayload(),
    answer: answer.toSocketPayload(),
  };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/** One chat, in the shape both apps' list rows read. */
function toChatRow(chat, viewerRole) {
  const other = viewerRole === 'user' ? chat.astrologer : chat.user;

  return {
    id: String(chat._id),
    channel: chat.channel,
    status: chat.status,
    with: other && other.name
      ? { id: String(other._id), name: other.name, photo: other.photoUrl || other.avatarUrl }
      : null,
    topic: chat.intake?.topic,
    /** Only the seeker's own past submissions matter here — the "recent chats" intake shortcut on their own side, not something the astrologer's list rows need. */
    birthDetails: viewerRole === 'user' && chat.intake?.birthDetails
      ? {
          fullName: chat.intake.birthDetails.fullName,
          gender: chat.intake.birthDetails.gender,
          dateOfBirth: chat.intake.birthDetails.dateOfBirth,
          timeOfBirth: chat.intake.birthDetails.timeOfBirth,
          place: chat.intake.birthDetails.place?.formatted,
        }
      : undefined,
    lastMessage: chat.lastMessage,
    unread: chat.unread?.[viewerRole] || 0,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing?.amountCharged,
    astrologerEarning: chat.billing?.astrologerEarning,
    billingMode: chat.billing?.mode,
    packageMinutes: chat.billing?.mode === 'package'
      ? (chat.billing.packages || []).reduce((sum, entry) => sum + entry.minutes, 0) || chat.billing.requestedPackageMinutes
      : undefined,
    rating: chat.review?.rating,
    createdAt: chat.createdAt,
  };
}

/**
 * Where a package session stands, for a screen opening or reconnecting —
 * `serverTime` lets the app count down against the server's clock rather
 * than trust its own. `undefined` for a per-minute session. The extension
 * options are included (priced against the live balance) only while the
 * prompt is open, so a reconnecting app can re-show it straight away.
 */
async function packageViewFor(chat, now = new Date()) {
  if (chat.billing?.mode !== 'package') {
    return undefined;
  }
  const state = chat.packageState || {};
  const phase = state.perMinuteStartedAt ? 'per_minute' : state.promptedAt ? 'awaiting_extension' : 'package';
  const responseSeconds = env.consultation.packageExtensionResponseSeconds;

  const view = {
    phase,
    endsAt: state.endsAt,
    warningSeconds: env.consultation.packageWarningSeconds,
    promptedAt: state.promptedAt,
    respondBy: state.promptedAt ? new Date(state.promptedAt.getTime() + responseSeconds * 1000) : undefined,
    respondWithinSeconds: responseSeconds,
    perMinuteStartedAt: state.perMinuteStartedAt,
    requestedMinutes: chat.billing.requestedPackageMinutes,
    minutesPurchased: (chat.billing.packages || []).reduce((sum, entry) => sum + entry.minutes, 0),
    amountCharged: chat.billing.packageAmountCharged || 0,
    purchases: (chat.billing.packages || []).map(entry => ({
      seq: entry.seq,
      kind: entry.kind,
      minutes: entry.minutes,
      discountPercent: entry.discountPercent,
      originalAmount: entry.originalAmount,
      amount: entry.amount,
      purchasedAt: entry.purchasedAt,
    })),
  };

  if (phase === 'awaiting_extension' && chat.status === 'active') {
    const balance = await balanceFor(chat.user);
    view.balanceRemaining = balance;
    view.perMinuteAffordable = balance >= chat.billing.ratePerMinute;
    view.packages = packageQuotes(chat.billing.ratePerMinute, balance, await currentPackageDiscounts());
  }
  return view;
}

/**
 * One session's current state, with server-computed remaining minutes — what
 * a client polls, or loads on reconnect, to know where the meter stands. The
 * timer is 100% server-side; a client only ever displays this, never
 * computes it.
 */
async function getSessionState({ chatId, accountId }) {
  const [chat, role] = await participantChat(chatId, accountId);

  return {
    chatId: String(chat._id),
    role,
    channel: chat.channel,
    status: chat.status,
    startedAt: chat.startedAt,
    ratePerMinute: chat.billing.ratePerMinute,
    minutesBilled: chat.minutesBilled,
    amountCharged: chat.billing.amountCharged,
    /** Same "is it paused right now" truth as joinChat's own `paused` — this REST read is what a screen's very first render (before any socket rejoin has answered) has to go on. */
    paused: Boolean(chat.balanceExhaustedAt),
    pausedSince: chat.balanceExhaustedAt,
    minutesRemaining: chat.status === 'active' ? await remainingMinutesFor(chat) : undefined,
    endedAt: chat.endedAt,
    endReason: chat.endReason,
    billingMode: chat.billing.mode,
    package: await packageViewFor(chat),
    serverTime: new Date(),
  };
}

/** The consultation list for whoever is asking. */
async function listChats({ accountId, role, status, page = 1, limit = 20 }) {
  const query = role === 'user' ? { user: accountId } : { astrologer: accountId };
  if (status) {
    query.status = status;
  }

  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [rows, total] = await Promise.all([
    ChatSession.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('astrologer', 'name photoUrl')
      .populate('user', 'name avatarUrl'),
    ChatSession.countDocuments(query),
  ]);

  return {
    items: rows.map(chat => toChatRow(chat, role)),
    total,
    page: Number(page),
    limit: Number(limit),
  };
}

/**
 * Ages a request out to `missed` once it has sat unanswered past the window
 * the astrologer was shown it in (`REQUEST_TIMEOUT_SECONDS`) — the astrologer
 * "didn't join in time" case. Nothing is ever charged at the request stage
 * (billing only starts once accepted, in acceptChat), so there is no refund
 * to issue here — just closing the request out and telling the seeker.
 *
 * Called two ways: scoped to one astrologer, lazily, wherever that
 * astrologer's own queue is read (pendingRequests, below); and globally
 * (`astrologerId` omitted) from runBillingSweep's own recurring tick, so a
 * seeker is not left waiting on a dead request until something else happens
 * to read that astrologer's queue.
 */
async function expireStaleRequests(astrologerId, now = new Date()) {
  const cutoff = new Date(now.getTime() - REQUEST_TIMEOUT_SECONDS * 1000);
  const filter = { status: 'requested', requestedAt: { $lte: cutoff } };
  if (astrologerId) {
    filter.astrologer = astrologerId;
  }

  const stale = await ChatSession.find(filter);
  for (const chat of stale) {
    chat.status = 'missed';
    chat.endedAt = now;
    chat.endedBy = 'system';
    chat.endReason = 'astrologer_no_response';
    // eslint-disable-next-line no-await-in-loop
    await chat.save();

    emit(`user:${chat.user}`, 'chat:missed', { chatId: String(chat._id) });
    // eslint-disable-next-line no-await-in-loop
    await notificationService
      .notify({
        ownerRole: 'user',
        ownerId: chat.user,
        type: 'consultation_missed',
        title: 'No response',
        body: 'The astrologer did not respond in time. Please try again or choose someone else.',
        action: { screen: 'consultation', id: String(chat._id) },
      })
      .catch(() => {}); // best-effort — a notification failure must never block the expiry itself
  }

  return stale.length;
}

/** The astrologer's incoming-request queue. */
async function pendingRequests(astrologerId) {
  await expireStaleRequests(astrologerId);

  const rows = await ChatSession.find({ astrologer: astrologerId, status: 'requested' })
    .sort({ requestedAt: -1 })
    .populate('user', 'name avatarUrl');

  return rows.map(chat => ({
    chatId: String(chat._id),
    channel: chat.channel,
    user: chat.user ? { id: String(chat.user._id), name: chat.user.name, photo: chat.user.avatarUrl } : null,
    intake: chat.intake,
    ratePerMinute: chat.billing.ratePerMinute,
    billingMode: chat.billing.mode,
    packageMinutes: chat.billing.requestedPackageMinutes,
    requestedAt: chat.requestedAt,
  }));
}

/** One page of the transcript, walking backwards from `beforeSeq`. */
async function getMessages({ chatId, accountId, beforeSeq, limit = 30 }) {
  await participantChat(chatId, accountId);

  const rows = await Message.history(chatId, beforeSeq, Number(limit));
  /** history() returns newest first; a transcript reads oldest first. */
  return rows.reverse().map(message => message.toSocketPayload());
}

/**
 * Entering a conversation over a socket. The caller says the highest `seq` it
 * holds and gets back everything it missed, which is what makes a dropped
 * connection a non-event.
 */
async function joinChat({ chatId, accountId, lastSeq = 0 }) {
  const [chat, role] = await participantChat(chatId, accountId);
  const missed = await Message.since(chatId, lastSeq);

  return {
    chatId: String(chat._id),
    role,
    status: chat.status,
    /**
     * Whether billing is paused for insufficient balance, RIGHT NOW — not
     * just "was a pause event ever seen." A live pause/resume push
     * (chat:low_balance) can be missed entirely by a socket that was briefly
     * disconnected; this join/rejoin response (services/socket.ts's own
     * `rejoin`, which fires on every connect, not only reconnects) is what
     * lets a client recover the true current state instead of trusting
     * whatever it last happened to see.
     */
    paused: Boolean(chat.balanceExhaustedAt),
    /** When the current pause began, if any — lets a (re)joining client backdate its own freeze point instead of only freezing from whenever it happens to notice. */
    pausedSince: chat.balanceExhaustedAt,
    seq: chat.messageSeq,
    unread: chat.unread[role],
    messages: missed.map(message => message.toSocketPayload()),
    /** Package sessions: the true current package clock/prompt, for the same reason as `paused` above. */
    billingMode: chat.billing?.mode,
    package: await packageViewFor(chat),
    serverTime: new Date(),
  };
}

/**
 * Posting a message.
 *
 * The sender is taken from the authenticated account, never from the payload,
 * so nobody can post as somebody else.
 */
async function sendMessage({ chatId, accountId, type = 'text', content, replyTo, clientMessageId }) {
  if (!Message.canSend(type)) {
    throw ApiError.badRequest(`"${type}" messages are not enabled yet.`);
  }

  const [chat, role] = await participantChat(chatId, accountId);
  if (!chat.acceptsMessages()) {
    throw ApiError.badRequest(`This chat is ${chat.status}.`);
  }
  /** A package whose time is up is frozen until the seeker extends, switches to per-minute, or ends. */
  if (isPackagePhase(chat) && chat.packageState?.endsAt
    && (chat.packageState.promptedAt || chat.packageState.endsAt.getTime() <= Date.now())) {
    throw ApiError.badRequest('Package time is over — extend the consultation to keep chatting.', undefined, 'package_time_up');
  }

  try {
    return await Message.send({
      chatId,
      senderId: accountId,
      senderRole: role,
      type,
      content,
      replyTo,
      clientMessageId,
    });
  } catch (error) {
    /** A refused payload is the caller's problem, not a server fault. */
    if (error.name === 'ValidationError' || /message (needs|cannot carry|type)/.test(error.message)) {
      throw ApiError.badRequest(error.message);
    }
    throw error;
  }
}

/** Moves the other side's ticks up to `seq`. Safe to call twice. */
async function markSeen({ chatId, accountId, seq, state = 'read' }) {
  const [, role] = await participantChat(chatId, accountId);
  await Message.markSeen(chatId, seq, role, state);
  return role;
}

module.exports = {
  participantChat,
  getOrCreateAiChat,
  sendAiMessage,
  precheckSession,
  requestChat,
  acceptChat,
  rejectChat,
  cancelChat,
  billNextMinute,
  purchasePackage,
  tickOneSession,
  tickPackageSession,
  extendPackage,
  continuePerMinute,
  isPackagePhase,
  tickAstrologerDisconnectGrace,
  pauseSessionsForAstrologer,
  resumeSessionsForAstrologer,
  resumePausedSessionsForUser,
  refundMinute,
  runBillingSweep,
  remainingMinutesFor,
  getSessionState,
  endChat,
  rateChat,
  listChats,
  pendingRequests,
  expireStaleRequests,
  getMessages,
  joinChat,
  sendMessage,
  markSeen,
  toChatRow,
  REQUEST_TIMEOUT_SECONDS,
  MIN_SESSION_MINUTES,
  TICK_INTERVAL_MS,
  LOW_BALANCE_WARNING_MINUTES,
  MAX_TICK_GAP_MS,
};
