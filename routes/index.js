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
 *   /panchang       website     today's panchang (AstrologyAPI-backed, cached daily)
 *   /support        both apps   tickets and disputes
 *   /places, /kundli, /birth-profiles   user_app   kundli generation (AstrologyAPI-backed)
 *   /products, /orders, /pujas, /puja-bookings   website + user_app   the store and pujas
 *   /articles       website + user_app   published articles
 *   /offers, /coupons, /loyalty, /referral   website + user_app   discounts, points, refer-a-friend
 *   /reviews, /testimonials, /careers        website              site-wide reviews and hiring
 *   /internal       a scheduler  jobs driven over HTTP where the process holds no timers
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
const internalRoutes = require('./internal.routes');
const commerceRoutes = require('./commerce.routes');
const articleRoutes = require('./article.routes');
const growthRoutes = require('./growth.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/astrologers', directoryRouter);
router.use('/astrologer', selfRouter);
router.use('/chats', chatRoutes);
router.use('/wallet', walletRoutes);
router.use('/notifications', notificationRoutes);
router.use('/admin', adminRoutes);
router.use('/internal', internalRoutes);

/** Settings, horoscope, panchang and support — not tied to one kind of account. */
router.use('/', publicRoutes);
router.use('/', kundliRoutes);

/** The store, pujas and published articles — browsing is open, buying needs a seeker. */
router.use('/', commerceRoutes);
router.use('/', articleRoutes);

/** Offers, points, referrals, reviews and careers — mostly open, the seeker's own parts signed in. */
router.use('/', growthRoutes);

module.exports = router;
