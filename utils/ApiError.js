/**
 * An error that already knows what the client should be told.
 *
 * Services throw these; the error middleware turns them into a response. Any
 * other error that reaches the middleware is treated as a bug and reported as a
 * plain 500, so an internal message can never leak by accident.
 */

class ApiError extends Error {
  /**
   * @param {number} status  HTTP status to answer with.
   * @param {string} message Safe to show a user.
   * @param {Record<string, string>} [fields] Per-field messages, for a form.
   * @param {string} [code] A stable machine-readable reason, so a client can
   *   branch on it without matching on prose — "token_expired" tells the apps
   *   to refresh and retry rather than to sign the user out.
   */
  constructor(status, message, fields, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
    this.code = code;
    /** Marks this as deliberate, as opposed to something that merely broke. */
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, fields, code) {
    return new ApiError(400, message, fields, code);
  }

  static unauthorized(message = 'Please sign in.', code) {
    return new ApiError(401, message, undefined, code);
  }

  static forbidden(message = 'You cannot do that.', code) {
    return new ApiError(403, message, undefined, code);
  }

  static notFound(message = 'Not found.', code) {
    return new ApiError(404, message, undefined, code);
  }

  static conflict(message, fields, code) {
    return new ApiError(409, message, fields, code);
  }

  /**
   * Attaches machine-readable numbers a client needs to act on a refusal —
   * e.g. the exact shortfall on an `insufficient_balance`, or the new price
   * on a `price_changed` — sent back as `details` alongside `code`.
   */
  withDetails(details) {
    this.details = details;
    return this;
  }

  /** What a form gets back when its values do not pass validation. */
  static unprocessable(message = 'Please check the form.', fields) {
    return new ApiError(422, message, fields);
  }

  /**
   * Asked for too soon or too often — a resend inside its cooldown, a code
   * guessed past its attempt limit. The client reads `code` to tell which.
   *
   * `retryAfterSeconds` is how long the caller should wait, when that is
   * knowable. It goes out as the standard `Retry-After` header as well as in
   * the body, so an app can run an accurate countdown rather than guessing.
   */
  static tooManyRequests(
    message = 'Please wait a moment and try again.',
    code,
    retryAfterSeconds,
  ) {
    const error = new ApiError(429, message, undefined, code);
    error.retryAfterSeconds = retryAfterSeconds;
    return error;
  }
}

module.exports = ApiError;
