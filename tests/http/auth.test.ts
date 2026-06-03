/**
 * MCP Adoption #10 — HTTP transport auth bridge unit tests.
 *
 * Exercises the pure decision functions directly (no socket): token
 * extraction, the Origin DNS-rebinding gate (403), and the bearer gate (401 vs
 * happy-path) bridged to the EXISTING consumer registry via resolveConsumer.
 * We build a real registry from a known token using the real hashToken, so the
 * bridge is tested against the actual governance code path (no mocking of
 * resolveConsumer).
 */
import { describe, it, expect } from 'vitest';
import { extractBearerToken, isOriginAllowed, authorizeHttpRequest } from '../../src/http/auth.js';
import { loadConsumerRegistry, hashToken } from '../../src/governance/consumers.js';
import type { ConsumerProfile } from '../../src/governance/types.js';

const VALID_TOKEN = 'super-secret-consumer-token-123';

function registryWithToken(token: string): ConsumerProfile[] {
  const entry = {
    id: 'ops-http',
    token_sha256: hashToken(token),
    defaultContract: 'ops_operator',
    allowedContracts: ['ops_operator'],
    writeCapability: 'false',
  };
  return loadConsumerRegistry({
    MCP_CONSUMER_REGISTRY: JSON.stringify([entry]),
  } as NodeJS.ProcessEnv);
}

describe('extractBearerToken', () => {
  it('extracts a well-formed bearer token (case-insensitive scheme)', () => {
    expect(extractBearerToken('Bearer abc123')).toBe('abc123');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
    expect(extractBearerToken('  Bearer   abc123  ')).toBe('abc123');
  });
  it('returns undefined for missing / non-bearer / empty', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
    expect(extractBearerToken(['Bearer a', 'Bearer b'])).toBeUndefined();
  });
});

describe('isOriginAllowed (DNS-rebinding gate)', () => {
  it('allows requests with no Origin header (native/CLI clients)', () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
    expect(isOriginAllowed('', [])).toBe(true);
  });
  it('rejects any present Origin when allowlist is empty (default-deny)', () => {
    expect(isOriginAllowed('https://evil.test', [])).toBe(false);
  });
  it('allows only exact-match origins', () => {
    expect(isOriginAllowed('https://app.test', ['https://app.test'])).toBe(true);
    expect(isOriginAllowed('https://evil.test', ['https://app.test'])).toBe(false);
  });
});

describe('authorizeHttpRequest', () => {
  const registry = registryWithToken(VALID_TOKEN);

  it('403 when Origin present but not allowlisted (checked before auth)', () => {
    const d = authorizeHttpRequest({
      authorizationHeader: `Bearer ${VALID_TOKEN}`,
      originHeader: 'https://evil.test',
      env: 'production',
      registry,
      allowedOrigins: [],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(403);
      expect(d.wwwAuthenticate).toBe(false);
    }
  });

  it('401 when bearer token is missing', () => {
    const d = authorizeHttpRequest({
      authorizationHeader: undefined,
      originHeader: undefined,
      env: 'production',
      registry,
      allowedOrigins: [],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(401);
      expect(d.wwwAuthenticate).toBe(true);
      // No token / internals leaked in the public message.
      expect(d.publicMessage).toBe('Unauthorized');
    }
  });

  it('401 when bearer token is unknown', () => {
    const d = authorizeHttpRequest({
      authorizationHeader: 'Bearer not-a-real-token',
      originHeader: undefined,
      env: 'production',
      registry,
      allowedOrigins: [],
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.status).toBe(401);
  });

  it('happy path: valid token resolves to the consumer profile, anon never used', () => {
    const d = authorizeHttpRequest({
      authorizationHeader: `Bearer ${VALID_TOKEN}`,
      originHeader: undefined,
      env: 'production',
      registry,
      allowedOrigins: [],
    });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.profile.id).toBe('ops-http');
      // The internal token hash is stripped from the resolved profile.
      expect((d.profile as Record<string, unknown>).tokenSha256).toBeUndefined();
    }
  });

  it('happy path with an allowlisted Origin present', () => {
    const d = authorizeHttpRequest({
      authorizationHeader: `Bearer ${VALID_TOKEN}`,
      originHeader: 'https://app.test',
      env: 'production',
      registry,
      allowedOrigins: ['https://app.test'],
    });
    expect(d.ok).toBe(true);
  });
});
