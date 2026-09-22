/**
 * A third-party service noted for reference in the admin panel (Settings →
 * Third Parties → "Other third parties") — anything outside the six fixed,
 * live-wired providers in services/integrations.service.js. This is a plain
 * record, not a working credential store: nothing here is used to actually
 * call the named service, unlike the fixed providers' .env-backed fields.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const CATEGORIES = ['payment_gateway', 'sms_otp', 'push_notifications', 'email', 'analytics', 'other'];

const thirdPartySchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 120 },
    category: { type: String, enum: CATEGORIES, default: 'other' },
    /** API key, merchant id, account name — free text, for reference only. */
    identifier: { type: String, trim: true, maxlength: 200 },
    enabled: { type: Boolean, default: true },
    notes: { type: String, trim: true, maxlength: 1000 },

    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

module.exports = mongoose.models.ThirdParty || mongoose.model('ThirdParty', thirdPartySchema);
module.exports.CATEGORIES = CATEGORIES;
