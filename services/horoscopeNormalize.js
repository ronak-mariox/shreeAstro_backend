/**
 * Turns AstrologyAPI's real /sun_sign_prediction response into this API's own
 * contract — pure, tested against real captured fixtures, no network or DB.
 */

/**
 * Real /sun_sign_prediction/daily(/next|/previous)/:sign shape
 * (tests/fixtures/astrologyapi/sun_sign_daily.json, sun_sign_daily_next.json):
 *   { status: true, sun_sign: "leo", prediction_date: "7-9-2026",
 *     prediction: { personal_life, profession, health, emotions, travel, luck } }
 * `prediction_date` (D-M-YYYY, not zero-padded) is never read here — the
 * caller already knows which calendar date it asked for, so `date` below
 * comes from that, not from re-parsing the provider's own echoed date.
 * `summary` is the `luck` section, which is the closest AstrologyAPI comes to
 * a one-line overall reading — the shape the frontend's DailyHoroscopeCard
 * already renders (see user_app/src/components/DailyHoroscopeCard.tsx).
 */
function normalizeHoroscope(raw, derived, zodiacSign, targetDate) {
  const prediction = raw?.prediction ?? {};

  return {
    sign: zodiacSign,
    date: targetDate,
    summary: prediction.luck ?? '',
    sections: {
      personal_life: prediction.personal_life ?? '',
      profession: prediction.profession ?? '',
      health: prediction.health ?? '',
      emotions: prediction.emotions ?? '',
      travel: prediction.travel ?? '',
      luck: prediction.luck ?? '',
    },
    lucky_number: derived?.luckyNumber,
    lucky_color: derived?.luckyColor,
    energy: derived?.energy,
  };
}

module.exports = { normalizeHoroscope };
