/**
 * B3 — Consumer registry + bearer-token resolution tests.
 *
 * Proofs:
 *  - valid registry parses
 *  - invalid JSON / missing field => fail-fast
 *  - known token => correct profile
 *  - unknown token in production => denied (never privileged)
 *  - env_forbidden when profile env-restricted
 *  - anonymous fallback only when configured + allowed, only llm_safe_summary
 *  - raw token never present in resolution output or thrown errors
 *  - hashToken is stable
 *
 * All tokens/ids below are SYNTHETIC test fixtures, not real secrets.
 */

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  hashToken,
  loadConsumerRegistry,
  resolveConsumer,
} from '../../src/governance/consumers.js';
import type { ConsumerProfile, ProjectionEnv } from '../../src/governance/types.js';

// ---- synthetic fixtures -----------------------------------------------------

const RAW_OPS_TOKEN = 'synthetic-ops-token-AAAA1111';
const RAW_ADMIN_TOKEN = 'synthetic-admin-token-BBBB2222';
const RAW_UNKNOWN_TOKEN = 'synthetic-unknown-token-ZZZZ9999';

function sha(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

const opsEntry = {
  id: 'consumer-ops',
  token_sha256: sha(RAW_OPS_TOKEN),
  allowedScopes: ['read:clients'],
  defaultContract: 'ops_operator',
  allowedContracts: ['ops_operator', 'llm_safe_summary'],
  allowedActions: ['GetClients'],
  writeCapability: 'disabled',
  envRestrictions: [],
};

const adminEntry = {
  id: 'consumer-admin',
  token_sha256: sha(RAW_ADMIN_TOKEN),
  allowedScopes: ['read:all'],
  defaultContract: 'admin_full_trusted',
  allowedContracts: ['admin_full_trusted'],
  allowedActions: ['GetClients', 'GetInvoices'],
  writeCapability: 'approval_required',
  envRestrictions: ['staging'] as ProjectionEnv[],
};

const anonEntry = {
  id: 'consumer-anon',
  token_sha256: sha('unused-anon-hash-CCCC3333'),
  allowedScopes: [],
  defaultContract: 'llm_safe_summary',
  allowedContracts: ['llm_safe_summary'],
  allowedActions: [],
  writeCapability: 'false',
  envRestrictions: [],
  anonymous: true,
};

function envWith(registry: unknown): NodeJS.ProcessEnv {
  return { MCP_CONSUMER_REGISTRY: JSON.stringify(registry) } as NodeJS.ProcessEnv;
}

// ---- hashToken --------------------------------------------------------------

describe('hashToken', () => {
  it('produces a stable 64-char sha256 hex digest', () => {
    const h1 = hashToken(RAW_OPS_TOKEN);
    const h2 = hashToken(RAW_OPS_TOKEN);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(opsEntry.token_sha256);
  });

  it('does not echo the raw token', () => {
    expect(hashToken(RAW_OPS_TOKEN)).not.toContain(RAW_OPS_TOKEN);
  });
});

// ---- loadConsumerRegistry ---------------------------------------------------

describe('loadConsumerRegistry', () => {
  it('parses a valid registry', () => {
    const registry = loadConsumerRegistry(envWith([opsEntry, adminEntry]));
    expect(registry).toHaveLength(2);
    const ops = registry.find((p) => p.id === 'consumer-ops');
    expect(ops?.defaultContract).toBe('ops_operator');
    expect(ops?.anonymous).toBe(false);
  });

  it('returns empty array when env var absent', () => {
    expect(loadConsumerRegistry({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('fails fast on invalid JSON without leaking the raw value', () => {
    let err: unknown;
    try {
      loadConsumerRegistry({ MCP_CONSUMER_REGISTRY: '{not json' } as NodeJS.ProcessEnv);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/MCP_CONSUMER_REGISTRY/);
  });

  it('fails fast on a missing required field', () => {
    const broken = { ...opsEntry } as Record<string, unknown>;
    delete broken.defaultContract;
    expect(() => loadConsumerRegistry(envWith([broken]))).toThrow(/MCP_CONSUMER_REGISTRY/);
  });

  it('fails fast on an unknown contract name', () => {
    const broken = { ...opsEntry, defaultContract: 'totally_made_up' };
    expect(() => loadConsumerRegistry(envWith([broken]))).toThrow(/MCP_CONSUMER_REGISTRY/);
  });

  it('fails fast on a duplicate consumer id', () => {
    expect(() => loadConsumerRegistry(envWith([opsEntry, { ...opsEntry }]))).toThrow(
      /MCP_CONSUMER_REGISTRY/
    );
  });

  it('never includes a raw token field on the loaded profile', () => {
    const registry = loadConsumerRegistry(envWith([opsEntry]));
    const serialized = JSON.stringify(registry);
    expect(serialized).not.toContain(RAW_OPS_TOKEN);
    expect(serialized).toContain(opsEntry.token_sha256);
  });
});

// ---- resolveConsumer --------------------------------------------------------

describe('resolveConsumer', () => {
  const registry: ConsumerProfile[] = loadConsumerRegistry(
    envWith([opsEntry, adminEntry, anonEntry])
  );

  it('resolves a known token to the correct profile', () => {
    const r = resolveConsumer(RAW_OPS_TOKEN, 'production', registry, { allowAnon: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.id).toBe('consumer-ops');
      expect(r.profile.defaultContract).toBe('ops_operator');
    }
  });

  it('denies no_token with no anonymous allowance', () => {
    const r = resolveConsumer(undefined, 'production', registry, { allowAnon: false });
    expect(r).toEqual({ ok: false, reason: 'no_token' });
  });

  it('denies an empty-string token as no_token', () => {
    const r = resolveConsumer('', 'production', registry, { allowAnon: false });
    expect(r).toEqual({ ok: false, reason: 'no_token' });
  });

  it('denies an unknown token in production (never privileged)', () => {
    const r = resolveConsumer(RAW_UNKNOWN_TOKEN, 'production', registry, { allowAnon: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['unknown_token', 'anonymous_disabled']).toContain(r.reason);
    }
    expect(JSON.stringify(r)).not.toContain('admin_full_trusted');
    expect(JSON.stringify(r)).not.toContain('consumer-admin');
  });

  it('returns env_forbidden when the profile is env-restricted', () => {
    const r = resolveConsumer(RAW_ADMIN_TOKEN, 'production', registry, { allowAnon: false });
    expect(r).toEqual({ ok: false, reason: 'env_forbidden' });
  });

  it('allows an env-restricted profile in its permitted env', () => {
    const r = resolveConsumer(RAW_ADMIN_TOKEN, 'staging', registry, { allowAnon: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.id).toBe('consumer-admin');
  });

  it('never leaks the raw token in the resolution output', () => {
    const r = resolveConsumer(RAW_OPS_TOKEN, 'production', registry, { allowAnon: false });
    expect(JSON.stringify(r)).not.toContain(RAW_OPS_TOKEN);
  });

  describe('anonymous fallback', () => {
    it('falls back to anonymous llm_safe_summary in local when allowed', () => {
      const r = resolveConsumer(undefined, 'local', registry, { allowAnon: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.profile.anonymous).toBe(true);
        expect(r.profile.defaultContract).toBe('llm_safe_summary');
      }
    });

    it('uses anonymous for an unknown token when allowed (staging)', () => {
      const r = resolveConsumer(RAW_UNKNOWN_TOKEN, 'staging', registry, { allowAnon: true });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.profile.id).toBe('consumer-anon');
    });

    it('denies anonymous_disabled in production even with a configured anon entry', () => {
      const r = resolveConsumer(undefined, 'production', registry, { allowAnon: true });
      expect(r).toEqual({ ok: false, reason: 'anonymous_disabled' });
    });

    it('denies when allowAnon is false even though anon entry exists', () => {
      const r = resolveConsumer(undefined, 'local', registry, { allowAnon: false });
      expect(r).toEqual({ ok: false, reason: 'no_token' });
    });

    it('never yields a privileged profile via anonymous fallback', () => {
      const onlyPrivileged = loadConsumerRegistry(envWith([opsEntry, adminEntry]));
      const r = resolveConsumer(RAW_UNKNOWN_TOKEN, 'local', onlyPrivileged, {
        allowAnon: true,
      });
      // no anon entry configured -> must NOT borrow a privileged profile
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('unknown_token');
    });

    it('rejects an anon entry not pinned to llm_safe_summary at parse time', () => {
      const badAnon = {
        ...anonEntry,
        defaultContract: 'admin_full_trusted',
        allowedContracts: ['admin_full_trusted'],
      };
      expect(() => loadConsumerRegistry(envWith([badAnon]))).toThrow(/MCP_CONSUMER_REGISTRY/);
    });
  });
});
