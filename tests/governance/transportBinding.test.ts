/**
 * HTTP→tool identity binding (H2). The HTTP server authenticates the bearer,
 * resolves a ConsumerProfile, and OVERWRITES the tool-call auth_token with
 * `${TRANSPORT_BOUND_PREFIX}<id>`. resolveConsumer must trust that marker ONLY
 * when binding is enabled (HTTP process) — never on stdio — so a client cannot
 * impersonate via the marker.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  loadConsumerRegistry,
  resolveConsumer,
  enableTransportConsumerBinding,
  TRANSPORT_BOUND_PREFIX,
  hashToken,
} from '../../src/governance/consumers.js';

const REG = JSON.stringify([
  {
    id: 'oc-1',
    token_sha256: hashToken('real-token-1'),
    allowedScopes: ['read'],
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    allowedActions: [],
    writeCapability: 'execution_allowed',
    allowedWriteScopes: [],
    envRestrictions: [],
    anonymous: false,
  },
]);
const registry = loadConsumerRegistry({ MCP_CONSUMER_REGISTRY: REG } as NodeJS.ProcessEnv);

afterEach(() => enableTransportConsumerBinding(false));

describe('transport consumer binding', () => {
  it('with binding ENABLED, the marker resolves the profile by id (HTTP path)', () => {
    enableTransportConsumerBinding(true);
    const r = resolveConsumer(`${TRANSPORT_BOUND_PREFIX}oc-1`, 'production', registry, {
      allowAnon: false,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.id).toBe('oc-1');
  });

  it('with binding DISABLED (stdio), the marker is just an unknown token — NO impersonation', () => {
    enableTransportConsumerBinding(false);
    const r = resolveConsumer(`${TRANSPORT_BOUND_PREFIX}oc-1`, 'production', registry, {
      allowAnon: false,
    });
    expect(r.ok).toBe(false);
  });

  it('a marker for a non-existent consumer is denied even when bound', () => {
    enableTransportConsumerBinding(true);
    const r = resolveConsumer(`${TRANSPORT_BOUND_PREFIX}nope`, 'production', registry, {
      allowAnon: false,
    });
    expect(r.ok).toBe(false);
  });

  it('a real registry token still resolves normally (binding on)', () => {
    enableTransportConsumerBinding(true);
    const r = resolveConsumer('real-token-1', 'production', registry, { allowAnon: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.id).toBe('oc-1');
  });
});
