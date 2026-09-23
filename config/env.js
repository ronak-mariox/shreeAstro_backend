/**
 * Centralized environment configuration.
 *
 * All environment variables used by the server are resolved here.
 * Production secrets MUST be provided through deployment environment variables.
 */

require('dotenv').config({ quiet: true });

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Helper for required production environment variables.
 *
 * In development, a fallback can be used.
 * In production, the variable must be explicitly configured.
 */
function getEnv(name, developmentDefault = '') {
  const value = process.env[name];

  if (isProduction && (!value || value.trim() === '')) {
    throw new Error(`${name} must be set in production.`);
  }

  return value || developmentDefault;
}

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',

  port: Number(process.env.PORT || 5000),

  /**
   * MongoDB
   */
  mongoUri: getEnv(
    'MONGODB_URI',
    'mongodb://127.0.0.1:27017/shree_astro'
  ),

  /**
   * JWT access token secret.
   */
  jwtSecret: getEnv(
    'JWT_SECRET',
    'dev-only-change-me'
  ),

  /**
   * JWT refresh token secret.
   */
  refreshSecret: getEnv(
    'JWT_REFRESH_SECRET',
    'dev-only-change-me-too'
  ),

  /**
   * OTP configuration.
   */
  otp: {
    secret: getEnv(
      'OTP_SECRET',
      'dev-only-change-me-otp'
    ),

    /**
     * A code that signs in as any account.
     *
     * Standing in for real OTP delivery until MSG91 credentials land, so it is
     * allowed in production — deliberately, and only when something actually
     * sets it: no default here, because a value defaulted in is a value nobody
     * chose. Unset in production and it is off, which with no SMS or email
     * provider configured means nobody can sign in at all; the boot check at
     * the bottom of this file says so either way.
     *
     * While it is set, it is effectively one password for every account, so
     * services/otp.service.js counts wrong guesses of it against the same
     * per-destination budget as a real code, and the OTP endpoints are rate
     * limited per caller (middlewares/rateLimit.middleware.js). Remove it the
     * day delivery works.
     */
    masterCode: isProduction
      ? process.env.OTP_MASTER_CODE || ''
      : process.env.OTP_MASTER_CODE ?? '123456',
  },

  /**
   * Redis
   */
  redis: {
    url: getEnv(
      'REDIS_URL',
      'redis://127.0.0.1:6379'
    ),

    keyPrefix: process.env.REDIS_KEY_PREFIX ?? 'shreeastro:',
  },

  /**
   * Public URL used for generated/public file URLs.
   */
  publicUrl: process.env.PUBLIC_URL || '',

  /**
   * AstrologyAPI.com — the sole source of kundli calculations; nothing is
   * computed locally. Credits are metered (see ApiUsage / the credit guard in
   * services/kundliCache.service.js), so `monthlyCreditLimit` exists to fail
   * loudly instead of silently burning the plan on a caching bug.
   */
  astrologyApi: {
    userId: getEnv('ASTROLOGY_API_USER_ID', ''),
    apiKey: getEnv('ASTROLOGY_API_KEY', ''),
    baseUrl: process.env.ASTROLOGY_API_BASE || 'https://json.astrologyapi.com/v1',
    /**
     * Fixed to 'lahiri' everywhere in practice — a different ayanamsha per
     * call would make the planetary table and the chart image disagree — but
     * this stays an env var rather than a hardcoded literal so it can be
     * proven/changed in one place if that ever needs to change.
     */
    ayanamsha: process.env.ASTROLOGY_AYANAMSHA || 'lahiri',
    /** Calls made this calendar month, across every non-horoscope endpoint, before the guard refuses. */
    monthlyCreditLimit: Number(process.env.ASTROLOGY_API_MONTHLY_LIMIT || 150),
    /**
     * The daily horoscope prefetch's own separate ceiling — kept apart from
     * `monthlyCreditLimit` on purpose. 12 signs x up to 31 days is 372 calls a
     * month on its own; sharing one pool with kundli generation would let a
     * month of horoscope prefetching starve every new kundli of credits for
     * the rest of the month. Default covers a full month with a small buffer;
     * size it against whatever the real AstrologyAPI plan actually allows.
     */
    horoscopeMonthlyCreditLimit: Number(process.env.HOROSCOPE_API_MONTHLY_LIMIT || 400),
    /**
     * Whether jobs/horoscopePrefetch.job.js's daily cron actually gets
     * scheduled (see index.js). On by default — this is the standing design,
     * not an experiment — but still overridable via `.env` for a dev sandbox
     * that shouldn't spend its own horoscope budget in the background.
     */
    horoscopePrefetchEnabled: process.env.HOROSCOPE_PREFETCH_ENABLED !== 'false',
  },

  /**
   * The AI astrology assistant.
   *
   * `llmProvider` picks which client services/llm/index.js hands back
   * ('anthropic' | 'openai') — empty until a key is actually configured, so
   * the assistant fails with a clear "not configured" error rather than
   * quietly picking a default with no key behind it.
   *
   * The rest tune behaviour, not identity, so they stay plain numbers with
   * sane defaults rather than required production secrets.
   */
  assistant: {
    llmProvider: process.env.LLM_PROVIDER || '',
    /**
     * Deliberately generic, not e.g. GROQ_API_KEY/GROQ_MODEL — the plan is to
     * start on Groq's free tier and move to OpenAI later (both speak the same
     * OpenAI-shaped chat-completions API, see services/llm/groq.js), and that
     * swap should only ever mean changing `LLM_PROVIDER` plus these two, not
     * renaming environment variables.
     */
    llmApiKey: process.env.LLM_API_KEY || '',
    llmModel: process.env.LLM_MODEL || '',
    /** How many turns accumulate before the oldest chunk gets folded into the thread's AssistantMemory (models/AssistantMemory.js). */
    summariseAfterMessages: Number(process.env.SUMMARISE_AFTER_MESSAGES || 15),
    /** The context window budget for prior messages, in (estimated) tokens — see utils/tokens.js. Not the model's own context limit, just how much history this app chooses to spend per request. */
    contextTokenBudget: Number(process.env.CONTEXT_TOKEN_BUDGET || 2000),
    /**
     * How long the AI assistant's own conversation context lives in Mongo,
     * in days — a message 7 days past its own `createdAt` (and an
     * AssistantMemory document 7 days past its last fold) becomes eligible
     * for MongoDB's own TTL removal (see models/Chat.js's `chatType` index
     * and models/AssistantMemory.js). Read once, at process start, to build
     * those indexes' `expireAfterSeconds` — changing this value later
     * changes what a *newly created* index would use, but does not retroactively
     * rewrite one already built with the old number; see this feature's own
     * migration note for how to change it on a running deployment.
     */
    messageRetentionDays: Number(process.env.CHAT_MESSAGE_RETENTION_DAYS || 7),
    /** Reserved: no cron or sweep sets an AI thread to `expired` today — the assistant's own 7-day retention above is a MongoDB TTL index instead, which needs no idle-session bookkeeping to work. */
    sessionIdleExpiryDays: Number(process.env.SESSION_IDLE_EXPIRY_DAYS || 10),
    /** Per user message, not per session — stops a confused model from looping on the same tool forever. */
    maxToolCallsPerMessage: Number(process.env.MAX_TOOL_CALLS_PER_MESSAGE || 5),
  },

  /**
   * Live per-minute consultation billing (services/chat.service.js).
   *
   * Every knob below tunes behaviour, never identity, so — like `assistant`
   * above — these stay plain numbers with sane defaults rather than required
   * production secrets.
   */
  consultation: {
    /**
     * A request may not start unless the seeker can afford at least this
     * many minutes — billing is pay-as-you-go, so this only needs to cover
     * the single minute charged upfront on accept. A commitment beyond one
     * minute belongs to the future fixed-length package flow (ChatSession's
     * `type` field is already reserved for that), not to plain per-minute
     * chat.
     */
    minBalanceMinutes: Number(process.env.MIN_BALANCE_MINUTES || 1),
    /**
     * How many seconds before the current paid minute runs out the *next*
     * minute's affordability is checked — enough lead time to warn the
     * seeker and let them top up before the meter actually cuts them off.
     * Not wired to a distinct check-ahead phase yet — see chat.service.js's
     * own note on `tickOneSession`.
     */
    checkAheadSeconds: Number(process.env.CHECK_AHEAD_SECONDS || 40),
    /** How long a session is kept alive, unable to afford its next minute, before it is ended. */
    gracePeriodSeconds: Number(process.env.GRACE_PERIOD_SECONDS || 15),
    /** How long an unanswered request stays open before it is auto-missed. */
    astrologerJoinTimeoutSeconds: Number(process.env.ASTROLOGER_JOIN_TIMEOUT_SECONDS || 120),
    /**
     * How long a session's billing may sit paused after the astrologer's own
     * socket drops before the session is ended on that account — reserved,
     * not wired to any pause/resume logic yet.
     */
    astrologerReconnectGraceSeconds: Number(process.env.ASTROLOGER_RECONNECT_GRACE_SECONDS || 60),
    /**
     * How long an active consultation waits after the SEEKER's app disappears
     * before it is ended (reason 'user_disconnected').
     *
     * Not a pause — the session ends, billed only up to the moment they went.
     * The wait exists because a dropped socket does not distinguish "closed the
     * app" from "walked through a tunnel" or "backgrounded it for a second",
     * and ending a paid consultation over a blink would be far worse than
     * waiting a moment to be sure. Shorter ends a genuinely abandoned session
     * sooner; longer survives a worse connection.
     */
    userReconnectGraceSeconds: Number(process.env.USER_RECONNECT_GRACE_SECONDS || 45),
    /**
     * The only rounding rule billing ever applies: any part of a minute
     * already bills as the whole minute (see utils/billing.js's
     * `minutesFor`) — always "up" today. Kept as one named constant, not
     * scattered, so a future change to the rule has exactly one place to
     * change it.
     */
    partialMinuteRounding: process.env.PARTIAL_MINUTE_ROUNDING || 'up',
    /**
     * How long a consultation is assumed to last when working out the
     * "busy for about N min" estimate a seeker sees on a busy astrologer
     * (services/astrologer.service.js's estimatedWaitSecondsFor) — used
     * only until that astrologer has consultations of their own to average.
     */
    estimatedConsultationMinutes: Number(process.env.ESTIMATED_CONSULTATION_MINUTES || 10),
    /** Package sessions (config/packages.js): how many seconds before a package runs out the seeker is warned. */
    packageWarningSeconds: Number(process.env.PACKAGE_WARNING_SECONDS || 30),
  },

  /**
   * Whether a wallet top-up may complete with no payment gateway behind it.
   *
   * There is no gateway wired up yet: services/wallet.service.js's startTopUp
   * opens a pending row and confirmTopUp credits the wallet, with nothing in
   * between verifying that anyone paid. That is fine in development and it is
   * how the app has always been walked through — but in production it is free
   * money, spendable on consultations that pay astrologers real rupees out the
   * other side.
   *
   * So in production that path is closed unless this explicitly opens it.
   * Admins can still credit a wallet by hand (POST /admin/wallets/adjust) for
   * payments collected some other way, and the two-step start/confirm shape is
   * unchanged, so wiring a real gateway means filling the gap between them and
   * deleting this.
   */
  allowUnverifiedTopUps: process.env.ALLOW_UNVERIFIED_TOPUPS === 'true',

  /**
   * The shared secret an external scheduler presents to drive a job over HTTP
   * (routes/internal.routes.js).
   *
   * Only needed where the server cannot hold its own timers: the Vercel
   * serverless entry (api/index.js) never starts the billing sweep, so without
   * a cron calling in, an active consultation is billed its first minute and
   * then nothing, and a package never reaches its end. On a persistent host
   * index.js runs the sweep itself and this can stay unset, which leaves the
   * endpoint switched off entirely.
   */
  internalApiKey: process.env.INTERNAL_API_KEY || '',

  /**
   * CORS
   *
   * Example:
   *
   * CORS_ORIGINS=https://admin.example.com,https://app.example.com
   */
  corsOrigins: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
};

env.isProduction = isProduction;

/**
 * Security checks
 */

// Access and refresh secrets must always be different.
if (env.jwtSecret === env.refreshSecret) {
  throw new Error(
    'JWT_REFRESH_SECRET must differ from JWT_SECRET.'
  );
}

/**
 * The master OTP in production: allowed, never silent.
 *
 * It used to be refused outright, which is the right end state — but real OTP
 * delivery is not configured yet, so refusing it would mean a live deployment
 * nobody could sign in to. So it boots, and says exactly what is switched on,
 * every start, where anyone reading the logs will see it.
 */
if (env.isProduction && env.otp.masterCode) {
  console.warn(
    '[env] WARNING: OTP_MASTER_CODE is set in production — this one code signs in as ANY account. ' +
      'It is a stand-in for SMS/email delivery: configure MSG91 (INTEGRATION_SMS_*) or SMTP and unset it.',
  );
}

/**
 * Self-serve top-ups with nothing verifying payment, in production, on purpose.
 * Worth saying out loud on every start for as long as it lasts.
 */
if (env.isProduction && env.allowUnverifiedTopUps) {
  console.warn(
    '[env] WARNING: ALLOW_UNVERIFIED_TOPUPS is on — wallet top-ups complete with no payment gateway ' +
      'behind them, so anyone signed in can credit their own wallet for free. Wire a gateway and unset it.',
  );
}

/**
 * The other way round: no master code and no way to deliver a real one means
 * every login request stores a code that reaches nobody. Worth one line at
 * boot rather than a support thread about codes never arriving.
 */
if (
  env.isProduction &&
  !env.otp.masterCode &&
  process.env.INTEGRATION_SMS_ENABLED !== 'true' &&
  process.env.INTEGRATION_EMAIL_ENABLED !== 'true'
) {
  console.warn(
    '[env] WARNING: no OTP delivery is configured (INTEGRATION_SMS_* / INTEGRATION_EMAIL_*) and ' +
      'OTP_MASTER_CODE is unset — login codes will be written to this log and nowhere else, so nobody can sign in.',
  );
}

module.exports = env;