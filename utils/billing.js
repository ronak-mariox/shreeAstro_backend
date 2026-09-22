/**
 * The one rule every per-minute billing calculation shares: any part of a
 * minute is billed as a full minute (3 min 20 sec = 4 minutes). Kept here,
 * not scattered — models/Chat.js's settle() and the live billing tick
 * (services/chat.service.js, jobs/chatBilling.job.js) both call this, so a
 * future change to the rounding rule is one edit, not a hunt.
 */
function minutesFor(seconds) {
  return Math.max(0, Math.ceil(seconds / 60));
}

module.exports = { minutesFor };
