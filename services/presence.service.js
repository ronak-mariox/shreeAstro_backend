/**
 * Who is available right now.
 *
 * "Online" in the seeker's directory is the astrologer's OWN choice — the
 * dashboard toggle (PATCH /astrologer/me/presence → astrologer.service's
 * setOnline) — and it stays what they chose until they change it. It used to
 * follow the app's socket instead: closing the app put them offline and
 * opening it put them back online, whatever the toggle said. With push
 * notifications a closed app is still reachable (the request arrives in the
 * tray and opens the Consult tab), so a connection coming or going no longer
 * says anything about availability.
 *
 * What the socket layer still reports here is only *when the app was last
 * seen* — useful to an admin, and to anything that later wants to spot an
 * astrologer who is marked online but has not opened the app in days.
 */

const Astrologer = require('../models/Astrologer');

/** The app connected or disconnected: note the time, leave availability alone. */
async function touchAstrologerSeen(astrologerId) {
  await Astrologer.updateOne({ _id: astrologerId }, { $set: { 'presence.lastSeenAt': new Date() } });
}

/** Sets availability outright — for the places that really do decide it (never the socket). */
async function setAstrologerOnline(astrologerId, isOnline) {
  await Astrologer.updateOne(
    { _id: astrologerId },
    { $set: { 'presence.isOnline': isOnline, 'presence.lastSeenAt': new Date() } },
  );
}

module.exports = { setAstrologerOnline, touchAstrologerSeen };
