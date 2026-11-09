# AgentCard integration

Payments for agents running on Chusky. Each user gets a browser and a payment
system together (plan sections 0 and 5). The user stores their own card once, on
AgentCard's page. The card number never reaches this app or the model. Each
purchase needs the user's approval on their own device with their passkey.

**Status:** built, wired into `server.js`, and tested offline (121 tests, including
real HTTP and a restart). It has not yet run against live AgentCard. The live step
needs sandbox credentials and a human to complete the passkey enrolment.

## Routes

All user routes sit behind the app's access-key middleware. The backend names the
user with `userId` (in the body or the query). The webhook is the one exception:
AgentCard calls it, and its HMAC signature is the only authentication.

| Method and path | What it does |
|---|---|
| `POST /agentcard/vault/enrol` | Returns `has_card` if the user already has a card, otherwise a vault link. `addAnother: true` mints a link that adds a second card for the same user. |
| `GET /agentcard/vault/sessions/:id?userId=` | Owner-only status of a link: `pending`, `linked`, `expired` or `conflict`. Reads are budgeted. |
| `GET /agentcard/vault/cards?userId=` | Stored cards, display fields only (brand, last4, expiry). |
| `POST /agentcard/purchases` | Requests an approval-gated purchase. Returns `approvalUrl` for the backend to deliver to the user untouched. |
| `GET /agentcard/purchases?userId=` | The user's purchases. |
| `GET /agentcard/purchases/:id?userId=` | One purchase, its event log and whether a retry is safe. |
| `POST /agentcard/purchases/:id/cancel` | Cancels a purchase still awaiting approval. |
| `POST /agentcard/purchases/:id/refresh` | Reads the authoritative status from AgentCard (use when a webhook is late). |
| `POST /agentcard/commerce/buy` | One buy call for the user (products, food, tables, flights). The backend sends `userId` and the model's five fields. Returns `model` (no links) and the links and products to deliver. |
| `GET /agentcard/commerce/tool` | The buy tool's definition from the SDK, for the backend's model. |
| `GET /agentcard/merchants` | Merchant check: whether AgentCard can pay at each store (`supported`). With `userId`, direct merchants carry `link_status` (connections). |
| `POST /agentcard/webhooks` | Signed AgentCard events. Mounted before the JSON parser so the raw bytes are verified. |

Every route has an `@openapi` block in `server.js`, and the spec is in `openapi.json`.

## How a card gets stored

1. Backend calls `POST /agentcard/vault/enrol` with its user id.
2. If the user has no card, the response carries a vault link. The backend sends it
   to the user unchanged. The user enters the card on AgentCard's page, in the
   company brand, and approves with a passkey.
3. Storage is learned from the `vault.session_linked` and `vault.card_stored`
   webhooks, or by polling `GET /vault/sessions/:id`, whichever comes first.
4. The AgentCard user id is saved against our user id, and the session is closed.
   A returning user is checked first (`vault_cards`), so they are never enrolled twice.

## Where user ids are stored and found

- Our user id maps to AgentCard's user id in the durable state file. Path:
  `<profile dir>/../agentcard/state.json`, mode `0600`, written atomically.
- It holds ids and purchase records only. No card data, tokens, client secrets
  or webhook secrets.
- It is reloaded on boot. A corrupt file is moved aside and the app starts empty.
- If the file is lost, a `vault.session_linked` webhook still re-links the user,
  because AgentCard sends our `external_user_id` back.

## Layout

```
agentcard/
  src/
    api.js            REST client: token cache, retries, errors without secrets
    config.js         credentials from loadConfig(); no process.env reads here
    store.js          in-memory store contract (snapshot, restore, de-duplication)
    file-store.js     the store, persisted atomically to state.json
    vault.js          enrolment: check, link, poll, record the mapping
    checkout.js       approval-gated purchases, state machine, retry rule, limits
    webhook.js        HMAC verification of the raw body
    webhooks.js       receiver: verify, de-duplicate, dispatch, 500 on failure
    http.js           Express handlers (server.js mounts them)
    interception.js   pays on any page (Chusky included): pauses the card request, approval, fulfil
    account.js        processors, vault link, disconnect/erase, spend presets
    commerce.js       buy tool from @agent-cards/commerce-sdk, bound to our userId; merchant check
    service.js        composes everything; boot never fails without credentials
    index.js          public exports
  test/
    helpers.js        makeService() with a fake clock and fake AgentCard
    fake-agentcard.js in-process double built from the documented contract
    agentcard.test.js, vault.test.js, checkout.test.js, webhooks.test.js,
    http.test.js, persistence.test.js, payments.test.js, commerce.test.js
  scripts/
    sandbox-check.mjs live check (sandbox credentials)
    camoufox-pay-check.mjs payment on Firefox (Camoufox), no Chromium. --engine-only needs no account
```

## Run the tests

```
node --test agentcard/test/agentcard.test.js agentcard/test/vault.test.js \
  agentcard/test/checkout.test.js agentcard/test/webhooks.test.js \
  agentcard/test/http.test.js agentcard/test/persistence.test.js \
  agentcard/test/payments.test.js agentcard/test/commerce.test.js
```

No network, credentials or SDK are needed. The fake implements the endpoints and
statuses from the AgentCard docs, and enforces bearer auth.

## Configuration

Environment variables hold only secrets and service URLs. Behaviour is never set
by environment variables. `lib/config.js` is the only place that reads them.

| Variable | Required | Purpose |
|---|---|---|
| `AGENTCARD_CLIENT_ID` | yes | Platform client id |
| `AGENTCARD_CLIENT_SECRET` | yes | Platform client secret |
| `AGENTCARD_WEBHOOK_SECRET` | for webhooks | Endpoint signing secret (`whsec_...`), shown once at creation |
| `AGENTCARD_BASE_URL` | no | Defaults to `https://api.agentcard.sh` |

Sandbox or production is set by the credentials. Start with sandbox. The connect
code is `111111`, and Stripe's published test card works.

Keep secrets in the environment or a secret store. Never commit them, log them or print them.

## Payment on Firefox (no Chromium)

```
npm run fetch-bin                                        # once: downloads the Camoufox binary
node agentcard/scripts/camoufox-pay-check.mjs --engine-only   # Firefox launches; a page request is paused and answered
node agentcard/scripts/camoufox-pay-check.mjs --user camo-check  # full sandbox payment, with your approval
```

The full check opens a sandbox enrolment link, waits for the card, pays on a local checkout
page, and prints an approval link for your device. It has not been run yet.

## Live check (sandbox only)

```
node agentcard/scripts/sandbox-check.mjs                          # token, session, poll, error handling
node agentcard/scripts/sandbox-check.mjs --user usr_...           # + approval-gated purchase: create, read, cancel
node agentcard/scripts/sandbox-check.mjs --register-url https://<railway-url>/agentcard/webhooks
```

- `--user` needs an AgentCard user id that already has a sandbox card on file. It
  looks up that user's first card and fails clearly if there is none.
- `--register-url` writes the endpoint secret to `.env` as `AGENTCARD_WEBHOOK_SECRET`.
  The value is never printed.
- The script exits non-zero if any check that ran fails.

## Mounting

Mounted in `server.js`, always on. Without credentials the routes answer `503` with
the missing variable names, so a deploy without them keeps working.

Order in `server.js`, and why:
- The webhook route comes before the global JSON parser, so the signature is
  checked against the exact bytes. The handler refuses with `500 raw_body_required`
  if the body was already parsed.
- The user routes come after the access-key middleware.
- Shutdown flushes the state file.

## Assumptions to confirm in sandbox

These are not fully documented. The code handles them defensively, and the live check confirms them.

- The vault card list envelope (`data` array). Display fields are mapped from it.
- The `vault.card_stored` payload fields (`user_id`, `card_id`, `brand`, `last4`).
- The checkout webhook `data` object: `data.id` is the authorization id, and
  `data.settlement` is present when settlement is known.
- Sandbox and production users are separate. A user id from one does not work in the other.

## Rules this module follows

- The API is called from the backend only.
- Card numbers never go through the app or the model. Enrolment uses a link, and the link is sent unchanged.
- One AgentCard user id per end user. Never shared across users.
- Verify webhook signatures on the raw body. Reject timestamps older than 5 minutes.
- Act on webhook events, not on what the agent says.
- `approved` and `submitted` purchases are never retried. A purchase is retried only
  after a decline, expiry or refusal, or a final unconfirmed settlement.
- Purchase limits: decided. The app sets no cap (`DEFAULT_MAX_AMOUNT_CENTS` is `null`). Each user sets their own limits with AgentCard presets (`agentcard_preset_set`), and AgentCard enforces them before any approval.

## Not built yet

- Live verification of the purchase approval path (needs a sandbox user with a card).
- Q4 answered from the SDK's own docs: its browser attach is Chromium-only, so it is not used on Chusky. Payment on Chusky uses the interception path instead, which is unverified live.
- Live verification of the buy tool against AgentCard's `/buy` endpoints (offline tests use an injected buy tool; the merchant check runs over HTTP against the documented shape).
- Flight traveler details and flight cancellation. The current Commerce SDK and REST docs do not document `buy_save_traveler` or `buy_cancel_flight`, so they are not built. Flights are bought through the buy tool as `book` products.
- Issuing, identity verification, company wallet and user balance (out of scope for this release).
- Identity verification, company wallet, rewards and presets.
- Shared storage (Redis). The state file is single-instance only.
- Fee display and refunds (plan Q2 and Q3).
