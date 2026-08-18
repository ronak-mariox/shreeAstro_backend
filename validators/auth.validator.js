/**
 * What the auth endpoints accept.
 *
 * Validators are middleware: they check the request's shape and stop it before
 * a controller or service ever sees it, so those two only deal in values that
 * are already the right kind of thing.
 */

const ApiError = require('../utils/ApiError');

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Indian mobile numbers: ten digits starting 6–9. */
const PHONE_PATTERN = /^[6-9]\d{9}$/;
const GENDERS = ['male', 'female', 'other'];
/** As the app's form types them: DD/MM/YYYY and "06 : 30 AM" or "18:30". */
const DATE_PATTERN = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/;
const TIME_PATTERN = /^(\d{1,2})\s*:\s*(\d{2})(\s*[APap][Mm])?$/;

/**
 * Create Account, as the two-step wizard submits it: the profile step, the
 * birth-details step, and optionally a photo.
 */
function validateRegister(req, res, next) {
  const { fullName, email, phone, gender, dateOfBirth, timeOfBirth, placeOfBirth } =
    req.body || {};
  const fields = {};

  if (!fullName || String(fullName).trim().length < 2) {
    fields.fullName = 'Enter your full name.';
  }
  if (!email || !EMAIL_PATTERN.test(String(email).trim())) {
    fields.email = 'Enter a valid email address.';
  }
  if (!phone || !PHONE_PATTERN.test(String(phone))) {
    fields.phone = 'Enter a 10-digit mobile number.';
  }
  if (gender !== undefined && !GENDERS.includes(gender)) {
    fields.gender = 'Pick a gender.';
  }

  /** Birth details arrive with the same request, so they are checked with it. */
  if (!dateOfBirth || !DATE_PATTERN.test(String(dateOfBirth).trim())) {
    fields.dateOfBirth = 'Use the format DD/MM/YYYY.';
  }
  if (!timeOfBirth || !TIME_PATTERN.test(String(timeOfBirth).trim())) {
    fields.timeOfBirth = 'Use the format HH:MM AM/PM.';
  }
  if (!placeOfBirth || String(placeOfBirth).trim().length < 2) {
    fields.placeOfBirth = 'Enter your place of birth.';
  }

  if (Object.keys(fields).length) {
    return next(ApiError.unprocessable('Please check the form.', fields));
  }
  return next();
}

module.exports = { validateRegister, GENDERS };
