//agent/tools/agentcard_enrol.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  camofoxPostBody,
  camofoxRequest,
  getCamofoxUserId,
  readCamofoxJson,
} from "../lib/camofox.js";

export default defineTool({
  description:
    "Start storing the user's own card with AgentCard. If a card is already stored, this returns has_card and nothing else is needed. Otherwise it returns a vault link: send that link to the user in chat, unchanged. The user enters the card on AgentCard's page, not in this chat. Never ask the user for a card number. Use addAnother to add a second card.",
  inputSchema: z.object({
    addAnother: z.boolean().optional().describe("true to add a second card for this user."),
  }),
  outputSchema: z.object({}).passthrough(),
  async execute({ addAnother }, ctx) {
    const userId = getCamofoxUserId(ctx.session.auth.current);
    const response = await camofoxRequest(
      `/agentcard/vault/enrol`,
      userId,
      ctx.abortSignal,
      "agentcard enrol",
      { method: "POST", body: camofoxPostBody(userId, { addAnother: addAnother === true }) },
    );
    return readCamofoxJson(response, "agentcard enrol");
  },
});
