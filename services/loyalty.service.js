/**
 * Loyalty points.
 *
 * Points are earned on what a seeker spends — a consultation, a store order,
 * a puja — at the rates in settings.loyalty, and lifetime points decide the
 * tier. `award()` is the one write path: a LoyaltyTransaction row is claimed
 * first (its `dedupeKey` makes "points for order X" a thing that can happen
 * once), then the counters on the user move, then the seeker is told.
 *
 * Cashback is separate money, not points: when `cashbackEnabled` is on, a
 * tier's percentage of each consultation charge lands in the wallet as a
 * `cashback` credit (through wallet.service's post, like every rupee).
 */

const mongoose = require('mongoose');

const User = require('../models/User');
const LoyaltyTransaction = require('../models/LoyaltyTransaction');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');

const TIER_NAMES = { silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond' };

/** What each tier promises beyond its cashback — the offers page copy. */
const TIER_PERKS = {
  silver: ['Access to member offers', 'Birthday bonus 50 points'],
  gold: ['Free monthly horoscope', 'Priority astrologer matching', 'Birthday bonus 100 points'],
  platinum: ['Free Kundli report monthly', 'Exclusive astrologers access', 'Festival bonus points'],
  diamond: ['Dedicated relationship manager', 'Unlimited free Kundli reports', 'VIP festival offers'],
};

const EARN_LABELS = {
  chat: 'Chat consultation',
  call: 'Call consultation',
  order: 'Store purchase',
  puja: 'Puja booking',
};

const DEFAULT_TIERS = [
  { key: 'silver', minPoints: 0, cashbackPercent: 0 },
  { key: 'gold', minPoints: 500, cashbackPercent: 2 },
  { key: 'platinum', minPoints: 2000, cashbackPercent: 3 },
  { key: 'diamond', minPoints: 5000, cashbackPercent: 5 },
];

/** The tier table, lowest first, from settings (or the defaults when unset). */
function tiersFrom(settings) {
  const rows = settings?.loyalty?.tiers?.length ? settings.loyalty.tiers : DEFAULT_TIERS;
  return [...rows]
    .map(tier => ({
      key: tier.key,
      minPoints: Number(tier.minPoints) || 0,
      cashbackPercent: Number(tier.cashbackPercent) || 0,
    }))
    .sort((a, b) => a.minPoints - b.minPoints);
}

/** Which tier `lifetimePoints` lands in. */
function tierFor(lifetimePoints, tiers = DEFAULT_TIERS) {
  const sorted = tiersFrom({ loyalty: { tiers } });
  let current = sorted[0];
  for (const tier of sorted) {
    if (lifetimePoints >= tier.minPoints) current = tier;
  }
  return current ? current.key : 'silver';
}

/** The public tier cards: ranges, cashback and perks. */
function publicTiers(settings) {
  const tiers = tiersFrom(settings);
  return tiers.map((tier, index) => {
    const next = tiers[index + 1];
    const perks = [
      ...(tier.cashbackPercent > 0 ? [`${tier.cashbackPercent}% cashback on consultations`] : []),
      ...(TIER_PERKS[tier.key] || []),
    ];
    return {
      key: tier.key,
      name: TIER_NAMES[tier.key] || tier.key,
      minPoints: tier.minPoints,
      maxPoints: next ? next.minPoints - 1 : null,
      cashbackPercent: tier.cashbackPercent,
      perks,
    };
  });
}

/** The "how to earn" list on the offers page. */
function publicEarn(settings) {
  const rates = settings?.loyalty?.pointsPer100 || {};
  return [
    ...Object.keys(EARN_LABELS).map(key => ({
      key,
      label: EARN_LABELS[key],
      pointsPer100: Number(rates[key]) || 0,
    })),
    {
      key: 'referral',
      label: 'Referral bonus',
      pointsPer100: null,
      points: Number(settings?.loyalty?.referralBonusPoints) || 0,
    },
  ];
}

/** Where a seeker stands: tier, the next one, and how far away it is. */
function standing(loyalty, settings) {
  const tiers = tiersFrom(settings);
  const lifetime = loyalty?.lifetimePoints || 0;
  const key = tierFor(lifetime, tiers);
  const index = tiers.findIndex(tier => tier.key === key);
  const current = tiers[index] || tiers[0];
  const next = tiers[index + 1] || null;
  return {
    points: loyalty?.points || 0,
    lifetimePoints: lifetime,
    tier: key,
    nextTier: next ? next.key : null,
    pointsToNext: next ? Math.max(next.minPoints - lifetime, 0) : 0,
    cashbackPercent: current ? current.cashbackPercent : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Writing points                                                             */
/* -------------------------------------------------------------------------- */

const dedupeKeyFor = ({ type, source }) =>
  source?.kind && source?.id && source.kind !== 'admin' ? `${type}:${source.kind}:${String(source.id)}` : undefined;

/**
 * Moves `points` (signed) on one seeker and writes the ledger row.
 *
 * Returns the row, or `null` when the same award was already made (the
 * dedupe key was taken) — the caller never needs to check first.
 */
async function award({ userId, points, reason, source, type = 'earn', notify = true }) {
  const delta = Math.round(Number(points));
  if (!Number.isFinite(delta) || delta === 0) {
    return null;
  }

  /**
   * Already awarded? The read catches the ordinary re-run (a hook firing
   * twice for the same event); the unique index on `dedupeKey` catches the
   * concurrent one the read cannot see.
   */
  const dedupeKey = dedupeKeyFor({ type, source });
  if (dedupeKey && (await LoyaltyTransaction.exists({ dedupeKey }))) {
    return null;
  }

  let row;
  try {
    row = await LoyaltyTransaction.create({
      user: userId,
      type,
      points: delta,
      reason,
      source,
      dedupeKey,
    });
  } catch (error) {
    if (error && error.code === 11000) {
      return null;
    }
    throw error;
  }

  const filter = { _id: userId };
  if (delta < 0) {
    filter['loyalty.points'] = { $gte: -delta };
  }
  const user = await User.findOneAndUpdate(
    filter,
    { $inc: { 'loyalty.points': delta, 'loyalty.lifetimePoints': Math.max(delta, 0) } },
    { returnDocument: 'after' },
  );
  if (!user) {
    await row.deleteOne();
    const exists = await User.exists({ _id: userId });
    throw exists
      ? ApiError.badRequest('The seeker does not have that many points.', { points: 'Not enough points.' })
      : ApiError.notFound('User not found.');
  }

  const settings = await settingsService.get();
  const tier = tierFor(user.loyalty.lifetimePoints, tiersFrom(settings));
  if (tier !== user.loyalty.tier) {
    await User.updateOne({ _id: userId }, { $set: { 'loyalty.tier': tier } });
    user.loyalty.tier = tier;
  }

  row.balanceAfter = user.loyalty.points;
  await row.save();

  if (notify) {
    await notificationService
      .notify({
        ownerRole: 'user',
        ownerId: userId,
        type: 'reward',
        title: delta > 0 ? `You earned ${delta} points` : `${-delta} points were deducted`,
        body: reason || (delta > 0 ? 'Thank you for being with Shree Astro.' : undefined),
        action: { screen: 'loyalty' },
      })
      .catch(() => {});
  }

  return row;
}

/**
 * Points for money spent: `kind` is 'chat' | 'call' | 'order' | 'puja', and
 * the rate is settings.loyalty.pointsPer100[kind]. Nothing when the programme
 * is off or the amount rounds to no points.
 */
async function awardForSpend({ userId, kind, amount, source, reason }) {
  const settings = await settingsService.get();
  if (settings.loyalty && settings.loyalty.enabled === false) {
    return null;
  }
  const rate = Number(settings.loyalty?.pointsPer100?.[kind]) || 0;
  const rupees = Math.round(Number(amount)) || 0;
  const points = Math.floor((rupees / 100) * rate);
  if (points <= 0) {
    return null;
  }
  return award({
    userId,
    points,
    reason: reason || `${EARN_LABELS[kind] || 'Purchase'} of ₹${rupees}`,
    source,
    type: 'earn',
  });
}

/** The welcome points a new account gets. */
async function awardSignupBonus(userId) {
  const settings = await settingsService.get();
  if (settings.loyalty && settings.loyalty.enabled === false) {
    return null;
  }
  const points = Number(settings.loyalty?.signupBonusPoints) || 0;
  if (points <= 0) return null;
  return award({
    userId,
    points,
    reason: 'Welcome to Shree Astro',
    source: { kind: 'signup', id: userId },
    type: 'bonus',
  });
}

/**
 * A tier's cashback on one consultation charge — a real wallet credit, once
 * per session (the ledger's `chatSession` link is checked before posting).
 */
async function creditCashback({ userId, amount, chatSession }) {
  const settings = await settingsService.get();
  if (!settings.loyalty?.cashbackEnabled) {
    return null;
  }
  const user = await User.findById(userId).select('loyalty');
  if (!user) return null;

  const percent = standing(user.loyalty, settings).cashbackPercent;
  const cashback = Math.floor((Math.round(Number(amount)) * percent) / 100);
  if (cashback <= 0) {
    return null;
  }

  const WalletTransaction = require('../models/WalletTransaction');
  const already = await WalletTransaction.exists({ chatSession, type: 'cashback', owner: userId });
  if (already) {
    return null;
  }

  return walletService.post({
    ownerRole: 'user',
    ownerId: userId,
    direction: 'credit',
    type: 'cashback',
    amount: cashback,
    title: `${percent}% ${TIER_NAMES[user.loyalty.tier] || ''} cashback`.trim(),
    description: `Cashback on a ₹${Math.round(Number(amount))} consultation`,
    chatSession,
  });
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

/** GET /loyalty */
async function summary(userId) {
  const [user, settings, history] = await Promise.all([
    User.findById(userId).select('loyalty'),
    settingsService.get(),
    LoyaltyTransaction.find({ user: userId }).sort({ createdAt: -1 }).limit(20),
  ]);
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }
  return {
    ...standing(user.loyalty, settings),
    tiers: publicTiers(settings),
    history,
  };
}

/** GET /loyalty/history */
async function history({ userId, page, limit }) {
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [items, total] = await Promise.all([
    LoyaltyTransaction.find({ user: userId }).sort({ createdAt: -1 }).skip(skip).limit(size),
    LoyaltyTransaction.countDocuments({ user: userId }),
  ]);
  return { items, total, page: current, limit: size };
}

/** The `me` block on GET /offers. */
async function standingFor(userId) {
  const [user, settings] = await Promise.all([User.findById(userId).select('loyalty'), settingsService.get()]);
  if (!user) return null;
  const { points, tier, nextTier, pointsToNext, lifetimePoints } = standing(user.loyalty, settings);
  return { points, lifetimePoints, tier, nextTier, pointsToNext };
}

/** POST /admin/loyalty/adjust */
async function adminAdjust({ userId, points, reason, admin }) {
  if (!mongoose.isValidObjectId(userId)) {
    throw ApiError.notFound('User not found.');
  }
  const row = await award({
    userId,
    points,
    reason: String(reason).trim(),
    source: { kind: 'admin', id: admin._id },
    type: 'adjust',
  });
  const user = await User.findById(userId).select('loyalty name');
  return { transaction: row, loyalty: user.loyalty };
}

module.exports = {
  award,
  awardForSpend,
  awardSignupBonus,
  creditCashback,
  tierFor,
  tiersFrom,
  publicTiers,
  publicEarn,
  standing,
  standingFor,
  summary,
  history,
  adminAdjust,
  TIER_NAMES,
};
