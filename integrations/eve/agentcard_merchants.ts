//agent/tools/agentcard_merchants.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { chuskyRequest, getChuskyUserId, readChuskyJson } from "../lib/chusky.js";

export default defineTool({
  description:
    "Check whether AgentCard can pay at a store before sending the user there. supported: true means a real purchase went through; false means it cannot pay there; null means nothing recent settles it. link_status (direct merchants such as DoorDash) shows whether the user still has to connect; if so, the next agentcard_buy reply contains the sign-in link.",
  inputSchema: z.object({
    kind: z.string().regex(/^[a-z_]{1,32}$/).optional().describe("e.g. catalog or direct."),
    q: z.string().max(100).optional().describe("Part of a store name or domain."),
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z.string().optional().describe("next_cursor from the previous page."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ kind, q, limit, cursor }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    if (kind) query.set("kind", kind);
    if (q) query.set("q", q);
    if (limit !== undefined) query.set("limit", String(limit));
    if (cursor) query.set("cursor", cursor);
    const response = await chuskyRequest(
      `/agentcard/merchants?${query}`,
      userId,
      ctx.abortSignal,
      "agentcard merchants",
    );
    return readChuskyJson(response, "agentcard merchants");
  },
});
