/**
 * Kundli generation — birth profiles, the chart AstrologyAPI computes from
 * them, and everything derived from it. Grows across several build steps.
 */

const express = require('express');

const kundliController = require('../controllers/kundli.controller');
const kundliValidator = require('../validators/kundli.validator');
const { authenticate, authorize } = require('../middlewares/auth.middleware');

const router = express.Router();

/** Open, like /settings and /horoscope — this runs before a birth profile (or even a session) exists. */
router.get('/places/search', kundliValidator.searchPlaces, kundliController.searchPlaces);

/** A birth profile belongs to the account that created it. */
router.post(
  '/birth-profiles',
  authenticate,
  authorize('user'),
  kundliValidator.createBirthProfile,
  kundliController.createBirthProfile,
);

router.get(
  '/kundli/:profileId',
  authenticate,
  authorize('user'),
  kundliValidator.profileIdParam,
  kundliController.getKundli,
);
router.get(
  '/kundli/:profileId/dasha',
  authenticate,
  authorize('user'),
  kundliValidator.profileIdParam,
  kundliController.getDasha,
);
/** Lazy — only fetched (and only ever billed) the first time this specific lord is asked for. */
router.get(
  '/kundli/:profileId/dasha/:lord',
  authenticate,
  authorize('user'),
  kundliValidator.antardashaParams,
  kundliController.getAntardasha,
);
router.get(
  '/kundli/:profileId/doshas',
  authenticate,
  authorize('user'),
  kundliValidator.profileIdParam,
  kundliController.getDoshas,
);
router.get(
  '/kundli/:profileId/strength',
  authenticate,
  authorize('user'),
  kundliValidator.profileIdParam,
  kundliController.getStrength,
);
router.get(
  '/kundli/:profileId/remedies',
  authenticate,
  authorize('user'),
  kundliValidator.profileIdParam,
  kundliController.getRemedies,
);

module.exports = router;
