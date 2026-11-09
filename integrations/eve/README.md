# Eve tools for Chusky and AgentCard

Tool files for the user's own Eve agent (built with Vercel's Eve framework). They go in the
agent's `tools/` folder. Each file's first line says where it goes.

## Tools in this folder

| Tool | Route it calls | What it does |
|---|---|---|
| `chusky_pay_arm` | `POST /agentcard/tabs/:tabId/payment` | Pay on a checkout page with the user's own card. The card request pauses until the user approves on their device |
| `chusky_pay_status` | `GET /agentcard/tabs/:tabId/payment/:attachmentId` | Shows the approval link to send to the user, and the result |
| `chusky_pay_disarm` | `DELETE /agentcard/tabs/:tabId/payment/:attachmentId` | Stops paying on the tab |
| `agentcard_enrol` | `POST /agentcard/vault/enrol` | Vault link to store the user's card (or `has_card`) |
| `agentcard_cards` | `GET /agentcard/vault/cards` | Cards on file: brand, last four, expiry |
| `agentcard_placeholder` | `GET /agentcard/cards/placeholder` | The test card to type into a checkout for a stored card (number, CVC, expiry that match the card that pays) |
| `agentcard_buy` | `POST /agentcard/commerce/buy` | Products, food, tables (reserve), flights (book) |
| `agentcard_merchants` | `GET /agentcard/merchants` | Whether AgentCard can pay at a store, and connection status |
| `agentcard_presets` | `GET`, `PUT`, `POST /agentcard/presets...` | List, set and attach spending rules |

The browser handoff tool (`chusky_handoff`) is not in this folder. Your Eve project has
it. Its file was deleted from this repo in commits `9317ef0` and `e414229`.

## Requirements

- The helpers from your `lib/chusky.js`, the same ones `chusky_handoff` uses:
  `chuskyRequest`, `chuskyPostBody`, `readChuskyJson`, `parseChuskyResponse`,
  `getChuskyUserId`, `ChuskyTabIdSchema`. The signatures are inferred from that file.
  They are not in this repo, so check them against your copy.
- The user id comes from the agent's auth, as in `chusky_handoff`. The model never sends it.

## Status

- Written to match `chusky_handoff.ts` and the routes in `server.js`. Not yet run inside
  your Eve project, and not type-checked there.
- `agentcard_buy` returns links for the user. The tool tells the model to send them unchanged,
  but nothing enforces it. Check the agent's replies in your first live test.
- No `needsApproval` on the payment tools. The passkey approval on the user's device is the
  gate for every charge. Add `needsApproval` if you also want approval inside the agent.
