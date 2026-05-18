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
  consumerWriteScopes,
  consumerWriteCapability,
  consumerCanDraft,
  assertWriteScopeAllowed,
} from '../../src/governance/consumers.js';
import type { ConsumerProfile, ProjectionEnv } from '../../src/governance/types.js';

/**
 * Locate a profile by id, failing the test loudly if absent. Avoids `!`
 * non-null assertions and `as` casts in the assertions below (both flagged by
 * the project eslint config).
 */
function findProfile(
  registry: readonly ConsumerProfile[],
  id: string
): ConsumerProfile {
  const found = registry.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`test fixture missing consumer '${id}'`);
  }
  return found;
}

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

// ---- Phase F: allowedWriteScopes + per-consumer write-scope gate ------------

const writerEntry = {
  id: 'consumer-writer',
  token_sha256: sha('synthetic-writer-token-DDDD4444'),
  allowedScopes: ['read:clients'],
  defaultContract: 'support_triage',
  allowedContracts: ['support_triage', 'llm_safe_summary'],
  allowedActions: ['GetTickets'],
  writeCapability: 'execution_allowed',
  allowedWriteScopes: ['client_note:write', 'ticket:reply'],
  envRestrictions: [],
};

describe('allowedWriteScopes (Phase F, additive)', () => {
  it('legacy registry with no write-scope fields still parses + behaves unchanged', () => {
    const registry = loadConsumerRegistry(envWith([opsEntry, adminEntry]));
    expect(registry).toHaveLength(2);
    const ops = findProfile(registry, 'consumer-ops');
    expect(ops.defaultContract).toBe('ops_operator');
    expect(ops.writeCapability).toBe('disabled');
    // No write scopes configured -> default-deny empty list.
    expect(consumerWriteScopes(ops)).toEqual([]);
    expect(consumerWriteCapability(ops)).toBe('disabled');
    expect(consumerCanDraft(ops)).toBe(false);
  });

  it('fails fast on an unknown write scope without leaking the raw env value', () => {
    const broken = {
      ...opsEntry,
      allowedWriteScopes: ['client_note:write', 'totally:made:up:scope'],
    };
    let err: unknown;
    try {
      loadConsumerRegistry(envWith([broken]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/MCP_CONSUMER_REGISTRY/);
    expect((err as Error).message).not.toContain('synthetic-ops-token');
  });

  it('resolves a profile with valid allowedWriteScopes', () => {
    const registry = loadConsumerRegistry(envWith([writerEntry]));
    const writer = findProfile(registry, 'consumer-writer');
    expect(consumerWriteScopes(writer)).toEqual([
      'client_note:write',
      'ticket:reply',
    ]);
    expect(consumerWriteCapability(writer)).toBe('execution_allowed');
    expect(consumerCanDraft(writer)).toBe(true);
  });

  it('surfaces allowedWriteScopes through resolveConsumer', () => {
    const registry = loadConsumerRegistry(envWith([writerEntry]));
    const r = resolveConsumer(
      'synthetic-writer-token-DDDD4444',
      'production',
      registry,
      { allowAnon: false }
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(consumerWriteScopes(r.profile)).toEqual([
        'client_note:write',
        'ticket:reply',
      ]);
    }
  });
});

describe('assertWriteScopeAllowed (pure, default-deny)', () => {
  const writer = findProfile(
    loadConsumerRegistry(envWith([writerEntry])),
    'consumer-writer'
  );

  it('allows when capability != false/disabled AND scope is listed', () => {
    expect(assertWriteScopeAllowed(writer, 'client_note:write')).toEqual({ ok: true });
    expect(assertWriteScopeAllowed(writer, 'ticket:reply')).toEqual({ ok: true });
  });

  it('denies scope_not_allowed when scope is not in allowedWriteScopes', () => {
    expect(assertWriteScopeAllowed(writer, 'billing:refund:record')).toEqual({
      ok: false,
      reason: 'scope_not_allowed',
    });
  });

  it("denies write_capability_false when writeCapability is 'false'", () => {
    const noWrite = findProfile(
      loadConsumerRegistry(
        envWith([
          {
            ...writerEntry,
            id: 'consumer-nowrite',
            token_sha256: sha('synthetic-nowrite-token-EEEE5555'),
            writeCapability: 'false',
          },
        ])
      ),
      'consumer-nowrite'
    );
    expect(assertWriteScopeAllowed(noWrite, 'client_note:write')).toEqual({
      ok: false,
      reason: 'write_capability_false',
    });
  });

  it("denies write_capability_false when writeCapability is 'disabled'", () => {
    const disabled = findProfile(
      loadConsumerRegistry(
        envWith([
          {
            ...writerEntry,
            id: 'consumer-disabled',
            token_sha256: sha('synthetic-disabled-token-FFFF6666'),
            writeCapability: 'disabled',
          },
        ])
      ),
      'consumer-disabled'
    );
    expect(assertWriteScopeAllowed(disabled, 'client_note:write')).toEqual({
      ok: false,
      reason: 'write_capability_false',
    });
  });

  it('never infers scopes: a legacy profile with empty scopes denies everything', () => {
    const ops = findProfile(
      loadConsumerRegistry(envWith([opsEntry])),
      'consumer-ops'
    );
    expect(assertWriteScopeAllowed(ops, 'client_note:write')).toEqual({
      ok: false,
      reason: 'write_capability_false',
    });
  });

  it('does not echo any raw token in its result', () => {
    const out = JSON.stringify(assertWriteScopeAllowed(writer, 'ticket:reply'));
    expect(out).not.toContain('synthetic-writer-token-DDDD4444');
  });
});
