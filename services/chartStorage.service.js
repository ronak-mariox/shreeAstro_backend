/**
 * The kundli chart SVG's storage.
 *
 * AstrologyAPI charges a credit to fetch the SVG, so it is uploaded exactly
 * once — the first time it's actually fetched — and served from that URL
 * forever after. BirthProfile.chartUrl is what remembers "already uploaded";
 * without it, every read would have to inspect KundliCache's raw payload and
 * re-upload the identical file needlessly.
 *
 * Reuses the same storage the profile-photo/document uploads use
 * (services/s3.service.js, services/storage.service.js) — S3 when
 * configured, local disk otherwise — but writes a buffer directly instead of
 * going through multer's HybridStorage, since this SVG comes from
 * AstrologyAPI's JSON response, not a multipart request.
 */

const fs = require('fs');
const path = require('path');

const env = require('../config/env');
const BirthProfile = require('../models/BirthProfile');
const { getKundliSection } = require('./kundliCache.service');
const { ensureUploadDir, uploadRoot } = require('./storage.service');
const s3Service = require('./s3.service');

const CHART_ENDPOINT = 'horo_chart_image/D1';
const SUBDIRECTORY = 'charts';

/**
 * @param {string} svg Raw SVG markup.
 * @param {string} birthHash Names the file — deterministic, so a race
 *   between two uploads for the identical birth overwrites the same key
 *   with identical content instead of littering storage with duplicates.
 * @param {string} [origin] Scheme+host to build a local-disk URL against,
 *   e.g. `${req.protocol}://${req.get('host')}` — only used when S3 isn't
 *   configured and env.publicUrl is blank. Mirrors storage.service.js's
 *   publicUrlFor, which needs the same thing for the same reason: a device
 *   on Wi-Fi and an emulator reach the same dev machine at different hosts.
 */
async function uploadChartSvg(svg, birthHash, origin) {
  const buffer = Buffer.from(svg, 'utf8');
  const filename = `${birthHash}.svg`;

  const useS3 = await s3Service.isConfigured().catch(error => {
    console.error('[chartStorage] could not check S3 configuration, using local disk:', error.message);
    return false;
  });

  if (useS3) {
    return s3Service.upload({ buffer, key: `${SUBDIRECTORY}/${filename}`, contentType: 'image/svg+xml' });
  }

  const destination = ensureUploadDir(SUBDIRECTORY);
  const target = path.join(destination, filename);
  fs.writeFileSync(target, buffer);

  const relative = path.relative(uploadRoot, target).split(path.sep).join('/');
  return `${env.publicUrl || origin || ''}/uploads/${relative}`;
}

/**
 * Resolves a birth's chart to a stored URL.
 *
 * `birthProfile.chartUrl` already set means zero cost, not even a cache
 * lookup. Otherwise the SVG is fetched the normal way (through
 * getKundliSection — cached and credit-guarded like any other section),
 * uploaded once, and the URL is written onto the profile so this never
 * repeats for it.
 */
async function getChartImageUrl(birthProfile, origin) {
  if (birthProfile.chartUrl) {
    return birthProfile.chartUrl;
  }

  const raw = await getKundliSection(birthProfile, CHART_ENDPOINT);
  const url = await uploadChartSvg(raw.svg, birthProfile.birthHash, origin);

  await BirthProfile.updateOne({ _id: birthProfile._id }, { $set: { chartUrl: url } });
  /** Keeps this same in-memory object correct for the rest of whichever call just resolved it. */
  birthProfile.chartUrl = url;

  return url;
}

module.exports = { getChartImageUrl, uploadChartSvg, CHART_ENDPOINT };
