/**
 * Consultation rules — who may read a conversation, what may be posted to it,
 * and what a receipt moves.
 *
 * The socket handlers are only a transport over this; a REST chat-history
 * endpoint will call the same functions.
 */

const { ChatSession, Message } = require('../models/Chat');
const ApiError = require('../utils/ApiError');

/**
 * Loads a conversation and checks the caller is one of its sides.
 * @returns {Promise<[import('mongoose').Document, 'user'|'astrologer']>}
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

/**
 * Entering a conversation. The caller says the highest `seq` it holds and gets
 * back everything it missed, which is what makes a dropped socket a non-event.
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
 * Posting a turn. The sender is taken from the authenticated account, never
 * from the payload, so a caller cannot post as someone else.
 */
async function sendMessage({
  chatId,
  accountId,
  type = 'text',
  content,
  replyTo,
  clientMessageId,
}) {
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

/** Moving the other side's ticks up to `seq`. Idempotent. */
async function markSeen({ chatId, accountId, seq, state = 'read' }) {
  const [, role] = await participantChat(chatId, accountId);
  await Message.markSeen(chatId, seq, role, state);
  return role;
}

module.exports = { participantChat, joinChat, sendMessage, markSeen };
