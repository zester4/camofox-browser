# AgentCard: payments for agents on Camofox

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

Every route below needs the app's access key, like the other Camofox routes.
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
   - **Browser pay (Camofox, any site).** Open the checkout in a tab. Then:
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

- Browser pay works on Camofox (Firefox) with no Chromium. It uses the documented
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
  browser pay on Camofox against a real processor. Each is a sandbox step.
