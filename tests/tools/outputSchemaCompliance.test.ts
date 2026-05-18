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
import { Ajv } from 'ajv';
import { registerListTools } from '../../src/tools/listTools.js';
import { registerClientTools } from '../../src/tools/clients.js';
import { registerAggregatorTools } from '../../src/tools/aggregators.js';
import { registerCapabilityShellTools } from '../../src/tools/capabilityShellTools.js';
import { registerSupportTools } from '../../src/tools/support.js';
import { registerBillingTools } from '../../src/tools/billing.js';
import { registerDomainTools } from '../../src/tools/domains.js';
import { registerOrderTools } from '../../src/tools/orders.js';
import { registerServiceTools } from '../../src/tools/services.js';

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

// outputSchema may be a raw Zod shape OR an already-built ZodObject
// (passthrough tools). Normalize for lenient structural parsing.
function asZodSchema(os: unknown): z.ZodType {
  return os !== null &&
    typeof os === 'object' &&
    (os as { _def?: unknown })._def !== undefined
    ? (os as z.ZodType)
    : z.object(os as z.ZodRawShape);
}

describe('MCP outputSchema compliance (governance OFF) — RCA #4 guardrail', () => {
  it('every registered read tool with an outputSchema returns schema-valid structuredContent', async () => {
    const h = harness();
    registerListTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerClientTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerAggregatorTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerCapabilityShellTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerSupportTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerBillingTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerDomainTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerOrderTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerServiceTools(h.server as any, h.whmcs, h.logger, h.rl);

    const names = Object.keys(h.handlers).filter(
      (n) => h.configs[n]?.outputSchema
    );
    expect(names.length).toBeGreaterThan(15);

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
      const parsed = asZodSchema(h.configs[name].outputSchema).safeParse(
        res.structuredContent
      );
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

  // Regression-lock the two reliability-sprint targets explicitly.
  it('regression-lock: get_ticket_departments + list_client_domains emit schema-valid structuredContent (gov OFF)', async () => {
    const h = harness();
    registerListTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerSupportTools(h.server as any, h.whmcs, h.logger, h.rl);

    for (const [name, args] of [
      ['get_ticket_departments', {}],
      ['list_client_domains', { clientid: 30, status: 'Active', limit: 25, offset: 0 }],
    ] as const) {
      const cfg = h.configs[name];
      expect(cfg?.outputSchema, `${name} must declare an outputSchema`).toBeTruthy();
      const res = await h.handlers[name](args);
      expect(
        res?.structuredContent,
        `${name} must return structuredContent (RCA #4)`
      ).not.toBeUndefined();
      const parsed = asZodSchema(cfg.outputSchema).safeParse(
        res.structuredContent
      );
      expect(
        parsed.success,
        `${name} structuredContent must validate its outputSchema`
      ).toBe(true);
    }
  });
});

/**
 * STRICT-RUNTIME fidelity guard (the REAL recurrence prevention).
 *
 * The lenient sweep above uses `z.object(shape).safeParse()`, which STRIPS
 * unknown keys — it passed even though strict MCP runtimes (Kilo) reject
 * extras with -32602 "must NOT have additional properties". Reproducing the
 * SDK's Zod→JSON-Schema conversion by hand is version-fragile (Zod v4 routes
 * through a different path than the vendored v3 converter). The only faithful
 * source of truth is the JSON Schema a REAL SDK `McpServer` advertises in
 * `tools/list` — exactly what Kilo validates against. This guard registers
 * the read tools on a real McpServer, takes that authoritative schema, and
 * ajv-validates real handler `structuredContent` (governance OFF) against it.
 *
 * Self-check: a raw-shape outputSchema advertises `additionalProperties:false`
 * (strict) while a passthrough ZodObject advertises a permissive schema —
 * so this guard provably DETECTS the regression class (pre-fix the
 * aggregator/list schemas were strict-`false` and rejected; post-fix they
 * are passthrough and accept their heterogeneous gov-OFF payloads).
 */
describe('MCP strict-runtime outputSchema fidelity (real McpServer schema + ajv)', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });

  it('every registered read tool: structuredContent passes the AUTHORITATIVE tools/list schema (governance OFF)', async () => {
    // 1. Authoritative schemas from a REAL McpServer's tools/list.
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const mcp = new McpServer({ name: 'compliance', version: '1.0.0' });
    const m = harness();
    for (const reg of [
      registerListTools, registerClientTools, registerAggregatorTools,
      registerCapabilityShellTools, registerSupportTools, registerBillingTools,
      registerDomainTools, registerOrderTools, registerServiceTools,
    ]) {
      try {
        reg(mcp as any, m.whmcs, m.logger, m.rl);
      } catch {
        /* a group that also registers write tools via the older server.tool()
           signature may partially throw; read tools registered before the
           throw are still advertised — the sprint-critical groups
           (list/aggregator/support) register cleanly. */
      }
    }
    const listHandler = (mcp as any).server._requestHandlers.get('tools/list');
    const listed = await listHandler({ method: 'tools/list', params: {} }, {});
    const schemaByName = new Map<string, object>();
    for (const t of listed.tools as { name: string; outputSchema?: object }[]) {
      if (t.outputSchema) schemaByName.set(t.name, t.outputSchema);
    }
    expect(schemaByName.size).toBeGreaterThan(10);

    // Self-check: the mechanism really distinguishes strict vs permissive.
    const agg = schemaByName.get('get_billing_snapshot') as
      | { additionalProperties?: unknown }
      | undefined;
    expect(
      agg && agg.additionalProperties !== false,
      'get_billing_snapshot outputSchema must permit additional properties (RCA: strict-false caused -32602)'
    ).toBe(true);

    // 2. Real handler structuredContent, validated against that schema.
    const h = harness();
    registerListTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerClientTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerAggregatorTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerCapabilityShellTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerSupportTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerBillingTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerDomainTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerOrderTools(h.server as any, h.whmcs, h.logger, h.rl);
    registerServiceTools(h.server as any, h.whmcs, h.logger, h.rl);

    const names = Object.keys(h.handlers).filter((n) => schemaByName.has(n));
    const cases: [string, Record<string, unknown>][] = names.map((n) => [n, argsFor(n)]);
    // list_client_domains + status exercises the Track B client-side-filter
    // envelope metadata that strict runtimes previously rejected.
    cases.push(['list_client_domains', { clientid: 30, status: 'Active', limit: 25, offset: 0 }]);

    const failures: string[] = [];
    for (const [name, args] of cases) {
      let res: any;
      try {
        res = await h.handlers[name](args);
      } catch (e) {
        failures.push(`${name}: handler threw ${(e as Error).message}`);
        continue;
      }
      if (res?.structuredContent === undefined) {
        failures.push(`${name}: no structuredContent`);
        continue;
      }
      const validate = ajv.compile(schemaByName.get(name) as object);
      if (!validate(res.structuredContent)) {
        const argTag = args.status ? ` [status=${String(args.status)}]` : '';
        failures.push(
          `${name}${argTag}: strict-runtime REJECT — ${(validate.errors ?? [])
            .slice(0, 4)
            .map((e) => `${e.instancePath || '/'} ${e.keyword} ${e.message}`)
            .join('; ')}`
        );
      }
    }
    expect(failures, `\n${failures.join('\n')}\n`).toEqual([]);
  });
});
