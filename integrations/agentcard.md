# AgentCard: payments for agents on Chusky

Lets an agent buy things on any website with the user's own card. The user stores
their card once, on AgentCard's page. The card number never reaches our server or
the model. Every purchase waits for the user to approve on their own device with
their passkey. Nothing is charged before that approval.

Status: built and tested offline (`agentcard/test`, 100 tests). Not yet run against
live AgentCard. See "What is verified" at the end.

## Setup (once per company)

1. Set `AGENTCARD_CLIENT_ID` and `AGENTCARD_CLIENT_SECRET` in the server's secret
   store (Railway variables). Start with sandbox credentials.
2. Set `AGENTCARD_WEBHOOK_SECRET` after registering the webhook endpoint:
   `node agentcard/scripts/sandbox-check.mjs --register-url https://<railway-url>/agentcard/webhooks`
3. Without credentials the routes answer `503` and name the missing variables.

Every route below needs the app's access key, like the other Chusky routes.
Pass our stable user id as `userId` (body or query). The webhook is the only route
without it.

## The flow

1. **Store a card.** `POST /agentcard/vault/enrol` with `{ "userId": "<our id>" }`.
   - `200 { "status": "has_card", "cards": [...] }`: the user already has a card. No link.
   - `201 { "status": "link", "url": "...", "sessionId": "..." }`: deliver `url` to the
     user untouched. Do not edit it or build your own. The user enters the card on
     AgentCard's page.
   - Or let AgentCard send the link by text or email: `POST /agentcard/vault/send-link`.
     It returns the `url` only when AgentCard did not send it.
   - Check progress with `GET /agentcard/vault/sessions/{sessionId}?userId=`.
     Statuses: `pending`, `linked`, `expired`, `conflict`.
   - To add a second card: `{ "userId": "...", "addAnother": true }`.
2. **Set spending rules (optional, recommended).** `PUT /agentcard/presets/{label}`
   with `{ "userId": "...", "perDayCents": 5000, "onlyMerchants": ["..."] }`, then
   `POST /agentcard/presets/{label}/attach` with `{ "userId": "..." }`. AgentCard
   enforces the rules before any approval is asked for.
3. **Check where we can pay.** `GET /agentcard/processors` lists processors AgentCard
   can complete. `needsPreparation` lists those that need step 4 first.
4. **Pay.** Two ways:
   - **Browser pay (Chusky, any site).** Open the checkout in a tab. Then:
     `POST /agentcard/tabs/{tabId}/payment` with
     `{ "userId", "merchant", "amount", "currency", "checkoutOrigin" }`. Returns
     `attachmentId`. Now the agent clicks Pay in the tab as normal (existing click route).
     When the page sends its card request, it is paused. `approvalUrl` appears on
     `GET /agentcard/tabs/{tabId}/payment/{attachmentId}?userId=`. Deliver it to the
     user untouched. After approval, the request is completed and the page continues.
     Detach with `DELETE` on the same path.
   - **Approve first.** `POST /agentcard/purchases/prepare` with `{ "userId", "merchant",
     "amount", "currency", "psp", "merchantOrigin" }`. Deliver `approvalUrl`. Poll
     `POST /agentcard/purchases/{purchaseId}/refresh` until `status` is `ready`, then
     start Pay within `readyExpiresAt` (about 30 seconds). Used for processors that
     need approval first.
5. **Read the outcome.** The purchase's `status` moves through `awaiting_approval`,
   `approved`, `submitted_on_device`, `declined`, `expired`, `refused`, `settled`,
   `not_settled`. Read `GET /agentcard/purchases/{purchaseId}?userId=`, which also
   says whether a retry is safe. `approved` is not the merchant's order confirmation.
   Read the order confirmation on the merchant's page.

## Rules the agent must follow

- Never retry a purchase that is `approved` or `submitted_on_device`. Retry only when
  `canRetry` is true (declined, expired or refused, or a final "not settled").
- A tab has one payment attachment at a time. Re-arming replaces it.
- The page can make only one payment through an attachment. Further card requests
  are refused while one is pending or done.
- Never send the user's card number through the chat or to any route. There is no
  route for it.
- Deliver every approval link untouched.

## Errors

| Code | HTTP | Meaning |
|---|---|---|
| `invalid_request` | 400 | Bad input. The message says what. |
| `policy_invalid` | 400 | AgentCard refused a spending rule. |
| `not_enrolled` / `no_card` | 409 | No card on file. Store a card first. |
| `card_not_found` | 404 | That card is not in this user's vault. |
| `over_limit` | 422 | Above the configured limit. |
| `outcome_not_reportable` | 409 | Outcomes are only for auto-approved purchases AgentCard did not charge. |
| `not_configured` | 503 | AgentCard credentials are missing. |
| (upstream) | 502 | AgentCard failed. The body says whether to retry. |

## Disconnect and erase

- `DELETE /agentcard/vault/connection?userId=` disconnects the user at AgentCard.
  Their cards stay in their vault, and the purchase history stays here.
- `DELETE /agentcard/users?userId=` disconnects and removes everything we hold for
  the user. The user can remove their cards in their own vault.
- `202` means AgentCard asked us to call again.

## Limits in this version

- Browser pay works on Chusky (Firefox) with no Chromium. It uses the documented
  "your own interception" path. The AgentCard SDK's browser attach is Chromium-only,
  and it is not used.
- Processors that need approval first (`needsPreparation`) can't be paid through the
  browser path. Use "approve first".
- The approve-first flow and the browser-pay flow are separate. The user approves
  once per purchase on the browser path. How a ready preparation binds to the
  browser's request is not documented. It is open until verified in sandbox.
- Auto-approval (no per-purchase passkey) is not enabled. It is a product decision.
- One payment per attachment, with a 15 minute approval window.

## What is verified

- Offline (`node --test agentcard/test/*.test.js`, 100 tests): every module, the HTTP
  routes, persistence, webhooks, and the payment interception on a Playwright-style
  page. These run against a double of AgentCard built from the documented shapes.
- Live sandbox (`node agentcard/scripts/sandbox-check.mjs`): token, enrolment session,
  polling, and error handling passed in the user's Codespace (6 of 6).
- Not yet verified live: the purchase path, presets, outcomes, disconnect, and the
  browser pay on Chusky against a real processor. Each is a sandbox step.

## Commerce: products, food, tables, flights, merchant check

Built on `@agent-cards/commerce-sdk` (pinned). The SDK's buy tool does the shopping. Our
backend runs it, and the model only ever sees the tool's five fields.

### Who the call is for

Your backend calls `POST /agentcard/commerce/buy` from its own tool layer, with `userId`
(your id for the user). We pass that to the SDK as `externalUserId`, so AgentCard
resolves the user. The model never supplies a user id, an AgentCard id or a card id. The
route refuses any other field, so the model cannot name someone else.

```json
POST /agentcard/commerce/buy
{ "userId": "user-42", "threadId": "chat-9", "ask": "two packs of AA batteries from Amazon" }
```

The five model fields are `ask`, `confirm`, `new_order`, `product_id` and `store_id`.
Absent `confirm` and `new_order` are `false`, and absent ids are `null`. The result has:

- `model`: what the model may read. It has no links.
- `links`: Vault, approval, store-login, product and store links. Deliver them to the user
  untouched.
- `products`: each with `action`: `buy`, `reserve` (a table) or `book` (a flight or ticket).
- `status`, `reply`, `messages`, `cart`, `carts`, `link_sent`, `approval_expires_at`,
  `shopper_need_not_reply`.

Pass `threadId` to keep one purchase per chat. The tool is kept per user and chat.

### Use the definition for the model

`GET /agentcard/commerce/tool` returns the SDK's tool definition (name, description and
input schema). Give that to the model, and send each call back through `/commerce/buy`.

### Merchant check and connections

`GET /agentcard/merchants?kind=&q=&limit=&cursor=&userId=` passes through AgentCard's
`GET /buy/merchants`. Each merchant has:

- `supported`: `true` when a real purchase went through, `false` when AgentCard cannot pay
  there, `null` when nothing recent settles it. Check this before sending a user to a store.
- `supported_reason`: `pay_proven`, `reach_proven`, `gate_refused` or `unreached`.
- `link_status` (with `userId`): whether that user still has to connect a direct merchant,
  such as DoorDash. If not connected, the sign-in link arrives as a `store_login` link from
  `/commerce/buy`.

`limit` is 1 to 100. A `403 user_not_connected` means no connected user has that id.

### Food, tables and flights

- Food: a `buy` call with the store (`store_id`) and then the product (`product_id`).
- Tables: products with `action: "reserve"`. Pick one with `product_id`.
- Flights: products with `action: "book"`. A flight has no store page, so its `url` is null
  and it is shown as a card. Pick one with `product_id`.

Flight traveler details and flight cancellation are not in the current Commerce SDK or REST
docs (`buy_save_traveler` and `buy_cancel_flight` do not exist there), so they are not built.

### Errors

| Status | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | Missing `ask`, unknown field, both `product_id` and `store_id`, bad query |
| 200 | `status: needs_card` | No card on file yet. The vault link is in `links`; the user adds a card, then the next call buys |
| 502 | `agentcard_unavailable` | AgentCard did not answer; whether the turn ran is unknown, so read the conversation before retrying |
| 503 | `not_configured` | Credentials missing |

A purchase turn can take up to 130 seconds. Set your proxy or load balancer timeout above that.

### Verified and not verified

- Offline (`agentcard/test/commerce.test.js`, 21 tests): the user binding, the refusal of
  AgentCard-style fields, input against the SDK schema, links kept out of the model view,
  `book` and `reserve` products, one tool per user and chat, merchant query validation and
  the root `/buy/merchants` path. The buy call uses an injected stand-in for the SDK's
  `answer()`. The merchant check runs over HTTP against the documented shape.
- Not verified: the SDK's buy call against live AgentCard, and merchant results from
  live AgentCard. Both are sandbox steps.
