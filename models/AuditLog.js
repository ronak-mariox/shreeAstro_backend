/**
 * A record of every change an admin made through the panel.
 *
 * Write-only: the panel lists these and nothing ever edits or deletes one.
 * That is the whole point — a log you can change is not a log.
 *
 * Rows are written by services/audit.service.js, not by controllers directly.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

/** Which part of the panel the change was made in. */
const AREAS = [
  'Users',
  'Astrologers',
  'Consultations',
  'Payments',
  'Wallets',
  'Content',
  'Settings',
  'Third parties',
  'Shop',
  'Pujas',
  'Offers',
  'Reviews',
  'Careers',
];

const auditLogSchema = new Schema(
  {
    admin: { type: Schema.Types.ObjectId, ref: 'Admin', required: true, index: true },
    /** Copied in, so the log still reads correctly if the admin is deleted. */
    adminName: { type: String, trim: true },
    adminRole: { type: String, trim: true },

    /** What was done, in plain words: "Blocked user account". */
    action: { type: String, trim: true, required: true },
    area: { type: String, enum: AREAS, required: true, index: true },
    /** What it was done to: "u-1030 · Farah Sheikh". */
    target: { type: String, trim: true },
    /** The record itself, when there is one to link to. */
    targetId: { type: Schema.Types.ObjectId },

    ip: { type: String, trim: true },
    /** Anything worth keeping about the change — old and new values. */
    details: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);
module.exports.AREAS = AREAS;
