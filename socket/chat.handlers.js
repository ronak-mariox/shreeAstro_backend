/**
 * The chat events — transport only. No rules live here.
 *
 * Every handler does the same three things, in the same order:
 *
 *   1. read the payload the client sent,
 *   2. call services/chat.service.js, which decides whether it is allowed,
 *   3. tell people about it — broadcast to the room, reply to the caller.
 *
 * Three socket.io words are worth knowing before reading on:
 *
 *   room      A named group of sockets. `roomFor(chatId)` is one conversation,
 *             so both sides of a chat sit in the same room and a message sent
 *             to the room reaches exactly them.
 *   reply     The last argument a client may pass when it emits ("ack" in the
 *             socket.io docs). Calling it sends a value straight back to that
 *             one client — like returning from a function, across the network.
 *   broadcast `io.to(room)` reaches everyone in the room including the sender;
 *             `socket.to(room)` reaches everyone *except* the sender. Which one
 *             to use is noted at each place below.
 *
 * Every handler below is written out in full, with the same two lines at the
 * top and the same catch block at the bottom. That repetition is deliberate —
 * each one can be read on its own, without chasing a wrapper. What repeats:
 *
 *   const reply = ...   A client may emit without a reply function. Falling
 *                       back to a function that does nothing means the handler
 *                       can always call `reply(...)` without checking first.
 *   payload || {}       A client may also emit with no payload at all.
 *   try / catch         A promise that rejects inside `socket.on` is caught by
 *                       nothing — it would take the whole server down instead
 *                       of answering the client. So each handler catches its
 *                       own: an ApiError is a deliberate refusal and its
 *                       message is safe to show, and anything else is a bug,
 *                       logged in full while the client is told nothing.
 */

const chatService = require('../services/chat.service');
const { CHAT_EVENTS, roomFor } = require('../models/Chat');
const ApiError = require('../utils/ApiError');

function registerChatHandlers(io, socket) {
  /**
   * Who is calling, taken from the token checked during the handshake — never
   * from a payload, which the client controls and could lie in.
   */
  const { accountId } = socket.data;

  /**
   * Entering a conversation.
   *
   * The client says the highest `seq` it already has, and gets back everything
   * it missed. That is what makes a dropped connection a non-event: reconnect,
   * join again, and the gap fills itself in.
   */
  socket.on(CHAT_EVENTS.JOIN, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId, lastSeq = 0 } = payload || {};

      const state = await chatService.joinChat({ chatId, accountId, lastSeq });

      /** Joined only after the service agreed the caller belongs in this chat. */
      socket.join(roomFor(chatId));
      reply(state);
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });

  /**
   * Leaving a conversation. Only stops this socket hearing the room; the chat
   * itself is untouched, so there is nothing to ask the service about.
   */
  socket.on(CHAT_EVENTS.LEAVE, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId } = payload || {};

      socket.leave(roomFor(chatId));
      reply({ ok: true });
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });

  /**
   * Posting a message.
   *
   * `io.to` rather than `socket.to`, so the sender receives its own message
   * back the same way the other side does — one code path on the client for
   * "a message arrived", whoever wrote it.
   */
  socket.on(CHAT_EVENTS.SEND, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId, type, content, replyTo, clientMessageId } = payload || {};

      const message = await chatService.sendMessage({
        chatId,
        accountId,
        type,
        content,
        replyTo,
        clientMessageId,
      });

      const saved = message.toSocketPayload();

      io.to(roomFor(chatId)).emit(CHAT_EVENTS.NEW, saved);
      /** The reply carries it too, so the sender can match its own pending row. */
      reply({ message: saved });
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });

  /**
   * The "delivered" tick — the message reached the other device.
   *
   * `socket.to` here, and in the two handlers below: the point of a receipt is
   * to tell the *other* side, so the sender is left out of the broadcast.
   */
  socket.on(CHAT_EVENTS.DELIVERED, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId, seq } = payload || {};

      const role = await chatService.markSeen({
        chatId,
        accountId,
        seq,
        state: 'delivered',
      });

      socket.to(roomFor(chatId)).emit(CHAT_EVENTS.DELIVERED, { chatId, seq, by: role });
      reply({ ok: true });
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });

  /**
   * The "read" tick — the message was actually opened. Same shape as
   * "delivered" above; only the state passed to the service differs, and the
   * service moves the unread counters accordingly.
   */
  socket.on(CHAT_EVENTS.READ, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId, seq } = payload || {};

      const role = await chatService.markSeen({
        chatId,
        accountId,
        seq,
        state: 'read',
      });

      socket.to(roomFor(chatId)).emit(CHAT_EVENTS.READ, { chatId, seq, by: role });
      reply({ ok: true });
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });

  /**
   * "typing…" — transient by design. Nothing is stored and nothing is normally
   * replied to; it is relayed to the other side and then forgotten. The service
   * call is only there to confirm the caller is in this chat before relaying.
   */
  socket.on(CHAT_EVENTS.TYPING, async (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    try {
      const { chatId, isTyping = true } = payload || {};

      const [, role] = await chatService.participantChat(chatId, accountId);

      socket.to(roomFor(chatId)).emit(CHAT_EVENTS.TYPING, { chatId, role, isTyping });
    } catch (error) {
      if (error instanceof ApiError) {
        reply({ error: error.message });
        return;
      }
      console.error('[socket]', error);
      reply({ error: 'Something went wrong, please try again.' });
    }
  });
}

module.exports = { registerChatHandlers };
