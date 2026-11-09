/**
 * OpenAPI spec generation via swagger-jsdoc + docs UI (swagger-stripey).
 *
 * swagger-jsdoc scans JSDoc `@openapi` comments on route handlers in server.js
 * (and any file passed in `apis`) to build the spec at startup.
 * Docs UI lives in docs/api.html (swagger-stripey: Stripe-style 3-panel renderer).
 *
 * Usage:
 *   import { mountDocs } from './lib/openapi.js';
 *   // After all routes are registered:
 *   mountDocs(app);
 */

import swaggerJsdoc from 'swagger-jsdoc';
import express from 'express';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let version = 'unknown';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  version = pkg.version;
} catch { /* ignore */ }

const swaggerDefinition = {
  openapi: '3.0.3',
  info: {
    title: 'chuskybrowser',
    version,
    description:
      'Anti-detection browser automation server for AI agents. ' +
      'Accessibility snapshots, element refs, session isolation, cookie import, proxy rotation, and structured logs.',
    license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    contact: { name: 'Seyyid Annan', email: 'seyyid236@gmail.com' },
  },
  servers: [{ url: 'http://localhost:9377', description: 'Local development' }],
  tags: [
    { name: 'System', description: 'Server health, metrics, and status.' },
    { name: 'Tabs', description: 'Create, list, inspect, and destroy browser tabs.' },
    { name: 'Navigation', description: 'Navigate tabs to URLs or via search macros.' },
    { name: 'Interaction', description: 'Click, type, scroll, press keys, evaluate JS.' },
    { name: 'Content', description: 'Accessibility snapshots, screenshots, links, images, downloads.' },
    { name: 'Sessions', description: 'Per-user session state: cookies, teardown.' },
    { name: 'Browser', description: 'Global browser lifecycle (start/stop).' },
    { name: 'Legacy', description: 'OpenClaw-compatible endpoints (deprecated).' },
  ],
  components: {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching CHUSKY_API_KEY (per-route auth for sensitive endpoints like cookie import and traces).',
      },
      AccessKeyAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Bearer token matching CHUSKY_ACCESS_KEY. When set, gates all routes except /health, cookie import, and /stop. Acts as a superkey -- also accepted by endpoints that normally require CHUSKY_API_KEY.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      AgentCardCard: {
        type: 'object',
        description: 'Display fields for a stored card. Card numbers are never returned.',
        properties: {
          cardId: { type: 'string' },
          brand: { type: 'string', nullable: true },
          last4: { type: 'string', nullable: true },
          expiryMonth: { type: 'integer', nullable: true },
          expiryYear: { type: 'integer', nullable: true },
          createdAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      AgentCardVaultResult: {
        type: 'object',
        description: 'has_card when the user already has a card (no link). Otherwise a link to deliver to the user untouched.',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['has_card', 'link'] },
          cards: { type: 'array', items: { $ref: '#/components/schemas/AgentCardCard' } },
          sessionId: { type: 'string' },
          url: { type: 'string', format: 'uri', description: 'Vault link. Send untouched.' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          purpose: { type: 'string', enum: ['enrol', 'add_card'] },
          reused: { type: 'boolean', description: 'True when the pending link for this user was returned again.' },
        },
      },
      AgentCardSessionStatus: {
        type: 'object',
        required: ['status'],
        properties: {
          status: { type: 'string', enum: ['pending', 'linked', 'expired', 'conflict'] },
          retryAfterMs: { type: 'integer', description: 'Present when polled too early or still pending.' },
        },
      },
      AgentCardPurchaseRequest: {
        type: 'object',
        required: ['userId', 'merchant', 'amount', 'currency', 'psp', 'request'],
        properties: {
          userId: { type: 'string' },
          merchant: { type: 'string', maxLength: 120 },
          amount: { type: 'integer', minimum: 1, description: 'Minor units (cents).' },
          currency: { type: 'string', pattern: '^[a-z]{3}$', example: 'usd' },
          psp: { type: 'string', pattern: '^[a-z][a-z_]{1,31}$', example: 'stripe' },
          checkoutOrigin: { type: 'string', format: 'uri', description: 'Origin of the merchant checkout page (https, no path).' },
          request: {
            type: 'object',
            required: ['url', 'method'],
            properties: {
              url: { type: 'string', format: 'uri' },
              method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
            },
          },
        },
      },
      AgentCardPreset: {
        type: 'object',
        description: 'One of the user’s spending rules. attachments lists the cards it applies to.',
        properties: {
          label: { type: 'string' },
          summary: { type: 'string', nullable: true },
          version: { type: 'integer', nullable: true },
          attachments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['card'] },
                cardId: { type: 'string' },
                last4: { type: 'string', nullable: true },
              },
            },
          },
        },
      },
      AgentCardPurchase: {
        type: 'object',
        properties: {
          purchaseId: { type: 'string' },
          merchant: { type: 'string' },
          amount: { type: 'integer' },
          currency: { type: 'string' },
          status: {
            type: 'string',
            enum: ['awaiting_approval', 'approved', 'submitted_on_device', 'declined', 'expired', 'refused', 'settled', 'not_settled', 'cancelled'],
          },
          cardId: { type: 'string', nullable: true },
          settlement: { type: 'string', enum: ['settled', 'not_settled', 'unknown'], nullable: true },
          chargedAmount: { type: 'integer', nullable: true },
          approvalUrl: { type: 'string', format: 'uri', nullable: true, description: 'Send untouched to the user for approval. Present while awaiting approval.' },
          expiresAt: { type: 'string', format: 'date-time', nullable: true },
          canRetry: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

/**
 * Mount GET /openapi.json and GET /docs on the Express app.
 * Call AFTER all routes are registered so swagger-jsdoc can scan them.
 *
 * @param {import('express').Application} app
 * @param {Object} [opts]
 * @param {string[]} [opts.apis] - Glob patterns for files with @openapi JSDoc (default: ['./server.js'])
 */
export function mountDocs(app, opts = {}) {
  const apis = opts.apis || ['./server.js'];

  const spec = swaggerJsdoc({
    definition: swaggerDefinition,
    apis,
  });

  app.get('/openapi.json', (_req, res) => {
    res.json(spec);
  });

  // Serve docs static assets (api.html, openapi.json)
  const docsDir = join(__dirname, '..', 'docs');
  app.use('/docs', express.static(docsDir, { index: 'api.html' }));

  // The logo lives at the repo root; the docs page links to it as /chusky-logo.svg.
  app.get('/chusky-logo.svg', (_req, res) => {
    res.type('image/svg+xml').sendFile(join(__dirname, '..', 'chusky-logo.svg'));
  });

  return spec;
}

export { swaggerDefinition };
