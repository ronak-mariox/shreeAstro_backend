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
 * Both are self-contained: everything needed to check one is inside it and in
 * the secret, so nothing about a signed-in client is written down anywhere.
 * That is what makes the API stateless — and what makes a token impossible to
 * take back before it expires. See services/auth.service.js for what that
 * costs at sign-out.
 */

const jwt = require('jsonwebtoken');

const env = require('../config/env');

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
    expiresIn: env.jwtExpiresIn,
  });
}

/** The same two claims, plus `typ` so it cannot pass as an access token. */
function signRefreshToken(accountId, role) {
  return jwt.sign({ sub: String(accountId), role, typ: 'refresh' }, env.refreshSecret, {
    expiresIn: env.refreshExpiresIn,
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

  return { accountId: payload.sub, role: payload.role };
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
