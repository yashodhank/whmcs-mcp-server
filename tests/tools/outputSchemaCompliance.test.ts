/**
 * Phase H.1 Track G — MCP output-contract compliance (RCA finding #4 +
 * preventive #2).
 *
 * Strict MCP runtimes (e.g. Kilo) validate a tool result against the tool's
 * declared `outputSchema`. The governance-OFF "legacy" path historically
 * returned ONLY `content:[{type:text}]` with NO `structuredContent`, so every
 * tool that declares an `outputSchema` failed validation by default
 * (governance is opt-in / OFF by default). This test asserts the invariant:
 *
 *   For every registered read tool that declares an `outputSchema`, invoking
 *   it with governance OFF returns a `structuredContent` object that is valid
 *   against that tool's `outputSchema`.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { MCP_MAX_PAGE_SIZE: 100, MCP_GOVERNANCE_ENABLED: false, MCP_ENV: 'production', MCP_ALLOW_ANON_LLM: false },
  isToolAllowed: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  ensureClientAllowed: () => null,
}));

import { z } from 'zod';
import { registerListTools } from '../../src/tools/listTools.js';
import { registerClientTools } from '../../src/tools/clients.js';
import { registerAggregatorTools } from '../../src/tools/aggregators.js';
import { registerCapabilityShellTools } from '../../src/tools/capabilityShellTools.js';

function harness() {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = {
    registerTool: (n: string, cfg: any, cb: any) => {
      configs[n] = cfg;
      handlers[n] = cb;
    },
    // Write tools use the older SDK `server.tool()` signature; they are NOT
    // part of the governance-OFF legacy-path bug, so the compliance sweep
    // intentionally ignores them.
    tool: () => {},
  };
  const childLogger: Record<string, unknown> = {
    logToolCall: vi.fn(), logToolResult: vi.fn(), info: vi.fn(), error: vi.fn(),
  };
  childLogger.child = (): Record<string, unknown> => childLogger;
  const logger: Record<string, unknown> = {
    child: (): Record<string, unknown> => childLogger,
  };
  const rl: Record<string, unknown> = { tryConsume: () => true };
  // Permissive read mock: every read returns an empty WHMCS-ish object so
  // every tool produces its empty/legacy payload (still must be schema-valid).
  const read = vi.fn().mockResolvedValue({});
  const whmcs: any = { read };
  return { server, handlers, configs, logger, rl, whmcs };
}

// Minimal valid args per tool (clientid-bearing tools need a positive id).
function argsFor(name: string): Record<string, unknown> {
  if (name === 'get_account_360') return { clientid: 30, recent: 3 };
  if (name === 'search_clients') return { search: 'x', limit: 25, offset: 0 };
  if (name === 'get_client_details') return { clientid: 30 };
  if (name === 'get_capability_matrix') return {};
  if (name === 'get_stats') return {};
  return { clientid: 30, limit: 25, offset: 0 };
}

describe('MCP outputSchema compliance (governance OFF) — RCA #4 guardrail', () => {
  it('every registered read tool with an outputSchema returns schema-valid structuredContent', async () => {
    const h = harness();
    registerListTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerClientTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerAggregatorTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerCapabilityShellTools(h.server as any, h.whmcs, h.logger, h.rl);

    const names = Object.keys(h.handlers).filter(
      (n) => h.configs[n]?.outputSchema
    );
    expect(names.length).toBeGreaterThan(10);

    const failures: string[] = [];
    for (const name of names) {
      let res: any;
      try {
        res = await h.handlers[name](argsFor(name));
      } catch (e) {
        failures.push(`${name}: handler threw ${(e as Error).message}`);
        continue;
      }
      if (res?.structuredContent === undefined) {
        failures.push(`${name}: no structuredContent (MCP outputSchema violation)`);
        continue;
      }
      const schema = z.object(h.configs[name].outputSchema as z.ZodRawShape);
      const parsed = schema.safeParse(res.structuredContent);
      if (!parsed.success) {
        failures.push(
          `${name}: structuredContent fails its own outputSchema — ${parsed.error.issues
            .map((i) => i.path.join('.') + ':' + i.message)
            .join('; ')}`
        );
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
});
