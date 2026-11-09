//agent/tools/agentcard_placeholder.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { chuskyRequest, getChuskyUserId, readChuskyJson } from "../lib/chusky.js";

export default defineTool({
  description:
    "Get the test card to type into a checkout for one of the user's stored cards: the card number, security code and expiry that match the card that pays. The real card number is never returned. Use the same cardId here and in chusky_pay_arm. Type these values into the checkout's card fields, then submit; the user approves on their device.",
  inputSchema: z.object({
    cardId: z.string().max(128).optional().describe("Which stored card. Omit for the first one on file."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ cardId }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    if (cardId) query.set("cardId", cardId);
    const response = await chuskyRequest(
      `/agentcard/cards/placeholder?${query}`,
      userId,
      ctx.abortSignal,
      "agentcard placeholder",
    );
    return readChuskyJson(response, "agentcard placeholder");
  },
});
