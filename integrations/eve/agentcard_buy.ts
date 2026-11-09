//agent/tools/agentcard_buy.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  chuskyPostBody,
  chuskyRequest,
  getChuskyUserId,
  readChuskyJson,
} from "../lib/chusky.js";

export default defineTool({
  description:
    "Shop for the user at real stores through AgentCard: products, food delivery, table reservations and flights. Pass the user's words in ask. Pass product_id or store_id only when the user picked one from an earlier result. Set confirm to true only when the user has said yes to the cart or asks to check out. The reply contains links for the user: send each link to the user exactly as given. Never change, shorten or summarise a link. A product with action 'reserve' is a table, and one with 'book' is a flight. The user approves the payment on their own device.",
  inputSchema: z.object({
    ask: z.string().trim().min(1).max(2000).describe("What the user said, in their own words."),
    threadId: z.string().max(128).optional().describe("The chat, so one purchase stays in one chat."),
    confirm: z.boolean().optional().describe("true only when the user said yes to the cart."),
    new_order: z.boolean().optional().describe("true only when the user drops the cart to start a new order."),
    product_id: z.string().nullable().optional().describe("The product the user picked from the last result."),
    store_id: z.string().nullable().optional().describe("The store the user picked from the last result."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ ask, threadId, confirm, new_order, product_id, store_id }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const response = await chuskyRequest(
      `/agentcard/commerce/buy`,
      userId,
      ctx.abortSignal,
      "agentcard buy",
      {
        method: "POST",
        body: chuskyPostBody(userId, {
          ask,
          threadId,
          confirm: confirm === true,
          new_order: new_order === true,
          product_id: product_id ?? null,
          store_id: store_id ?? null,
        }),
      },
    );
    return readChuskyJson(response, "agentcard buy");
  },
});
