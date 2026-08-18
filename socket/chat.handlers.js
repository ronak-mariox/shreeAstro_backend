/**
 * The chat events — transport only.
 *
 * Each handler reads the payload, calls chat.service, and answers: broadcasts
 * to the conversation's room and an ack to the caller. No rules live here.
 */

const chatService = require('../services/chat.service');
const { CHAT_EVENTS, roomFor } = require('../models/Chat');
const ApiError = require('../utils/ApiError');

/**
 * Turns a thrown error into an ack the client can show, instead of a crash.
 * Anything that is not a deliberate refusal is logged and reported plainly.
 */
const safe = handler => async (payload, ack) => {
  const answer = typeof ack === 'function' ? ack : () => {};
  try {
    await handler(payload || {}, answer);
  } catch (error) {
    if (error instanceof ApiError) {
      answer({ error: error.message });
      return;
    }
    console.error('[socket]', error);
    answer({ error: 'Something went wrong, please try again.' });
  }
};

function registerChatHandlers(io, socket) {
  const { accountId } = socket.data;

  socket.on(
    CHAT_EVENTS.JOIN,
    safe(async ({ chatId, lastSeq = 0 }, ack) => {
      const state = await chatService.joinChat({ chatId, accountId, lastSeq });
      socket.join(roomFor(chatId));
      ack(state);
    }),
  );

  socket.on(
    CHAT_EVENTS.LEAVE,
    safe(async ({ chatId }, ack) => {
      socket.leave(roomFor(chatId));
      ack({ ok: true });
    }),
  );

  socket.on(
    CHAT_EVENTS.SEND,
    safe(async ({ chatId, type, content, replyTo, clientMessageId }, ack) => {
      const message = await chatService.sendMessage({
        chatId,
        accountId,
        type,
        content,
        replyTo,
        clientMessageId,
      });

      const payload = message.toSocketPayload();
      io.to(roomFor(chatId)).emit(CHAT_EVENTS.NEW, payload);
      ack({ message: payload });
    }),
  );

  /** Both receipts are the same call with a different state. */
  const receipt = state =>
    safe(async ({ chatId, seq }, ack) => {
      const role = await chatService.markSeen({ chatId, accountId, seq, state });
      socket
        .to(roomFor(chatId))
        .emit(state === 'read' ? CHAT_EVENTS.READ : CHAT_EVENTS.DELIVERED, {
          chatId,
          seq,
          by: role,
        });
      ack({ ok: true });
    });

  socket.on(CHAT_EVENTS.DELIVERED, receipt('delivered'));
  socket.on(CHAT_EVENTS.READ, receipt('read'));

  /** Transient by design — never stored, only relayed to the other side. */
  socket.on(
    CHAT_EVENTS.TYPING,
    safe(async ({ chatId, isTyping = true }) => {
      const [, role] = await chatService.participantChat(chatId, accountId);
      socket.to(roomFor(chatId)).emit(CHAT_EVENTS.TYPING, { chatId, role, isTyping });
    }),
  );
}

module.exports = { registerChatHandlers };
