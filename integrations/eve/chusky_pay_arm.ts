//agent/tools/chusky_pay_arm.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  ChuskyTabIdSchema,
  chuskyPostBody,
  chuskyRequest,
  getChuskyUserId,
  parseChuskyResponse,
  readChuskyJson,
} from "../lib/chusky.js";

const ArmOutputSchema = z.object({
  ok: z.literal(true),
  attachmentId: z.string(),
  tabId: z.string(),
});

export default defineTool({
  description:
    "Pay on a checkout page in this browser tab with the user's own saved card. Call this on the checkout page, before the page sends its payment, and give the merchant name, the most the user can be charged in minor units (2306 is $23.06), and the currency. The card number never reaches you. When the page sends its payment, it is paused until the user approves on their own device. Then call chusky_pay_status and send its approvalUrl to the user, unchanged. Only pay when the user has asked you to buy something.",
  inputSchema: z.object({
    tabId: ChuskyTabIdSchema,
    merchant: z.string().trim().min(1).max(120).describe("Store name, shown on the approval screen."),
    amount: z.number().int().positive().describe("The most the user can be charged, in minor units (cents)."),
    currency: z.string().regex(/^[a-z]{3}$/).describe("Lowercase ISO 4217 code, e.g. usd."),
    checkoutOrigin: z
      .string()
      .url()
      .optional()
      .describe("The https origin of the checkout page, e.g. https://shop.example.com. No path."),
    cardId: z.string().optional().describe("Which stored card to use. Omit for the first card."),
  }),
  outputSchema: ArmOutputSchema,
  async execute({ tabId, merchant, amount, currency, checkoutOrigin, cardId }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    const response = await chuskyRequest(
      `/agentcard/tabs/${encodeURIComponent(tabId)}/payment`,
      userId,
      ctx.abortSignal,
      "payment arm",
      {
        method: "POST",
        body: chuskyPostBody(userId, { merchant, amount, currency, checkoutOrigin, cardId }),
      },
    );
    const body = parseChuskyResponse(
      ArmOutputSchema.omit({ ok: true }).extend({ tabId: z.string() }),
      await readChuskyJson(response, "payment arm"),
      "payment arm",
    );
    return { ok: true as const, attachmentId: body.attachmentId, tabId };
  },
});
