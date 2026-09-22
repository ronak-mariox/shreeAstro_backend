/**
 * Fixed-length consultation packages — the alternative to per-minute billing.
 *
 * A package is bought whole, upfront (on accept, in the same transaction that
 * starts the session — see services/chat.service.js's purchasePackage), and
 * the per-minute meter never runs while one is in force. When its time is up
 * the session pauses and the seeker chooses how to continue — per-minute or
 * another package (recharging first, through the existing recharge flow, if
 * the wallet can't cover either).
 *
 * The list below is the ONE place the offered durations live; both apps get
 * it priced from `packageQuotes` (POST /chats/precheck), so changing an entry
 * here changes every screen. user_app keeps an identical fallback copy in
 * src/data/consultPackages.ts for dummy mode only.
 *
 * Discounts: the `discountPercent` here is only the default (0). The live
 * discount for each duration is set by an admin in the panel (Settings →
 * Platform → Consultation package discounts), stored on models/Settings.js's
 * `packageDiscounts`, and merged in by `packagesWithDiscounts`. Every price
 * the server quotes or charges goes through `packagePrice`, so the discounted
 * price is the one both shown and charged.
 */

const CONSULTATION_PACKAGES = Object.freeze([
  Object.freeze({ minutes: 3, discountPercent: 0 }),
  Object.freeze({ minutes: 5, discountPercent: 0 }),
  Object.freeze({ minutes: 10, discountPercent: 0 }),
  Object.freeze({ minutes: 20, discountPercent: 0 }),
]);

/** The most an admin may take off a package, in percent — anything above is refused, never silently clamped. */
const MAX_PACKAGE_DISCOUNT_PERCENT = 90;

/**
 * Every offered package with the admin's discount applied (Settings'
 * `packageDiscounts`, `[{ minutes, discountPercent }]`). A duration with no
 * admin entry — or an entry for a duration no longer offered — falls back
 * to the default here, so a stale setting can never add or remove a package.
 */
function packagesWithDiscounts(discounts = []) {
  return CONSULTATION_PACKAGES.map(pkg => {
    const override = (discounts || []).find(entry => Number(entry?.minutes) === pkg.minutes);
    const percent = Number(override?.discountPercent);
    return {
      minutes: pkg.minutes,
      discountPercent: Number.isFinite(percent) && percent >= 0 && percent <= MAX_PACKAGE_DISCOUNT_PERCENT
        ? percent
        : pkg.discountPercent,
    };
  });
}

/** The package offered for exactly this many minutes (with its admin discount), or null when none is. */
function findPackage(minutes, discounts) {
  const wanted = Number(minutes);
  return packagesWithDiscounts(discounts).find(entry => entry.minutes === wanted) || null;
}

/**
 * Validates an admin's discount edit and merges it over `current` — used by
 * services/settings.service.js. Returns one entry per offered package.
 * Throws an Error with `field` set on anything invalid; the caller turns it
 * into a 400.
 */
function mergePackageDiscounts(changes, current = []) {
  if (!Array.isArray(changes)) {
    const error = new Error('Package discounts must be a list.');
    error.field = 'packageDiscounts';
    throw error;
  }
  const merged = new Map(packagesWithDiscounts(current).map(pkg => [pkg.minutes, pkg.discountPercent]));
  for (const entry of changes) {
    const minutes = Number(entry?.minutes);
    const percent = Number(entry?.discountPercent);
    if (!merged.has(minutes)) {
      const error = new Error(`There is no ${entry?.minutes}-minute package.`);
      error.field = 'packageDiscounts';
      throw error;
    }
    if (!Number.isInteger(percent) || percent < 0 || percent > MAX_PACKAGE_DISCOUNT_PERCENT) {
      const error = new Error(`The ${minutes}-minute discount must be a whole number from 0 to ${MAX_PACKAGE_DISCOUNT_PERCENT}%.`);
      error.field = 'packageDiscounts';
      throw error;
    }
    merged.set(minutes, percent);
  }
  return [...merged.entries()].map(([minutes, discountPercent]) => ({ minutes, discountPercent }));
}

/** minutes × rate — the package's price before any discount (the struck-through figure in the app). */
function originalPackagePrice(ratePerMinute, pkg) {
  const rate = Number(ratePerMinute);
  if (!pkg || !Number.isFinite(rate) || rate < 0) {
    return null;
  }
  return Math.round(rate * pkg.minutes);
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

/**
 * Every package priced at `ratePerMinute` with the admin's `discounts`
 * applied — `originalPrice` is before the discount, `price` is what is
 * charged — optionally flagged against a wallet balance.
 */
function packageQuotes(ratePerMinute, balance, discounts) {
  return packagesWithDiscounts(discounts).map(pkg => {
    const price = packagePrice(ratePerMinute, pkg);
    const quote = {
      minutes: pkg.minutes,
      discountPercent: pkg.discountPercent,
      originalPrice: originalPackagePrice(ratePerMinute, pkg),
      price,
    };
    if (balance !== undefined) {
      quote.affordable = balance >= price;
      quote.shortfallAmount = Math.max(0, price - balance);
    }
    return quote;
  });
}

/**
 * Seconds of a package still unused at `now` — 0 once its time has run out
 * or the session has moved on to per-minute.
 */
function unusedPackageSeconds(packageState, now) {
  if (!packageState?.endsAt || packageState.perMinuteStartedAt || packageState.awaitingChoiceSince) {
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
  MAX_PACKAGE_DISCOUNT_PERCENT,
  packagesWithDiscounts,
  mergePackageDiscounts,
  findPackage,
  originalPackagePrice,
  packagePrice,
  packageQuotes,
  unusedPackageSeconds,
  unusedPackageRefund,
};
