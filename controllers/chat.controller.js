/**
 * Consultations over HTTP.
 *
 * The socket layer (socket/chat.handlers.js) carries live messages; these
 * routes carry everything else — starting a chat, ending one, reading history.
 * Both call the same services/chat.service.js, so the rules cannot differ
 * between them.
 */

const chatService = require('../services/chat.service');
const asyncHandler = require('../utils/asyncHandler');

/** POST /api/v1/chats/precheck — is the seeker's balance enough to start, and for how many minutes? Creates nothing. */
const precheck = asyncHandler(async (req, res) => {
  const result = await chatService.precheckSession({
    userId: req.account.accountId,
    astrologerId: req.body.astrologerId,
    channel: req.body.channel || 'chat',
  });
  return res.json(result);
});

/** GET /api/v1/chats/:chatId — one session's state, with server-computed remaining minutes. */
const state = asyncHandler(async (req, res) => {
  const result = await chatService.getSessionState({
    chatId: req.params.chatId,
    accountId: req.account.accountId,
  });
  return res.json(result);
});

/** POST /api/v1/chats — the seeker asks an astrologer for a chat. */
const request = asyncHandler(async (req, res) => {
  const chat = await chatService.requestChat({
    userId: req.account.accountId,
    astrologerId: req.body.astrologerId,
    channel: req.body.channel || 'chat',
    intake: req.body.intake || {},
    /** `{ mode: 'package', packageMinutes, quotedPrice }` for a package; omitted (or anything else) means per-minute, as always. */
    billing: req.body.billing,
  });

  return res.status(201).json({
    chatId: String(chat._id),
    status: chat.status,
    ratePerMinute: chat.billing.ratePerMinute,
    billingMode: chat.billing.mode,
    packageMinutes: chat.billing.requestedPackageMinutes,
    expiresInSeconds: chatService.REQUEST_TIMEOUT_SECONDS,
  });
});

/** POST /api/v1/chats/:chatId/extend — the seeker buys another package when the current one runs out. */
const extend = asyncHandler(async (req, res) => {
  const result = await chatService.extendPackage({
    chatId: req.params.chatId,
    userId: req.account.accountId,
    packageMinutes: req.body.packageMinutes,
    quotedPrice: req.body.quotedPrice,
  });
  return res.json(result);
});

/** POST /api/v1/chats/:chatId/continue-per-minute — the seeker switches a finished package over to per-minute billing. */
const continuePerMinute = asyncHandler(async (req, res) => {
  const result = await chatService.continuePerMinute({
    chatId: req.params.chatId,
    userId: req.account.accountId,
  });
  return res.json(result);
});

/** POST /api/v1/chats/:chatId/accept — the astrologer takes it. */
const accept = asyncHandler(async (req, res) => {
  const chat = await chatService.acceptChat({
    chatId: req.params.chatId,
    astrologerId: req.account.accountId,
  });
  return res.json({ chatId: String(chat._id), status: chat.status, startedAt: chat.startedAt });
});

/** POST /api/v1/chats/:chatId/reject */
const reject = asyncHandler(async (req, res) => {
  const chat = await chatService.rejectChat({
    chatId: req.params.chatId,
    astrologerId: req.account.accountId,
    reason: req.body.reason,
  });
  return res.json({ chatId: String(chat._id), status: chat.status });
});

/** POST /api/v1/chats/:chatId/cancel — the seeker gives up waiting. */
const cancel = asyncHandler(async (req, res) => {
  const chat = await chatService.cancelChat({
    chatId: req.params.chatId,
    userId: req.account.accountId,
  });
  return res.json({ chatId: String(chat._id), status: chat.status });
});

/** POST /api/v1/chats/:chatId/end — either side may end it. */
const end = asyncHandler(async (req, res) => {
  const chat = await chatService.endChat({
    chatId: req.params.chatId,
    accountId: req.account.accountId,
    endedBy: req.account.role,
    reason: req.body.reason,
  });

  return res.json({
    chatId: String(chat._id),
    status: chat.status,
    durationSeconds: chat.durationSeconds,
    amountCharged: chat.billing.amountCharged,
    astrologerEarning: chat.billing.astrologerEarning,
  });
});

/** POST /api/v1/chats/:chatId/rate — the seeker scores it. */
const rate = asyncHandler(async (req, res) => {
  const chat = await chatService.rateChat({
    chatId: req.params.chatId,
    userId: req.account.accountId,
    rating: req.body.rating,
    comment: req.body.comment,
  });
  return res.json({ chatId: String(chat._id), review: chat.review });
});

/** GET /api/v1/chats — the consultation list for whoever is asking. */
const list = asyncHandler(async (req, res) => {
  const result = await chatService.listChats({
    accountId: req.account.accountId,
    role: req.account.role,
    status: req.query.status,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json(result);
});

/**
 * GET /api/v1/chats/:chatId/messages
 *
 * One page of the transcript, oldest first. Pass `?beforeSeq=` to walk further
 * back — the `seq` of the oldest message already held.
 */
const messages = asyncHandler(async (req, res) => {
  const items = await chatService.getMessages({
    chatId: req.params.chatId,
    accountId: req.account.accountId,
    beforeSeq: req.query.beforeSeq ? Number(req.query.beforeSeq) : undefined,
    limit: req.query.limit,
  });
  return res.json({ items });
});

/**
 * POST /api/v1/chats/:chatId/messages
 *
 * A fallback for sending without a socket. The socket path is the normal one —
 * this exists so a message is not lost when the connection is down.
 */
const send = asyncHandler(async (req, res) => {
  const message = await chatService.sendMessage({
    chatId: req.params.chatId,
    accountId: req.account.accountId,
    type: req.body.type || 'text',
    content: req.body.content,
    replyTo: req.body.replyTo,
    clientMessageId: req.body.clientMessageId,
  });

  const payload = message.toSocketPayload();

  /** Still broadcast, so the other side sees it arrive live. */
  try {
    const { getIO } = require('../socket');
    const { roomFor, CHAT_EVENTS } = require('../models/Chat');
    getIO().to(roomFor(req.params.chatId)).emit(CHAT_EVENTS.NEW, payload);
  } catch (error) {
    /** No socket server running; the message is stored either way. */
  }

  return res.status(201).json({ message: payload });
});

/**
 * GET /api/v1/chats/ai — the seeker's AI thread.
 *
 * One thread per seeker, so this returns the existing one or opens it with the
 * assistant's greeting already in place.
 */
const aiThread = asyncHandler(async (req, res) => {
  const chat = await chatService.getOrCreateAiChat(req.account.accountId);
  const items = await chatService.getMessages({
    chatId: chat._id,
    accountId: req.account.accountId,
    limit: Number(req.query.limit) || 50,
  });

  return res.json({ chatId: String(chat._id), items });
});

/**
 * POST /api/v1/chats/ai/messages — ask the assistant something.
 *
 * Returns both turns — the question and the answer — so the screen can append
 * them together.
 *
 * No AI provider is connected yet, so the answer is a holding reply. See
 * `generateAiReply` in services/chat.service.js.
 */
const askAi = asyncHandler(async (req, res) => {
  const result = await chatService.sendAiMessage({
    userId: req.account.accountId,
    text: req.body.text,
    clientMessageId: req.body.clientMessageId,
  });

  return res.status(201).json(result);
});

module.exports = { aiThread, askAi, precheck, state, request, extend, continuePerMinute, accept, reject, cancel, end, rate, list, messages, send };
