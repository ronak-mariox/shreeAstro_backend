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
| POST | `/auth/admin/login` | — | Email + password, admin panel only. |
| POST | `/auth/refresh` | — | New token pair. |
| POST | `/auth/logout` | — | Clears cookies. |
| GET | `/auth/me` | any | The signed-in account. |

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
| PATCH | `/astrologer/me/services` | `{ type, isEnabled, freeMinutes }`. |
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
| POST | `/chats/:id/accept` | astrologer | Take it. The meter starts. |
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
     "freeMinutes": 3, "expiresInSeconds": 120 }
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
| POST | `/wallet/withdrawals` | astrologer | Ask to be paid out. |

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
| PATCH | `/admin/withdrawals/:id` | `payouts.approve` |
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
  "services": [ { "type": "chat", "ratePerMinute": 20, "freeMinutes": 3, "isEnabled": true },
                { "type": "call", "ratePerMinute": 30, "isEnabled": true } ] }
```

Every admin change writes an audit row. Audit rows are never edited or deleted —
a log you can change is not a log.

---

## Shared — `/settings`, `/horoscope`, `/support`

| Method | Path | Who | What |
|---|---|---|---|
| GET | `/settings` | anyone | Recharge limits, feature switches, app versions. |
| GET | `/horoscope` | anyone | `?sign=Leo` for one, none for all twelve. |
| POST | `/support/tickets` | both apps | Raise a support request or dispute. |
| GET | `/support/tickets` | both apps | The ones this account raised. |

`/settings` and `/horoscope` are open because the apps read them on first
launch, before anyone has signed in. `/settings` deliberately excludes the
commission and anything else about the business.

## Platform settings

One document, edited from the panel, read live on every money path — so a change
governs the very next top-up and the very next consultation:

| Setting | Governs |
|---|---|
| `commissionPercent` | the default cut for a newly created astrologer |
| `minRecharge` / `maxRecharge` | `POST /wallet/topup` |
| `minPayout` | `POST /wallet/withdrawals` |
| `freeTrialMinutes` | free minutes on a seeker's first consultation |
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
| Google / Apple sign-in | beside the OTP flow in `services/auth.service.js` |
| Image and audio messages | `ENABLED_TYPES` in `models/Chat.js` |
| The AI assistant's answers | `generateAiReply` in `services/chat.service.js` |
| Real horoscope readings | `services/horoscope.service.js` |
