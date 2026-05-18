/**
 * PHASE H.1 / Track A2 — surfacing the audit trace via MCP_AUDIT_TRACE.
 *
 * Default (flag unset) ⇒ behaviour 100% unchanged, NO `__audit_trace` key.
 * Flag = '1' ⇒ `__audit_trace: AuditTraceRecord[]` present in both
 * structuredContent and the JSON text payload, and VALUE-FREE.
 *
 * Synthetic data only.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { hashToken } from '../../src/governance/consumers.js';
import {
  governedToolResult,
  governedListResult,
  __resetRegistryCacheForTests,
} from '../../src/governance/pipeline.js';
import type { Canonical } from '../../src/governance/types.js';

const TOKEN = 'tok-trace-aaaaaaaa';

function setRegistry(): void {
  process.env.MCP_CONSUMER_REGISTRY = JSON.stringify([
    {
      id: 'ops_desk',
      token_sha256: hashToken(TOKEN),
      defaultContract: 'ops_operator',
      allowedContracts: ['ops_operator'],
      writeCapability: 'false',
    },
  ]);
  __resetRegistryCacheForTests();
}

const RAW_EMAIL = 'jane@example.test';
const RAW_SECRET = 'sk_live_NEVER_LEAKS';

function canonical(): Canonical<Record<string, unknown>> {
  return {
    entity: 'client',
    data: { clientid: 42, email: RAW_EMAIL, password: RAW_SECRET },
    classes: {
      clientid: 'business.identifier',
      email: 'pii.email',
      password: 'secret.credential',
    },
  };
}

afterEach(() => {
  delete process.env.MCP_AUDIT_TRACE;
  delete process.env.MCP_CONSUMER_REGISTRY;
  delete process.env.MCP_GOVERNANCE_ENABLED;
  delete process.env.MCP_ENV;
  __resetRegistryCacheForTests();
});

describe('MCP_AUDIT_TRACE default OFF', () => {
  it('no __audit_trace key in structuredContent or text payload', () => {
    setRegistry();
    const r = governedToolResult({
      canonical: canonical(),
      authToken: TOKEN,
    });
    expect(r.structuredContent).toBeDefined();
    expect('__audit_trace' in (r.structuredContent ?? {})).toBe(false);
    const parsed = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect('__audit_trace' in parsed).toBe(false);
  });
});

describe('MCP_AUDIT_TRACE = 1 ON', () => {
  it('tool result carries a value-free __audit_trace', () => {
    setRegistry();
    process.env.MCP_AUDIT_TRACE = '1';
    const r = governedToolResult({
      canonical: canonical(),
      authToken: TOKEN,
    });
    const sc = r.structuredContent ?? {};
    const trace = sc.__audit_trace as Record<string, unknown>[];
    expect(Array.isArray(trace)).toBe(true);
    expect(trace.length).toBeGreaterThan(0);
    // also present in the text payload
    const parsed = JSON.parse(r.content[0].text) as Record<string, unknown>;
    expect(Array.isArray(parsed.__audit_trace)).toBe(true);
    // VALUE-FREE: no field value anywhere in the trace
    const blob = JSON.stringify(trace);
    expect(blob).not.toContain(RAW_EMAIL);
    expect(blob).not.toContain(RAW_SECRET);
    // the secret is dropped → recorded as omit
    const pwRec = trace.find((t) => t.source_path === 'password');
    expect(pwRec?.projection_decision).toBe('omit');
  });

  it('list result traces each row with an indexed source_path', () => {
    setRegistry();
    process.env.MCP_AUDIT_TRACE = '1';
    const rows = [
      { clientid: 1, email: 'a@example.test', password: 'sek1' },
      { clientid: 2, email: 'b@example.test', password: 'sek2' },
    ];
    const r = governedListResult({
      rows,
      mapItem: (raw) => {
        const d = raw as Record<string, unknown>;
        return {
          entity: 'invoice' as const,
          data: d,
          classes: {
            clientid: 'business.identifier' as const,
            email: 'pii.email' as const,
            password: 'secret.credential' as const,
          },
        };
      },
      envelope: { total: 2 },
      authToken: TOKEN,
    });
    const sc = r.structuredContent ?? {};
    const trace = sc.__audit_trace as Record<string, unknown>[];
    expect(Array.isArray(trace)).toBe(true);
    const paths = trace.map((t) => t.source_path);
    expect(paths).toContain('items[0].clientid');
    expect(paths).toContain('items[1].email');
    const out = trace.find((t) => t.source_path === 'items[0].email');
    expect(out?.output_path).toBe('items[0].email');
    const blob = JSON.stringify(trace);
    expect(blob).not.toContain('sek1');
    expect(blob).not.toContain('a@example.test');
  });

  it('OFF again ⇒ identical output to the no-flag run (no __audit_trace)', () => {
    setRegistry();
    const off1 = governedToolResult({
      canonical: canonical(),
      authToken: TOKEN,
    });
    process.env.MCP_AUDIT_TRACE = '0';
    const off2 = governedToolResult({
      canonical: canonical(),
      authToken: TOKEN,
    });
    expect(off2.content[0].text).toBe(off1.content[0].text);
    expect('__audit_trace' in (off2.structuredContent ?? {})).toBe(false);
  });
});
