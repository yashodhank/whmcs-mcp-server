/**
 * OAuth 2.1 Protected Resource Metadata (RFC 9728) — unit tests.
 *
 * Pure builders, no I/O: we exercise the metadata document shape (required +
 * optional fields), the empty-array omission rule, and the `WWW-Authenticate`
 * header value with and without an error code.
 */
import { describe, it, expect } from 'vitest';
import {
  PRM_PATH,
  buildProtectedResourceMetadata,
  wwwAuthenticateValue,
  type PrmConfig,
} from '../../src/auth/protectedResourceMetadata.js';

const RESOURCE = 'https://mcp.example.com/mcp';
const PRM_URL = `https://mcp.example.com${PRM_PATH}`;

describe('PRM_PATH', () => {
  it('is the RFC 9728 well-known path', () => {
    expect(PRM_PATH).toBe('/.well-known/oauth-protected-resource');
  });
});

describe('buildProtectedResourceMetadata', () => {
  it('returns all RFC 9728 fields when fully configured', () => {
    const cfg: PrmConfig = {
      resource: RESOURCE,
      authorizationServers: ['https://auth.example.com', 'https://auth2.example.com'],
      scopesSupported: ['whmcs:read', 'whmcs:write:low'],
    };
    const md = buildProtectedResourceMetadata(cfg);
    expect(md).toEqual({
      resource: RESOURCE,
      authorization_servers: ['https://auth.example.com', 'https://auth2.example.com'],
      scopes_supported: ['whmcs:read', 'whmcs:write:low'],
      bearer_methods_supported: ['header'],
    });
  });

  it('always advertises header-only bearer methods', () => {
    const md = buildProtectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: ['https://auth.example.com'],
      scopesSupported: [],
    });
    expect(md.bearer_methods_supported).toEqual(['header']);
  });

  it('omits authorization_servers when empty', () => {
    const md = buildProtectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: [],
      scopesSupported: ['whmcs:read'],
    });
    expect(md).not.toHaveProperty('authorization_servers');
    expect(md.resource).toBe(RESOURCE);
    expect(md.scopes_supported).toEqual(['whmcs:read']);
  });

  it('omits scopes_supported when empty', () => {
    const md = buildProtectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: ['https://auth.example.com'],
      scopesSupported: [],
    });
    expect(md).not.toHaveProperty('scopes_supported');
  });

  it('omits both optional arrays when both empty (minimal document)', () => {
    const md = buildProtectedResourceMetadata({
      resource: RESOURCE,
      authorizationServers: [],
      scopesSupported: [],
    });
    expect(md).toEqual({
      resource: RESOURCE,
      bearer_methods_supported: ['header'],
    });
  });

  it('copies arrays defensively (no shared mutable reference to config)', () => {
    const cfg: PrmConfig = {
      resource: RESOURCE,
      authorizationServers: ['https://auth.example.com'],
      scopesSupported: ['whmcs:read'],
    };
    const md = buildProtectedResourceMetadata(cfg);
    cfg.authorizationServers.push('https://evil.example.com');
    cfg.scopesSupported.push('whmcs:write:high');
    expect(md.authorization_servers).toEqual(['https://auth.example.com']);
    expect(md.scopes_supported).toEqual(['whmcs:read']);
  });
});

describe('wwwAuthenticateValue', () => {
  it('emits Bearer + resource_metadata when no error is given', () => {
    expect(wwwAuthenticateValue(PRM_URL)).toBe(`Bearer resource_metadata="${PRM_URL}"`);
  });

  it('appends error= when an error code is given', () => {
    expect(wwwAuthenticateValue(PRM_URL, 'invalid_token')).toBe(
      `Bearer resource_metadata="${PRM_URL}", error="invalid_token"`
    );
  });

  it('treats an empty-string error as no error', () => {
    expect(wwwAuthenticateValue(PRM_URL, '')).toBe(`Bearer resource_metadata="${PRM_URL}"`);
  });

  it('supports other OAuth error codes (e.g. insufficient_scope)', () => {
    expect(wwwAuthenticateValue(PRM_URL, 'insufficient_scope')).toBe(
      `Bearer resource_metadata="${PRM_URL}", error="insufficient_scope"`
    );
  });
});
