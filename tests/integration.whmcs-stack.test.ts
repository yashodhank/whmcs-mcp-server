/**
 * Integration tests against the DISPOSABLE local WHMCS stack
 * (docker-compose.whmcs-test.yml — WHMCS 8.13 on localhost:8813 / 9.0 on :8890).
 *
 * Unlike tests/integration.test.ts (raw axios vs a live/prod WHMCS), this drives
 * the REAL `WhmcsClient` end-to-end so the client wrapper, read-action policy,
 * retry/cache, and normalizers are all exercised against a real WHMCS response —
 * the thing only a disposable DB lets you do safely (plans/003, plans/001).
 *
 * OPT-IN + SELF-SKIP (never runs in a normal/CI run):
 *  - Skipped entirely unless `MCP_WHMCS_STACK=1`.
 *  - Skipped if the probe read fails (stack not up / not bootstrapped).
 *
 * WRITE SAFETY:
 *  - The write round-trip is gated behind `MCP_TEST_WRITE_MODE=true` AND a HARD
 *    localhost guard — it refuses to mutate unless the endpoint is localhost /
 *    127.0.0.1, so it can NEVER write to a remote/prod WHMCS by misconfig.
 *  - Writes are reversible/low-impact; the DB is disposable (`npm run
 *    whmcs:test:reset`) so no cleanup API is required.
 *
 * HOW TO RUN:
 *   npm run whmcs:test:up && npm run whmcs:test:bootstrap   # one-time stack setup
 *   WHMCS_API_URL=http://localhost:8813 \
 *     WHMCS_IDENTIFIER=<stack-id> WHMCS_SECRET=<stack-secret> \
 *     MCP_WHMCS_STACK=1 MCP_MODE=full MCP_TEST_WRITE_MODE=true \
 *     npm run test:integration:stack
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { config, getWhmcsApiEndpoint } from '../src/config.js';
import { WhmcsClient } from '../src/whmcs/WhmcsClient.js';

const STACK_ENABLED = process.env.MCP_WHMCS_STACK === '1';
const WRITE_MODE = process.env.MCP_TEST_WRITE_MODE === 'true';
const ENDPOINT = (() => {
  try {
    return getWhmcsApiEndpoint();
  } catch {
    return '';
  }
})();
const IS_LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i.test(ENDPOINT);

let stackUnreachable = !STACK_ENABLED;
let skipReason = STACK_ENABLED ? '' : 'MCP_WHMCS_STACK!=1 (opt-in stack test)';

/** Minimal Logger stub — the client only needs these methods. */
function makeLogger(): any {
  const noop = () => undefined;
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    logWhmcsCall: noop,
    child(): unknown {
      return this;
    },
  };
}

let client: WhmcsClient;
const skip = () => stackUnreachable;

describe('WHMCS disposable-stack integration (WhmcsClient end-to-end)', () => {
  beforeAll(async () => {
    if (!STACK_ENABLED) {
      console.error(`⏭️  ${skipReason}; skipping stack integration tests.`);
      return;
    }
    client = new WhmcsClient(config, makeLogger());
    // Probe through the real client (also validates the read-action policy path).
    try {
      await client.read('GetClients', { limitnum: 1 });
    } catch (e) {
      stackUnreachable = true;
      skipReason = e instanceof Error ? e.message : 'probe failed';
      console.error(`⏭️  stack probe failed (${skipReason}); skipping. Endpoint=${ENDPOINT}`);
    }
  });

  describe('Reads through the real client', () => {
    it.skipIf(skip)('lists clients (read-action policy + envelope)', async () => {
      const r = await client.read<Record<string, unknown>>('GetClients', { limitnum: 5 });
      expect(r.result).toBe('success');
      expect(r).toHaveProperty('totalresults');
    });

    it.skipIf(skip)('lists products', async () => {
      const r = await client.read<Record<string, unknown>>('GetProducts', { limitnum: 5 });
      expect(r.result).toBe('success');
    });

    it.skipIf(skip)('reads a client detail record when any client exists', async () => {
      const list = await client.read<Record<string, unknown>>('GetClients', { limitnum: 1 });
      const clients = (list.clients as { client?: { id?: number }[] } | undefined)?.client ?? [];
      if (clients.length === 0) {
        console.error('ℹ️  no clients in stack DB; skipping detail read.');
        return;
      }
      const id = clients[0].id;
      const detail = await client.read<Record<string, unknown>>('GetClientsDetails', {
        clientid: id,
        stats: true,
      });
      expect(detail.result).toBe('success');
    });
  });

  describe('Write round-trip (gated: MCP_TEST_WRITE_MODE=true + localhost only)', () => {
    const writeSkip = () => stackUnreachable || !WRITE_MODE;

    it.skipIf(writeSkip)('HARD GUARD: endpoint must be localhost before any mutate', () => {
      // If this fails, the misconfigured remote endpoint is reported and the
      // subsequent mutate tests will also refuse (guarded individually below).
      expect(IS_LOCALHOST, `refusing to write to non-localhost endpoint: ${ENDPOINT}`).toBe(true);
    });

    it.skipIf(writeSkip)(
      'creates a throwaway client, reads it back, and annotates it (reversible)',
      async () => {
        if (!IS_LOCALHOST) {
          throw new Error(`refusing to mutate non-localhost endpoint: ${ENDPOINT}`);
        }
        if (client.getMode() === 'read_only') {
          console.error('ℹ️  MCP_MODE=read_only; set MCP_MODE=full to run write round-trip.');
          return;
        }

        const stamp = process.env.MCP_TEST_STAMP ?? 'fixed-stamp';
        const email = `mcp-stack-${stamp}@test.local`;
        const created = await client.mutate<Record<string, unknown>>('AddClient', {
          firstname: 'MCP',
          lastname: 'StackTest',
          email,
          country: 'US',
          password2: 'Disposable!Pw123',
          skipvalidation: true,
        });
        expect(created.result).toBe('success');
        const clientId = Number(created.clientid ?? created.userid);
        expect(Number.isFinite(clientId)).toBe(true);

        // Read it back through the real client.
        const detail = await client.read<Record<string, unknown>>('GetClientsDetails', {
          clientid: clientId,
        });
        expect(detail.result).toBe('success');

        // Lowest-risk reversible write: an internal admin note on the client.
        const noted = await client.mutate<Record<string, unknown>>('AddClientNote', {
          userid: clientId,
          notes: `disposable stack integration note (${stamp})`,
        });
        expect(noted.result).toBe('success');

        console.error(
          `ℹ️  created disposable client ${clientId}. Reset the DB with \`npm run whmcs:test:reset\`.`
        );
      }
    );
  });
});
