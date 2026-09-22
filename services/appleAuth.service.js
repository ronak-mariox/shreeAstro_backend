/**
 * Verifies an Apple Sign-In identity token.
 *
 * Apple issues the client a signed JWT (the "identity token") after the
 * user authorizes; the client hands that to us, and this checks it is
 * genuinely Apple's, was issued for our app, and has not expired — per
 * https://developer.apple.com/documentation/sign_in_with_apple/verifying_a_user.
 *
 * Nothing calls this unless Apple is configured on the Third Parties tab —
 * services/auth.service.js's `loginWithApple` checks that first and answers
 * "not configured" otherwise, so this never runs against an absent Service ID.
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const integrationsService = require('./integrations.service');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

/** Apple's signing keys change rarely; refetching on every login would be wasteful. */
const JWKS_CACHE_MS = 60 * 60 * 1000;
let cachedKeys = null;
let cachedAt = 0;

async function fetchAppleKeys() {
  if (cachedKeys && Date.now() - cachedAt < JWKS_CACHE_MS) {
    return cachedKeys;
  }

  const response = await fetch(APPLE_KEYS_URL);
  if (!response.ok) {
    throw new Error(`Could not fetch Apple's signing keys (${response.status}).`);
  }

  const { keys } = await response.json();
  cachedKeys = keys;
  cachedAt = Date.now();
  return keys;
}

/** The JWK matching a token's `kid`, turned into a key `jwt.verify` can use. */
async function publicKeyFor(kid) {
  const keys = await fetchAppleKeys();
  const jwk = keys.find(candidate => candidate.kid === kid);
  if (!jwk) {
    throw new Error("Apple's signing keys do not include this token's key id.");
  }

  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Verifies an identity token against Apple's own keys, issuer and our
 * configured Service ID (the `aud` claim). Returns `{ sub, email,
 * emailVerified }` — `sub` is Apple's stable, opaque id for this user, and is
 * what we key an account to; `email` is only ever present on the very first
 * authorization. `email_verified` comes back from Apple as either a real
 * boolean or the string `"true"`/`"false"` depending on token version, hence
 * checking both.
 *
 * Throws when Apple is not configured, or the token fails any check.
 */
async function verifyIdentityToken(identityToken) {
  const config = await integrationsService.get('apple');
  if (!config?.serviceId) {
    const error = new Error('Apple Sign-In is not configured.');
    error.code = 'apple_not_configured';
    throw error;
  }

  const decodedHeader = jwt.decode(identityToken, { complete: true })?.header;
  if (!decodedHeader?.kid) {
    throw new Error('That does not look like an Apple identity token.');
  }

  const publicKey = await publicKeyFor(decodedHeader.kid);

  const payload = jwt.verify(identityToken, publicKey, {
    algorithms: ['RS256'],
    issuer: APPLE_ISSUER,
    audience: config.serviceId,
  });

  return {
    sub: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified === true || payload.email_verified === 'true',
  };
}

module.exports = { verifyIdentityToken };
