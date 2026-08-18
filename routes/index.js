/**
 * The v1 API surface: one line per area, so what exists is readable at a
 * glance. Each router declares its endpoints, a controller handles the request,
 * and a service holds the rules.
 */

const express = require('express');

const authRoutes = require('./auth.routes');

const router = express.Router();

router.use('/auth', authRoutes);
// router.use('/users', require('./user.routes'));
// router.use('/astrologers', require('./astrologer.routes'));
// router.use('/chats', require('./chat.routes'));

module.exports = router;
