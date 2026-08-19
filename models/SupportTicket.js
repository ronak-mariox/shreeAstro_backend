/**
 * A support request or dispute raised from either app.
 *
 * astro_app's Help & Support screen files these; the seeker app will use the
 * same shape. An admin answers them from the panel.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const OWNER_ROLES = ['user', 'astrologer'];

/** The categories astro_app's Help & Support screen offers. */
const ISSUE_TYPES = ['astrologer', 'puja', 'product', 'donation', 'payment', 'other'];

const STATUSES = ['open', 'in_progress', 'resolved', 'closed'];

const supportTicketSchema = new Schema(
  {
    reference: { type: String, unique: true, index: true },

    ownerRole: { type: String, enum: OWNER_ROLES, required: true },
    owner: { type: Schema.Types.ObjectId, required: true, index: true },
    /** Copied in so a ticket still reads correctly in a listing without a join. */
    ownerName: { type: String, trim: true },

    issueType: { type: String, enum: ISSUE_TYPES, required: true },
    description: { type: String, trim: true, required: true, maxlength: 2000 },
    /** The consultation being disputed, when there is one. */
    chatSession: { type: Schema.Types.ObjectId, ref: 'ChatSession' },
    attachments: [{ url: String, fileName: String }],

    status: { type: String, enum: STATUSES, default: 'open', index: true },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },

    /** What an admin wrote back. */
    resolution: { type: String, trim: true },
    resolvedAt: { type: Date },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
  },
  { timestamps: true },
);

supportTicketSchema.index({ owner: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });

supportTicketSchema.pre('validate', function setReference() {
  if (!this.reference) {
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    this.reference = `TKT-${random}`;
  }
});

module.exports =
  mongoose.models.SupportTicket || mongoose.model('SupportTicket', supportTicketSchema);
module.exports.ISSUE_TYPES = ISSUE_TYPES;
module.exports.STATUSES = STATUSES;
