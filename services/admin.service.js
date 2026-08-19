/**
 * Everything the admin panel does.
 *
 * Admins read across all the collections and approve things, so this file is
 * mostly listing with filters, plus the handful of decisions only an admin can
 * make: approving an astrologer, approving a price change, paying out a
 * withdrawal, blocking an account.
 *
 * Every one of those decisions writes an audit row — see services/audit.service.js.
 */

const User = require('../models/User');
const Astrologer = require('../models/Astrologer');
const AstrologerProfile = require('../models/AstrologerProfile');
const { ChatSession } = require('../models/Chat');
const WalletTransaction = require('../models/WalletTransaction');
const Withdrawal = require('../models/Withdrawal');
const Article = require('../models/Article');
const Admin = require('../models/Admin');
const ApiError = require('../utils/ApiError');
const walletService = require('./wallet.service');
const notificationService = require('./notification.service');
const settingsService = require('./settings.service');

/** Turns `page`/`limit` into what Mongo wants. */
function paging({ page = 1, limit = 20 }) {
  const size = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  return { skip: (current - 1) * size, limit: size, page: current };
}

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

/** The four tiles, the charts, and what is running right now. */
async function getDashboard() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [
    totalUsers,
    newUsersThisMonth,
    activeAstrologers,
    pendingApplications,
    consultationsToday,
    ongoing,
    revenue,
  ] = await Promise.all([
    User.countDocuments({ status: 'active' }),
    User.countDocuments({ status: 'active', createdAt: { $gte: startOfMonth } }),
    Astrologer.countDocuments({ applicationStatus: 'approved', status: 'active' }),
    Astrologer.countDocuments({ applicationStatus: 'under_review' }),
    ChatSession.countDocuments({ createdAt: { $gte: startOfToday } }),
    ChatSession.countDocuments({ status: 'active' }),
    /** Revenue is the platform's cut, not the whole charge. */
    ChatSession.aggregate([
      { $match: { status: 'ended', endedAt: { $gte: startOfMonth } } },
      {
        $group: {
          _id: null,
          charged: { $sum: '$billing.amountCharged' },
          paidOut: { $sum: '$billing.astrologerEarning' },
        },
      },
    ]),
  ]);

  const money = revenue[0] || { charged: 0, paidOut: 0 };

  return {
    users: { total: totalUsers, newThisMonth: newUsersThisMonth },
    astrologers: { active: activeAstrologers, pendingApplications },
    consultations: { today: consultationsToday, ongoing },
    revenue: {
      chargedThisMonth: money.charged,
      paidToAstrologers: money.paidOut,
      platformThisMonth: money.charged - money.paidOut,
    },
  };
}

/** Consultations per day for the last `days` days, split by channel. */
async function getConsultationMix(days = 7) {
  const from = new Date();
  from.setDate(from.getDate() - days + 1);
  from.setHours(0, 0, 0, 0);

  return ChatSession.aggregate([
    { $match: { createdAt: { $gte: from } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          channel: '$channel',
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.day': 1 } },
  ]);
}

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

async function listUsers({ search, status, page, limit }) {
  const query = {};
  if (status) {
    query.status = status;
  }
  if (search) {
    const term = String(search).trim();
    query.$or = [
      { name: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
      { 'phone.number': { $regex: term } },
    ];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [rows, total] = await Promise.all([
    User.find(query).sort({ createdAt: -1 }).skip(skip).limit(size),
    User.countDocuments(query),
  ]);

  return {
    items: rows.map(user => ({
      id: String(user._id),
      userCode: user.userCode,
      name: user.name,
      email: user.email,
      phone: user.phone?.number,
      signup: user.authProvider,
      joined: user.createdAt,
      lastActive: user.lastActiveAt,
      consults: user.stats?.consultations || 0,
      kundlis: user.stats?.kundlis || 0,
      spent: user.wallet?.totalSpent || 0,
      wallet: user.wallet?.balance || 0,
      status: user.status,
      verified: user.isVerified,
    })),
    total,
    page: current,
    limit: size,
  };
}

/**
 * One seeker, with everything the panel's drawer prints: their birth details,
 * how many charts they have saved, and their last few consultations.
 */
async function getUserDetail(userId) {
  const UserProfile = require('../models/UserProfile');

  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found.');
  }

  const [profile, consultations] = await Promise.all([
    UserProfile.findOne({ user: userId }),
    ChatSession.find({ user: userId, type: 'consultation' })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('astrologer', 'name'),
  ]);

  return {
    id: String(user._id),
    userCode: user.userCode,
    name: user.name,
    email: user.email,
    phone: user.phone?.number,
    countryCode: user.phone?.countryCode,
    signup: user.authProvider,
    joined: user.createdAt,
    lastActive: user.lastActiveAt,
    status: user.status,
    blocked: user.blocked,
    verified: user.isVerified,
    isPhoneVerified: user.isPhoneVerified,
    isEmailVerified: user.isEmailVerified,
    wallet: user.wallet,
    stats: user.stats,
    freeConsultation: user.freeConsultation,
    gender: profile?.gender,
    birthDetails: profile?.birthDetails,
    zodiac: profile?.zodiac,
    kundlis: profile?.savedKundlis?.length || 0,
    consultations: consultations.map(chat => ({
      id: String(chat._id),
      astrologer: chat.astrologer?.name,
      channel: chat.channel,
      status: chat.status,
      durationSeconds: chat.durationSeconds,
      amount: chat.billing?.amountCharged,
      at: chat.endedAt || chat.createdAt,
    })),
  };
}

/** Blocks or unblocks a seeker. */
async function setUserStatus({ userId, status, reason, admin }) {
  if (!['active', 'blocked'].includes(status)) {
    throw ApiError.badRequest('Status must be "active" or "blocked".');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw ApiError.notFound('User not found.');
  }

  user.status = status;
  user.blocked = status === 'blocked'
    ? { reason, at: new Date(), by: admin._id }
    : { reason: undefined, at: undefined, by: undefined };
  await user.save();

  return user;
}

/* -------------------------------------------------------------------------- */
/* Astrologers                                                                */
/* -------------------------------------------------------------------------- */

async function listAstrologers({ search, applicationStatus, status, page, limit }) {
  const query = {};
  if (applicationStatus) {
    query.applicationStatus = applicationStatus;
  }
  if (status) {
    query.status = status;
  }
  if (search) {
    const term = String(search).trim();
    query.$or = [
      { name: { $regex: term, $options: 'i' } },
      { email: { $regex: term, $options: 'i' } },
      { 'phone.number': { $regex: term } },
    ];
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [rows, total] = await Promise.all([
    Astrologer.find(query).sort({ createdAt: -1 }).skip(skip).limit(size),
    Astrologer.countDocuments(query),
  ]);

  return {
    items: rows.map(astrologer => ({
      id: String(astrologer._id),
      astroCode: astrologer.astroCode,
      name: astrologer.name,
      email: astrologer.email,
      phone: astrologer.phone?.number,
      expertise: astrologer.expertise || [],
      languages: astrologer.languages || [],
      experienceYears: astrologer.experienceYears,
      rating: astrologer.metrics?.rating || 0,
      consultations: astrologer.metrics?.totalConsultations || 0,
      earnings: astrologer.earnings?.lifetime || 0,
      commissionPercent: astrologer.commissionPercent,
      applicationStatus: astrologer.applicationStatus,
      status: astrologer.status,
      online: astrologer.presence?.isOnline,
      joined: astrologer.createdAt,
    })),
    total,
    page: current,
    limit: size,
  };
}

/**
 * Creates an astrologer account from the panel.
 *
 * This is the short form: an **email address**, the **platform commission**,
 * their **availability** and whether they are **listed or blocked**. Nothing
 * else is asked for, because the astrologer fills the rest in themselves — name,
 * phone, photo, languages, expertise, experience, about and their rates — from
 * the profile screen in their own app.
 *
 * The email is the login identity: they sign in with a code sent to it, and
 * `applicationStatus` is already `approved`, so there is no application to
 * review. They just cannot take work until they have set up a rate, which the
 * directory enforces on its own (`canAcceptRequest` needs an enabled service).
 *
 * `name` is seeded from the email so listings have something to print until the
 * astrologer sets their real one.
 */
async function createAstrologer({ email, commissionPercent, availability, status = 'approved', admin }) {
  const normalisedEmail = String(email || '').trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(normalisedEmail)) {
    throw ApiError.badRequest('Enter a valid email address.', { email: 'Enter a valid email address.' });
  }
  if (!['approved', 'blocked'].includes(status)) {
    throw ApiError.badRequest('Status must be "approved" or "blocked".', {
      status: 'Pick approved or blocked.',
    });
  }

  const taken = await Astrologer.findOne({ email: normalisedEmail });
  if (taken) {
    throw ApiError.conflict('An astrologer already exists with this email.', {
      email: 'Already in use.',
    });
  }

  const settings = await settingsService.get();
  const commission =
    commissionPercent === undefined || commissionPercent === ''
      ? settings.commissionPercent
      : Number(commissionPercent);

  if (!(commission >= 0 && commission <= 100)) {
    throw ApiError.badRequest('Commission must be between 0 and 100.', {
      commissionPercent: 'Between 0 and 100.',
    });
  }

  /** "rajesh.sharma@x.com" -> "Rajesh Sharma", until they set their own. */
  const placeholderName = normalisedEmail
    .split('@')[0]
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase())
    .slice(0, 80);

  const astrologer = await Astrologer.create({
    name: placeholderName,
    email: normalisedEmail,
    commissionPercent: commission,
    availabilityNote: availability ? String(availability).trim() : undefined,
    applicationStatus: 'approved',
    status: status === 'blocked' ? 'blocked' : 'active',
    approval: { at: new Date(), by: admin._id },
    createdVia: 'admin',
    createdBy: admin._id,
    /** Nothing to walk through — they complete the profile, not a wizard. */
    onboardingStep: 0,
  });

  /** "20260819" + 4 digits, as the app prints it. */
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  astrologer.astroCode = `${stamp}${Math.floor(1000 + Math.random() * 9000)}`;
  await astrologer.save();

  const profile = await AstrologerProfile.create({ astrologer: astrologer._id });
  astrologer.profile = profile._id;
  await astrologer.save();

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologer._id,
    type: 'application',
    title: 'Your astrologer account is ready',
    body: 'Sign in with this email and complete your profile to start taking consultations.',
    action: { screen: 'profileEdit' },
  });

  return astrologer;
}

/** One application, with everything an admin needs to decide on it. */
async function getAstrologerDetail(astrologerId) {
  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('Astrologer not found.');
  }

  const profile = await AstrologerProfile.findOne({ astrologer: astrologerId });

  return {
    astrologer,
    profile,
    documents: profile?.documents || [],
    bankAccounts: profile?.bankAccounts || [],
    priceChangeRequests: profile?.priceChangeRequests || [],
  };
}

/**
 * Approves an application.
 *
 * Approval is what gives an astrologer their astro code and their opening
 * rates, and it is the moment they become visible in the seeker's directory.
 */
async function approveAstrologer({ astrologerId, admin, services = [], commissionPercent }) {
  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('Astrologer not found.');
  }
  if (astrologer.applicationStatus === 'approved') {
    throw ApiError.badRequest('This application is already approved.');
  }

  astrologer.applicationStatus = 'approved';
  astrologer.approval = { at: new Date(), by: admin._id };

  if (!astrologer.astroCode) {
    /** e.g. "20260819" + 4 random digits, as the app prints it. */
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    astrologer.astroCode = `${stamp}${Math.floor(1000 + Math.random() * 9000)}`;
  }
  if (commissionPercent !== undefined) {
    astrologer.commissionPercent = Number(commissionPercent);
  }

  /** Opening rates. Without at least one service they cannot take work. */
  if (services.length) {
    astrologer.services = services.map(service => ({
      type: service.type,
      isEnabled: service.isEnabled !== false,
      ratePerMinute: Number(service.ratePerMinute),
      offerPercent: Number(service.offerPercent) || 0,
      freeMinutes: Number(service.freeMinutes) || 0,
    }));
  }

  await astrologer.save();

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologer._id,
    type: 'application',
    title: 'Your application is approved',
    body: 'You can now go online and take consultations.',
    action: { screen: 'dashboard' },
  });

  return astrologer;
}

/** Turns an application down, with a reason the app shows back. */
async function rejectAstrologer({ astrologerId, admin, reason }) {
  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('Astrologer not found.');
  }

  astrologer.applicationStatus = 'rejected';
  astrologer.approval = { at: new Date(), by: admin._id, rejectionReason: reason };
  await astrologer.save();

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologer._id,
    type: 'application',
    title: 'Your application was not approved',
    body: reason || 'Please check your documents and apply again.',
  });

  return astrologer;
}

/** Blocks or unblocks an astrologer. A blocked one drops out of the directory. */
async function setAstrologerStatus({ astrologerId, status, reason, admin }) {
  if (!['active', 'blocked'].includes(status)) {
    throw ApiError.badRequest('Status must be "active" or "blocked".');
  }

  const astrologer = await Astrologer.findById(astrologerId);
  if (!astrologer) {
    throw ApiError.notFound('Astrologer not found.');
  }

  astrologer.status = status;
  astrologer.blocked = status === 'blocked'
    ? { reason, at: new Date(), by: admin._id }
    : { reason: undefined, at: undefined, by: undefined };
  if (status === 'blocked') {
    astrologer.presence.isOnline = false;
  }
  await astrologer.save();

  return astrologer;
}

/** Approves or rejects one filed document. */
async function reviewDocument({ astrologerId, documentId, status, reason, admin }) {
  const profile = await AstrologerProfile.findOne({ astrologer: astrologerId });
  const document = profile?.documents.id(documentId);
  if (!document) {
    throw ApiError.notFound('Document not found.');
  }

  document.status = status;
  document.rejectionReason = status === 'rejected' ? reason : undefined;
  document.reviewedAt = new Date();
  document.reviewedBy = admin._id;
  await profile.save();

  return document;
}

/** Approves or rejects one filed bank account. */
async function reviewBankAccount({ astrologerId, accountId, status, reason, admin }) {
  const profile = await AstrologerProfile.findOne({ astrologer: astrologerId });
  const account = profile?.bankAccounts.id(accountId);
  if (!account) {
    throw ApiError.notFound('Bank account not found.');
  }

  account.status = status;
  account.rejectionReason = status === 'rejected' ? reason : undefined;
  account.reviewedAt = new Date();
  account.reviewedBy = admin._id;
  await profile.save();

  return account;
}

/**
 * Decides a price change. Approving it writes the new rate onto the service —
 * this is the only way a rate ever changes.
 */
async function reviewPriceChange({ astrologerId, requestId, status, reason, admin }) {
  const profile = await AstrologerProfile.findOne({ astrologer: astrologerId });
  const request = profile?.priceChangeRequests.id(requestId);
  if (!request) {
    throw ApiError.notFound('Price change request not found.');
  }
  if (request.status !== 'pending') {
    throw ApiError.badRequest('That request has already been decided.');
  }

  request.status = status;
  request.rejectionReason = status === 'rejected' ? reason : undefined;
  request.reviewedAt = new Date();
  request.reviewedBy = admin._id;
  await profile.save();

  if (status === 'approved') {
    const astrologer = await Astrologer.findById(astrologerId);
    const targets = request.applyToAll
      ? astrologer.services
      : astrologer.services.filter(service => service.type === request.service);

    for (const service of targets) {
      service.ratePerMinute = request.requestedRate;
      service.offerPercent = request.offerPercent;
    }
    await astrologer.save();
  }

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: astrologerId,
    type: 'system',
    title: status === 'approved' ? 'Price change approved' : 'Price change rejected',
    body: status === 'approved'
      ? `Your ${request.service} rate is now ₹${request.requestedRate}/min.`
      : reason || 'Your requested rate was not approved.',
  });

  return request;
}

/* -------------------------------------------------------------------------- */
/* Consultations, payments, wallets                                           */
/* -------------------------------------------------------------------------- */

async function listConsultations({ status, channel, page, limit }) {
  const query = {};
  if (status) {
    query.status = status;
  }
  if (channel) {
    query.channel = channel;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [rows, total] = await Promise.all([
    ChatSession.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(size)
      .populate('user', 'name')
      .populate('astrologer', 'name'),
    ChatSession.countDocuments(query),
  ]);

  return {
    items: rows.map(chat => ({
      id: String(chat._id),
      user: chat.user?.name,
      astrologer: chat.astrologer?.name,
      channel: chat.channel,
      topic: chat.intake?.topic,
      started: chat.startedAt,
      durationSeconds: chat.durationSeconds,
      rate: chat.billing?.ratePerMinute,
      amount: chat.billing?.amountCharged,
      status: chat.status,
      rating: chat.review?.rating ?? null,
    })),
    total,
    page: current,
    limit: size,
  };
}

/**
 * One consultation, with the transcript.
 *
 * Reading a transcript is a real intrusion into somebody's private
 * conversation, so it is deliberately not part of the listing — an admin has to
 * open a specific session, and that read is what the audit log records.
 */
async function getConsultationDetail(chatId, { messageLimit = 50 } = {}) {
  const { Message } = require('../models/Chat');

  const chat = await ChatSession.findById(chatId)
    .populate('user', 'name email wallet avatarUrl')
    .populate('astrologer', 'name email photoUrl commissionPercent');

  if (!chat) {
    throw ApiError.notFound('Consultation not found.');
  }

  const messages = await Message.find({ chatId: chat._id, isDeleted: false })
    .sort({ seq: 1 })
    .limit(Number(messageLimit));

  const charged = chat.billing?.amountCharged || 0;
  const earned = chat.billing?.astrologerEarning || 0;

  return {
    id: String(chat._id),
    type: chat.type,
    channel: chat.channel,
    status: chat.status,
    topic: chat.intake?.topic,
    question: chat.intake?.question,
    birthDetails: chat.intake?.birthDetails,
    user: chat.user
      ? {
          id: String(chat.user._id),
          name: chat.user.name,
          email: chat.user.email,
          walletBalance: chat.user.wallet?.balance || 0,
        }
      : null,
    astrologer: chat.astrologer
      ? {
          id: String(chat.astrologer._id),
          name: chat.astrologer.name,
          email: chat.astrologer.email,
        }
      : null,
    billing: {
      ratePerMinute: chat.billing?.ratePerMinute || 0,
      freeMinutes: chat.billing?.freeMinutes || 0,
      commissionPercent: chat.billing?.commissionPercent || 0,
      amountCharged: charged,
      astrologerEarning: earned,
      platformEarning: charged - earned,
    },
    requestedAt: chat.requestedAt,
    startedAt: chat.startedAt,
    endedAt: chat.endedAt,
    endedBy: chat.endedBy,
    endReason: chat.endReason,
    durationSeconds: chat.durationSeconds,
    review: chat.review?.rating ? chat.review : null,
    messageCount: chat.messageSeq,
    messages: messages.map(message => ({
      id: String(message._id),
      from: message.senderRole,
      type: message.type,
      text: message.content?.text,
      at: message.createdAt,
    })),
  };
}

async function listTransactions({ type, status, ownerRole, page, limit }) {
  const query = {};
  if (type) {
    query.type = type;
  }
  if (status) {
    query.status = status;
  }
  if (ownerRole) {
    query.ownerRole = ownerRole;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [items, total] = await Promise.all([
    WalletTransaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(size),
    WalletTransaction.countDocuments(query),
  ]);

  return { items, total, page: current, limit: size };
}

/**
 * Refunds a consultation charge back to the seeker's wallet.
 *
 * A refund is a new credit row, never an edit to the original charge — the
 * ledger is a history, and history does not change.
 */
async function refundTransaction({ transactionId, admin, reason }) {
  const original = await WalletTransaction.findById(transactionId);
  if (!original) {
    throw ApiError.notFound('Transaction not found.');
  }
  if (original.direction !== 'debit' || original.status !== 'success') {
    throw ApiError.badRequest('Only a successful debit can be refunded.');
  }

  const already = await WalletTransaction.findOne({
    type: 'refund',
    owner: original.owner,
    chatSession: original.chatSession,
  });
  if (already) {
    throw ApiError.conflict('That charge has already been refunded.');
  }

  return walletService.post({
    ownerRole: original.ownerRole,
    ownerId: original.owner,
    direction: 'credit',
    type: 'refund',
    amount: original.amount,
    title: 'Refund',
    description: reason,
    chatSession: original.chatSession,
    createdByAdmin: admin._id,
  });
}

async function listWithdrawals({ status, page, limit }) {
  const query = {};
  if (status) {
    query.status = status;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [items, total] = await Promise.all([
    Withdrawal.find(query)
      .sort({ requestedAt: -1 })
      .skip(skip)
      .limit(size)
      .populate('astrologer', 'name astroCode'),
    Withdrawal.countDocuments(query),
  ]);

  return { items, total, page: current, limit: size };
}

/**
 * Decides a payout.
 *
 * The money left the withdrawable balance when the request was made, so
 * approving only records the transfer, and rejecting is what puts it back.
 */
async function reviewWithdrawal({ withdrawalId, status, admin, reason, payoutReference }) {
  const withdrawal = await Withdrawal.findById(withdrawalId);
  if (!withdrawal) {
    throw ApiError.notFound('Withdrawal not found.');
  }
  if (withdrawal.status !== 'pending') {
    throw ApiError.badRequest('That request has already been decided.');
  }

  withdrawal.status = status;
  withdrawal.reviewedAt = new Date();
  withdrawal.reviewedBy = admin._id;

  if (status === 'rejected') {
    withdrawal.rejectionReason = reason;

    await Astrologer.updateOne(
      { _id: withdrawal.astrologer },
      {
        $inc: {
          'earnings.balance': withdrawal.amount,
          'earnings.pendingWithdrawal': -withdrawal.amount,
        },
      },
    );
  } else {
    withdrawal.status = 'paid';
    withdrawal.paidAt = new Date();
    withdrawal.payoutReference = payoutReference;

    await Astrologer.updateOne(
      { _id: withdrawal.astrologer },
      {
        $inc: {
          'earnings.pendingWithdrawal': -withdrawal.amount,
          'earnings.totalWithdrawn': withdrawal.amount,
        },
      },
    );

    await WalletTransaction.create({
      ownerRole: 'astrologer',
      owner: withdrawal.astrologer,
      direction: 'debit',
      type: 'withdrawal',
      status: 'success',
      amount: withdrawal.amount,
      title: 'Withdrawal paid out',
      createdByAdmin: admin._id,
    });
  }

  await withdrawal.save();

  await notificationService.notify({
    ownerRole: 'astrologer',
    ownerId: withdrawal.astrologer,
    type: 'withdrawal',
    title: status === 'rejected' ? 'Withdrawal rejected' : 'Withdrawal paid',
    body: status === 'rejected'
      ? reason || 'Your withdrawal request was not approved.'
      : `₹${withdrawal.amount} has been sent to your bank account.`,
  });

  return withdrawal;
}

/**
 * Every wallet on the platform in one table — seekers and astrologers together,
 * which is what the panel's Wallets page shows.
 *
 * Two collections, so they are read separately and merged. Sorted by balance
 * because the page is about where the money is sitting.
 */
async function listWallets({ ownerRole, search, page = 1, limit = 25 }) {
  const { skip, limit: size, page: current } = paging({ page, limit });

  const nameFilter = search ? { name: { $regex: String(search).trim(), $options: 'i' } } : {};

  const [users, astrologers] = await Promise.all([
    ownerRole === 'astrologer'
      ? []
      : User.find(nameFilter).select('name email wallet').lean(),
    ownerRole === 'user'
      ? []
      : Astrologer.find(nameFilter).select('name email earnings astroCode').lean(),
  ]);

  const rows = [
    ...users.map(user => ({
      id: String(user._id),
      ownerRole: 'user',
      holder: user.name,
      email: user.email,
      balance: user.wallet?.balance || 0,
      added: user.wallet?.totalAdded || 0,
      spent: user.wallet?.totalSpent || 0,
      updatedAt: user.wallet?.lastTransactionAt,
    })),
    ...astrologers.map(astrologer => ({
      id: String(astrologer._id),
      ownerRole: 'astrologer',
      holder: astrologer.name,
      email: astrologer.email,
      code: astrologer.astroCode,
      balance: astrologer.earnings?.balance || 0,
      added: astrologer.earnings?.lifetime || 0,
      spent: astrologer.earnings?.totalWithdrawn || 0,
      pending: astrologer.earnings?.pendingWithdrawal || 0,
    })),
  ].sort((a, b) => b.balance - a.balance);

  return { items: rows.slice(skip, skip + size), total: rows.length, page: current, limit: size };
}

/**
 * A manual credit or debit made by an admin.
 *
 * Goes through the same `post()` every other movement uses, so it lands in the
 * ledger like anything else and the running balance stays correct. The row
 * carries `createdByAdmin`, so a hand-made adjustment is always traceable to
 * the person who made it.
 */
async function adjustWallet({ ownerRole, ownerId, direction, amount, reason, admin }) {
  if (!['user', 'astrologer'].includes(ownerRole)) {
    throw ApiError.badRequest('Pick a user or an astrologer.');
  }
  if (!['credit', 'debit'].includes(direction)) {
    throw ApiError.badRequest('Direction must be "credit" or "debit".');
  }
  if (!reason || String(reason).trim().length < 3) {
    throw ApiError.badRequest('Say why this adjustment is being made.', {
      reason: 'A reason is required.',
    });
  }

  return walletService.post({
    ownerRole,
    ownerId,
    direction,
    type: 'adjustment',
    amount,
    title: direction === 'credit' ? 'Manual credit' : 'Manual debit',
    description: String(reason).trim(),
    createdByAdmin: admin._id,
  });
}

/* -------------------------------------------------------------------------- */
/* The admin team                                                             */
/* -------------------------------------------------------------------------- */

/** The Settings page's Admin team tab. */
async function listAdmins({ role, status, page = 1, limit = 25 }) {
  const query = {};
  if (role) query.role = role;
  if (status) query.status = status;

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [rows, total] = await Promise.all([
    Admin.find(query).sort({ createdAt: -1 }).skip(skip).limit(size),
    Admin.countDocuments(query),
  ]);

  return {
    items: rows.map(admin => ({
      id: String(admin._id),
      name: admin.name,
      email: admin.email,
      role: admin.role,
      status: admin.status,
      permissions: admin.permissions,
      lastActive: admin.lastActiveAt,
      lastLoginAt: admin.lastLoginAt,
      createdAt: admin.createdAt,
    })),
    total,
    page: current,
    limit: size,
  };
}

/**
 * Adds a colleague.
 *
 * A temporary password is generated and returned **once**, in this response —
 * it is stored only as a hash, so it cannot be read back later. Hand it over
 * and let them change it. `mustChangePassword` marks the account so the panel
 * can force that on first sign-in.
 */
async function createAdmin({ name, email, role, admin }) {
  const { hashPassword } = require('../utils/password');
  const normalisedEmail = String(email || '').trim().toLowerCase();

  if (!/^\S+@\S+\.\S+$/.test(normalisedEmail)) {
    throw ApiError.badRequest('Enter a valid email address.', { email: 'Enter a valid email.' });
  }
  if (!Admin.ROLES.includes(role)) {
    throw ApiError.badRequest('Pick a valid role.', { role: 'Unknown role.' });
  }
  if (await Admin.findOne({ email: normalisedEmail })) {
    throw ApiError.conflict('An admin already exists with this email.', {
      email: 'Already in use.',
    });
  }

  const temporaryPassword = `Sa-${Math.random().toString(36).slice(2, 10)}!`;

  const created = await Admin.create({
    name: String(name || '').trim() || normalisedEmail.split('@')[0],
    email: normalisedEmail,
    role,
    passwordHash: await hashPassword(temporaryPassword),
    mustChangePassword: true,
    status: 'active',
    createdBy: admin._id,
  });

  return { admin: created, temporaryPassword };
}

/** Changes a colleague's role, or suspends them. */
async function updateAdmin({ adminId, changes, admin }) {
  if (String(adminId) === String(admin._id) && changes.status && changes.status !== 'active') {
    throw ApiError.badRequest('You cannot suspend your own account.');
  }

  const target = await Admin.findById(adminId);
  if (!target) {
    throw ApiError.notFound('Admin not found.');
  }

  if (changes.role) {
    if (!Admin.ROLES.includes(changes.role)) {
      throw ApiError.badRequest('Pick a valid role.', { role: 'Unknown role.' });
    }
    target.role = changes.role;
  }
  if (changes.status) {
    target.status = changes.status;
  }
  if (changes.name) {
    target.name = String(changes.name).trim();
  }
  /** Bumping this invalidates every token the account is currently holding. */
  if (changes.signOutEverywhere) {
    target.tokenVersion += 1;
  }

  await target.save();
  return target;
}

/**
 * Revokes access.
 *
 * The record is suspended rather than deleted, because audit rows point at it
 * and a log that names a missing admin is worth less.
 */
async function revokeAdmin({ adminId, admin }) {
  if (String(adminId) === String(admin._id)) {
    throw ApiError.badRequest('You cannot revoke your own access.');
  }

  const target = await Admin.findById(adminId);
  if (!target) {
    throw ApiError.notFound('Admin not found.');
  }

  target.status = 'suspended';
  target.tokenVersion += 1;
  await target.save();

  return target;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The Reports page: how the platform did over a window of days.
 *
 * All of it is counted from the data rather than stored, so the numbers cannot
 * drift out of step with what actually happened.
 */
async function getReports({ days = 30 }) {
  const from = new Date();
  from.setDate(from.getDate() - Number(days) + 1);
  from.setHours(0, 0, 0, 0);

  const [newUsers, newAstrologers, sessions, signupSplit, topicSplit, topAstrologers, money] =
    await Promise.all([
      User.countDocuments({ createdAt: { $gte: from } }),
      Astrologer.countDocuments({ createdAt: { $gte: from } }),
      ChatSession.aggregate([
        { $match: { createdAt: { $gte: from } } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
            sessions: { $sum: 1 },
            minutes: { $sum: { $ceil: { $divide: ['$durationSeconds', 60] } } },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: from } } },
        { $group: { _id: '$authProvider', count: { $sum: 1 } } },
      ]),
      ChatSession.aggregate([
        { $match: { createdAt: { $gte: from }, 'intake.topic': { $ne: null } } },
        { $group: { _id: '$intake.topic', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      ChatSession.aggregate([
        { $match: { status: 'ended', endedAt: { $gte: from } } },
        {
          $group: {
            _id: '$astrologer',
            consultations: { $sum: 1 },
            earned: { $sum: '$billing.astrologerEarning' },
          },
        },
        { $sort: { earned: -1 } },
        { $limit: 10 },
      ]),
      ChatSession.aggregate([
        { $match: { status: 'ended', endedAt: { $gte: from } } },
        {
          $group: {
            _id: null,
            consultations: { $sum: 1 },
            minutes: { $sum: { $ceil: { $divide: ['$durationSeconds', 60] } } },
            collected: { $sum: '$billing.amountCharged' },
            paidOut: { $sum: '$billing.astrologerEarning' },
          },
        },
      ]),
    ]);

  /** The top-astrologer rows carry ids; the page wants names. */
  const names = await Astrologer.find({ _id: { $in: topAstrologers.map(row => row._id) } })
    .select('name')
    .lean();
  const nameOf = Object.fromEntries(names.map(row => [String(row._id), row.name]));

  const totals = money[0] || { consultations: 0, minutes: 0, collected: 0, paidOut: 0 };

  return {
    windowDays: Number(days),
    from,
    newUsers,
    newAstrologers,
    activityTrend: sessions.map(row => ({
      date: row._id,
      sessions: row.sessions,
      minutes: row.minutes,
    })),
    signupSplit: signupSplit.map(row => ({ provider: row._id || 'otp', count: row.count })),
    topicSplit: topicSplit.map(row => ({ topic: row._id, count: row.count })),
    topAstrologers: topAstrologers.map(row => ({
      id: String(row._id),
      name: nameOf[String(row._id)] || 'Unknown',
      consultations: row.consultations,
      earned: row.earned,
    })),
    summary: {
      consultations: totals.consultations,
      consultationMinutes: totals.minutes,
      grossCollections: totals.collected,
      astrologerPayouts: totals.paidOut,
      platformRevenue: totals.collected - totals.paidOut,
    },
  };
}

/**
 * An admin ends a session that is stuck or being abused.
 *
 * It runs through the ordinary end-a-chat path, so the seeker is still charged
 * for the time that actually elapsed and the astrologer is still paid — ending
 * it from here is not the same as cancelling it.
 */
async function endConsultation({ chatId, admin, reason }) {
  const chatService = require('./chat.service');
  const chat = await ChatSession.findById(chatId);

  if (!chat) {
    throw ApiError.notFound('Consultation not found.');
  }
  if (chat.status !== 'active') {
    throw ApiError.badRequest(`That consultation is already ${chat.status}.`);
  }

  return chatService.endChat({
    chatId,
    /** The seeker's id passes the participant check; `endedBy` records the truth. */
    accountId: chat.user,
    endedBy: 'system',
    reason: reason || `Ended by ${admin.name}`,
  });
}

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

async function listArticles({ category, status, page, limit }) {
  const query = {};
  if (category && category !== 'All') {
    query.category = category;
  }
  if (status) {
    query.status = status;
  }

  const { skip, limit: size, page: current } = paging({ page, limit });

  const [items, total] = await Promise.all([
    Article.find(query).sort({ updatedAt: -1 }).skip(skip).limit(size),
    Article.countDocuments(query),
  ]);

  return { items, total, page: current, limit: size };
}

async function saveArticle({ articleId, changes, admin }) {
  if (changes.status === 'published' && !changes.publishedAt) {
    changes.publishedAt = new Date();
  }

  if (articleId) {
    const article = await Article.findByIdAndUpdate(
      articleId,
      { $set: { ...changes, updatedBy: admin._id } },
      { returnDocument: 'after' },
    );
    if (!article) {
      throw ApiError.notFound('Article not found.');
    }
    return article;
  }

  return Article.create({ ...changes, createdBy: admin._id, updatedBy: admin._id });
}

async function deleteArticle(articleId) {
  const article = await Article.findByIdAndDelete(articleId);
  if (!article) {
    throw ApiError.notFound('Article not found.');
  }
  return { deleted: true };
}

module.exports = {
  getDashboard,
  createAstrologer,
  getConsultationMix,
  listUsers,
  getUserDetail,
  setUserStatus,
  listAstrologers,
  getAstrologerDetail,
  approveAstrologer,
  rejectAstrologer,
  setAstrologerStatus,
  reviewDocument,
  reviewBankAccount,
  reviewPriceChange,
  listConsultations,
  getConsultationDetail,
  listTransactions,
  refundTransaction,
  listWithdrawals,
  reviewWithdrawal,
  listArticles,
  saveArticle,
  deleteArticle,
  listWallets,
  adjustWallet,
  listAdmins,
  createAdmin,
  updateAdmin,
  revokeAdmin,
  getReports,
  endConsultation,
};
