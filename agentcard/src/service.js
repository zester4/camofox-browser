/**
 * The AgentCard integration, composed.
 *
 *   const agentcard = createAgentCardService({
 *     config: cfg.agentcard,          // from lib/config.js
 *     stateFile: '/data/agentcard/state.json',
 *     log,
 *   });
 *   agentcard.handlers.enrol           // Express handlers, see http.js
 *
 * Boot never fails because AgentCard is not configured. The routes answer 503
 * until credentials are present, so a deploy without them keeps working.
 */
import { createAgentCardApi, AgentCardError } from './api.js';
import { createMemoryStore } from './store.js';
import { createFileStore } from './file-store.js';
import { createVault } from './vault.js';
import { createCheckout, DEFAULT_MAX_AMOUNT_CENTS } from './checkout.js';
import { createWebhookHandler } from './webhooks.js';
import { createHttpHandlers } from './http.js';
import { loadConfig, requireCredentials, describeConfig } from './config.js';
import { createSdkClient, attachBrowserCheckout } from './browser-checkout.js';

/** Events this integration subscribes to when its endpoint is registered. */
export const SUBSCRIBED_EVENTS = [
  'vault.session_linked',
  'vault.card_stored',
  'checkout_authorization.*',
];

const API_METHODS = [
  'createVaultSession', 'getVaultSession', 'listVaultCards',
  'createAuthorization', 'getAuthorization', 'cancelAuthorization',
  'createWebhookEndpoint', 'getWebhookSecret',
];

/**
 * @param {{
 *   config: object,                     // the AgentCard block from lib/config.js (or a plain object)
 *   stateFile?: string | null,          // durable state path; null keeps state in memory
 *   log?: (level: string, msg: string, fields?: object) => void,
 *   now?: () => number,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   maxAmountCents?: number | null,
 *   sdkLoader?: () => Promise<any>,
 * }} options
 */
export function createAgentCardService(options) {
  const log = options.log ?? (() => {});
  const config = loadConfig(options.config ?? {});
  const store = options.stateFile
    ? createFileStore(options.stateFile, { log })
    : createMemoryStore();

  let api = null;
  function getApi() {
    if (!api) {
      requireCredentials(config);
      api = createAgentCardApi({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        baseUrl: config.baseUrl,
        fetchImpl: options.fetchImpl,
        sleep: options.sleep,
        now: options.now,
      });
    }
    return api;
  }

  // Modules receive a delegating client so that they can be built before
  // credentials exist. Each call checks credentials first.
  const lazyApi = Object.fromEntries(
    API_METHODS.map((name) => [name, (...args) => getApi()[name](...args)]),
  );

  const vault = createVault({ api: lazyApi, store, now: options.now, log });
  const checkout = createCheckout({
    api: lazyApi,
    store,
    vault,
    maxAmountCents: options.maxAmountCents ?? DEFAULT_MAX_AMOUNT_CENTS,
    log,
  });

  let webhookHandler = null;
  function webhooks() {
    if (!config.webhookSecret) {
      const err = new Error('AGENTCARD_WEBHOOK_SECRET is not set');
      err.code = 'not_configured';
      throw err;
    }
    if (!webhookHandler) {
      webhookHandler = createWebhookHandler({
        secret: config.webhookSecret,
        store,
        vault,
        checkout,
        log,
        now: options.now,
      });
    }
    return webhookHandler;
  }

  let sdk = null;
  return {
    config,
    describe: () => describeConfig(config),
    configured: Boolean(config.clientId && config.clientSecret),
    store,
    vault,
    checkout,
    webhooks,
    handlers: createHttpHandlers({ vault, checkout, webhooks, log }),

    /** Register this app's webhook endpoint. Run once per environment; the secret is shown once. */
    registerWebhookEndpoint({ url, description }) {
      return getApi().createWebhookEndpoint({ url, enabledEvents: SUBSCRIBED_EVENTS, description });
    },

    /** Browser checkout through @agent-cards/checkout, for pages driven by Camofox. */
    async attachBrowserCheckout(page, purchase) {
      const agentcardUserId = store.getAgentCardUser(purchase.userId);
      if (!agentcardUserId) {
        const err = new Error('This user has no card on file. Store a card first.');
        err.code = 'not_enrolled';
        throw err;
      }
      requireCredentials(config);
      if (!sdk) sdk = await createSdkClient(config, { loadSdk: options.sdkLoader });
      return attachBrowserCheckout(sdk, page, { ...purchase, agentcardUserId });
    },

    /** Flush durable state. Call on shutdown. */
    flush() {
      if (typeof store.flush === 'function') store.flush();
    },
  };
}

export { AgentCardError };
