//agent/tools/agentcard_presets.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  chuskyPostBody,
  chuskyRequest,
  getChuskyUserId,
  readChuskyJson,
} from "../lib/chusky.js";

const RulesSchema = z.object({
  perDayCents: z.number().int().positive().optional(),
  perWeekCents: z.number().int().positive().optional(),
  perMonthCents: z.number().int().positive().optional(),
  totalCents: z.number().int().positive().optional(),
  onlyMerchants: z.array(z.string()).min(1).max(20).optional(),
  categories: z
    .array(z.enum(["meals", "groceries", "travel", "software", "ai", "wellness", "retail"]))
    .min(1)
    .max(20)
    .optional(),
  currencies: z.array(z.string().regex(/^[a-z]{3}$/)).min(1).max(20).optional(),
  onlyDays: z.string().max(64).optional(),
  onlyHours: z.string().regex(/^\d{1,2}-\d{1,2}$/).optional(),
  timezone: z.string().optional(),
  mode: z.enum(["strict", "watch"]).optional(),
});

export default defineTool({
  description:
    "Manage the user's spending rules with AgentCard. action 'list' shows their rules. 'set' creates or changes a rule named by label, with money in cents; use it when the user sets a limit or allowed merchants. 'attach' applies a rule to one of their cards. AgentCard enforces the rules before any approval, so they protect the user even if an agent makes a mistake.",
  inputSchema: z.object({
    action: z.enum(["list", "set", "attach"]),
    label: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/)
      .optional()
      .describe("Required for set and attach."),
    rules: RulesSchema.optional().describe("Required for set. At least one rule."),
    cardId: z.string().optional().describe("For attach. Omit for the first card."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ action, label, rules, cardId }, ctx) {
    const userId = getChuskyUserId(ctx.session.auth.current);
    if (action === "list") {
      const query = new URLSearchParams({ userId });
      return readChuskyJson(
        await chuskyRequest(`/agentcard/presets?${query}`, userId, ctx.abortSignal, "agentcard presets"),
        "agentcard presets",
      );
    }
    if (!label) throw new Error("label is required for " + action + ".");
    if (action === "set") {
      if (!rules) throw new Error("rules is required for set.");
      const response = await chuskyRequest(
        `/agentcard/presets/${encodeURIComponent(label)}`,
        userId,
        ctx.abortSignal,
        "agentcard preset set",
        { method: "PUT", body: chuskyPostBody(userId, { rules }) },
      );
      return readChuskyJson(response, "agentcard preset set");
    }
    const response = await chuskyRequest(
      `/agentcard/presets/${encodeURIComponent(label)}/attach`,
      userId,
      ctx.abortSignal,
      "agentcard preset attach",
      { method: "POST", body: chuskyPostBody(userId, { cardId }) },
    );
    return readChuskyJson(response, "agentcard preset attach");
  },
});
