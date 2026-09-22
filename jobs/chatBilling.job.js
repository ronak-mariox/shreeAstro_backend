/**
 * The live per-minute consultation billing tick.
 *
 * Unlike jobs/horoscopePrefetch.job.js (once a day, node-cron), this needs to
 * check in on active sessions much more often than once a minute — a session
 * that started at 3:07:42 is due its second minute at 3:08:42, not at the
 * next wall-clock minute boundary — so this polls on a short `setInterval`
 * instead. services/chat.service.js's runBillingSweep does the actual work
 * (and takes an injectable `now`, so tests run it directly against a fake
 * clock rather than waiting on real time); this file only owns when it runs.
 */

const chatService = require('../services/chat.service');

/** How often the sweep itself runs — well under the 60s tick interval, so no active session is ever more than a few seconds late for its own next minute. */
const SWEEP_INTERVAL_MS = 10 * 1000;

async function runChatBillingSweep(now = new Date()) {
  try {
    return await chatService.runBillingSweep(now);
  } catch (error) {
    console.error('[chatBilling] sweep failed:', error);
    return [];
  }
}

/** Starts the recurring sweep. Called once from index.js at boot. */
function scheduleChatBillingSweep() {
  const timer = setInterval(() => {
    runChatBillingSweep().catch(error => {
      console.error('[chatBilling] unexpected crash:', error);
    });
  }, SWEEP_INTERVAL_MS);
  /** Never keeps the process alive on its own — the server's own listeners already do that. */
  timer.unref();
  return timer;
}

module.exports = { runChatBillingSweep, scheduleChatBillingSweep, SWEEP_INTERVAL_MS };
