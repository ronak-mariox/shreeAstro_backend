/**
 * Writing and clearing the auth cookies.
 *
 * Kept in one place because the options must match exactly between setting a
 * cookie and clearing it — a browser will not remove a cookie you named with a
 * different path or domain, and the mismatch is invisible until a "logged out"
 * user is still holding a session.
 */

const jwt = require('jsonwebtoken');

const env = require('../config/env');
const { ACCESS_COOKIE, REFRESH_COOKIE } = require('./token');

/**
 * Both cookies are httpOnly: no script on the page can read them, so an XSS
 * bug cannot walk off with a session.
 */
const baseOptions = {
  httpOnly: true,
  secure: env.cookie.secure,
  sameSite: env.cookie.sameSite,
  domain: env.cookie.domain,
};

const accessOptions = { ...baseOptions, path: '/' };
const refreshOptions = { ...baseOptions, path: env.cookie.refreshPath };

/**
 * How long the cookie should live, taken from the token it carries, so the two
 * expire together instead of drifting apart when a lifetime is reconfigured.
 */
function maxAgeOf(token) {
  const { exp } = jwt.decode(token) || {};
  return exp ? Math.max(exp * 1000 - Date.now(), 0) : undefined;
}

/** Called on register, login and every refresh. */
function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_COOKIE, accessToken, {
    ...accessOptions,
    maxAge: maxAgeOf(accessToken),
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...refreshOptions,
    maxAge: maxAgeOf(refreshToken),
  });
}

/** Logout, and any refusal that means the session the browser holds is dead. */
function clearAuthCookies(res) {
  res.clearCookie(ACCESS_COOKIE, accessOptions);
  res.clearCookie(REFRESH_COOKIE, refreshOptions);
}

module.exports = { setAuthCookies, clearAuthCookies };
