import { describe, it, expect } from 'vitest';
import { hashToken, loadConsumerRegistry } from '../../src/governance/consumers.js';
import {
  governProjection,
  pickContract,
  applyGovernanceOrLegacy,
} from '../../src/governance/pipeline.js';
import type { Canonical, ConsumerProfile } from '../../src/governance/types.js';

interface Demo {
  clientid: number;
  email: string;
  gatewayRef: string;
  password: string;
}

function demoCanonical(): Canonical<Demo> {
  return {
    entity: 'client',
    data: { clientid: 42, email: 'jane@example.test', gatewayRef: 'txn_abc123', password: 'sk_live_secret' },
    classes: {
      clientid: 'business.identifier',
      email: 'pii.email',
      gatewayRef: 'financial.reference',
      password: 'secret.credential',
    },
  };
}

const TOKEN_LLM = 'tok-llm-xxxxxxxx';
const TOKEN_BILL = 'tok-bill-yyyyyyyy';

function registry(): ConsumerProfile[] {
  const json = JSON.stringify([
    {
      id: 'llm_chat',
      token_sha256: hashToken(TOKEN_LLM),
      defaultContract: 'llm_safe_summary',
      allowedContracts: ['llm_safe_summary'],
      writeCapability: 'false',
    },
    {
      id: 'billing_app',
      token_sha256: hashToken(TOKEN_BILL),
      defaultContract: 'billing_reconciliation',
      allowedContracts: ['billing_reconciliation', 'ops_operator'],
      writeCapability: 'false',
    },
  ]);
  return loadConsumerRegistry({ MCP_CONSUMER_REGISTRY: json } as NodeJS.ProcessEnv);
}

function byId(id: string): ConsumerProfile {
  const p = registry().find((x) => x.id === id);
  if (!p) throw new Error(`fixture consumer '${id}' not found`);
  return p;
}

describe('pickContract', () => {
  it('honours a requested contract only when the profile allows it', () => {
    const prof = byId('billing_app');
    expect(pickContract(prof, 'ops_operator')).toBe('ops_operator');
  });
  it('falls back to the profile default when the request is not allowed', () => {
    const prof = byId('billing_app');
    expect(pickContract(prof, 'admin_full_trusted')).toBe('billing_reconciliation');
    expect(pickContract(prof, undefined)).toBe('billing_reconciliation');
  });
});

describe('governProjection (pure core)', () => {
  const base = { canonical: demoCanonical(), env: 'production' as const, registry: registry(), allowAnon: false };

  it('LLM consumer: secret dropped, financial reference masked/absent', () => {
    const r = governProjection({ ...base, authToken: TOKEN_LLM });
    expect(r.ok).toBe(true);
    expect(r.data ?? {}).not.toHaveProperty('password');
    expect(JSON.stringify(r.data)).not.toContain('sk_live_secret');
    expect(r.consumer_id).toBe('llm_chat');
    expect(r.contract).toBe('llm_safe_summary');
  });

  it('billing consumer: financial.reference + identifier preserved, secret still dropped', () => {
    const r = governProjection({ ...base, authToken: TOKEN_BILL });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ clientid: 42, gatewayRef: 'txn_abc123' });
    expect(JSON.stringify(r.data)).not.toContain('sk_live_secret');
  });

  it('unknown token in production is denied (no data leaked)', () => {
    const r = governProjection({ ...base, authToken: 'totally-unknown' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('consumer_denied');
    expect(r.data).toBeUndefined();
  });

  it('no token in production with anon disabled is denied', () => {
    const r = governProjection({ ...base, authToken: undefined });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('consumer_denied');
  });

  it('does not mutate the input canonical object', () => {
    const c = demoCanonical();
    const snapshot = JSON.stringify(c);
    governProjection({ ...base, canonical: c, authToken: TOKEN_BILL });
    expect(JSON.stringify(c)).toBe(snapshot);
  });
});

describe('applyGovernanceOrLegacy (backward-compat gate)', () => {
  const legacy = { items: [{ id: 1 }], total: 1 };
  const governed = {
    content: [{ type: 'text' as const, text: '{"governed":true}' }],
    structuredContent: { governed: true },
  };

  it('governance OFF returns the legacy payload verbatim (no behavior change)', () => {
    const out = applyGovernanceOrLegacy({
      enabled: false,
      legacy,
      govern: () => governed,
    });
    expect(out.structuredContent).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual(legacy);
    expect(out.isError).toBeUndefined();
  });

  it('governance ON delegates to the governed result (govern thunk not called when off)', () => {
    let called = 0;
    const offOut = applyGovernanceOrLegacy({
      enabled: false,
      legacy,
      govern: () => {
        called += 1;
        return governed;
      },
    });
    expect(called).toBe(0);
    expect(offOut).toBeDefined();

    const onOut = applyGovernanceOrLegacy({
      enabled: true,
      legacy,
      govern: () => {
        called += 1;
        return governed;
      },
    });
    expect(called).toBe(1);
    expect(onOut.structuredContent).toEqual({ governed: true });
  });
});
