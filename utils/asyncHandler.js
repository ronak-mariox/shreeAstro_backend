/**
 * Wraps an async route or middleware so a rejected promise reaches express's
 * error handler instead of hanging the request.
 */

const asyncHandler = handler => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

module.exports = asyncHandler;
