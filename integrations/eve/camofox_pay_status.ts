//agent/tools/camofox_pay_status.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  CamofoxTabIdSchema,
  camofoxRequest,
  getCamofoxUserId,
  parseCamofoxResponse,
  readCamofoxJson,
} from "../lib/camofox.js";

const StatusSchema = z.object({
  attachmentId: z.string(),
  phase: z.enum(["idle", "pending", "completed"]),
  approvalUrl: z.string().nullable(),
  purchaseId: z.string().nullable(),
  results: z.array(z.record(z.unknown())),
});

export default defineTool({
  description:
    "Read the state of a payment on a tab. When approvalUrl is set, a card request is waiting for the user: send that link to the user in chat, unchanged, and tell them to approve it on their device. phase 'completed' means the request has been answered; check results for what happened. Do not retry a payment that the results show as approved or submitted.",
  inputSchema: z.object({
    tabId: CamofoxTabIdSchema,
    attachmentId: z.string().min(1).describe("From camofox_pay_arm."),
  }),
  outputSchema: StatusSchema,
  async execute({ tabId, attachmentId }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const query = new URLSearchParams({ userId });
    const response = await camofoxRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment/${encodeURIComponent(attachmentId)}?${query}`,
      userId,
      ctx.abortSignal,
      "payment status",
    );
    return parseCamofoxResponse(
      StatusSchema,
      await readCamofoxJson(response, "payment status"),
      "payment status",
    );
  },
});
