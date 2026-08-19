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

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const { ChatSession, Message, CHAT_EVENTS, roomFor } = require('../models/Chat');
const ApiError = require('../utils/ApiError');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const settingsService = require('./settings.service');

/** How long an unanswered request stays open, in seconds. */
const REQUEST_TIMEOUT_SECONDS = 120;

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
    /** No socket server (a script or a test); the database is still correct. */
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
/* Starting a consultation                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The seeker asks an astrologer for a chat.
 *
 * Checks in order: the astrologer can take work, the seeker can afford at least
 * a minute, and there is not already a request in flight between these two.
 */
async function requestChat({ userId, astrologerId, channel = 'chat', intake = {} }) {
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

  const ratePerMinute = astrologer.rateFor(channel);

  /**
   * Free minutes come from two places: the platform's one-off first-consult
   * offer, and whatever this astrologer grants. The seeker gets the larger.
   */
  const settings = await settingsService.get();
  const service = astrologer.services.find(entry => entry.type === channel);
  /** The platform's offer is whatever the panel currently says it is. */
  const platformFree = user.freeConsultation.isUsed ? 0 : settings.freeTrialMinutes;
  const freeMinutes = Math.max(platformFree, service?.freeMinutes || 0);

  /** Nothing free and nothing in the wallet means the chat cannot start. */
  if (freeMinutes === 0 && user.wallet.balance < ratePerMinute) {
    throw ApiError.badRequest(
      `You need at least ₹${ratePerMinute} in your wallet to start this chat.`,
      undefined,
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
      birthDetails: intake.birthDetails,
      topic: intake.topic,
      question: intake.question,
      minutesBooked: intake.minutes,
    },
    billing: {
      ratePerMinute,
      freeMinutes,
      commissionPercent: astrologer.commissionPercent,
    },
  });

  /** Every request counts towards the acceptance rate, answered or not. */
  await Astrologer.updateOne({ _id: astrologerId }, { $inc: { 'metrics.requestsReceived': 1 } });

  /** The astrologer's app shows the incoming-request popup off this. */
  emit(`astrologer:${astrologerId}`, 'chat:requested', {
    chatId: String(chat._id),
    channel,
    user: { id: String(user._id), name: user.name, avatarUrl: user.avatarUrl },
    intake: chat.intake,
    ratePerMinute,
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
 * The astrologer takes the request. The meter starts here.
 */
async function acceptChat({ chatId, astrologerId }) {
  const chat = await ChatSession.findOne({ _id: chatId, astrologer: astrologerId });
  if (!chat) {
    throw ApiError.notFound('Chat not found.');
  }
  if (chat.status !== 'requested') {
    throw ApiError.badRequest(`This request is already ${chat.status}.`);
  }

  chat.status = 'active';
  chat.startedAt = new Date();
  await chat.save();

  await Astrologer.updateOne(
    { _id: astrologerId },
    {
      $inc: { 'presence.activeSessions': 1, 'metrics.requestsAccepted': 1 },
      $set: { 'presence.isBusy': true },
    },
  );

  /** The opening line of every transcript, in the server's own voice. */
  await Message.system(chat._id, 'Consultation started.', 'started');

  emit(roomFor(chat._id), 'chat:started', {
    chatId: String(chat._id),
    startedAt: chat.startedAt,
    ratePerMinute: chat.billing.ratePerMinute,
    freeMinutes: chat.billing.freeMinutes,
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
/* Ending, and paying for it                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ends an active chat and settles it.
 *
 * Three things happen, in this order:
 *   1. work out what it cost  (settle() on the model rounds up to the minute)
 *   2. take it from the seeker's wallet and pay the astrologer their share
 *   3. mark the chat ended and tell both sides
 *
 * Charging before marking it ended matters: if the charge fails, the chat is
 * left active and can be ended again, rather than being closed for free.
 */
async function endChat({ chatId, accountId, endedBy, reason }) {
  const [chat, role] = await participantChat(chatId, accountId);

  if (chat.status !== 'active') {
    throw ApiError.badRequest(`This chat is already ${chat.status}.`);
  }

  const seconds = Math.max(Math.round((Date.now() - chat.startedAt.getTime()) / 1000), 0);
  chat.settle(seconds);

  const astrologer = await Astrologer.findById(chat.astrologer);
  const chargeable = chat.billing.amountCharged;

  if (chargeable > 0) {
    /**
     * The seeker may have spent their balance elsewhere mid-chat. Rather than
     * fail, take whatever is actually there — the wallet cannot go negative,
     * and a chat that already happened has to be closed.
     */
    const user = await User.findById(chat.user).select('wallet');
    const toCharge = Math.min(chargeable, user.wallet.balance);

    if (toCharge > 0) {
      await walletService.post({
        ownerRole: 'user',
        ownerId: chat.user,
        direction: 'debit',
        type: 'consultation_charge',
        amount: toCharge,
        title: `${chat.channel === 'call' ? 'Call' : 'Chat'} with ${astrologer?.name || 'astrologer'}`,
        chatSession: chat._id,
      });
    }

    /** The astrologer is paid on what was actually collected, less commission. */
    const commission = Math.round((toCharge * chat.billing.commissionPercent) / 100);
    const earning = toCharge - commission;

    chat.billing.amountCharged = toCharge;
    chat.billing.astrologerEarning = earning;

    if (earning > 0) {
      await walletService.post({
        ownerRole: 'astrologer',
        ownerId: chat.astrologer,
        direction: 'credit',
        type: 'consultation_earning',
        amount: earning,
        title: `${chat.channel === 'call' ? 'Call' : 'Chat'} consultation`,
        chatSession: chat._id,
      });
    }
  }

  chat.status = 'ended';
  chat.endedAt = new Date();
  chat.endedBy = endedBy || role;
  chat.endReason = reason;
  await chat.save();

  /** The platform's free-consult offer is spent the first time it is used. */
  if (chat.billing.freeMinutes > 0) {
    await User.updateOne(
      { _id: chat.user, 'freeConsultation.isUsed': false },
      {
        $set: {
          'freeConsultation.isUsed': true,
          'freeConsultation.usedAt': new Date(),
          'freeConsultation.usedInSession': chat._id,
        },
      },
    );
  }

  const minutes = Math.ceil(seconds / 60);
  await Astrologer.updateOne(
    { _id: chat.astrologer },
    {
      $inc: {
        'presence.activeSessions': -1,
        'metrics.totalConsultations': 1,
        [chat.channel === 'call' ? 'metrics.callMinutes' : 'metrics.chatMinutes']: minutes,
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
    { $inc: { 'stats.consultations': 1, 'stats.chatMinutes': minutes } },
  );

  await Message.system(chat._id, 'Consultation ended.', 'ended');

  emit(roomFor(chat._id), CHAT_EVENTS.ENDED, {
    chatId: String(chat._id),
    endedBy: chat.endedBy,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing.amountCharged,
  });

  return chat;
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
    billing: { ratePerMinute: 0, freeMinutes: 0, commissionPercent: 0 },
  });

  await Message.send({
    chatId: chat._id,
    senderRole: 'ai',
    type: 'text',
    content: {
      text:
        'Namaste! 🙏 I am your AI Astrology Assistant. I can answer questions about ' +
        'your birth chart, planetary transits, compatibility, and more. How may I ' +
        'guide you today?',
    },
  });

  return chat;
}

/**
 * Produces the assistant's answer.
 *
 * **There is no AI provider wired up yet.** This returns a holding reply so the
 * screen works end to end. When a model is connected, call it here with the
 * question and the seeker's birth details — everything around this function
 * already stores and delivers whatever it returns.
 */
async function generateAiReply({ question, birthDetails }) {
  const known = birthDetails?.dateOfBirth
    ? 'I can see your birth details on file, so I can work from your chart.'
    : 'Add your birth details to your profile and I can answer from your own chart.';

  return (
    `You asked: “${String(question).trim()}”.\n\n${known}\n\n` +
    'The astrology engine is not connected yet, so I cannot give you a real ' +
    'reading. In the meantime a human astrologer can — try Find Astrologers.'
  );
}

/**
 * Posts a question to the assistant and stores its answer.
 *
 * Returns both turns, so the screen can append them together.
 */
async function sendAiMessage({ userId, text, clientMessageId }) {
  if (!text || !String(text).trim()) {
    throw ApiError.badRequest('Type a question first.', { text: 'Ask something.' });
  }

  const chat = await getOrCreateAiChat(userId);

  const question = await Message.send({
    chatId: chat._id,
    senderId: userId,
    senderRole: 'user',
    type: 'text',
    content: { text: String(text).trim() },
    clientMessageId,
  });

  const UserProfile = require('../models/UserProfile');
  const profile = await UserProfile.findOne({ user: userId }).select('birthDetails');

  const answer = await Message.send({
    chatId: chat._id,
    senderRole: 'ai',
    type: 'text',
    content: {
      text: await generateAiReply({
        question: text,
        birthDetails: profile?.birthDetails,
      }),
    },
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
    lastMessage: chat.lastMessage,
    unread: chat.unread?.[viewerRole] || 0,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing?.amountCharged,
    astrologerEarning: chat.billing?.astrologerEarning,
    rating: chat.review?.rating,
    createdAt: chat.createdAt,
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

/** The astrologer's incoming-request queue. */
async function pendingRequests(astrologerId) {
  const rows = await ChatSession.find({ astrologer: astrologerId, status: 'requested' })
    .sort({ requestedAt: -1 })
    .populate('user', 'name avatarUrl');

  return rows.map(chat => ({
    chatId: String(chat._id),
    channel: chat.channel,
    user: chat.user ? { id: String(chat.user._id), name: chat.user.name, photo: chat.user.avatarUrl } : null,
    intake: chat.intake,
    ratePerMinute: chat.billing.ratePerMinute,
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
    seq: chat.messageSeq,
    unread: chat.unread[role],
    messages: missed.map(message => message.toSocketPayload()),
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
  requestChat,
  acceptChat,
  rejectChat,
  cancelChat,
  endChat,
  rateChat,
  listChats,
  pendingRequests,
  getMessages,
  joinChat,
  sendMessage,
  markSeen,
  toChatRow,
  REQUEST_TIMEOUT_SECONDS,
};
