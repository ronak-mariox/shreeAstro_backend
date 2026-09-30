/**
 * Kundli generation, over HTTP.
 *
 * AstrologyAPI itself is never visible past this layer — every response a
 * client gets back here has already been normalised into this API's own
 * shape by the service underneath.
 */

const asyncHandler = require('../utils/asyncHandler');
const geoService = require('../services/geo.service');
const kundliService = require('../services/kundli.service');
const kundliReadService = require('../services/kundliRead.service');
const kundliAnalysisService = require('../services/kundliAnalysis.service');

/**
 * Scheme+host for building a local-disk chart URL when neither S3 nor
 * env.publicUrl is configured — see chartStorage.service.js. The only place
 * in this controller that reads anything off `req` beyond the usual params.
 */
const originOf = req => `${req.protocol}://${req.get('host')}`;

/** GET /places/search?q= — geocode suggestions as the user types a birth place. */
const searchPlaces = asyncHandler(async (req, res) => {
  const items = await geoService.searchPlaces(req.query.q);
  return res.json({ items });
});

/** POST /birth-profiles — creates the profile and generates its kundli (the 12-call batch) in one request. */
const createBirthProfile = asyncHandler(async (req, res) => {
  /**
   * `asSeeker`: this endpoint is the account's owner generating their own chart,
   * so two things follow that must not follow from anyone else's request — the
   * birth details it was cast from become what their account holds, and their
   * older charts for details they no longer claim are deleted. The astrologer's
   * in-consultation generation does not pass it, so nothing they type can
   * rewrite the seeker's account or throw away their charts.
   */
  const result = await kundliService.createBirthProfile(req.account.accountId, req.body, originOf(req), {
    asSeeker: true,
  });
  return res.status(201).json(result);
});

/** GET /kundli/:profileId — chart, key positions, planetary table. */
/** GET /kundli/me — the kundli for the seeker's current birth details, if one has been generated. */
const getCurrentKundli = asyncHandler(async (req, res) => {
  return res.json(await kundliReadService.getCurrentKundli(req.account.accountId));
});

const getKundli = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliOverview(req.params.profileId, req.account.accountId, originOf(req));
  return res.json(result);
});

/** GET /kundli/:profileId/dasha — mahadasha list + the currently running antardasha. */
const getDasha = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliDasha(req.params.profileId, req.account.accountId);
  return res.json(result);
});

/** GET /kundli/:profileId/dasha/:lord — lazy, first-tap-caches antardasha for one mahadasha lord. */
const getAntardasha = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliAntardasha(req.params.profileId, req.account.accountId, req.params.lord);
  return res.json(result);
});

/** GET /kundli/:profileId/doshas — kaal sarp, sade sati, pitra. */
const getDoshas = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliDoshas(req.params.profileId, req.account.accountId);
  return res.json(result);
});

/** GET /kundli/:profileId/strength — Shadbala planetary strength. */
const getStrength = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliStrength(req.params.profileId, req.account.accountId);
  return res.json(result);
});

/** GET /kundli/:profileId/remedies — gemstone + puja suggestions, merged. */
const getRemedies = asyncHandler(async (req, res) => {
  const result = await kundliReadService.getKundliRemedies(req.params.profileId, req.account.accountId);
  return res.json(result);
});

/** GET /kundli/:profileId/analysis/:domain — career / finance / health / marriage reading, computed from the cached chart. */
const getAnalysis = asyncHandler(async (req, res) => {
  const result = await kundliAnalysisService.getKundliAnalysis(req.params.profileId, req.account.accountId, req.params.domain);
  return res.json(result);
});

module.exports = {
  searchPlaces,
  createBirthProfile,
  getCurrentKundli,
  getKundli,
  getDasha,
  getAntardasha,
  getDoshas,
  getStrength,
  getRemedies,
  getAnalysis,
};
