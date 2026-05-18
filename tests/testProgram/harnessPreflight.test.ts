/**
 * Reliability-sprint Track A — harness preflight unit tests.
 *
 * These exercise the PURE, importable harness helpers
 * (`scripts/lib/harnessPreflight.mjs`) that gate the L0–L6 production
 * test program. They must run with NO live WHMCS and NO spawned server:
 *
 *   1. `validateToolNames` — every TEST_CASES tool must exist in the live
 *      `tools/list`; an unknown name (e.g. the historical
 *      `get_support_departments`) fails fast as `harness_config_error`.
 *   2. `governancePreflight` — governance ON with no consumer token AND no
 *      registry must fail fast as `harness_config_error` (so the harness
 *      never runs all cases and reports blanket denials as product
 *      failures). Governance OFF → legacy path. Governance ON + synthetic
 *      token+registry → proceed and inject the bearer.
 *
 * The helper module is plain `.mjs` (untyped by tsc `src/**`, never linted
 * by the `src/ tests/` glob); this test file IS linted, so the dynamic
 * import is given an explicit local type to avoid `no-unsafe-*`.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HARNESS_PATH = fileURLToPath(
  new URL('../../scripts/mcp-production-test-program.mjs', import.meta.url)
);

interface PreflightOk {
  ok: true;
  governanceEnabled: boolean;
  injectToken: string | undefined;
}
interface PreflightFail {
  ok: false;
  kind: 'harness_config_error';
  message: string;
}
type PreflightResult = PreflightOk | PreflightFail;

interface ToolNameOk {
  ok: true;
  validated: string[];
}
interface ToolNameFail {
  ok: false;
  kind: 'harness_config_error';
  message: string;
  missing: string[];
}
type ToolNameResult = ToolNameOk | ToolNameFail;

const mod = (await import('../../scripts/lib/harnessPreflight.mjs')) as {
  validateToolNames: (
    requested: readonly string[],
    live: readonly string[]
  ) => ToolNameResult;
  governancePreflight: (env: Record<string, string | undefined>) => PreflightResult;
};
const { validateToolNames, governancePreflight } = mod;

describe('harness preflight: tool-name validation', () => {
  it('passes when every requested tool exists in the live registry', () => {
    const r = validateToolNames(
      ['get_ticket_departments', 'list_client_domains'],
      ['get_ticket_departments', 'list_client_domains', 'get_client_details']
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.validated).toContain('get_ticket_departments');
  });

  it('fails fast as harness_config_error for the legacy non-existent tool name', () => {
    const r = validateToolNames(
      ['get_support_departments', 'list_client_domains'],
      ['get_ticket_departments', 'list_client_domains']
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('harness_config_error');
      expect(r.missing).toContain('get_support_departments');
      expect(r.message).toMatch(/get_support_departments/);
      expect(r.message).toMatch(/tools\/list|live registry|not registered/i);
    }
  });
});

describe('harness preflight: governance gate', () => {
  it('governance OFF → legacy path, no token injection', () => {
    const r = governancePreflight({ MCP_GOVERNANCE_ENABLED: 'false' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.governanceEnabled).toBe(false);
      expect(r.injectToken).toBeUndefined();
    }
  });

  it('governance default (unset) → legacy path', () => {
    const r = governancePreflight({});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.governanceEnabled).toBe(false);
  });

  it('governance ON + NO token + NO registry → fails fast as harness_config_error', () => {
    const r = governancePreflight({ MCP_GOVERNANCE_ENABLED: 'true' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe('harness_config_error');
      expect(r.message).toMatch(/governance/i);
      expect(r.message).toMatch(/token|registry|consumer/i);
    }
  });

  it('governance ON + synthetic token + registry → proceed and inject bearer', () => {
    const r = governancePreflight({
      MCP_GOVERNANCE_ENABLED: 'true',
      MCP_CONSUMER_REGISTRY: '[{"id":"x"}]',
      HARNESS_CONSUMER_TOKEN: 'SYNTHETIC-DO-NOT-USE',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.governanceEnabled).toBe(true);
      expect(r.injectToken).toBe('SYNTHETIC-DO-NOT-USE');
    }
  });

  it('governance ON + registry but missing token → still fails fast', () => {
    const r = governancePreflight({
      MCP_GOVERNANCE_ENABLED: 'true',
      MCP_CONSUMER_REGISTRY: '[{"id":"x"}]',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('harness_config_error');
  });
});

describe('harness script: tool-name correctness', () => {
  it('references the real get_ticket_departments and never the legacy get_support_departments', async () => {
    const src = await readFile(HARNESS_PATH, 'utf8');
    expect(src).toContain("tool: 'get_ticket_departments'");
    expect(src).not.toContain('get_support_departments');
  });

  it('wires the governance preflight + live tool-name validation before running cases', async () => {
    const src = await readFile(HARNESS_PATH, 'utf8');
    expect(src).toContain('governancePreflight(process.env)');
    expect(src).toContain('validateToolNames(');
    expect(src).toContain('client.listTools()');
  });
});
