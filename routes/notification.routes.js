/**
 * /api/v1/notifications — shared by both apps.
 *
 * The role on the token decides whose notifications come back, so a seeker and
 * an astrologer can call exactly the same two endpoints.
 */

const express = require('express');

const userController = require('../controllers/user.controller');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('user', 'astrologer', 'admin'));

router.get('/', userController.listNotifications);
router.post('/read', userController.markNotificationsRead);

module.exports = router;
