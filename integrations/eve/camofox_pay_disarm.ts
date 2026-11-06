//agent/tools/camofox_pay_disarm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

export default defineTool({
  description:
    "Stop paying on a tab. Call it when the checkout is finished, or when the user cancels. Any card request still waiting for approval is cancelled.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    attachmentId: z.string().min(1).describe("From camofox_pay_arm."),
  }),
  outputSchema: z.object({ ok: z.literal(true), disarmed: z.boolean() }),
  async execute({ tabId, attachmentId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await camofoxRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment/${encodeURIComponent(attachmentId)}?${query}`,
      userId,
      ctx.abortSignal,
      "payment disarm",
      { method: "DELETE" },
    );
    await readCamofoxJson(response, "payment disarm");
    return { ok: true as const, disarmed: true };
  },
});
