/**
 * Password hashing for admin accounts.
 *
 * Only the admin panel uses a password — the two apps sign in with an OTP.
 *
 * Uses Node's built-in scrypt, so there is no extra dependency to install.
 * scrypt is deliberately slow and memory-hungry, which is what makes a stolen
 * hash expensive to crack. Every password gets its own random salt, so two
 * people with the same password still get different hashes.
 *
 * A stored hash looks like:  scrypt$<salt-hex>$<hash-hex>
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const KEY_LENGTH = 64;

/** Turns a plain password into the string that goes in the database. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

/**
 * Checks a password against a stored hash.
 *
 * The comparison is timingSafeEqual rather than `===` so that how *long* the
 * check takes cannot tell an attacker how much of the hash they guessed right.
 */
async function verifyPassword(password, stored) {
  if (!stored) {
    return false;
  }

  const [scheme, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) {
    return false;
  }

  const expected = Buffer.from(hex, 'hex');
  const actual = await scrypt(String(password), salt, expected.length);

  return crypto.timingSafeEqual(expected, actual);
}

module.exports = { hashPassword, verifyPassword };
