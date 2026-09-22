/**
 * /api/v1/chats — consultations.
 *
 * Some of these belong to one side only: a seeker starts and rates a chat, an
 * astrologer accepts or rejects it. Ending it and reading it are shared, so
 * those are guarded only by "you are part of this chat", which the service
 * checks.
 */

const express = require('express');

const chatController = require('../controllers/chat.controller');
const chatValidator = require('../validators/chat.validator');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

router.use(authenticate, authorize('user', 'astrologer'));

/** Shared. */
router.get('/', chatController.list);

/**
 * The AI assistant, and the seeker's balance precheck. Declared before
 * /:chatId so "ai" and "precheck" are read as themselves, not as a chat id.
 */
router.get('/ai', authorize('user'), chatController.aiThread);
router.post('/ai/messages', authorize('user'), chatController.askAi);
router.post('/precheck', authorize('user'), chatValidator.precheck, chatController.precheck);

/** The seeker's side. */
router.post('/', authorize('user'), chatValidator.request, chatController.request);
router.post('/:chatId/cancel', authorize('user'), chatController.cancel);
/** After a package runs out: per-minute or another package. */
router.post('/:chatId/continue', authorize('user'), chatValidator.continueAfterPackage, chatController.continueAfterPackage);
router.post('/:chatId/rate', authorize('user'), chatController.rate);

/** The astrologer's side. */
router.post('/:chatId/accept', authorize('astrologer'), chatController.accept);
router.post('/:chatId/reject', authorize('astrologer'), chatController.reject);

/** Either side. */
router.get('/:chatId', chatValidator.chatIdParam, chatController.state);
router.post('/:chatId/end', chatController.end);
router.get('/:chatId/messages', chatController.messages);
router.post('/:chatId/messages', chatController.send);

module.exports = router;
