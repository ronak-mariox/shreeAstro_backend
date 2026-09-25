# Shree Astro API

Base URL: `http://localhost:5000/api/v1`

Three clients share one API. Which one calls what is decided by the **role**
inside the access token — `user`, `astrologer` or `admin` — so the same URL can
serve two apps without either one being able to reach the other's data.

## Postman

Import everything in [`postman/`](postman/) — three collections (one per client)
and a shared environment. Tokens, OTP codes and record ids are captured
automatically, so you rarely type anything. See [postman/README.md](postman/README.md).

## Running it

```bash
cp .env.example .env      # then fill in MONGODB_URI and REDIS_URL
npm install
npm run seed:admin        # admin@shreeastro.com / admin@123
npm run dev
```

Needs MongoDB and Redis. Redis is where login codes live.

```bash
npm test                  # 208 checks across five suites
```

### The admin account

The panel is the only client that signs in with a password, and it has no public
sign-up — so the account is seeded from the command line:

```bash
npm run seed:admin
```

That creates `admin@shreeastro.com` / `admin@123`. Running it again just resets
the password back to that, so it is also the way back in after locking yourself
out with five wrong attempts.

Everyone else is added from the panel: Settings → Admin team.

---

## Auth — `/auth`

| Method | Path | Who | What |
|---|---|---|---|
| POST | `/auth/register` | — | Seeker sign-up. `multipart/form-data`, optional `photo`. |
| POST | `/auth/astrologer/register` | — | Astrologer application, steps 1–2. `multipart/form-data`. |
| POST | `/auth/login/otp/request` | — | Send a login code. |
| POST | `/auth/login/otp/verify` | — | Trade the code for a session. |
| POST | `/auth/apple` | — | user_app "Continue with Apple". `{ identityToken }`. 400 `apple_not_configured` until Apple is set up under Settings → Third Parties. |
| POST | `/auth/google` | — | user_app "Continue with Google". `{ idToken }`. 400 `google_not_configured` until Google is set up under Settings → Third Parties. Neither Apple nor Google auto-registers — an unrecognised identity comes back 404 `account_not_found`, same as OTP login. |
| POST | `/auth/admin/login` | — | Email + password, admin panel only. |
| POST | `/auth/refresh` | — | New token pair. Cookie or body `{ refreshToken }`. The token just spent is revoked as part of the trade — see "Refresh token revocation" below. |
| POST | `/auth/logout` | — | Clears cookies, and revokes the refresh token if one is sent (cookie, or body `{ refreshToken }` — the apps should always send this). |
| GET | `/auth/me` | any | The signed-in account. |

### Refresh token revocation

Every refresh token carries a `jti`, recorded in Redis (`refreshToken.service.js`) for exactly as long as the token itself is valid. That record — not just the JWT's signature and expiry — is what `/auth/refresh` checks, which is what lets these actually take a refresh token back before its natural 30-day expiry:

- **Logout** — revokes the one refresh token the caller sent.
- **An admin blocking a user or astrologer**, or **suspending/revoking an admin** — revokes every refresh token that account is holding ("sign out everywhere" on `PATCH /admin/team/:adminId` does the same for a colleague's own request).
- **Refresh token rotation** — every `/auth/refresh` call revokes the token it just consumed and issues a new one, so a refresh token can only ever be traded once.

**Sending a code.** One endpoint for both apps and both channels:

```jsonc
POST /auth/login/otp/request
{ "role": "user",        // or "astrologer"; defaults to "user"
  "channel": "phone",    // or "email"
  "phone": "9876543210" }

-> { "message": "Code sent.",
     "channel": "phone",
     "destination": "••••••3210",
     "expiresInSeconds": 300,
     "resendInSeconds": 30,
     "devCode": "482910" }     // development only
```

```jsonc
POST /auth/login/otp/verify
{ "role": "user", "channel": "phone", "phone": "9876543210", "code": "482910" }

-> { "accessToken": "...", "refreshToken": "...", "user": { ... } }
```

> **Master OTP.** There is no SMS or email provider wired up yet, so
> `OTP_MASTER_CODE` (default `123456`) works for every login, and the real
> generated code is printed to the server log and returned as `devCode`.
> The server refuses to start in production while a master code is set.
> To plug in a provider: send the code inside `deliverOtp` and delete the
> master-code branch in `verifyOtp` — both in `services/otp.service.js`.

Codes are stored in Redis and expire on their own:

```
otp:login:phone:9876543210            the hashed code   (TTL 5 min)
otp:cooldown:login:phone:9876543210   "already sent"    (TTL 30 s)
```

Logging in never creates an account. An unregistered identifier is `404` with
`code: "account_not_found"` — the app's cue to offer Register.

---

## The seeker's own account — `/users` *(user_app)*

| Method | Path | What |
|---|---|---|
| GET | `/users/me` | Profile, wallet, stats. |
| PATCH | `/users/me` | Edit profile. `multipart/form-data`, optional `photo`. |
| PATCH | `/users/me/notification-prefs` | Toggle alert types. |
| GET / POST | `/users/me/kundlis` | Saved charts. |
| DELETE | `/users/me/kundlis/:kundliId` | Remove one. |
| GET | `/users/me/favourites` | Favourited astrologers. |
| POST | `/users/me/favourites/:astrologerId` | Add or remove (it toggles). |

---

## The directory — `/astrologers` *(user_app)*

| Method | Path | What |
|---|---|---|
| GET | `/astrologers` | The directory, filtered and sorted. |
| GET | `/astrologers/:id` | One profile, with reviews. |
| GET | `/astrologers/:id/reviews` | More reviews. |

Filters are query parameters; lists are comma-separated:

```
/astrologers?expertise=vedic,tarot&languages=hindi&online=true
            &minExperience=5&maxRate=30&minRating=4&gender=male
            &sort=rating&page=1&limit=20
```

`sort` — `recommended` (default), `rating`, `experience`, `price_low`,
`price_high`, `popular`.

Only approved, active astrologers ever appear here.

---

## The astrologer's own account — `/astrologer` *(astro_app)*

| Method | Path | What |
|---|---|---|
| GET / PATCH | `/astrologer/me` | Profile. |
| PATCH | `/astrologer/me/presence` | `{ isOnline }` — the dashboard toggle. |
| PATCH | `/astrologer/me/services` | `{ type, isEnabled }`. |
| GET | `/astrologer/me/service-rates` | Rates, and any pending change. |
| POST | `/astrologer/me/price-changes` | Ask to change a rate. |
| GET / POST | `/astrologer/me/documents` | Filed scans. POST is multipart, field `file`. |
| DELETE | `/astrologer/me/documents/:id` | Remove one (not if approved). |
| GET / POST | `/astrologer/me/bank-accounts` | Payout accounts. |
| POST | `/astrologer/me/submit` | Hand the application to the admins. |
| GET | `/astrologer/me/reviews` | Reviews received. |
| POST | `/astrologer/me/reviews/:chatId/reply` | Answer one. |
| GET | `/astrologer/me/requests` | The incoming-request queue. |

| GET | `/astrologer/me/dashboard` | The whole dashboard in one call. |
| PUT | `/astrologer/me/rates` | The opening rates — see below. |
| PUT | `/astrologer/me/documents/:id` | Replace a scan (resets it to pending). |
| POST | `/astrologer/me/reviews/:chatId/flag` | Raise a review as unfair. Toggles. |
| POST | `/astrologer/me/reviews/:chatId/pin` | Pin it to the public profile. Toggles. |

### Two ways an astrologer account comes to exist

**They applied** (`createdVia: "self"`) — the four-step wizard above, ending in
`under_review` for an admin to approve.

**An admin created it** (`createdVia: "admin"`) — from the panel's short form:
an email address, the platform commission, their availability and whether they
are listed. Nothing else. The account is approved on creation, and the
astrologer fills the rest in themselves.

Either way, `GET /astrologer/me` answers with two fields that drive the app:

- `missing` — which profile fields are still empty (`phone`, `gender`,
  `languages`, `expertise`, `experienceYears`, `photo`, `rates`). Nudge for
  exactly these.
- `canSetOwnRates` — whether `PUT /astrologer/me/rates` will still work.

### Rates

**An astrologer sets their own rate exactly once**, through
`PUT /astrologer/me/rates`, while the profile is still incomplete. There is no
agreed price yet, so there is nothing for an admin to approve.

The first save that leaves `missing` empty stamps `profileCompletedAt`. From
that moment the rate is settled: `PUT /me/rates` answers 400, and every change
goes through `POST /me/price-changes` for approval.

**An astrologer does not appear in the seeker's directory until they have a
rate**, however their account was created — listing someone who cannot be
consulted is worse than not listing them.

**Application states**, in order:
`professional_submitted` → `documents_submitted` → `bank_submitted` →
`under_review` → `approved` (or `rejected`). An admin-created account starts at
`approved`.

---

## Consultations — `/chats` *(both apps)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/chats` | both | The consultation list. |
| POST | `/chats` | user | Ask for a chat. |
| POST | `/chats/:id/cancel` | user | Give up waiting. |
| POST | `/chats/:id/accept` | astrologer | Take it. The meter starts. The server then posts the astrologer's opening greeting ("Namaste <first name>! … how can I help you today?") as a real astrologer message, so the seeker's first line is never silence. |
| POST | `/chats/:id/reject` | astrologer | Turn it down. |
| POST | `/chats/:id/end` | either | End it, and settle the money. |
| POST | `/chats/:id/rate` | user | `{ rating: 1–5, comment }`. |
| GET | `/chats/:id/messages` | either | Transcript, oldest first. `?beforeSeq=` pages back. |
| POST | `/chats/:id/messages` | either | Send without a socket (a fallback). |

| GET | `/chats/ai` | user | The AI assistant thread. |
| POST | `/chats/ai/messages` | user | Ask it something. |

```jsonc
POST /chats
{ "astrologerId": "...", "channel": "chat",
  "intake": { "topic": "career-job", "question": "When will I change jobs?", "minutes": 10 } }

-> { "chatId": "...", "status": "requested", "ratePerMinute": 20,
     "expiresInSeconds": 120 }
```

### Billing

Fixed at request time so a mid-chat price change cannot affect it.

1. Duration is rounded **up** to the whole minute.
2. Free minutes are subtracted — the larger of the platform's first-consult
   offer and whatever this astrologer grants.
3. The rest is charged to the seeker's wallet.
4. The astrologer is credited that amount less `commissionPercent`.

A chat cannot start unless the seeker has free minutes or can pay for at least
one minute.

---

## Live chat (socket.io)

```js
const socket = io('http://localhost:5000', { auth: { token: accessToken } });
```

The token is checked at the handshake — a bad one never connects. Identity comes
from the token alone, never from an event payload.

**Client → server** (the last argument is an acknowledgement callback):

| Event | Payload |
|---|---|
| `chat:join` | `{ chatId, lastSeq }` → replies with everything missed since `lastSeq` |
| `chat:leave` | `{ chatId }` |
| `message:send` | `{ chatId, type, content, replyTo?, clientMessageId? }` |
| `message:delivered` | `{ chatId, seq }` |
| `message:read` | `{ chatId, seq }` |
| `chat:typing` | `{ chatId, isTyping }` |

**Server → client:**

| Event | When |
|---|---|
| `message:new` | A message was posted (the sender gets it back too). |
| `message:delivered` / `message:read` | The other side's ticks moved. |
| `chat:typing` | The other side is typing. |
| `chat:requested` | *(astrologer)* A seeker wants a chat. |
| `chat:accepted` / `chat:rejected` / `chat:cancelled` | The request was answered. |
| `chat:started` | The meter is running. |
| `session:ended` | It is over. |
| `notification:new` | Any alert. |

### Message types

Every message is `{ type, content }`, and `type` alone decides what `content`
may hold:

| type | content |
|---|---|
| `text` | `{ text }` |
| `system` | `{ text, event }` — the server's own voice; clients cannot send it |
| `image` | `{ url, fileName?, mimeType?, size? }` |
| `audio` | `{ url, duration?, mimeType?, size? }` |
| `video` | `{ url, duration?, fileName?, mimeType?, size? }` |
| `file` | `{ url, fileName, mimeType?, size? }` |

**Only `text` is switched on today.** Anything else is refused with `400`.
Turning one on is a one-line change in `models/Chat.js`:

```js
const ENABLED_TYPES = ['text', 'system', 'image'];
```

Two things make the transcript reliable: `seq` numbers every message, so a
reconnecting client asks for everything after the last one it holds; and
`clientMessageId` makes a retried send return the message already stored
instead of a duplicate.

---

## Money — `/wallet` *(both apps)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/wallet` | both | Balance (seeker) or earnings (astrologer). |
| GET | `/wallet/transactions` | both | Ledger. `?filter=all\|added\|spent`. |
| POST | `/wallet/topup` | user | Start adding money. |
| POST | `/wallet/topup/confirm` | user | The payment succeeded. |
| GET | `/wallet/withdrawals` | astrologer | Payout history. |
| POST | `/wallet/withdrawals` | astrologer | Ask to be paid out. The balance is **not** deducted here: the amount is reserved in `earnings.pendingWithdrawal` (a request must fit in `balance − pendingWithdrawal`; `GET /wallet` reports that as `available`) and the astrologer is told to allow up to 24 hours for approval. |

> **No payment gateway yet.** `POST /wallet/topup` returns an order the app can
> confirm straight away. Wire Razorpay (or another) into `startTopUp`, and
> verify its signature in `confirmTopUp` — both in `services/wallet.service.js`.

Every rupee moves through one function, `post()` in `services/wallet.service.js`.
Balances are running totals kept by that function; nothing else writes them.

---

## Notifications — `/notifications` *(both apps)*

| Method | Path | What |
|---|---|---|
| GET | `/notifications` | The list, plus an unread count. |
| POST | `/notifications/read` | `{ notificationId }`, or nothing to mark all. |

---

## Admin panel — `/admin`

Every route needs an admin token **and** the right permission, so a Finance
admin can read payments but cannot approve astrologers. Permissions come from
the account's role — see `models/Admin.js`.

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/dashboard` | `dashboard.view` |
| GET | `/admin/users` | `users.view` |
| PATCH | `/admin/users/:id/status` | `users.manage` |
| GET | `/admin/astrologers` | `astrologers.view` |
| GET | `/admin/astrologers/:id` | `astrologers.view` |
| POST | `/admin/astrologers/:id/approve` | `astrologers.approve` |
| POST | `/admin/astrologers/:id/reject` | `astrologers.approve` |
| PATCH | `/admin/astrologers/:id/status` | `astrologers.manage` |
| PATCH | `/admin/astrologers/:id/documents/:docId` | `astrologers.approve` |
| PATCH | `/admin/astrologers/:id/bank-accounts/:accId` | `astrologers.approve` |
| PATCH | `/admin/astrologers/:id/price-changes/:reqId` | `astrologers.manage` |
| GET | `/admin/consultations` | `consultations.view` |
| GET | `/admin/transactions` | `payments.view` |
| POST | `/admin/transactions/:id/refund` | `payments.refund` |
| GET | `/admin/withdrawals` | `wallets.view` |
| PATCH | `/admin/withdrawals/:id` | `payouts.approve` | `{ status: 'approved', payoutReference }` deducts the balance **now** (refused if it can no longer cover the amount; the request stays pending) and marks it paid; `{ status: 'rejected', reason }` just releases the reservation. Rows from before this change (`deduction: 'on_request'`) keep the old refund-on-reject path. |
| GET / POST / PUT / DELETE | `/admin/articles` | `content.view` / `content.manage` |
| POST | `/admin/astrologers` | `astrologers.manage` |
| POST | `/admin/consultations/:chatId/end` | `consultations.manage` |
| GET | `/admin/wallets` | `wallets.view` |
| POST | `/admin/wallets/adjust` | `wallets.adjust` |
| GET | `/admin/reports` | `reports.view` |
| GET / PATCH | `/admin/settings` | `settings.view` / `settings.manage` |
| GET / POST / PATCH / DELETE | `/admin/team` | `admins.manage` |
| GET / PATCH | `/admin/support-tickets` | `consultations.view` / `.manage` |
| GET | `/admin/audit-logs` | `audit.view` |

### Creating an astrologer

The short form. Four fields, and the astrologer supplies the rest:

```jsonc
POST /admin/astrologers
{ "email": "rajesh.sharma@example.com",   // the whole login identity
  "commissionPercent": 30,                // omit to use the platform default
  "availability": "Mon–Sat · 9 AM – 9 PM",
  "status": "approved" }                  // or "blocked"
```

They sign in to the astrologer app with a code sent to that email, then fill in
name, phone, photo, languages, expertise, experience, about and their rates from
their own profile screen. Until they set a rate they stay out of the directory.

Approving an application is what mints the astro code and sets the opening
rates, so it needs the services:

```jsonc
POST /admin/astrologers/:id/approve
{ "commissionPercent": 25,
  "services": [ { "type": "chat", "ratePerMinute": 20, "isEnabled": true },
                { "type": "call", "ratePerMinute": 30, "isEnabled": true } ] }
```

Every admin change writes an audit row. Audit rows are never edited or deleted —
a log you can change is not a log.

---

## Shared — `/settings`, `/horoscope`, `/panchang`, `/support`

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/settings` | anyone | Recharge limits, feature switches, app versions. |
| GET | `/horoscope` | anyone | `?sign=Leo` for one, none for all twelve — placeholder readings, see "Still to plug in" below. |
| GET | `/horoscope/daily` | anyone | `?sign=leo&day=next\|previous` — real AstrologyAPI reading (`services/horoscopeCache.service.js`): the first request for a (sign, date) calls the provider and stores the verbatim payload in `HoroscopeCache`; every later request for that sign that day is served from the cache. If the provider fails, the most recent older reading is served with `stale: true` and `date` set to that reading's real date (`requested_date` = the day asked for). |
| GET | `/horoscope/compatibility` | anyone | `?sign=leo` — real AstrologyAPI `zodiac_compatibility` for this sign against the other eleven (`{ sign, items: [{ partner_sign, percentage, report }] }`, best first). Each pair is fetched once ever and kept in `ZodiacCompatibilityCache`; the first request for a sign costs 11 general credits, all later ones none. |
| GET | `/panchang` | anyone | `?date=YYYY-MM-DD` (default today, IST) — real AstrologyAPI panchang for the configured place, fetched at most once per date for the whole site. See "Panchang" below. |
| POST | `/support/tickets` | both apps | Raise a support request or dispute. |
| GET | `/support/tickets` | both apps | The ones this account raised. |

`/settings`, `/horoscope*` and `/panchang` are open because the apps read them
on first launch, before anyone has signed in, and the website's Panchang page
is public. `/settings` deliberately excludes the commission and anything else
about the business.

### Panchang — `GET /panchang`

The website's Panchang page. One place for everyone — `PANCHANG_LAT`,
`PANCHANG_LON`, `PANCHANG_TZONE`, `PANCHANG_PLACE_LABEL` in `.env` (New Delhi,
IST by default) — so the answer for a date is the same for every visitor and
is computed **at most once per date**: the first request of a day makes the
two AstrologyAPI calls (`advanced_panchang` + `chaughadiya_muhurta`, at 06:00
local so the tithi/nakshatra are the sunrise ones), maps them, and stores the
result in `PanchangCache` (`models/PanchangCache.js`, unique on
`{ date, locationKey }`, TTL 24h). Every later request for that date is a
free cache read; concurrent first requests share one in-flight fetch
(`services/panchang.service.js`). Both calls are metered in `ApiUsage` under
`category: 'panchang'` against their own ceiling, `PANCHANG_API_MONTHLY_LIMIT`
(default 100) — separate from the kundli and horoscope pools, same guard
(`assertCreditBudget` in `services/kundliCache.service.js`).

| Query | |
|---|---|
| `date` | optional `YYYY-MM-DD`; default today in IST. Allowed: yesterday … today + 30 days, else `422` with `fields.date`. |

Answers:

```json
{
  "date": "2026-09-23",
  "place": { "label": "New Delhi, India", "latitude": 28.6139, "longitude": 77.209, "tzone": 5.5 },
  "weekday": "Wednesday", "vaar": "Budhavar",
  "subline": "Budhavar · Bhadrapad Shukla Paksha · Shashthi Tithi",
  "sun": { "sunrise": "6:12 AM", "sunset": "7:08 PM" },
  "moon": { "moonrise": "10:15 AM", "moonset": "10:40 PM" },
  "rahuKaal": { "start": "12:12 PM", "end": "1:49 PM" },
  "gulikaKaal": { "start": "10:35 AM", "end": "12:12 PM" },
  "yamaganda": { "start": "7:49 AM", "end": "9:26 AM" },
  "abhijitMuhurat": { "start": "11:47 AM", "end": "12:33 PM" },
  "tithi": { "name": "Shashthi", "number": 6, "paksha": "Shukla", "endsAt": "8:45 PM", "endsNextDay": false },
  "nakshatra": { "name": "Chitra", "number": 14, "lord": "Mars", "endsAt": "3:05 AM", "endsNextDay": true },
  "yoga": { "name": "Dhruva", "endsAt": "2:30 PM", "endsNextDay": false },
  "karana": { "name": "Taitila", "endsAt": "8:45 AM", "endsNextDay": false },
  "masa": { "amanta": "Bhadrapad", "purnimanta": "Bhadrapad" },
  "ritu": "Sharad",
  "samvat": { "vikram": "2083", "shaka": "1948" },
  "choghadiya": {
    "day":   [{ "start": "6:12 AM", "end": "7:49 AM", "name": "Labh", "quality": "Good", "desc": "New beginnings, profit" }, "… 8 in all"],
    "night": [{ "start": "7:08 PM", "end": "8:31 PM", "name": "Udveg", "quality": "Bad", "desc": "Avoid important work" }, "… 8 in all"]
  },
  "cache": { "hit": false, "fetchedAt": "2026-09-23T00:31:12.000Z", "expiresAt": "2026-09-24T00:31:12.000Z" }
}
```

Every time is IST wall-clock, `h:mm AM/PM`. `endsNextDay` is true when the
boundary falls after midnight (the provider reports hour ≥ 24). Anything the
provider does not send for a date — `moon`, `gulikaKaal`, `yamaganda`,
`abhijitMuhurat`, `samvat`, `ritu`, or a name inside `tithi`/`nakshatra`/
`yoga`/`karana` — comes through as `null`, never an error. Choghadiya
quality/desc is the fixed table: Amrit → Excellent "All auspicious work",
Shubh → Good "Auspicious ceremonies", Labh → Good "New beginnings, profit",
Char → Good "Travel, business", Udveg → Bad "Avoid important work", Kaal →
Bad "Avoid all work", Rog → Bad "Avoid health decisions"; an unknown name
rates `Neutral` with `desc: null`. `cache.hit` is `false` for every request
that waited on the day's fetch, `true` afterwards. A `429`
`astrology_credit_limit_reached` means this month's panchang ceiling is
spent; cache hits still answer.

`npm run test:panchang` proves all of this against a stubbed provider.

## Kundli — `/places`, `/birth-profiles`, `/kundli` *(user_app + website)*

Every chart is generated once (the 11-call AstrologyAPI batch in
`services/kundli.service.js`) and cached forever by birth moment in
`KundliCache`; every read below is served from that cache. Reads are scoped to
the account that owns the profile — someone else's `profileId` is a plain 404.

| Method | Path | What |
|---|---|---|
| GET | `/places/search?q=` | Birth-place suggestions (3+ chars). |
| POST | `/birth-profiles` | Create a profile and generate its chart. |
| GET | `/kundli/me` | Is there a chart for the seeker's current birth details? |
| GET | `/kundli/:profileId` | Chart image, lagna, key positions, planetary table. The overview also carries `birth: { fullName, gender, dateOfBirth, timeOfBirth, place }` — the birth this chart was cast for (the report prints these, not the account's current details). |
| GET | `/kundli/:profileId/dasha` | Mahadasha list + the running antardasha. |
| GET | `/kundli/:profileId/dasha/:lord` | Antardasha for one mahadasha lord (lazy, cached on first tap). |
| GET | `/kundli/:profileId/doshas` | Kaal Sarp, Sade Sati, Pitra. |
| GET | `/kundli/:profileId/strength` | Shadbala. |
| GET | `/kundli/:profileId/remedies` | Gemstone + puja suggestions. |
| GET | `/kundli/:profileId/analysis/:domain` | Career / finance / health / marriage reading — see below. |

### Life-area analysis — `GET /kundli/:profileId/analysis/:domain`

`domain` is one of `career`, `finance`, `health`, `marriage` (anything else is
422). AstrologyAPI has no endpoints for these areas, so the reading is computed
by a deterministic rule engine (`services/kundliAnalysis.service.js`, rules and
wording in `config/kundliRules.js`) from the sections the batch already cached
— **it never calls the provider and never spends a credit**. The same chart
always yields the same text, and every statement names the chart factor it
comes from.

```json
{
  "profileId": "…", "domain": "career",
  "confidence": "high",
  "tiles": [{ "label": "Best Career Fields", "value": "Engineering, Defence, Manufacturing, Construction" }, …],
  "summary": "Your 10th house of career is Aries, and its lord Mars sits in the 3rd house in Virgo — …",
  "factors": [{ "title": "10th house lord", "text": "…", "tone": "positive", "basis": "Mars in the 3rd house (Virgo, neutral)" }, …],
  "periods": [{ "label": "Sun mahadasha", "from": "2031-10", "to": "2037-10", "tone": "positive", "reason": "…" }, …],
  "scores": { "tenthHouse": 50, "tenthLord": 60, "sun": 70, "saturn": 75, "mercury": 50, "jupiter": 63, … },
  "basedOn": ["Lagna Cancer (lord Moon)", "Moon in Pisces, Revati nakshatra", "Current mahadasha: Venus (2011–2031)", …],
  "disclaimer": "Generated from your birth chart by Shree Astro's rule engine — general guidance, not a substitute for a consultation."
}
```

- `tiles` — always four, with fixed labels per domain: Career `Best Career
  Fields` / `Career Period` / `Favorable Direction` / `Lucky Days`; Finance
  `Financial Outlook` / `Investment Type` / `Caution Period` / `Gain Period`;
  Health `Body Constitution` / `Sensitive Areas` / `Favorable Period` /
  `Precaution`; Marriage `Marriage Timing` / `Spouse Direction` /
  `Compatibility` / `Marriage Life`.
- `factors` — 3 to 6, `tone` is `positive` | `caution` | `neutral`, `basis` is
  the placement the statement rests on ("Saturn in the 8th house (Aquarius, own
  sign, retrograde)").
- `periods` — at most 4 dasha windows over the next 12 years, `YYYY-MM`,
  earliest first, the running one clipped to the current month. The running
  mahadasha's antardashas are used when `/dasha` has already cached them
  (`sub_vdasha/:lord`); otherwise mahadashas only.
- `scores` — the 0–100 strengths the reading was built from (planet: dignity,
  Shadbala, retrograde/combustion, house placement, benefic/malefic influence;
  house: its lord plus occupants and aspects).
- `confidence` — `high` when Shadbala and the three dosha reports are cached,
  `medium` when any of them is missing (the reading still answers).
- `409 kundli_not_ready` — the profile is still `pending` or is `failed`; open
  `GET /kundli/:profileId` first, which retries the missing batch sections.

`npm run test:kundli-analysis` runs the rule engine on the captured fixtures
with no database; `npm run test:kundli-read` covers the cached, credit-free
read path.

## Platform settings

One document, edited from the panel, read live on every money path — so a change
governs the very next top-up and the very next consultation:

| Setting | Governs |
|---|---|
| `commissionPercent` | the default cut for a newly created astrologer |
| `minRecharge` / `maxRecharge` | `POST /wallet/topup` |
| `minPayout` | `POST /wallet/withdrawals` |
| `features.*` | registrations, Apple/Google sign-in, the AI assistant, voice, auto-approve, maintenance mode |
| `appVersions.*` | what the apps check themselves against on launch |

## Where things live

```
config/      env, mongo, redis
models/      the shapes, and the rules that belong to one document
services/    the rules — no HTTP in here at all
controllers/ read the request, call a service, shape the answer
routes/      which URL goes to which controller, and who is allowed
middlewares/ auth, validation, uploads, errors
socket/      live chat — a transport over services/chat.service.js
```

A route never contains logic, and a service never knows it is being called over
HTTP. That is why the socket layer and the REST layer can share one rulebook.

## Still to plug in

| What | Where |
|---|---|
| SMS / email for OTPs | `deliverOtp` in `services/otp.service.js` |
| Payment gateway | `startTopUp` / `confirmTopUp` in `services/wallet.service.js` |
| Ephemeris for kundli charts | `saveKundli` in `services/user.service.js` |
| Google / Apple sign-in credentials | code is complete (`loginWithGoogle`/`loginWithApple` in `services/auth.service.js`); an admin still has to enter each provider's credentials under Settings → Third Parties, or the endpoint answers 400 `google_not_configured` / `apple_not_configured` |
| Image and audio messages | `ENABLED_TYPES` in `models/Chat.js` |
| The AI assistant's answers | `generateAiReply` in `services/chat.service.js` |
| Real horoscope readings on the OLD `/horoscope` route | `services/horoscope.service.js` — `GET /horoscope/daily` is the real one now; this placeholder still backs the older route and `/users/me/home`'s horoscope card |

---

## The store — `/products`, `/orders` *(website + user_app)*

Money is whole rupees and every payment is the wallet: an order debits
`type: 'order_payment'`, a cancellation credits `type: 'refund'` linked back
by `order`. Placing an order runs in one Mongo transaction (needs a replica
set — Atlas is one): the stock comes off each product with a conditional
`$inc` (`stock >= qty`), the wallet is debited, the order is written. Any one
of those failing undoes the rest, so two seekers can never both buy the last
unit and nobody is charged for an order that was not created.

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/products` | anyone | `?category&search&sort=featured\|price_low\|price_high\|rating\|newest&featured=true&page&limit` → `{ items, total, page, limit, categories: [{ key, label, count }] }`; active products only. |
| GET | `/products/:slug` | anyone | slug or id → `{ product, related }` (four more from the same category). A product carries `imageUrl` (cover) and `images` (gallery, up to 8). |
| GET | `/products/:slug/reviews` | anyone | `?rating=1..5&sort=recent|oldest|top|low&page&limit` (pinned always first) → `{ items, total, page, limit, summary: { average, count, distribution: { "1".."5" } } }`. Hidden reviews are left out; pinned first, then newest. `summary` always covers every visible review, whatever `rating` narrows the items to. |
| POST | `/products/:slug/reviews` | user | `{ orderId, rating 1–5, title? (≤80), comment (3–1000) }` — JSON, or multipart with up to 3 `images` photos (stored under `uploads/reviews`; discarded if the review is refused) → 201 `{ review (incl. images: [url]), product: { rating, ratingCount } }`. The order must be the caller's, `delivered`, and contain the product; one review per (product, order). Refusals: 404 (product or order), 400 `code: 'not_delivered'`, 400 `code: 'not_in_order'`, 409 `code: 'already_reviewed'`. |
| POST | `/orders` | user | `{ items: [{ productId, qty }], shipping: { fullName, phone, email, address, city, state, pincode } }` → 201 `{ order }`. |
| GET | `/orders` | user | `?status=active\|delivered\|cancelled&page&limit` — mine, newest first. |
| GET | `/orders/:orderId` | user | `{ order }`; someone else's is a 404. Each line item also carries `review: { id, rating } \| null` and `canReview` (true once the order is `delivered` and that product has not been reviewed from it). The `/orders` list does not. |
| POST | `/orders/:orderId/cancel` | user | only `placed`/`packed` → restocks, refunds → `{ order }`; otherwise 409 `not_cancellable`. |

Totals are computed server-side: `tax` is 18% of the subtotal (rounded),
`shippingFee` is ₹49 under a ₹999 subtotal and free from there. Line items
copy the unit price at purchase. Refusals: 422 `fields`, 400
`code: 'insufficient_balance'` with `details { total, balance, shortfallAmount }`,
409 `code: 'out_of_stock'` with `details { productId, available }`.

Order status flows one way — `placed → packed → shipped → out_for_delivery →
delivered` — and to `cancelled` from anything not yet delivered. Every move
appends to `tracking: [{ status, note, at }]`.

A product review item is `{ id, rating, title, comment, reply, pinned,
createdAt, reviewer: { name (first name + initial), avatarUrl }, verified: true }`
— every review comes from a delivered order, so all are verified purchases.
Reviews are `ProductReview` documents (unique on product + order + user);
`Product.rating` (one decimal) and `ratingCount` are recomputed from the
non-hidden reviews after every new review and whenever an admin hides or
unhides one. Product reviews are moderated with the rest under
`/admin/reviews` (`kind=product`), and the site-wide `GET /reviews` lists
them only when asked with `kind=product`.

## Pujas — `/pujas`, `/puja-bookings` *(website + user_app)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/pujas` | anyone | `?category&search&featured=true&page&limit` → `{ items, total, page, limit, categories }`. |
| GET | `/pujas/:slug` | anyone | `{ puja }` with its `timeSlots`. |
| GET | `/pujas/:slug/slots?date=YYYY-MM-DD` | anyone | `{ date, slots: [{ time, available, left }] }` — today or later; counts confirmed bookings against `maxPerSlot`. |
| POST | `/puja-bookings` | user | `{ pujaId (id or slug), date, time, contact: { fullName, phone, email, gotra?, address? }, notes? }` → 201 `{ booking }`. |
| GET | `/puja-bookings` | user | `?status=upcoming\|completed\|cancelled&page&limit` — upcoming sorts by date ascending. |
| GET | `/puja-bookings/:bookingId` | user | `{ booking }`. |
| POST | `/puja-bookings/:bookingId/cancel` | user | confirmed and not yet started → refund → `{ booking }`; else 409 `not_cancellable`. |
| POST | `/puja-bookings/:bookingId/rate` | user | `{ rating 1–5, comment? }` once the booking is `completed`, once → moves the puja's `rating`/`ratingCount`. |

A booking debits `type: 'puja_booking'` and links itself by `pujaBooking`;
refunds link the same way. A full slot is a 409 `code: 'slot_full'`. Inside
the booking transaction every booking of a puja first writes the Puja document
itself, which makes two bookings racing for the last place in a slot conflict
and retry — the loser then sees the winner's row and is refused.

## Articles — `/articles` *(website + user_app)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/articles` | anyone (`optionalAuthenticate`) | `?category&search&page&limit` → `{ items, total, page, limit, categories: [{ key, count }] }`; published only, and `visibility: 'users'` rows only for a signed-in caller. Items carry no `body`. |
| GET | `/articles/:slug` | anyone (`optionalAuthenticate`) | `{ article }` with `body`; counts a view. Unpublished, or members-only without a token, is a 404. |

`readMinutes` is worked out from the body on every save (words / 200). The
slug follows the title unless one is sent explicitly; a clash gets `-2`, `-3`.

## Admin panel — Shop, Pujas and article covers

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/products` | `shop.view` |
| POST | `/admin/products` | `shop.manage` — JSON, or multipart with an optional cover `image` (one) and gallery `images` (up to 6 files per request) |
| PUT | `/admin/products/:id` | `shop.manage` — same; `keepImages` (JSON array of existing gallery URLs, in order) says which of the stored gallery to retain — when sent, the gallery becomes `keepImages` + the new uploads; when absent the stored gallery is kept and uploads are appended. `imageUrl` may name a gallery URL to promote it to cover. The gallery is capped at 8 (422 `fields.images`). With no cover but a gallery, the first gallery image becomes the cover. Removing the cover's URL from the gallery is fine — the cover stays. |
| PATCH | `/admin/products/:id/status` | `shop.manage` — `{ status: active\|hidden\|archived }` |
| DELETE | `/admin/products/:id` | `shop.manage` — archives → `{ deleted: true }` |
| GET | `/admin/orders` | `shop.view` — `?status&search&page&limit`; rows carry `user: { id, name, phone }` |
| GET | `/admin/orders/:id` | `shop.view` |
| PATCH | `/admin/orders/:id/status` | `shop.manage` — `{ status, note? }`; forward only, or `cancelled` (refund + restock); backward is a 409 `invalid_transition` |
| GET | `/admin/pujas` | `pujas.view` |
| POST | `/admin/pujas` | `pujas.manage` — JSON or multipart `image` |
| PUT | `/admin/pujas/:id` | `pujas.manage` |
| PATCH | `/admin/pujas/:id/status` | `pujas.manage` |
| DELETE | `/admin/pujas/:id` | `pujas.manage` — archives |
| GET | `/admin/puja-bookings` | `pujas.view` — `?status&date&search&page&limit` |
| GET | `/admin/puja-bookings/:id` | `pujas.view` |
| PATCH | `/admin/puja-bookings/:id` | `pujas.manage` — `{ status?: completed\|cancelled, streamUrl?, adminNote? }`; cancel refunds |
| GET | `/admin/articles/:id` | `content.view` |
| POST / PUT | `/admin/articles[/:id]` | `content.manage` — now also multipart with a `coverImage` → `coverImageUrl` |

`content_manager` holds the four new permissions (`shop.view`, `shop.manage`,
`pujas.view`, `pujas.manage`) alongside content. `GET /admin/dashboard` gains
`shop: { ordersToday, pendingOrders, revenue30d }` and
`pujas: { bookingsToday, upcoming }`. Audit areas: `Shop`, `Pujas`.

In multipart form, a list field (`highlights`, `images`, `keepImages`,
`benefits`, `timeSlots`, `tags`) may be a JSON array or one entry per line /
comma. (`keepImages: []` must be sent as the JSON string `[]` — an empty
field reads as "not sent".)

### Seeding the launch catalogue

```
npm run seed:commerce
```

Upserts by slug the website's 10 products, 6 pujas and 8 articles, with images
served from `uploads/seed/<slug>.jpg` at `PUBLIC_URL` (or
`http://localhost:5000`). Running it again refreshes copy and prices but leaves
stock and ratings alone.

## Offers & coupons — `/offers`, `/coupons` *(website + user_app)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/offers` | anyone (`optionalAuthenticate`) | `{ coupons: PublicCoupon[], festivals: FestivalOffer[], loyalty: { enabled, tiers: [{ key, name, minPoints, maxPoints, cashbackPercent, perks }], earn: [{ key, label, pointsPer100 }], me? }, referral? }` — `me` (`{ points, lifetimePoints, tier, nextTier, pointsToNext }`) and `referral` (`{ code, link, rewardAmount, invited, completed, earned }`) only for a signed-in seeker. Coupons are the active, public ones inside their date window; festivals the active cards inside theirs, by `sortOrder`. |
| POST | `/coupons/validate` | user | `{ code, context: order\|puja\|topup, amount }` → `{ valid: true, coupon: PublicCoupon, discount, payable }`, or 400 `code: 'coupon_invalid'` with a human reason (unknown, paused, not yet active, expired, wrong context, below `minAmount`, usage limit, already used). |

`PublicCoupon` is `{ id, code, title, description, kind, value, maxDiscount, minAmount, appliesTo, validTo, tag, tone, label }` — `label` is `50% OFF` / `₹200 OFF`. A percent coupon is capped by `maxDiscount`; no coupon ever takes off more than the amount.

**Using one.** `POST /orders` and `POST /puja-bookings` accept an optional `couponCode`. The coupon is checked before any money moves and redeemed inside the same transaction as the wallet debit, so a failed purchase never uses one up. The order carries `{ subtotal, discount, coupon, couponCode, total }` (the discount is on the subtotal; tax and shipping are unchanged); the booking carries `{ subtotal, discount, coupon, couponCode, amount, total }` where `amount === total` is what was charged. Cancelling refunds what was actually paid. `POST /wallet/topup { amount, couponCode? }` treats a `topup` coupon as a *bonus*: the start response gains `{ couponCode, bonusAmount }`, and `POST /wallet/topup/confirm` credits the bonus as a second `type: 'bonus'` row (`Coupon CODE bonus`) and reports `{ couponCode, bonusAmount }` on the transaction.

## Loyalty — `/loyalty` *(website + user_app)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/loyalty` | user | `{ points, lifetimePoints, tier, nextTier, pointsToNext, cashbackPercent, tiers, history: LoyaltyTransaction[20] }`. |
| GET | `/loyalty/history` | user | `?page&limit` → `{ items, total, page, limit }`; a row is `{ id, type: earn\|redeem\|adjust\|bonus, points (signed), reason, source: { kind, id }, balanceAfter, createdAt }`. |

Points are earned on what a seeker spends, at `settings.loyalty.pointsPer100[kind]` (defaults chat 10, call 12, order 8, puja 8 per ₹100): a chat or call **ends** with `amountCharged > 0` (`chat.service.endChat`, after billing is settled), an order reaches **delivered**, a puja booking is marked **completed**. Registration adds `signupBonusPoints` (50). `lifetimePoints` never falls and decides the tier from `settings.loyalty.tiers` (silver 0, gold 500, platinum 2000, diamond 5000). Every award is one `LoyaltyTransaction` claimed under a dedupe key, so a hook running twice for the same event pays once; every award notifies the seeker (`type: 'reward'`, "You earned N points"). When `settings.loyalty.cashbackEnabled` is on, the tier's `cashbackPercent` of each consultation charge lands in the wallet as `type: 'cashback'`, once per session. The hooks live in `services/growthHooks.service.js`.

## Referral — `/referral` *(website + user_app)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/referral` | user | `{ code, link, rewardAmount, minFirstSpend, stats: { invited, completed, earned }, recent: [{ name (masked, "Kavya R."), status, at }] }`. The code (`SA` + 6) is made the first time it is asked for; `link` is `${PUBLIC_WEB_URL \|\| 'https://shreeastro.com'}/login?ref=CODE`. |

`POST /auth/register` accepts `referralCode`; an unknown code, or the account's own, is ignored (the reply is still 201, with `referralApplied: false`). A valid one sets `referredBy` and opens a `Referral` in `signed_up`. The first time the referred seeker spends at least `settings.referral.minFirstSpend` (₹100) on a **finished** consultation, a **delivered** order or a **completed** puja, the referral is claimed into `rewarded`: both wallets get `settings.referral.rewardAmount` (₹200) as `type: 'referral_bonus'`, the referrer also gets `loyalty.referralBonusPoints` (100), and both are told (`type: 'referral'`). One reward per referred account, ever.

## Reviews & testimonials — `/reviews`, `/testimonials` *(website)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/reviews` | anyone | `?rating=1..5&min=1..5&kind=consultation\|puja\|product&page&limit` → `{ items, total, page, limit, summary: { average, count, breakdown: { 5..1 }, categories: { consultation, puja } } }`. Pinned first, then newest. Hidden and flagged reviews are left out. Without `kind` the list is consultations + pujas; `kind=product` returns product reviews only (`summary` is always the consultation + puja numbers). |
| GET | `/testimonials` | anyone | `?kind=video\|story&limit` → `{ items, total }` of published testimonials by `sortOrder`. The homepage takes `?kind=story&limit=3`. |

A review item is `{ id, kind, rating, comment, reply, pinned, createdAt, reviewer: { name (first name + initial), avatarUrl } }` plus, for a consultation, `astrologer: { id, name, photo }`, `channel`, `durationSeconds`, for a puja, `puja: { id, name, slug }`, and for a product, `title` and `product: { id, name, slug }`. Consultation and puja reviews stay on the record they were written on (`ChatSession.review`, `PujaBooking.rating/review`); a product review is its own `ProductReview` document. The list is one `$unionWith` aggregation projected onto that shape. A testimonial is `{ id, kind, title, quote, name, city, tag, outcome, duration, avatarUrl, thumbnailUrl, videoUrl, views }`.

## Careers — `/careers` *(website)*

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/careers/jobs` | anyone | `?department&page&limit` → `{ items, total, page, limit, departments: [{ key, label, count }] }`, open postings only. |
| GET | `/careers/jobs/:slug` | anyone | `{ job }` (slug or id; 404 unless open). |
| POST | `/careers/applications` | anyone, 10/hour/IP | multipart or JSON `{ jobId?, kind: job\|astrologer\|internship, roleTitle?, fullName, email, phone, experience?, linkedin?, message?, resume? }` → 201 `{ application: { id, reference ('APP-' + 6), roleTitle, kind, status } }`. `resume` is a PDF or Word document up to 5 MB (`uploadResume`, stored under `uploads/resumes`). With `jobId` the title and kind come from the posting; without one, `roleTitle` defaults to "Astrologer Application" / "Internship Program" by `kind`. Admins are notified (`type: 'application'`). |

## Admin panel — Offers, Reviews, Careers

| Method | Path | Permission |
|---|---|---|
| GET | `/admin/coupons` | `offers.view` — `?status&search&page&limit` |
| POST | `/admin/coupons` | `offers.manage` — `{ code, title, description?, kind, value, maxDiscount?, minAmount?, appliesTo[], validFrom?, validTo?, usageLimit?, perUserLimit?, status?, isPublic?, tag?, tone? }`; a taken code is a 409 `duplicate_code` |
| PUT | `/admin/coupons/:id` | `offers.manage` |
| PATCH | `/admin/coupons/:id/status` | `offers.manage` — `{ status: active\|paused\|expired }` |
| DELETE | `/admin/coupons/:id` | `offers.manage` — only while `usedCount` is 0, else 409 `coupon_used` |
| GET | `/admin/coupons/:id/redemptions` | `offers.view` — `{ items: [{ id, user, context, reference, amountBefore, discount, createdAt }], total, page, limit, coupon }` |
| GET | `/admin/festival-offers` | `offers.view` |
| POST | `/admin/festival-offers` | `offers.manage` — JSON, or multipart with an `image` |
| PUT | `/admin/festival-offers/:id` | `offers.manage` — same |
| PATCH | `/admin/festival-offers/:id/status` | `offers.manage` — `{ status: active\|hidden }` |
| DELETE | `/admin/festival-offers/:id` | `offers.manage` |
| POST | `/admin/loyalty/adjust` | `wallets.adjust` — `{ userId, points (signed, non-zero), reason }` → 201 `{ transaction, loyalty }`; cannot take points below zero |
| GET | `/admin/referrals` | `users.view` — `?status&search&page&limit`; rows carry `referrer` and `referred` as `{ id, name, phone, email }` |
| GET | `/admin/reviews` | `reviews.view` — `?kind=consultation\|puja\|product&rating&flagged&hidden&search&page&limit`; without `kind` all three kinds; items as the public list plus `hidden`, `flagged`, `flagReason`, `user` and the reviewer's full name. `search` matches the comment, a product review's title, and the reviewer's, astrologer's, puja's or product's name |
| PATCH | `/admin/reviews/:kind/:id` | `reviews.manage` — `kind` is `consultation` (id = chat id), `puja` (id = booking id) or `product` (id = review id); `{ hidden?, pinned?, flagged?, flagReason?, reply? }` → `{ review }`. Hiding or unhiding a product review recomputes the product's `rating`/`ratingCount` |
| GET | `/admin/testimonials` | `reviews.view` — `?kind&status&page&limit` |
| POST | `/admin/testimonials` | `reviews.manage` — JSON, or multipart with `avatar` and/or `thumbnail` |
| PUT | `/admin/testimonials/:id` | `reviews.manage` — same |
| PATCH | `/admin/testimonials/:id/status` | `reviews.manage` — `{ status: published\|draft }` |
| DELETE | `/admin/testimonials/:id` | `reviews.manage` |
| GET | `/admin/jobs` | `careers.view` — `?status&department&search&page&limit` |
| POST | `/admin/jobs` | `careers.manage` — `{ title, department, location?, type?, experience?, tags?, description?, responsibilities?, requirements?, stipend?, salary?, openings?, status?, postedAt? }` |
| PUT | `/admin/jobs/:id` | `careers.manage` — the slug follows a changed title unless sent |
| PATCH | `/admin/jobs/:id/status` | `careers.manage` — `{ status: open\|closed\|draft }` |
| DELETE | `/admin/jobs/:id` | `careers.manage` — applications keep their `roleTitle`, their `job` link is cleared |
| GET | `/admin/applications` | `careers.view` — `?status&kind&job&search&page&limit` |
| GET | `/admin/applications/:id` | `careers.view` |
| PATCH | `/admin/applications/:id` | `careers.manage` — `{ status?: received\|shortlisted\|interview\|rejected\|hired, adminNote? }` |

Permissions: `offers.view/manage` (super_admin, admin, finance), `reviews.view/manage` and `careers.view/manage` (super_admin, admin, content_manager). Audit areas: `Offers`, `Reviews`, `Careers` (a loyalty adjustment logs under `Wallets`). `GET /admin/users/:id` now carries `loyalty: { points, lifetimePoints, tier, nextTier, pointsToNext }` and `referral: { code, referredBy, invited, completed, earned }`. `PATCH /admin/settings` accepts `loyalty: { enabled, pointsPer100: { chat, call, order, puja }, referralBonusPoints, signupBonusPoints, tiers: [{ key, minPoints, cashbackPercent }] (all four), cashbackEnabled }` and `referral: { enabled, rewardAmount, minFirstSpend }`, merged key by key; `GET /settings` exposes both blocks.

New enum values: `Notification.type` += `reward`, `referral`; `WalletTransaction.type` += `cashback`, `referral_bonus` (both credits; `bonus` stays for admin and coupon top-up bonuses).

### Seeding the growth content

```
npm run seed:growth
```

Upserts the website's four coupons (by code), four festival cards (by title), four video and three story testimonials (by kind + title) and six job postings plus four internships (by slug), copying the images it needs from `shree_astroWeb/src/assets/pages/{offers,reviews}` into `uploads/seed/` and storing them as absolute URLs at `PUBLIC_URL` (or `http://localhost:5000`). Running it again refreshes copy but leaves a coupon's `usedCount` and a testimonial's `views` alone.
