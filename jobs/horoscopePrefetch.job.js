/**
 * Prefetches all 12 signs' daily horoscope once a day, so no user's own
 * request ever triggers a live provider call — see
 * services/horoscopeCache.service.js for why that reduces the whole app to
 * at most 12 real calls a day, regardless of how many users open it.
 *
 * Idempotent and partial-failure tolerant, the same way kundli.service.js's
 * runBatch is: Promise.allSettled means one sign failing never blocks the
 * other eleven from caching, and re-running this (the next scheduled fire,
 * or a manual retry) only ever re-fetches whatever is still missing — a
 * cache hit costs nothing, so there is no separate "retry" code path here.
 */

const cron = require('node-cron');

const { ZODIAC_SIGNS } = require('../utils/zodiac');
const { getHoroscope } = require('../services/horoscopeCache.service');
const { istDateString } = require('../utils/istDate');

/** @param {string} [targetDate] Defaults to today (IST) — a param only so tests can pin it without waiting for midnight. */
async function runHoroscopePrefetch(targetDate = istDateString()) {
  const results = await Promise.allSettled(
    /**
     * allowStaleFallback: false — this job's whole job is knowing whether
     * TODAY's fetch actually succeeded; a stale reading from an older date
     * papering over a real failure would defeat that (see
     * horoscopeCache.service.js's getHoroscope for the flag itself, which
     * defaults to true for every other, user-facing caller).
     */
    ZODIAC_SIGNS.map(sign => getHoroscope(sign, 'daily', targetDate, undefined, { allowStaleFallback: false })),
  );

  const failed = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed.push(ZODIAC_SIGNS[index]);
      console.error(`[horoscopePrefetch] ${ZODIAC_SIGNS[index]} failed:`, result.reason?.message);
    }
  });

  const succeeded = ZODIAC_SIGNS.length - failed.length;
  console.log(
    `[horoscopePrefetch] ${targetDate}: ${succeeded}/${ZODIAC_SIGNS.length} cached` +
      (failed.length ? `, failed: ${failed.join(', ')}` : ''),
  );

  return { targetDate, succeeded, failed };
}

/**
 * Registers the daily 00:05 IST prefetch. Called once from index.js at boot.
 * `timezone: 'Asia/Kolkata'` is load-bearing — without it node-cron fires at
 * 00:05 in the server's own local time, which is wrong the moment this ever
 * runs on a non-IST host.
 */
function scheduleHoroscopePrefetch() {
  return cron.schedule(
    '5 0 * * *',
    () => {
      runHoroscopePrefetch().catch(error => {
        console.error('[horoscopePrefetch] unexpected crash:', error);
      });
    },
    { timezone: 'Asia/Kolkata' },
  );
}

module.exports = { runHoroscopePrefetch, scheduleHoroscopePrefetch };
