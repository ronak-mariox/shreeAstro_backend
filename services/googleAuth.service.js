/**
 * Verifies a Google Sign-In ID token.
 *
 * Google issues the client a signed JWT (the "ID token") after the user
 * authorizes; the client hands that to us, and this checks it is genuinely
 * Google's, was issued for one of our apps, and has not expired — per
 * https://developers.google.com/identity/sign-in/web/backend-auth.
 *
 * Nothing calls this unless Google is configured on the Third Parties tab —
 * services/auth.service.js's `loginWithGoogle` checks that first and answers
 * "not configured" otherwise, so this never runs against an empty client id
 * list. Mirrors appleAuth.service.js — same shape, same JWKS-caching approach
 * — since both are "verify someone else's signed JWT" and nothing about that
 * needs a dedicated OAuth client library.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const integrationsService = require('./integrations.service');

const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const GOOGLE_KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/** Google's signing keys change rarely; refetching on every login would be wasteful. */
const JWKS_CACHE_MS = 60 * 60 * 1000;
let cachedKeys = null;
let cachedAt = 0;

async function fetchGoogleKeys() {
  if (cachedKeys && Date.now() - cachedAt < JWKS_CACHE_MS) {
    return cachedKeys;
  }

  const response = await fetch(GOOGLE_KEYS_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch Google's signing keys (${response.status}).`);
  }

  const { keys } = await response.json();
  cachedKeys = keys;
  cachedAt = Date.now();
  return keys;
}

/** The JWK matching a token's `kid`, turned into a key `jwt.verify` can use. */
async function publicKeyFor(kid) {
  const keys = await fetchGoogleKeys();
  const jwk = keys.find(candidate => candidate.kid === kid);
  if (!jwk) {
    throw new Error("Google's signing keys do not include this token's key id.");
  }

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verifies an ID token against Google's own keys, issuer, and our configured
 * client id(s) (the `aud` claim — one app may ship an Android and an iOS
 * client id, both valid audiences for the same backend). Returns
 * `{ sub, email, emailVerified, name }` — `sub` is Google's stable, opaque id
 * for this user, and is what we key an account to. `name` is only present
 * when the client requested the `profile` scope; loginWithGoogle falls back
 * to a client-supplied `fullName` when it isn't.
 *
 * Throws when Google is not configured, or the token fails any check.
 */
async function verifyIdToken(idToken) {
  const config = await integrationsService.get('google');
  const clientIds = String(config?.clientIds || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (!clientIds.length) {
    const error = new Error('Google Sign-In is not configured.');
    error.code = 'google_not_configured';
    throw error;
  }

  const decodedHeader = jwt.decode(idToken, { complete: true })?.header;
  if (!decodedHeader?.kid) {
    throw new Error('That does not look like a Google ID token.');
  }

  const publicKey = await publicKeyFor(decodedHeader.kid);

  const payload = jwt.verify(idToken, publicKey, {
    algorithms: ['RS256'],
    issuer: GOOGLE_ISSUERS,
    audience: clientIds,
  });

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true,
    name: payload.name,
  };
}

module.exports = { verifyIdToken };
