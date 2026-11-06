import { createAgentCardService } from '../src/index.js';
import { createFakeAgentCard, FAKE_CLIENT, signedDelivery } from './fake-agentcard.js';

export const WEBHOOK_SECRET = 'whsec_test';

/**
 * A service wired to the fake AgentCard, with a controllable clock.
 * @param {{ stateFile?: string | null, fake?: ReturnType<typeof createFakeAgentCard>, configOverrides?: object, maxAmountCents?: number | null }} [opts]
 */
export function makeService(opts = {}) {
  const fake = opts.fake ?? createFakeAgentCard({ webhookSecret: WEBHOOK_SECRET });
  let clock = Date.now();
  const logs = [];
  const service = createAgentCardService({
    config: {
      clientId: FAKE_CLIENT.id,
      clientSecret: FAKE_CLIENT.secret,
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: 'https://api.agentcard.sh',
      ...(opts.configOverrides ?? {}),
    },
    stateFile: opts.stateFile ?? null,
    fetchImpl: fake.fetch,
    sleep: opts.sleep ?? (async () => {}),
    now: () => clock,
    maxAmountCents: opts.maxAmountCents ?? null,
    log: (level, msg, fields) => logs.push({ level, msg, fields }),
  });
  return {
    service,
    fake,
    logs,
    advance(ms) { clock += ms; },
    nowSeconds() { return Math.floor(clock / 1000); },
    /** Deliver a signed webhook through the real handler. */
    async deliver(event) {
      const { body, headers } = signedDelivery(event, WEBHOOK_SECRET, Math.floor(clock / 1000));
      return service.webhooks()({ headers, rawBody: body });
    },
  };
}
