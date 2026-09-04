/**
 * Encrypts third-party credentials at rest.
 *
 * Anything an admin saves on the Third Parties tab is written to Mongo
 * through this, never as plain text — AES-256-GCM with a random IV per call
 * (so the same secret never produces the same ciphertext twice) and a
 * built-in auth tag (so a tampered or truncated row fails to decrypt instead
 * of silently decrypting to garbage).
 */

const crypto = require('crypto');

const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';

/** Any-length key string, folded to the 32 bytes aes-256 needs. */
const key = crypto.createHash('sha256').update(String(env.configEncryptionKey)).digest();

/** A plain object in, an opaque `{ iv, ciphertext, authTag }` record out. */
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

/** The reverse of `encrypt`. Returns `null` for a missing/empty record. */
function decrypt(payload) {
  if (!payload?.iv || !payload?.ciphertext || !payload?.authTag) {
    return null;
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(payload.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, 'base64')),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString('utf8'));
}

module.exports = { encrypt, decrypt };
