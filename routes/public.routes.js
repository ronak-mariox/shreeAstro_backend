/**
 * /api/v1 — the few things that are not about one account.
 *
 * `/settings` and `/horoscope` are open: the apps read them on the very first
 * launch, before anyone has signed in. `/support` needs a token, because a
 * ticket belongs to whoever raised it.
 */

const express = require('express');

const userController = require('../controllers/user.controller');
const horoscopeController = require('../controllers/horoscope.controller');
const horoscopeValidator = require('../validators/horoscope.validator');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

/** Recharge limits, free trial minutes, feature switches, app versions. */
router.get('/settings', userController.publicSettings);

/** `?sign=Leo` for one, no sign for all twelve plus the planet positions. */
router.get('/horoscope', userController.horoscope);

/** `?sign=leo&day=next|previous` — real AstrologyAPI reading, cached at most 12x/day across the whole app. */
router.get('/horoscope/daily', horoscopeValidator.dailyHoroscope, horoscopeController.getDaily);

/** Support tickets and disputes — both apps file them the same way. */
router.post('/support/tickets', authenticate, authorize('user', 'astrologer'), userController.createTicket);
router.get('/support/tickets', authenticate, authorize('user', 'astrologer'), userController.listTickets);

module.exports = router;
