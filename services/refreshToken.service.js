/**
 * Server-side record of which refresh tokens are still good.
 *
 * A refresh token is a stateless JWT — proving it hasn't expired or been
 * tampered with is not the same as proving nobody has signed it out since.
 * Every refresh token carries a `jti` (see utils/token.js), and this is where
 * that id lives in Redis for exactly as long as the token itself is valid.
 * Trading a refresh token for a new pair deletes the old entry and writes a
 * new one, so a token can only ever be used once (rotation); signing out
 * deletes it outright; "sign out everywhere" deletes every entry an account
 * holds. A `jti` missing from Redis means the token is dead even though its
 * signature and expiry still check out.
 */

const { redis } = require('../config/redis');
const { JWT_REFRESH_EXPIRES_IN } = require('../config/constants');

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

/** "30d" -> 2592000. Falls back to 30 days if the format ever changes shape. */
function ttlSecondsFrom(expiresIn) {
  const match = /^(\d+)([smhd])$/.exec(String(expiresIn));
  return match ? Number(match[1]) * UNITS[match[2]] : 30 * UNITS.d;
}

const TTL_SECONDS = ttlSecondsFrom(JWT_REFRESH_EXPIRES_IN);

function keyFor(role, accountId, jti) {
  return `refresh:${role}:${accountId}:${jti}`;
}

/** Called once a refresh token is minted, so it has something to be checked against. */
async function record({ role, accountId, jti }) {
  await redis.set(keyFor(role, accountId, jti), '1', 'EX', TTL_SECONDS);
}

/** Whether this exact refresh token is still allowed to be redeemed. */
async function isActive({ role, accountId, jti }) {
  return (await redis.exists(keyFor(role, accountId, jti))) === 1;
}

/** Burns one refresh token — logout, or rotating it away on a successful refresh. */
async function revoke({ role, accountId, jti }) {
  await redis.del(keyFor(role, accountId, jti));
}

/**
 * Burns every refresh token an account is holding — "sign out everywhere",
 * and anywhere an account is blocked/suspended and should stop being able to
 * silently mint fresh access tokens.
 */
async function revokeAll({ role, accountId }) {
  const pattern = keyFor(role, accountId, '*');
  let cursor = '0';

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length) {
      await redis.del(...keys);
    }
  } while (cursor !== '0');
}

module.exports = { record, isActive, revoke, revokeAll };
