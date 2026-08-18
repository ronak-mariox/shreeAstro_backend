/**
 * Who is available right now.
 *
 * An astrologer's app holding a socket is what "Online" means in the seeker's
 * directory, so the socket layer reports connections here rather than writing
 * to the model itself.
 */

const Astrologer = require('../models/Astrologer');

async function setAstrologerOnline(astrologerId, isOnline) {
  await Astrologer.updateOne(
    { _id: astrologerId },
    { $set: { 'presence.isOnline': isOnline, 'presence.lastSeenAt': new Date() } },
  );
}

module.exports = { setAstrologerOnline };
