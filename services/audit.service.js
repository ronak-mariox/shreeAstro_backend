/**
 * Writes the admin audit trail.
 *
 * Called after a change has succeeded, never before — the log records what
 * happened, not what was attempted.
 *
 * A failure to write the log is swallowed on purpose: losing an audit row is
 * bad, but undoing a change that already succeeded because its log failed would
 * be worse, and leaves the two out of step anyway.
 */

const AuditLog = require('../models/AuditLog');

/**
 * @param admin   The `req.admin` document (needs _id, name, role).
 * @param action  Plain words: "Blocked user account".
 * @param area    One of the AREAS in models/AuditLog.js.
 * @param target  What it was done to, for the table: "u-1030 · Farah Sheikh".
 */
async function record({ admin, action, area, target, targetId, ip, details }) {
  try {
    await AuditLog.create({
      admin: admin._id,
      adminName: admin.name,
      adminRole: admin.role,
      action,
      area,
      target,
      targetId,
      ip,
      details,
    });
  } catch (error) {
    console.error('[audit] could not write log:', error.message);
  }
}

/** The Audit Logs page: newest first, optionally narrowed to one area. */
async function list({ area, adminId, page = 1, limit = 25 }) {
  const query = {};
  if (area) {
    query.area = area;
  }
  if (adminId) {
    query.admin = adminId;
  }

  const skip = (Math.max(Number(page), 1) - 1) * limit;

  const [items, total] = await Promise.all([
    AuditLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
    AuditLog.countDocuments(query),
  ]);

  return { items, total, page: Number(page), limit };
}

module.exports = { record, list };
