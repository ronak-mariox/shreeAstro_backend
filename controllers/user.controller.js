/**
 * The seeker's own account, over HTTP.
 *
 * Every handler here reads `req.account.accountId` — the id from the verified
 * token — and never an id from the body or the URL. That is what stops one
 * signed-in user reading or changing another's record.
 */

const userService = require('../services/user.service');
const notificationService = require('../services/notification.service');
const horoscopeService = require('../services/horoscope.service');
const supportService = require('../services/support.service');
const settingsService = require('../services/settings.service');
const asyncHandler = require('../utils/asyncHandler');

/** GET /api/v1/users/me */
const getProfile = asyncHandler(async (req, res) => {
  return res.json({ user: await userService.getProfile(req.account.accountId) });
});

/** PATCH /api/v1/users/me */
const updateProfile = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.account.accountId, {
    ...req.body,
    /**
     * Only when a file actually came with the request — spreading it in
     * unconditionally would blank out a photoUrl sent in the body.
     */
    ...(req.uploadedPhotoUrl ? { photoUrl: req.uploadedPhotoUrl } : {}),
  });
  return res.json({ user });
});

/** PATCH /api/v1/users/me/notification-prefs */
const updateNotificationPrefs = asyncHandler(async (req, res) => {
  const prefs = await userService.updateNotificationPrefs(req.account.accountId, req.body);
  return res.json({ notificationPrefs: prefs });
});

/** GET /api/v1/users/me/home — everything the home screen prints, in one call. */
const getHome = asyncHandler(async (req, res) => {
  return res.json(await userService.getHome(req.account.accountId));
});

/** GET /api/v1/users/me/kundlis */
const listKundlis = asyncHandler(async (req, res) => {
  return res.json({ items: await userService.listKundlis(req.account.accountId) });
});

/** POST /api/v1/users/me/kundlis */
const saveKundli = asyncHandler(async (req, res) => {
  const kundli = await userService.saveKundli(req.account.accountId, req.body);
  return res.status(201).json({ kundli });
});

/** DELETE /api/v1/users/me/kundlis/:kundliId */
const deleteKundli = asyncHandler(async (req, res) => {
  return res.json(await userService.deleteKundli(req.account.accountId, req.params.kundliId));
});

/** GET /api/v1/users/me/favourites */
const listFavourites = asyncHandler(async (req, res) => {
  return res.json({ items: await userService.listFavourites(req.account.accountId) });
});

/** POST /api/v1/users/me/favourites/:astrologerId — adds or removes. */
const toggleFavourite = asyncHandler(async (req, res) => {
  return res.json(
    await userService.toggleFavourite(req.account.accountId, req.params.astrologerId),
  );
});

/**
 * GET /api/v1/notifications
 *
 * Shared by both apps — the role on the token decides whose notifications
 * come back, so neither app needs its own copy of this.
 */
const listNotifications = asyncHandler(async (req, res) => {
  const result = await notificationService.list({
    ownerRole: req.account.role,
    ownerId: req.account.accountId,
    page: req.query.page,
    limit: req.query.limit,
  });
  return res.json(result);
});

/** POST /api/v1/notifications/read — one, or all when no id is sent. */
const markNotificationsRead = asyncHandler(async (req, res) => {
  const result = await notificationService.markRead({
    ownerRole: req.account.role,
    ownerId: req.account.accountId,
    notificationId: req.body.notificationId,
  });
  return res.json(result);
});

/* --------------------------------------------------------------- shared */

/**
 * GET /api/v1/horoscope — today's reading.
 *
 * `?sign=Leo` for one sign, no sign for all twelve. Open to anyone: the home
 * screen shows a reading before an account is even created.
 */
const horoscope = asyncHandler(async (req, res) => {
  const { sign } = req.query;

  if (sign) {
    return res.json({ horoscope: horoscopeService.dailyFor(sign) });
  }
  return res.json({
    items: horoscopeService.dailyForAll(),
    planetPositions: horoscopeService.planetPositions(),
  });
});

/** GET /api/v1/settings — the handful of settings the apps are allowed to read. */
const publicSettings = asyncHandler(async (req, res) => {
  return res.json({ settings: await settingsService.publicSettings() });
});

/** POST /api/v1/support/tickets — raise a support request or a dispute. */
const createTicket = asyncHandler(async (req, res) => {
  const ticket = await supportService.create({
    ownerRole: req.account.role,
    ownerId: req.account.accountId,
    issueType: req.body.issueType,
    description: req.body.description,
    chatSession: req.body.chatId,
  });

  return res.status(201).json({
    ticket: {
      id: String(ticket._id),
      reference: ticket.reference,
      status: ticket.status,
      createdAt: ticket.createdAt,
    },
  });
});

/** GET /api/v1/support/tickets — the tickets this account has raised. */
const listTickets = asyncHandler(async (req, res) => {
  return res.json(
    await supportService.listMine({
      ownerRole: req.account.role,
      ownerId: req.account.accountId,
      page: req.query.page,
      limit: req.query.limit,
    }),
  );
});

module.exports = {
  getProfile,
  getHome,
  horoscope,
  publicSettings,
  createTicket,
  listTickets,
  updateProfile,
  updateNotificationPrefs,
  listKundlis,
  saveKundli,
  deleteKundli,
  listFavourites,
  toggleFavourite,
  listNotifications,
  markNotificationsRead,
};
