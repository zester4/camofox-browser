//agent/tools/agentcard_cards.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { chuskyRequest, getChuskyUserId, readChuskyJson } from "../lib/chusky.js";

export default defineTool({
  description:
    "List the cards the user has stored with AgentCard: brand, last four digits and expiry. Card numbers are never returned. Use it before a purchase to check that a card is on file.",
  inputSchema: z.object({}),
  outputSchema: z.object({}).passthrough(),
  async execute(_input, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await chuskyRequest(
      `/agentcard/vault/cards?${query}`,
      userId,
      ctx.abortSignal,
      "agentcard cards",
    );
    return readChuskyJson(response, "agentcard cards");
  },
});
