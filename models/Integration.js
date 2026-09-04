/**
 * Third-party credentials an admin enters on the panel's Third Parties tab.
 *
 * One document per provider, created the first time it is saved — there is no
 * seed step, the same way Settings needs none. `config` is never plain text;
 * utils/crypto.js encrypts it before it is written and decrypts it after it
 * is read, so a database dump alone is not enough to recover a credential.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const PROVIDERS = ['apple', 'google', 'email', 'sms', 'awsS3', 'firebase'];

const integrationSchema = new Schema(
  {
    provider: { type: String, enum: PROVIDERS, unique: true, index: true, required: true },
    enabled: { type: Boolean, default: false },
    /** `{ iv, ciphertext, authTag }` from utils/crypto.js — never the raw values. */
    config: { type: Schema.Types.Mixed, default: null },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

module.exports = mongoose.models.Integration || mongoose.model('Integration', integrationSchema);
module.exports.PROVIDERS = PROVIDERS;
