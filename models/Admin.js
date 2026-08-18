/**
 * A console operator — the accounts the admin panel signs in, and what each of
 * them is allowed to reach.
 *
 * Roles and their scopes follow the panel's Settings → Role permissions table
 * (admin_panel/src/data/analytics.js); every write an admin makes is expected
 * to leave an audit line carrying this account's id.
 */

const mongoose = require('mongoose');
const { Schema } = mongoose;

const { phoneSchema, otpSchema } = require('./common');

const ROLES = [
  'super_admin',
  'admin',
  'finance',
  'support_lead',
  'content_manager',
  'consultation_manager',
  'user_manager',
];

/** Every gate the API checks, grouped by the area of the panel it guards. */
const PERMISSIONS = [
  'dashboard.view',
  'users.view',
  'users.manage',
  'astrologers.view',
  'astrologers.approve',
  'astrologers.manage',
  'consultations.view',
  'consultations.manage',
  'payments.view',
  'payments.refund',
  'wallets.view',
  'wallets.adjust',
  'payouts.approve',
  'content.view',
  'content.manage',
  'reports.view',
  'settings.view',
  'settings.manage',
  'admins.manage',
  'audit.view',
];

/** What a role grants when no per-account override is set. */
const ROLE_PERMISSIONS = {
  super_admin: PERMISSIONS,
  admin: PERMISSIONS.filter(permission => permission !== 'admins.manage'),
  finance: [
    'dashboard.view',
    'payments.view',
    'payments.refund',
    'wallets.view',
    'wallets.adjust',
    'payouts.approve',
    'reports.view',
    'audit.view',
  ],
  support_lead: [
    'dashboard.view',
    'users.view',
    'users.manage',
    'astrologers.view',
    'consultations.view',
    'consultations.manage',
    'audit.view',
  ],
  content_manager: ['dashboard.view', 'content.view', 'content.manage'],
  consultation_manager: [
    'dashboard.view',
    'consultations.view',
    'consultations.manage',
    'astrologers.view',
    'reports.view',
  ],
  user_manager: ['dashboard.view', 'users.view', 'users.manage'],
};

const adminSchema = new Schema(
  {
    name: { type: String, trim: true, required: true, maxlength: 80 },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true,
      unique: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address.'],
    },
    phone: { type: phoneSchema, default: () => ({}) },

    /** Never selected by default; the login handler asks for it explicitly. */
    passwordHash: { type: String, required: true, select: false },
    /** Forces a reset on first sign-in after an invite. */
    mustChangePassword: { type: Boolean, default: false },
    passwordChangedAt: { type: Date },

    role: { type: String, enum: ROLES, required: true, index: true },
    /**
     * Grants beyond the role, and revocations from it. Both are optional — an
     * account with neither simply gets {@link ROLE_PERMISSIONS} for its role.
     */
    extraPermissions: [{ type: String, enum: PERMISSIONS }],
    revokedPermissions: [{ type: String, enum: PERMISSIONS }],

    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended'],
      default: 'active',
      index: true,
    },

    twoFactor: {
      isEnabled: { type: Boolean, default: false },
      secret: { type: String, select: false },
      otp: { type: otpSchema, select: false },
    },

    /** How the account came to exist; an invite is pending until accepted. */
    invite: {
      tokenHash: { type: String, select: false },
      expiresAt: { type: Date },
      acceptedAt: { type: Date },
      invitedBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    },

    /** Login trail the Settings → Access policy card reads. */
    lastLoginAt: { type: Date },
    lastLoginIp: { type: String, trim: true },
    lastActiveAt: { type: Date },
    failedLoginAttempts: { type: Number, default: 0, min: 0 },
    lockedUntil: { type: Date },

    /** Sessions are invalidated by bumping this; every JWT carries it. */
    tokenVersion: { type: Number, default: 0 },

    avatarUrl: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'Admin' },
    deletedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/** Everything this account may do, once role, grants and revocations settle. */
adminSchema.virtual('permissions').get(function permissions() {
  const granted = new Set([
    ...(ROLE_PERMISSIONS[this.role] || []),
    ...(this.extraPermissions || []),
  ]);
  (this.revokedPermissions || []).forEach(permission => granted.delete(permission));
  return [...granted];
});

adminSchema.methods.can = function can(permission) {
  return (
    this.status === 'active' && this.permissions.includes(permission)
  );
};

adminSchema.methods.isLocked = function isLocked() {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);
module.exports.ROLES = ROLES;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.ROLE_PERMISSIONS = ROLE_PERMISSIONS;
