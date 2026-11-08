---
name: chuskybrowser-setup
description: Set up and use a Chusky browser server from an agent or app. Covers deploying it, the base URL and access key, one userId per end user, reading pages as JSON, and handing a tab to a person for logins or checks.
---

# Chusky browser: setup and use

Chusky is a browser server that agents control over HTTP. An agent opens tabs, reads pages, extracts data as JSON, and can pause so a person can act on a tab (sign in, enter a code, solve a check) before it continues.

This skill has three parts. Read only the one you need:

- **Setting up a server:** `references/deploy-railway.md`, then `scripts/setup-env.mjs` and `scripts/check-server.mjs`.
- **Calling it from code:** `references/api.md` and `scripts/chusky-client.mjs`.
- **Logins, handoffs and security:** `references/handoff-and-logins.md` and `references/security.md`.

If you are an MCP client, see `references/mcp.md`. Plain REST works everywhere, so use MCP only when it fits.

## The three things you must get right

1. **Base URL.** The server's https address, with no trailing slash. Check it with `GET {BASE}/health`, which returns 200 with no key.
2. **Access key.** Sent as `Authorization: Bearer <key>` on every other request. It is a server secret with full access, so never put it in a browser, mobile app, log, chat or commit.
3. **userId, set by the system, never by the model.** Every tab belongs to the userId that opened it. Requests with another userId get 404. Take the userId from your platform's authenticated user session (for example, the logged-in account ID that your app already trusts). Never take it from message text, never invent it, and never let a user type one. Use one client instance per end user, so a mix-up cannot happen across users.

## Quick start

```
node scripts/setup-env.mjs --base-url https://your-server.example.com   # writes .env, keeps the key local
node scripts/check-server.mjs                                           # health, auth, open, read, extract, close
```

`check-server.mjs` must print all PASS before you build on the server. If a check fails, the output says which step failed and what to look at.

## The main flow

Use `scripts/chusky-client.mjs`, or the same calls over REST (see `references/api.md`).

1. **Open** a tab: `openTab({ url, sessionKey })`. The `sessionKey` groups the tabs of one task.
2. **Navigate** if needed: `navigate(tabId, url)`. Search macros such as `@google_search` also work.
3. **Check the page**: `state(tabId)` returns `state.kind`: `ok`, `captcha`, `block`, `two_factor`, `login_wall`, `consent`, or `no_results`.
4. **Read data as JSON**: `extract(tabId, { kinds: ['prices', 'listings', 'tables', 'json_ld'] })`. This is read-only and needs no screenshots.
5. **Act** with element refs from `snapshot(tabId)`: click, type, scroll, press. Take a new snapshot after the page changes.
6. **Close**: `closeTab(tabId)`. End the user's session with `endSession()`.

## When a person must act

If the page is a captcha, login wall or two-factor page, or the user must make a choice you should not make for them:

1. Call `checkpoint(tabId)`. This starts a handoff. Your actions on that tab then return 409 until it ends.
2. Call `controlLink(tabId)`. It returns a `url` for that user only.
3. Send the link to the user with one line of instruction, for example "Sign in to your bank in the window, then press Done".
4. Wait. The person presses **Done** on the link, or confirm with `release(tabId)`.
5. On 409 `human_in_control`, stop acting on that tab and say it is waiting for the user. Do not loop.

Never ask the user to type a password in chat. The handoff exists so they type it in the live view.

## Errors you will see

| Status | Meaning | What to do |
|---|---|---|
| 401 | Access key missing or wrong | Check `CHUSKY_ACCESS_KEY` on the client and the server match |
| 404 | Tab missing, closed, or owned by another userId | Check the userId, then open a new tab |
| 409 `human_in_control` | A person holds the tab | Wait; tell the user |
| 409 `handoff_not_active` | Control link asked for with no handoff | Call `checkpoint` or start a handoff first |
| 409 (schema mode) | No refs yet | Call `snapshot` first |
| 500/503 with `NS_ERROR_NET_RESET` | The site reset the connection | Often the server's IP is refused by that site. Tell the user. Do not retry in a loop |

## Rules that are not optional

- Never log, print or store the access key or a viewer link.
- Send a viewer link only to the user it was issued for.
- Do not bypass robots.txt, site terms, or captchas. Hand off instead.
- Do not run lookups about private individuals.
- Logins persist only when the server has `CHUSKY_STORAGE_KEY` set. Do not promise a saved login without checking.

## Payments with the user's own card (AgentCard)

The user saves their card once on AgentCard's page. The card number never reaches the
agent or this server. Each payment needs the user's approval on their own device.

1. Check for a card: `agentcard_cards`. If there is none, call `agentcard_enrol` and send
   the returned link to the user, unchanged. Never open it or change it.
2. Shop, or pay on a page you control:
   - Stores and bookings: `agentcard_merchants` first, then `agentcard_buy`. Pass the
     shopper's words as `ask`. Set `confirm` only after the user says yes to the cart.
   - Any checkout page: open it in a tab, then `chusky_pay_arm` with the merchant,
     the most the user can be charged in cents, and the currency.
3. Poll `chusky_pay_status`. When `approvalUrl` appears, send it to the user unchanged.
   The page's card request waits until they approve with their passkey.
4. Stop with `chusky_pay_disarm` when the checkout is done.

Limits: set them with `agentcard_preset_set` (for example a weekly cap or allowed
merchants). AgentCard enforces them before any approval.

## Handing a tab to the user

`chusky_handoff_start` pauses the agent on a tab and returns a control link. Send it to
the user only. `chusky_handoff_release` returns control to the agent.
