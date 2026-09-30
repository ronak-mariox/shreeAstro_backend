/**
 * /api/v1/articles — the published side of the content library.
 *
 * Open to everyone, but `optionalAuthenticate` runs first so a signed-in
 * reader also sees the members-only pieces.
 */

const express = require('express');

const commerceController = require('../controllers/commerce.controller');
const { optionalAuthenticate } = require('../middlewares/auth.middleware');

const router = express.Router();

router.get('/articles', optionalAuthenticate, commerceController.listArticles);
router.get('/articles/:slug', optionalAuthenticate, commerceController.getArticle);

module.exports = router;
