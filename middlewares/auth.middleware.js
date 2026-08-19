/** Route guards: who is calling, and whether they may. */

const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const { verifyToken, tokenFrom } = require('../utils/token');

/**
 * Requires a valid access token and hangs `{ accountId, role }` off the request
 * as `req.account`. Controllers read that rather than trusting anything in a
 * body.
 *
 * The token may arrive as an `Authorization` header (the apps) or as the
 * httpOnly cookie (the admin panel) — `tokenFrom` looks in both.
 *
 * An expired token is a 401 with `code: 'token_expired'`, which is the client's
 * cue to call POST /auth/refresh once and retry, rather than to sign the user
 * out.
 */
function authenticate(req, res, next) {
  try {
    req.account = verifyToken(
      tokenFrom({ query: req.query, headers: req.headers, cookies: req.cookies }),
    );
    return next();
  } catch (error) {
    return next(ApiError.unauthorized(error.message, error.code));
  }
}

/**
 * Identifies the caller when a token is present, and shrugs when it is not —
 * for endpoints that answer everyone but answer a signed-in caller better.
 */
function optionalAuthenticate(req, res, next) {
  try {
    req.account = verifyToken(
      tokenFrom({ query: req.query, headers: req.headers, cookies: req.cookies }),
    );
  } catch (error) {
    req.account = null;
  }
  return next();
}

/** Narrows an authenticated route to certain roles. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.account || !roles.includes(req.account.role)) {
    return next(ApiError.forbidden('This is not available to your account.'));
  }
  return next();
};

/**
 * Loads the signed-in admin's document onto `req.admin`.
 *
 * Admin routes need more than an id: the audit log records who made a change,
 * and permission checks read the account's role and grants. Run this after
 * `authenticate` and `authorize('admin')`.
 */
async function loadAdmin(req, res, next) {
  try {
    const admin = await Admin.findById(req.account.accountId);

    if (!admin) {
      return next(ApiError.unauthorized('This account no longer exists.', 'account_missing'));
    }
    if (admin.status !== 'active') {
      return next(ApiError.forbidden('This account is not active.', 'account_blocked'));
    }

    req.admin = admin;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Narrows an admin route to accounts holding a particular permission.
 *
 * The permission list is worked out by the Admin model from the account's role
 * plus any per-account grants and revocations.
 */
const requirePermission = permission => (req, res, next) => {
  if (!req.admin?.can(permission)) {
    return next(ApiError.forbidden('You do not have permission to do that.'));
  }
  return next();
};

/** The three middlewares every admin route needs, in the right order. */
const adminOnly = [authenticate, authorize('admin'), loadAdmin];

module.exports = {
  authenticate,
  optionalAuthenticate,
  authorize,
  loadAdmin,
  requirePermission,
  adminOnly,
};
