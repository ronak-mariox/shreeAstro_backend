/**
 * Refer a friend.
 *
 * A seeker's code is made the first time anyone asks for it. A new account
 * that registers with someone's code gets a Referral row in `signed_up`; the
 * first time that account spends enough (minFirstSpend) — a paid consultation,
 * a delivered order, a completed puja — the row is claimed atomically into
 * `rewarded` and both wallets are credited. Claiming first is what keeps two
 * qualifying events landing at once from paying twice.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const User = require('../models/User');
const Referral = require('../models/Referral');
const ApiError = require('../utils/ApiError');
const settingsService = require('./settings.service');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const loyaltyService = require('./loyalty.service');

const WEB_URL = (process.env.PUBLIC_WEB_URL || 'https://shreeastro.com').replace(/\/$/, '');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
  const bytes = crypto.randomBytes(6);
  let out = 'SA';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

const normaliseCode = code => String(code || '').trim().toUpperCase();

const linkFor = code => `${WEB_URL}/login?ref=${code}`;

/** "Arjun Sharma" → "Arjun S." */
function maskedName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A seeker';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

/** The seeker's code, made now if they never had one. */
async function ensureCode(userId) {
  const user = await User.findById(userId).select('referralCode');
  if (!user) {
    throw ApiError.notFound('Account not found.');
  }
  if (user.referralCode) {
    return user.referralCode;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = randomCode();
    try {
      // eslint-disable-next-line no-await-in-loop
      const claimed = await User.findOneAndUpdate(
        { _id: userId, referralCode: { $exists: false } },
        { $set: { referralCode: code } },
        { returnDocument: 'after' },
      );
      if (claimed) return claimed.referralCode;
      /** Someone else set it between the read and the write. */
      // eslint-disable-next-line no-await-in-loop
      const again = await User.findById(userId).select('referralCode');
      if (again?.referralCode) return again.referralCode;
    } catch (error) {
      if (!(error && error.code === 11000)) throw error;
    }
  }
  throw new Error('Could not allocate a referral code.');
}

/**
 * Records who brought a new account in. Called from registration with
 * whatever the form sent; an unknown code, or the account's own, is simply
 * ignored — registration must never fail over it.
 */
async function applyAtRegistration({ user, referralCode }) {
  const code = normaliseCode(referralCode);
  if (!code) return false;

  const settings = await settingsService.get();
  if (settings.referral && settings.referral.enabled === false) return false;

  const referrer = await User.findOne({ referralCode: code, _id: { $ne: user._id } }).select('_id name');
  if (!referrer) return false;

  try {
    await Referral.create({
      referrer: referrer._id,
      referred: user._id,
      code,
      rewardAmount: Number(settings.referral?.rewardAmount) || 0,
    });
  } catch (error) {
    if (error && error.code === 11000) return false;
    throw error;
  }
  await User.updateOne({ _id: user._id }, { $set: { referredBy: referrer._id } });
  user.referredBy = referrer._id;
  return true;
}

/**
 * The reward trigger. `amount` is what the referred seeker just paid for a
 * finished consultation / delivered order / completed puja; when it reaches
 * minFirstSpend and this is their first, both sides are paid.
 */
async function onQualifyingSpend({ userId, amount, source }) {
  const settings = await settingsService.get();
  if (settings.referral && settings.referral.enabled === false) return null;
  const rupees = Math.round(Number(amount)) || 0;
  if (rupees < (Number(settings.referral?.minFirstSpend) || 0)) return null;

  /** Claim it: whichever event gets here first flips the row, the rest see nothing. */
  const referral = await Referral.findOneAndUpdate(
    { referred: userId, status: 'signed_up' },
    { $set: { status: 'rewarded', rewardedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!referral) return null;

  const reward = referral.rewardAmount || 0;
  const [referred, referrer] = await Promise.all([
    User.findById(referral.referred).select('name'),
    User.findById(referral.referrer).select('name'),
  ]);

  if (reward > 0) {
    const [toReferrer, toReferred] = await Promise.all([
      walletService.post({
        ownerRole: 'user',
        ownerId: referral.referrer,
        direction: 'credit',
        type: 'referral_bonus',
        amount: reward,
        title: 'Referral reward',
        description: `${maskedName(referred?.name)} completed their first ${labelFor(source)}.`,
      }),
      walletService.post({
        ownerRole: 'user',
        ownerId: referral.referred,
        direction: 'credit',
        type: 'referral_bonus',
        amount: reward,
        title: 'Welcome reward',
        description: `For joining through ${maskedName(referrer?.name)}'s referral.`,
      }),
    ]);
    referral.referrerTransaction = toReferrer._id;
    referral.referredTransaction = toReferred._id;
    await referral.save();
  }

  const bonusPoints = Number(settings.loyalty?.referralBonusPoints) || 0;
  if (bonusPoints > 0 && settings.loyalty?.enabled !== false) {
    await loyaltyService.award({
      userId: referral.referrer,
      points: bonusPoints,
      reason: `Referral bonus — ${maskedName(referred?.name)} joined`,
      source: { kind: 'referral', id: referral._id },
      type: 'bonus',
    });
  }

  await Promise.all([
    notificationService.notify({
      ownerRole: 'user',
      ownerId: referral.referrer,
      type: 'referral',
      title: reward > 0 ? `You earned ₹${reward}` : 'Your referral completed',
      body: `${maskedName(referred?.name)} completed their first ${labelFor(source)}. ${reward > 0 ? `₹${reward} is in your wallet.` : ''}`.trim(),
      action: { screen: 'referral' },
    }),
    reward > 0
      ? notificationService.notify({
          ownerRole: 'user',
          ownerId: referral.referred,
          type: 'referral',
          title: `₹${reward} welcome reward`,
          body: 'Thanks for joining through a friend — the reward is in your wallet.',
          action: { screen: 'wallet' },
        })
      : Promise.resolve(),
  ]);

  return referral;
}

function labelFor(source) {
  const kind = source?.kind;
  if (kind === 'order') return 'store order';
  if (kind === 'puja') return 'puja';
  return 'consultation';
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

async function stats(userId) {
  const rows = await Referral.aggregate([
    /** An aggregation `$match` does not cast a string id (see wallet.service's sumCreditsSince). */
    { $match: { referrer: new mongoose.Types.ObjectId(String(userId)) } },
    {
      $group: {
        _id: null,
        invited: { $sum: 1 },
        completed: { $sum: { $cond: [{ $eq: ['$status', 'rewarded'] }, 1, 0] } },
        earned: { $sum: { $cond: [{ $eq: ['$status', 'rewarded'] }, '$rewardAmount', 0] } },
      },
    },
  ]);
  const row = rows[0] || {};
  return { invited: row.invited || 0, completed: row.completed || 0, earned: row.earned || 0 };
}

/** GET /referral */
async function summary(userId) {
  const [code, settings, counts, recentRows] = await Promise.all([
    ensureCode(userId),
    settingsService.get(),
    stats(userId),
    Referral.find({ referrer: userId }).sort({ createdAt: -1 }).limit(10).populate('referred', 'name'),
  ]);
  return {
    code,
    link: linkFor(code),
    rewardAmount: Number(settings.referral?.rewardAmount) || 0,
    minFirstSpend: Number(settings.referral?.minFirstSpend) || 0,
    stats: counts,
    recent: recentRows.map(row => ({
      name: maskedName(row.referred?.name),
      status: row.status,
      at: row.rewardedAt || row.createdAt,
    })),
  };
}

/** The `referral` block on GET /offers. */
async function offersBlock(userId) {
  const { code, link, rewardAmount, stats: counts } = await summary(userId);
  return { code, link, rewardAmount, ...counts };
}

/** What GET /admin/users/:userId adds. */
async function adminStatsFor(userId) {
  const user = await User.findById(userId).select('referralCode referredBy').populate('referredBy', 'name');
  const counts = await stats(userId);
  return {
    code: user?.referralCode ?? null,
    referredBy: user?.referredBy ? { id: String(user.referredBy._id), name: user.referredBy.name } : null,
    ...counts,
  };
}

function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

const escapeRegex = text => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** GET /admin/referrals */
async function adminList({ status, search, page, limit }) {
  const query = {};
  if (status) query.status = status;
  if (search) {
    const pattern = new RegExp(escapeRegex(search), 'i');
    const users = await User.find({
      $or: [{ name: pattern }, { 'phone.number': pattern }, { email: pattern }, { referralCode: pattern }],
    }).select('_id');
    const ids = users.map(user => user._id);
    query.$or = [{ code: pattern }, { referrer: { $in: ids } }, { referred: { $in: ids } }];
  }
  const { skip, limit: size, page: current } = paging({ page, limit });
  const [rows, total] = await Promise.all([
    Referral.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size)
      .populate('referrer', 'name phone email')
      .populate('referred', 'name phone email'),
    Referral.countDocuments(query),
  ]);
  const person = user =>
    user
      ? {
          id: String(user._id),
          name: user.name,
          phone: user.phone?.number ? `${user.phone.countryCode || ''}${user.phone.number}` : undefined,
          email: user.email,
        }
      : null;
  return {
    items: rows.map(row => ({
      id: String(row._id),
      code: row.code,
      status: row.status,
      rewardAmount: row.rewardAmount,
      rewardedAt: row.rewardedAt ?? null,
      referrer: person(row.referrer),
      referred: person(row.referred),
      createdAt: row.createdAt,
    })),
    total,
    page: current,
    limit: size,
  };
}

module.exports = {
  ensureCode,
  applyAtRegistration,
  onQualifyingSpend,
  summary,
  offersBlock,
  stats,
  adminStatsFor,
  adminList,
  maskedName,
  linkFor,
};
