/** JWT minting and reading — REST and the socket handshake share both. */

const jwt = require('jsonwebtoken');

const env = require('../config/env');

const ROLES = ['user', 'astrologer', 'admin'];

/** `sub` is the account id, `role` says which app is holding it. */
function signToken(accountId, role) {
  return jwt.sign({ sub: String(accountId), role }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });
}

/**
 * Reads a token and returns `{ accountId, role }`.
 * Throws when it is missing, tampered with, expired, or names a role we do not
 * issue — callers decide whether that is a 401 or a refused socket.
 */
function verifyToken(token) {
  if (!token) {
    throw new Error('No auth token.');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (error) {
    throw new Error('Invalid or expired token.');
  }

  if (!ROLES.includes(payload.role)) {
    throw new Error('Unknown role in token.');
  }

  return { accountId: payload.sub || payload.id, role: payload.role };
}

/** Pulls the token off a request or a socket handshake, wherever it was put. */
function tokenFrom({ auth, query, headers } = {}) {
  return (
    auth?.token ||
    query?.token ||
    (headers?.authorization || '').replace(/^Bearer /, '') ||
    null
  );
}

module.exports = { signToken, verifyToken, tokenFrom, ROLES };
