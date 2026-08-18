/** Route guards: who is calling, and whether they may. */

const ApiError = require('../utils/ApiError');
const { verifyToken, tokenFrom } = require('../utils/token');

/**
 * Requires a valid token and hangs `{ accountId, role }` off the request as
 * `req.account`. Controllers read that rather than trusting anything in a body.
 */
function authenticate(req, res, next) {
  try {
    req.account = verifyToken(tokenFrom({ query: req.query, headers: req.headers }));
    return next();
  } catch (error) {
    return next(ApiError.unauthorized(error.message));
  }
}

/** Narrows an authenticated route to certain roles. */
const authorize = (...roles) => (req, res, next) => {
  if (!req.account || !roles.includes(req.account.role)) {
    return next(ApiError.forbidden('This is not available to your account.'));
  }
  return next();
};

module.exports = { authenticate, authorize };
