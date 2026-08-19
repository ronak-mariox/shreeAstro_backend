/**
 * The socket.io server: who may connect, what rooms they land in, and what
 * their coming and going means.
 *
 * How a connection is made, from the client's side:
 *
 *   io('https://api.example.com', { auth: { token } })
 *
 * The token is the access token the REST API issues. It is the only source of
 * identity here — handlers read `socket.data`, never the event payloads — so a
 * client cannot claim to be someone it is not.
 *
 * Everything below happens inside initSocket, in the order it runs:
 *
 *   io.use          the handshake check. Refuse here and no connection is made.
 *   io.on('connection')   runs once per socket, and sets that socket up.
 *   the chat events       live in chat.handlers.js, and run many times.
 *   'disconnect'          runs once per socket, and tidies up.
 */

const { Server } = require('socket.io');

const env = require('../config/env');
const { verifyToken, tokenFrom } = require('../utils/token');
const { setAstrologerOnline } = require('../services/presence.service');
const { registerChatHandlers } = require('./chat.handlers');

/** Set by initSocket, and handed to the rest of the app by getIO. */
let io = null;

function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
      credentials: true,
    },
    /** The apps run on mobile networks; give a dropped socket room to return. */
    pingTimeout: 25000,
    pingInterval: 20000,
  });

  /**
   * `io.use` is middleware for the handshake: it runs before "connection", and
   * decides whether this connection is allowed at all. `next()` with nothing
   * lets it through; `next(error)` refuses it, and the client sees a
   * `connect_error`.
   *
   * The apps pass the token as `auth.token`; a browser passes nothing and lets
   * the access-token cookie ride along on the handshake request. `tokenFrom`
   * looks in both places.
   *
   * This runs once, at connect. An access token only lives minutes, but a
   * socket that outlives its token is *not* dropped — the connection was
   * vouched for when it opened. What fails is reconnecting with a stale token,
   * which is the client's cue to refresh first.
   */
  io.use((socket, next) => {
    try {
      /** `{ accountId, role }`, which every handler downstream reads. */
      socket.data = verifyToken(tokenFrom(socket.handshake));
      return next();
    } catch (error) {
      const refusal = new Error(error.message);
      /** socket.io only forwards `data`, and the client branches on the code. */
      refusal.data = { code: error.code };
      return next(refusal);
    }
  });

  io.on('connection', async socket => {
    const { accountId, role } = socket.data;

    /**
     * The room this one account listens on, across all of its devices.
     *
     * Separate from the chat rooms in chat.handlers.js: this one carries things
     * that reach someone who is not currently in a conversation — an incoming
     * call, a notification, a wallet credit.
     */
    const myRoom = `${role}:${accountId}`;
    socket.join(myRoom);

    /**
     * An astrologer holding a socket is what "Online" means in the seeker's
     * directory. Presence is a nicety, so a failure is logged and shrugged off
     * rather than allowed to break a connection that is otherwise fine.
     */
    if (role === 'astrologer') {
      try {
        await setAstrologerOnline(accountId, true);
      } catch (error) {
        console.error('[socket] presence:', error.message);
      }
    }

    console.log(`[socket] ${role} ${accountId} connected (${socket.id})`);

    /** Everything the client may now emit is declared in chat.handlers.js. */
    registerChatHandlers(io, socket);

    socket.on('disconnect', async reason => {
      if (role === 'astrologer') {
        /**
         * By the time this runs the socket has already left its rooms, so what
         * is left in the room is the astrologer's *other* devices. Only when
         * there are none do they actually go offline — otherwise closing one
         * tab would put them offline while they work in another.
         */
        const stillConnected = io.sockets.adapter.rooms.get(myRoom);

        if (!stillConnected || stillConnected.size === 0) {
          try {
            await setAstrologerOnline(accountId, false);
          } catch (error) {
            console.error('[socket] presence:', error.message);
          }
        }
      }

      console.log(`[socket] ${role} ${accountId} disconnected (${reason})`);
    });
  });

  return io;
}

/** For emitting from outside a handler — a session ending, a wallet credit. */
function getIO() {
  if (!io) {
    throw new Error('Socket.io is not initialised yet.');
  }
  return io;
}

module.exports = { initSocket, getIO };
