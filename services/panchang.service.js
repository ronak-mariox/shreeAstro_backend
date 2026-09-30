/**
 * The single choke point for AstrologyAPI's panchang endpoints — same shape
 * as horoscopeCache.service's getHoroscope: cache check, the credit guard,
 * provider calls, cache write, usage log. Nothing else in the codebase may
 * call /advanced_panchang or /chaughadiya_muhurta directly.
 *
 * The page is the same for every visitor (one configured place — see
 * config/env.js's `panchang`), so the provider is called AT MOST ONCE per
 * (date, place): the first request of a day fetches both endpoints, maps
 * them into the site's shape and stores that in models/PanchangCache.js
 * (1-day TTL); every later request for that date is a free cache read.
 * Concurrent first requests share one in-flight fetch (`inFlight` below), so
 * ten visitors landing at once still cost the same two credits as one.
 *
 * Its own separate monthly credit pool (`category: 'panchang'` on both the
 * guard and the ApiUsage ledger) — see config/env.js's
 * panchangMonthlyCreditLimit — for the same reason horoscope has one: a bug
 * here must never starve kundli generation of credits.
 *
 * Every time the site shows is IST wall-clock, 'h:mm AM/PM', straight from
 * the provider's own local-time values for `tzone` — no timezone conversion
 * happens here, only formatting.
 */

const ApiError = require('../utils/ApiError');
const env = require('../config/env');
const { ASTROLOGY_API_PROVIDER } = require('../config/constants');
const PanchangCache = require('../models/PanchangCache');
const { PANCHANG_TTL_SECONDS } = require('../models/PanchangCache');
const ApiUsage = require('../models/ApiUsage');
const { assertCreditBudget } = require('./kundliCache.service');
const { istDateString, dateOffset } = require('../utils/istDate');

const MONGO_DUPLICATE_KEY = 11000;

/** The allowed window around today (IST): yesterday … today + 30 days. */
const PAST_DAYS = 1;
const FUTURE_DAYS = 30;

/** The two provider endpoints one cache miss costs. */
const ADVANCED_PANCHANG = 'advanced_panchang';
const CHAUGHADIYA_MUHURTA = 'chaughadiya_muhurta';
const CALLS_PER_MISS = 2;

/**
 * Sunrise-based: the provider computes the panchang for the given instant,
 * and the day's tithi/nakshatra are conventionally the ones in force at
 * sunrise. 06:00 local is never later than an Indian sunrise, so the values
 * it answers are the ones a printed panchang would show for that date.
 */
const PANCHANG_HOUR = 6;
const PANCHANG_MINUTE = 0;

/** English weekday -> the vaar name the page shows in its subline. */
const VAAR_BY_WEEKDAY = {
  Sunday: 'Ravivar',
  Monday: 'Somvar',
  Tuesday: 'Mangalvar',
  Wednesday: 'Budhavar',
  Thursday: 'Guruvar',
  Friday: 'Shukravar',
  Saturday: 'Shanivar',
};
const WEEKDAYS = Object.keys(VAAR_BY_WEEKDAY);

/**
 * How the site rates each of the seven choghadiya — the contract's fixed
 * quality/description table, keyed by the provider's muhurta name. Anything
 * the provider names differently falls back to 'Neutral' with no description
 * rather than failing the whole day.
 */
const CHOGHADIYA_QUALITY = {
  amrit: { quality: 'Excellent', desc: 'All auspicious work' },
  shubh: { quality: 'Good', desc: 'Auspicious ceremonies' },
  labh: { quality: 'Good', desc: 'New beginnings, profit' },
  char: { quality: 'Good', desc: 'Travel, business' },
  chal: { quality: 'Good', desc: 'Travel, business' },
  udveg: { quality: 'Bad', desc: 'Avoid important work' },
  udweg: { quality: 'Bad', desc: 'Avoid important work' },
  kaal: { quality: 'Bad', desc: 'Avoid all work' },
  kal: { quality: 'Bad', desc: 'Avoid all work' },
  rog: { quality: 'Bad', desc: 'Avoid health decisions' },
};

/* ------------------------------------------------------------------ dates */

/** True for a real "YYYY-MM-DD" calendar date — "2026-02-30" is not one. */
function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Yesterday … today + FUTURE_DAYS, relative to today in IST. Plain string comparison works on ISO dates. */
function isWithinWindow(value, today = istDateString()) {
  if (!isCalendarDate(value)) {
    return false;
  }
  return value >= dateOffset(today, -PAST_DAYS) && value <= dateOffset(today, FUTURE_DAYS);
}

/** The English weekday of a "YYYY-MM-DD" calendar date — a fallback for when the provider omits `day`. */
function weekdayOf(dateString) {
  return WEEKDAYS[new Date(`${dateString}T00:00:00.000Z`).getUTCDay()];
}

/* ----------------------------------------------------------------- times */

/**
 * Anything the provider uses for a clock time -> { hour, minute } in local
 * time, or null. Accepts "6:12:34", "06:12", "18:05 PM"-style strings, an
 * `{ hour, minute, second }` object, or a bare number of hours. Hours may
 * legitimately be >= 24 (a tithi ending at 27:15 ends at 3:15 AM the next
 * day) — they are kept as-is here; `formatTime` wraps them.
 */
function parseClock(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'object') {
    const hour = Number(value.hour);
    const minute = Number(value.minute ?? value.min ?? 0);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { hour, minute };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const hour = Math.floor(value);
    return { hour, minute: Math.round((value - hour) * 60) };
  }
  const text = String(value).trim();
  const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*([AaPp][Mm])?$/);
  if (!match) {
    return null;
  }
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[4] ? match[4].toUpperCase() : null;
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  return { hour, minute };
}

/** { hour: 20, minute: 45 } -> "8:45 PM"; hours >= 24 wrap around to the next morning. */
function formatClock(clock) {
  if (!clock) {
    return null;
  }
  const hour24 = ((clock.hour % 24) + 24) % 24;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  return `${hour12}:${String(clock.minute).padStart(2, '0')} ${meridiem}`;
}

/** A provider time value straight to the site's 'h:mm AM/PM', or null. */
function formatTime(value) {
  return formatClock(parseClock(value));
}

/**
 * A tithi/nakshatra/yoga/karana boundary -> { endsAt, endsNextDay }. The
 * provider marks "tomorrow" by an hour of 24 or more; some accounts also
 * carry an explicit next-day flag, which is honoured when present.
 */
function endTimeOf(section) {
  const raw = section?.end_time ?? section?.endTime ?? section?.end ?? null;
  const clock = parseClock(raw);
  if (!clock) {
    return { endsAt: null, endsNextDay: false };
  }
  const flagged = Boolean(
    section?.end_time_next_day ?? section?.next_day ?? section?.nextDay ?? raw?.next_day ?? raw?.nextDay ?? false,
  );
  return { endsAt: formatClock(clock), endsNextDay: clock.hour >= 24 || flagged };
}

/** A `{ start, end }` window (rahu kaal and friends) -> the same, formatted, or null when either edge is missing. */
function windowOf(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const start = formatTime(value.start ?? value.start_time ?? value.from);
  const end = formatTime(value.end ?? value.end_time ?? value.to);
  return start && end ? { start, end } : null;
}

/* --------------------------------------------------------------- mapping */

/** The first present (non-null, non-empty) value among several candidate keys — the provider's naming drifts between accounts. */
function pick(object, ...keys) {
  if (!object || typeof object !== 'object') {
    return null;
  }
  for (const key of keys) {
    const value = object[key];
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** "Shukla Paksha" / "shukla_paksha" / "Shukla" -> "Shukla"; "Krishna Paksha" -> "Krishna". */
function pakshaOf(...candidates) {
  const raw = candidates.find(value => textOrNull(value));
  if (!raw) return null;
  const word = String(raw).trim().split(/[\s_-]+/)[0];
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** "Budhavar · Bhadrapad Shukla Paksha · Shashthi Tithi", from whichever parts are known. */
function sublineOf({ vaar, masa, tithi }) {
  const parts = [];
  if (vaar) parts.push(vaar);
  const monthAndPaksha = [masa?.amanta, tithi?.paksha ? `${tithi.paksha} Paksha` : null].filter(Boolean).join(' ');
  if (monthAndPaksha) parts.push(monthAndPaksha);
  if (tithi?.name) parts.push(`${tithi.name} Tithi`);
  return parts.join(' · ') || null;
}

/**
 * One /chaughadiya_muhurta response -> { day: [...], night: [...] }, eight
 * slots each in the normal case. Each provider slot is
 * `{ time: 'HH:MM - HH:MM', muhurta: 'Amrit' }`; the start/end are split
 * out and formatted, and the site's quality/desc looked up by name.
 */
function mapChoghadiya(raw) {
  const root = raw?.chaughadiya ?? raw?.choghadiya ?? raw ?? {};
  const mapList = list => (Array.isArray(list) ? list : []).map(slot => {
    const name = textOrNull(pick(slot, 'muhurta', 'name', 'chaughadiya'));
    let start = formatTime(pick(slot, 'start', 'start_time'));
    let end = formatTime(pick(slot, 'end', 'end_time'));
    if ((!start || !end) && typeof slot?.time === 'string') {
      const [from, to] = slot.time.split(/\s*(?:-|–|to)\s*/i);
      start = start || formatTime(from);
      end = end || formatTime(to);
    }
    const rating = CHOGHADIYA_QUALITY[String(name || '').toLowerCase()] || { quality: 'Neutral', desc: null };
    return { start, end, name, quality: rating.quality, desc: rating.desc };
  });
  return { day: mapList(root.day), night: mapList(root.night) };
}

/**
 * The two raw provider responses -> the site's response shape, minus the
 * `cache` block (added on read by `withCacheInfo`). Every field the provider
 * might not send comes through as null — this must never throw on a missing
 * optional field, since a missing yoga name is not a reason to lose the
 * whole page.
 *
 * @param {object} advanced The /advanced_panchang response.
 * @param {object} chaughadiya The /chaughadiya_muhurta response.
 * @param {string} date "YYYY-MM-DD".
 * @param {{ label: string, latitude: number, longitude: number, tzone: number }} place
 */
function mapPanchang(advanced, chaughadiya, date, place) {
  const source = advanced && typeof advanced === 'object' ? advanced : {};

  const weekday = textOrNull(pick(source, 'day', 'weekday', 'vaar')) || weekdayOf(date);
  const weekdayKey = WEEKDAYS.find(name => name.toLowerCase() === String(weekday).toLowerCase()) || weekdayOf(date);
  const vaar = VAAR_BY_WEEKDAY[weekdayKey] || null;

  const tithiRaw = source.tithi || {};
  const tithi = {
    name: textOrNull(pick(tithiRaw.details, 'tithi_name', 'name')) ?? textOrNull(pick(tithiRaw, 'tithi_name', 'name')),
    number: numberOrNull(pick(tithiRaw.details, 'tithi_number', 'number') ?? pick(tithiRaw, 'tithi_number', 'number')),
    paksha: pakshaOf(tithiRaw.paksha, tithiRaw.details?.paksha, source.paksha),
    ...endTimeOf(tithiRaw),
  };

  const nakRaw = source.nakshatra || {};
  const nakshatra = {
    name: textOrNull(pick(nakRaw.details, 'nak_name', 'nakshatra_name', 'name')) ?? textOrNull(pick(nakRaw, 'nak_name', 'name')),
    number: numberOrNull(pick(nakRaw.details, 'nak_number', 'nakshatra_number', 'number') ?? pick(nakRaw, 'nak_number', 'number')),
    lord: textOrNull(pick(nakRaw.details, 'ruling_planet', 'ruler', 'lord') ?? pick(nakRaw, 'ruling_planet', 'ruler', 'lord')),
    ...endTimeOf(nakRaw),
  };

  const yogRaw = source.yog || source.yoga || {};
  const yoga = {
    name: textOrNull(pick(yogRaw.details, 'yog_name', 'yoga_name', 'name')) ?? textOrNull(pick(yogRaw, 'yog_name', 'name')),
    ...endTimeOf(yogRaw),
  };

  const karanRaw = source.karan || source.karana || {};
  const karana = {
    name: textOrNull(pick(karanRaw.details, 'karan_name', 'karana_name', 'name')) ?? textOrNull(pick(karanRaw, 'karan_name', 'name')),
    ...endTimeOf(karanRaw),
  };

  const maahRaw = source.hindu_maah || source.hindu_month || source.masa || {};
  const masa = {
    amanta: textOrNull(pick(maahRaw, 'amanta', 'amant')),
    purnimanta: textOrNull(pick(maahRaw, 'purnimanta', 'purnimant')),
  };

  const sunrise = formatTime(pick(source, 'sunrise', 'sun_rise'));
  const sunset = formatTime(pick(source, 'sunset', 'sun_set'));
  const moonrise = formatTime(pick(source, 'moonrise', 'moon_rise'));
  const moonset = formatTime(pick(source, 'moonset', 'moon_set'));

  const vikram = pick(source, 'vikram_samvat', 'vikram_samvat_name', 'vkram_samvat');
  const shaka = pick(source, 'shaka_samvat', 'shaka_samvat_name', 'saka_samvat');

  return {
    date,
    place: {
      label: place.label,
      latitude: place.latitude,
      longitude: place.longitude,
      tzone: place.tzone,
    },
    weekday: weekdayKey,
    vaar,
    subline: sublineOf({ vaar, masa, tithi }),
    sun: { sunrise, sunset },
    moon: moonrise || moonset ? { moonrise, moonset } : null,
    rahuKaal: windowOf(pick(source, 'rahukaal', 'rahu_kaal', 'rahukal', 'rahu_kalam')),
    gulikaKaal: windowOf(pick(source, 'guliKaal', 'gulikaa', 'gulika_kaal', 'gulikaal', 'gulika', 'gulikai_kalam')),
    yamaganda: windowOf(pick(source, 'yamghant_kaal', 'yamghant', 'yamganda', 'yamaganda', 'yamagandam', 'yamghanta')),
    abhijitMuhurat: windowOf(pick(source, 'abhijit_muhurta', 'abhijit', 'abhijit_muhurat')),
    tithi,
    nakshatra,
    yoga,
    karana,
    masa,
    ritu: textOrNull(pick(source, 'ritu', 'season')),
    samvat: vikram !== null || shaka !== null
      ? { vikram: textOrNull(vikram), shaka: textOrNull(shaka) }
      : null,
    choghadiya: mapChoghadiya(chaughadiya),
  };
}

/* ---------------------------------------------------------------- caching */

/** "28.6139,77.2090" — 4 decimals, same rounding as the kundli birth hash, so a config nudge in the 5th decimal never splits the cache. */
function locationKeyFor(latitude, longitude) {
  return `${Number(latitude).toFixed(4)},${Number(longitude).toFixed(4)}`;
}

/** The configured place, in the shape `mapPanchang` and the provider params want. */
function configuredPlace() {
  return {
    label: env.panchang.placeLabel,
    latitude: env.panchang.latitude,
    longitude: env.panchang.longitude,
    tzone: env.panchang.tzone,
  };
}

/** A cache row -> the response the site sees. */
function withCacheInfo(row, hit) {
  const fetchedAt = new Date(row.createdAt);
  return {
    ...row.payload,
    cache: {
      hit,
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + PANCHANG_TTL_SECONDS * 1000).toISOString(),
    },
  };
}

/** Lazy-required, and through the module object rather than a destructured binding, so tests can stub `client.request` (see astrologyApi.client.js). */
function defaultCallProvider(endpoint, params) {
  // eslint-disable-next-line global-require
  return require('./astrologyApi.client').request(endpoint, params);
}

/**
 * One fetch, one map, one row — the miss path. Bills each call that actually
 * answered even when the other one failed (the credit is spent either way),
 * but only caches when both did, so a half-day is never served.
 */
async function fetchAndStore(date, locationKey, place, callProvider) {
  await assertCreditBudget(ASTROLOGY_API_PROVIDER, CALLS_PER_MISS, 'panchang');

  const [year, month, day] = date.split('-').map(Number);
  const params = {
    day,
    month,
    year,
    hour: PANCHANG_HOUR,
    min: PANCHANG_MINUTE,
    lat: place.latitude,
    lon: place.longitude,
    tzone: place.tzone,
  };

  const results = await Promise.allSettled([
    callProvider(ADVANCED_PANCHANG, params),
    callProvider(CHAUGHADIYA_MUHURTA, params),
  ]);
  const endpoints = [ADVANCED_PANCHANG, CHAUGHADIYA_MUHURTA];
  const answered = results
    .map((result, index) => (result.status === 'fulfilled' ? endpoints[index] : null))
    .filter(Boolean);
  if (answered.length) {
    await ApiUsage.insertMany(
      answered.map(endpoint => ({ provider: ASTROLOGY_API_PROVIDER, endpoint, category: 'panchang', calledAt: new Date() })),
    );
  }
  const failed = results.find(result => result.status === 'rejected');
  if (failed) {
    throw failed.reason;
  }

  const payload = mapPanchang(results[0].value, results[1].value, date, place);
  console.log(`[panchang] fetched ${date} from provider`);

  try {
    return await PanchangCache.findOneAndUpdate(
      { date, locationKey },
      {
        $set: { payload, provider: ASTROLOGY_API_PROVIDER },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
    ).lean();
  } catch (error) {
    /**
     * Two processes raced for the same (date, place) and the unique index
     * caught it — the credits are spent either way; the row the other
     * process wrote is exactly what this one would have written.
     */
    if (error?.code !== MONGO_DUPLICATE_KEY) {
      throw error;
    }
    const row = await PanchangCache.findOne({ date, locationKey }).lean();
    if (!row) {
      throw error;
    }
    return row;
  }
}

/**
 * Per-process "someone is already fetching this" map, keyed by the cache
 * key. The first miss for a date puts its promise here; every concurrent
 * miss for the same date awaits that same promise instead of spending its
 * own two credits. Cleared once the fetch settles, success or failure, so a
 * failed fetch is retried by the next request rather than poisoning the key.
 */
const inFlight = new Map();

/**
 * The panchang for one date, from cache whenever possible.
 *
 * @param {string} [date] "YYYY-MM-DD" — today in IST when omitted. Must be
 *   within the allowed window (yesterday … today + 30); the validator
 *   already enforces that over HTTP, this re-checks for any other caller.
 * @param {(endpoint: string, params: object) => Promise<unknown>} [callProvider]
 *   Overrides the real client — the seam tests use to run against a fake
 *   provider instead of the network.
 */
async function getPanchang(date, callProvider) {
  const targetDate = date ? String(date).trim() : istDateString();
  if (!isCalendarDate(targetDate)) {
    throw ApiError.unprocessable('Please check the form.', { date: 'date must be a real calendar date in YYYY-MM-DD form.' });
  }
  if (!isWithinWindow(targetDate)) {
    throw ApiError.unprocessable('Please check the form.', {
      date: `date must be between yesterday and ${FUTURE_DAYS} days from today (IST).`,
    });
  }

  const place = configuredPlace();
  const locationKey = locationKeyFor(place.latitude, place.longitude);

  const cached = await PanchangCache.findOne({ date: targetDate, locationKey }).lean();
  if (cached) {
    return withCacheInfo(cached, true);
  }

  const key = `${targetDate}|${locationKey}`;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetchAndStore(targetDate, locationKey, place, callProvider || defaultCallProvider)
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const row = await pending;
  return withCacheInfo(row, false);
}

module.exports = {
  getPanchang,
  mapPanchang,
  mapChoghadiya,
  isCalendarDate,
  isWithinWindow,
  locationKeyFor,
  formatTime,
  endTimeOf,
  PAST_DAYS,
  FUTURE_DAYS,
  CALLS_PER_MISS,
};
