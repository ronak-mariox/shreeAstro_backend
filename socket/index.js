/**
 * The socket.io server: authentication, rooms, presence.
 *
 * A connection must carry a JWT — the same one the REST API issues — as
 * `auth.token` in the handshake:
 *
 *   io('https://api.example.com', { auth: { token } })
 *
 * That token is the only source of identity: handlers read `socket.data`, never
 * the event payloads, so a client cannot claim to be someone else.
 */

const { Server } = require('socket.io');

const env = require('../config/env');
const { verifyToken, tokenFrom } = require('../utils/token');
const { setAstrologerOnline } = require('../services/presence.service');
const { registerChatHandlers } = require('./chat.handlers');

/** Personal rooms carry ring/notification events to someone outside a chat. */
const accountRoom = (role, id) => `${role}:${id}`;

let io = null;

/** Reads the handshake token and hangs the caller's identity off the socket. */
function authenticate(socket, next) {
  try {
    socket.data = verifyToken(tokenFrom(socket.handshake));
    return next();
  } catch (error) {
    return next(new Error(error.message));
  }
}

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

  io.use(authenticate);

  io.on('connection', async socket => {
    const { accountId, role } = socket.data;

    socket.join(accountRoom(role, accountId));
    if (role === 'astrologer') {
      await setAstrologerOnline(accountId, true).catch(error =>
        console.error('[socket] presence:', error.message),
      );
    }
    console.log(`[socket] ${role} ${accountId} connected (${socket.id})`);

    registerChatHandlers(io, socket);

    socket.on('disconnect', async reason => {
      /** Only the last tab going quiet takes the astrologer offline. */
      if (role === 'astrologer') {
        const room = io.sockets.adapter.rooms.get(accountRoom(role, accountId));
        if (!room || room.size === 0) {
          await setAstrologerOnline(accountId, false).catch(error =>
            console.error('[socket] presence:', error.message),
          );
        }
      }
      console.log(`[socket] ${role} ${accountId} disconnected (${reason})`);
    });
  });

  return io;
}

/** For emitting from controllers — a session ending, a wallet credit. */
function getIO() {
  if (!io) {
    throw new Error('Socket.io is not initialised yet.');
  }
  return io;
}

module.exports = { initSocket, getIO, accountRoom };
