# Postman collections

Three collections, one per client, plus one shared environment.

| File | Requests | For |
|---|---|---|
| `Shree Astro - User App.postman_collection.json` | 39 | `user_app` |
| `Shree Astro - Astrologer App.postman_collection.json` | 41 | `astro_app` |
| `Shree Astro - Admin Panel.postman_collection.json` | 41 | `admin_panel` |
| `Shree Astro - Local.postman_environment.json` | — | shared by all three |

Between them they cover all 97 routes.

## Importing

In Postman: **Import** → drag all four files in at once. Then pick
**Shree Astro — Local** from the environment dropdown, top right.

Selecting the environment matters. The collections chain requests by saving ids
out of responses, and those saves go to the environment. (They fall back to
collection variables if no environment is selected, but then the three
collections can't share ids — the admin panel wouldn't know which astrologer to
approve.)

## Before you start

```bash
cd backend
npm run seed:admin     # admin@shreeastro.com / admin@123
npm run dev
```

Needs MongoDB and Redis running. `baseUrl` defaults to
`http://localhost:5000/api/v1` — change it in the environment for a real device
or a deployed server.

## You don't copy tokens

Every sign-in request has a test script that saves the tokens for you, and each
collection sends its own automatically:

| Collection | Sends |
|---|---|
| User App | `Bearer {{userAccessToken}}` |
| Astrologer App | `Bearer {{astroAccessToken}}` |
| Admin Panel | `Bearer {{adminAccessToken}}` |

Three separate tokens, so all three can be signed in at once — which is what you
want when an admin is approving an astrologer a seeker is about to consult.

Ids chain the same way. Browsing the directory saves `{{astrologerId}}`,
requesting a chat saves `{{chatId}}`, and so on, so the next request in the
folder already points at the right record.

## You don't copy OTPs either

There's no SMS or email provider yet, so **Request login OTP** returns the real
code as `devCode` and saves it to `{{devCode}}` — **Verify OTP** picks it up on
its own. It's also printed to the server log.

Or skip step one: put `{{masterOtp}}` (`123456`) in the code field. That master
code works for every account until a provider is wired in, and the server
refuses to boot in production while it's set.

## The order that works

The three collections are meant to be run together, because the platform's main
flow crosses all three:

There are two ways to get an astrologer onto the platform. Pick one.

**A — the admin creates them** (the short form, and the quicker route):

1. **Admin Panel** → *2 · Sign in*, then *5 · Astrologers → Create astrologer*.
   Four fields: email, commission, availability, status.
2. **Astrologer App** → *3 · Signing in* — change the OTP request to
   `channel: "email"` with that address, and sign in.
3. **Astrologer App** → *4 · My profile* — fill the profile in, then
   *Set my opening rates*, then go online.

**B — the astrologer applies:**

1. **Astrologer App** → *2 · Application* — register, upload a document, add a
   bank account, submit. Attach a real file on the two upload requests.
2. **Admin Panel** → *5 · Astrologers* — approve the document, the bank account,
   then the application. That last step sets the rates for them.
3. **Astrologer App** → *4 · My profile* — go online.

Then, either way:
4. **User App** → register, top up the wallet, browse the directory, request a
   chat.
5. **Astrologer App** → *6 · Consultations* — accept it.
6. Either side sends messages and ends the chat; the seeker rates it.
7. **Astrologer App** → *8 · Earnings* — request a withdrawal.
   **Admin Panel** → *8 · Payouts* — pay it out.

Three things trip people up if they skip ahead: the directory only lists an
astrologer once they are **approved and have set a rate**; a chat can't start
until the seeker has free minutes or money in the wallet; and an admin-created
astrologer signs in by **email**, not by phone.

## Reading the descriptions

Every request has a description covering what it does, which fields matter, what
it refuses and why, and — where it applies — which admin permission it needs and
what's still a placeholder (payments, OTP delivery, the kundli ephemeris). Open
the request and read the pane on the right.

## Live chat isn't in here

Messages normally travel over socket.io, which Postman can't drive. The REST
`POST /chats/:chatId/messages` in these collections is the real fallback
endpoint and behaves identically — it stores the message and broadcasts it to
the room. See the socket section of `../API.md` for the event names, and
`tests/socket.test.js` for a working client.
