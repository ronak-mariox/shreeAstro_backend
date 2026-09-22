/**
 * Fixed-length consultation packages — the alternative to per-minute billing.
 *
 * A package is bought whole, upfront (on accept, in the same transaction that
 * starts the session — see services/chat.service.js's purchasePackage), and
 * the per-minute meter never runs while one is in force. When its time is up
 * the seeker is asked to extend with another package, switch to per-minute,
 * or end.
 *
 * The list below is the ONE place the offered durations live; both apps get
 * it priced from `packageQuotes` (POST /chats/precheck), so changing an entry
 * here changes every screen. user_app keeps an identical fallback copy in
 * src/data/consultPackages.ts for dummy mode only.
 *
 * `discountPercent` is the hook for discounted packages. It is honoured by
 * `packagePrice` already, but every entry is 0 today — no discount applies.
 */

const CONSULTATION_PACKAGES = Object.freeze([
  Object.freeze({ minutes: 3, discountPercent: 0 }),
  Object.freeze({ minutes: 5, discountPercent: 0 }),
  Object.freeze({ minutes: 10, discountPercent: 0 }),
  Object.freeze({ minutes: 20, discountPercent: 0 }),
]);

/** The package offered for exactly this many minutes, or null when none is. */
function findPackage(minutes) {
  const wanted = Number(minutes);
  return CONSULTATION_PACKAGES.find(entry => entry.minutes === wanted) || null;
}

/**
 * What a package costs at a given per-minute rate: minutes × rate, less the
 * package's own discount (rounded to whole rupees, like every wallet amount).
 * The rate is always the astrologer's real one — never a client-sent figure.
 */
function packagePrice(ratePerMinute, pkg) {
  const rate = Number(ratePerMinute);
  if (!pkg || !Number.isFinite(rate) || rate < 0) {
    return null;
  }
  const gross = rate * pkg.minutes;
  const discount = Math.round((gross * (pkg.discountPercent || 0)) / 100);
  return Math.max(0, Math.round(gross - discount));
}

/** Every package priced at `ratePerMinute`, optionally flagged against a wallet balance. */
function packageQuotes(ratePerMinute, balance) {
  return CONSULTATION_PACKAGES.map(pkg => {
    const price = packagePrice(ratePerMinute, pkg);
    const quote = { minutes: pkg.minutes, discountPercent: pkg.discountPercent, price };
    if (balance !== undefined) {
      quote.affordable = balance >= price;
      quote.shortfallAmount = Math.max(0, price - balance);
    }
    return quote;
  });
}

/**
 * Seconds of a package still unused at `now` — 0 once its time has run out,
 * the extension prompt is open, or the session has moved on to per-minute.
 */
function unusedPackageSeconds(packageState, now) {
  if (!packageState?.endsAt || packageState.promptedAt || packageState.perMinuteStartedAt) {
    return 0;
  }
  return Math.max(0, Math.floor((new Date(packageState.endsAt).getTime() - now.getTime()) / 1000));
}

/**
 * REFUND POLICY HOOK — not decided yet, deliberately a no-op.
 *
 * Called by endChat for every package session that ends, with how many
 * seconds of paid package time were left over. The seeker ending early is
 * their own choice and is never refunded. The open question is what happens
 * when the ASTROLOGER ends early (or drops and never reconnects) — refund the
 * unused whole minutes? pro-rata? nothing? Until that's decided this returns
 * 0 in every case, so unused minutes are currently NOT refunded. endChat
 * already posts whatever this returns as a `refund` credit and records it on
 * the session, so implementing the policy is only this function.
 *
 * @param {{ unusedSeconds: number, ratePerMinute: number, endedBy: 'user'|'astrologer'|'system', reason?: string }} context
 * @returns {number} rupees to refund to the seeker
 */
// eslint-disable-next-line no-unused-vars
function unusedPackageRefund({ unusedSeconds, ratePerMinute, endedBy, reason }) {
  if (endedBy === 'user') {
    return 0;
  }
  // TODO(package-refund-policy): astrologer/system-ended sessions — pending product decision.
  return 0;
}

module.exports = {
  CONSULTATION_PACKAGES,
  findPackage,
  packagePrice,
  packageQuotes,
  unusedPackageSeconds,
  unusedPackageRefund,
};
