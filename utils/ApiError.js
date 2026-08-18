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
   */
  constructor(status, message, fields) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields;
    /** Marks this as deliberate, as opposed to something that merely broke. */
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message, fields) {
    return new ApiError(400, message, fields);
  }

  static unauthorized(message = 'Please sign in.') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You cannot do that.') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Not found.') {
    return new ApiError(404, message);
  }

  static conflict(message, fields) {
    return new ApiError(409, message, fields);
  }

  /** What a form gets back when its values do not pass validation. */
  static unprocessable(message = 'Please check the form.', fields) {
    return new ApiError(422, message, fields);
  }
}

module.exports = ApiError;
