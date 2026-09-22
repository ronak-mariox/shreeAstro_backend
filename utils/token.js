/**
 * JWT minting and reading.
 *
 * Two kinds of token, signed with two different secrets:
 *
 *   access  — minutes long, proves who is calling. REST reads it, and so does
 *             the socket handshake.
 *   refresh — a month long, and does one thing: buys a new access token.
 *
 * Separate secrets mean neither token can be presented where the other is
 * expected, even if one leaks.
 *
 * Both are self-contained: everything needed to check one's signature and
 * expiry is inside it and in the secret. The access token is left fully
 * stateless on purpose — it is short-lived, and checking it against anything
 * external on every request would be wasteful. The refresh token additionally
 * carries a `jti`, which services/refreshToken.service.js records and checks,
 * so that one — the one worth actually being able to take back — can be
 * revoked at sign-out instead of just outliving the session on the client.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const env = require('../config/env');
const { JWT_EXPIRES_IN, JWT_REFRESH_EXPIRES_IN } = require('../config/constants');

const ROLES = ['user', 'astrologer', 'admin'];

const ACCESS_COOKIE = 'accessToken';
const REFRESH_COOKIE = 'refreshToken';

/**
 * A rejection, tagged with why. `code` travels out to the client, which is how
 * an app tells "refresh and retry" from "sign in again".
 */
function authError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** `sub` is the account id, `role` says which app is holding it. */
function signAccessToken(accountId, role) {
  return jwt.sign({ sub: String(accountId), role, typ: 'access' }, env.jwtSecret, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

/**
 * The same two claims, plus `typ` so it cannot pass as an access token, and a
 * `jti` — a random id with no meaning of its own, whose only job is to give
 * services/refreshToken.service.js something to record and later check, since
 * a JWT's signature alone can prove a token is genuine but never that it
 * hasn't since been revoked.
 */
function signRefreshToken(accountId, role, jti = crypto.randomUUID()) {
  return jwt.sign({ sub: String(accountId), role, typ: 'refresh', jti }, env.refreshSecret, {
    expiresIn: JWT_REFRESH_EXPIRES_IN,
  });
}

/**
 * Reads an access token and returns `{ accountId, role }`.
 * Throws when it is missing, tampered with, expired, or names a role we do not
 * issue — callers decide whether that is a 401 or a refused socket.
 */
function verifyToken(token) {
  if (!token) {
    throw authError('No auth token.', 'no_token');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.jwtSecret);
  } catch (error) {
    throw error.name === 'TokenExpiredError'
      ? authError('This session has expired.', 'token_expired')
      : authError('Invalid auth token.', 'invalid_token');
  }

  /** Older tokens predate `typ`; anything that names itself must say access. */
  if (payload.typ && payload.typ !== 'access') {
    throw authError('Wrong kind of token.', 'invalid_token');
  }
  if (!ROLES.includes(payload.role)) {
    throw authError('Unknown role in token.', 'invalid_token');
  }

  return { accountId: payload.sub || payload.id, role: payload.role };
}

/** The refresh counterpart. Same answer; only the secret and `typ` differ. */
function verifyRefreshToken(token) {
  if (!token) {
    throw authError('No refresh token.', 'no_refresh_token');
  }

  let payload;
  try {
    payload = jwt.verify(token, env.refreshSecret);
  } catch (error) {
    throw authError('This session has expired. Please sign in again.', 'session_expired');
  }

  if (payload.typ !== 'refresh') {
    throw authError('Wrong kind of token.', 'invalid_token');
  }
  if (!ROLES.includes(payload.role)) {
    throw authError('Unknown role in token.', 'invalid_token');
  }
  if (!payload.jti) {
    throw authError('Wrong kind of token.', 'invalid_token');
  }

  return { accountId: payload.sub, role: payload.role, jti: payload.jti };
}

/**
 * One cookie out of a raw `Cookie:` header — for the socket handshake, which
 * never passes through cookie-parser and so has only the header to read.
 */
function cookieFromHeader(header, name) {
  return (
    String(header || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith(`${name}=`))
      ?.slice(name.length + 1) || null
  );
}

/**
 * Pulls the access token off a request or a socket handshake, wherever it was
 * put. The apps send a header; the admin panel sends nothing and lets the
 * browser attach the cookie, which is `req.cookies` over REST and a raw header
 * on a handshake.
 */
function tokenFrom({ auth, query, headers, cookies } = {}) {
  return (
    auth?.token ||
    (headers?.authorization || '').replace(/^Bearer /, '') ||
    cookies?.[ACCESS_COOKIE] ||
    cookieFromHeader(headers?.cookie, ACCESS_COOKIE) ||
    query?.token ||
    null
  );
}

/**
 * The refresh token, in the order it is trusted: the cookie a browser sent, or
 * the body field a mobile app posted (React Native has no cookie jar worth
 * relying on, so the apps hold theirs in secure storage and send it here).
 */
function refreshTokenFrom(req = {}) {
  return req.cookies?.[REFRESH_COOKIE] || req.body?.refreshToken || null;
}

module.exports = {
  signAccessToken,
  signRefreshToken,
  verifyToken,
  verifyRefreshToken,
  tokenFrom,
  refreshTokenFrom,
  cookieFromHeader,
  ROLES,
  ACCESS_COOKIE,
  REFRESH_COOKIE,
};
