/**
 * The v1 API, one line per area.
 *
 * Each router declares its endpoints, a controller reads the request, and a
 * service holds the rules. Which client uses what:
 *
 *   /auth           all three   sign up, sign in, refresh
 *   /users          user_app    the seeker's own account
 *   /astrologers    user_app    the directory of astrologers to consult
 *   /astrologer     astro_app   what one astrologer manages about themselves
 *   /chats          both apps   consultations
 *   /wallet         both apps   money in and money out
 *   /notifications  both apps   alerts
 *   /admin          admin_panel everything else
 *   /settings       all         limits, feature switches, app versions
 *   /horoscope      user_app    today's reading and the planet positions
 *   /support        both apps   tickets and disputes
 *   /places, /kundli, /birth-profiles   user_app   kundli generation (AstrologyAPI-backed)
 */

const express = require('express');

const authRoutes = require('./auth.routes');
const userRoutes = require('./user.routes');
const { directoryRouter, selfRouter } = require('./astrologer.routes');
const chatRoutes = require('./chat.routes');
const walletRoutes = require('./wallet.routes');
const notificationRoutes = require('./notification.routes');
const adminRoutes = require('./admin.routes');
const publicRoutes = require('./public.routes');
const kundliRoutes = require('./kundli.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/astrologers', directoryRouter);
router.use('/astrologer', selfRouter);
router.use('/chats', chatRoutes);
router.use('/wallet', walletRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);

/** Settings, horoscope and support — not tied to one kind of account. */
router.use('/', publicRoutes);
router.use('/', kundliRoutes);

module.exports = router;
