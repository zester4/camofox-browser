//agent/tools/chusky_pay_disarm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ChuskyTabIdSchema,
  chuskyRequest,
  getChuskyUserId,
  readChuskyJson,
} from "../lib/chusky.js";

export default defineTool({
  description:
    "Stop paying on a tab. Call it when the checkout is finished, or when the user cancels. Any card request still waiting for approval is cancelled.",
  inputSchema: z.object({
    tabId: ChuskyTabIdSchema,
    attachmentId: z.string().min(1).describe("From chusky_pay_arm."),
  }),
  outputSchema: z.object({ ok: z.literal(true), disarmed: z.boolean() }),
  async execute({ tabId, attachmentId }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await chuskyRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment/${encodeURIComponent(attachmentId)}?${query}`,
      userId,
      ctx.abortSignal,
      "payment disarm",
      { method: "DELETE" },
    );
    await readChuskyJson(response, "payment disarm");
    return { ok: true as const, disarmed: true };
  },
});
