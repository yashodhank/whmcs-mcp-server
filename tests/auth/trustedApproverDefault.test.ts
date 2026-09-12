/**
 * Tests for MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN resolution.
 * Mirrors trustedStdioDefault.test.ts patterns.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveStdioApproverToken,
  hasApproverDefaultToken,
  _resetApproverDefaultTokenForTests,
} from '../../src/auth/trustedApproverDefault.js';

beforeEach(() => {
  _resetApproverDefaultTokenForTests();
});

describe('trustedApproverDefault', () => {
  it('returns undefined when not configured', () => {
    expect(resolveStdioApproverToken('stdio', undefined, {})).toBeUndefined();
    expect(hasApproverDefaultToken({})).toBe(false);
  });

  it('returns the inline token from MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN', () => {
    const env = { MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN: 'approver-token-abc' };
    expect(resolveStdioApproverToken('stdio', undefined, env)).toBe('approver-token-abc');
    _resetApproverDefaultTokenForTests();
    expect(hasApproverDefaultToken(env)).toBe(true);
  });

  it('does NOT inject for HTTP transport', () => {
    const env = { MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN: 'approver-token-abc' };
    expect(resolveStdioApproverToken('http', undefined, env)).toBeUndefined();
  });

  it('does NOT inject when caller already provided a token', () => {
    const env = { MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN: 'approver-token-abc' };
    expect(resolveStdioApproverToken('stdio', 'caller-supplied-token', env)).toBeUndefined();
  });

  it('trims whitespace from inline token', () => {
    const env = { MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN: '  trimmed-token  ' };
    expect(resolveStdioApproverToken('stdio', undefined, env)).toBe('trimmed-token');
  });

  it('returns undefined for empty inline token', () => {
    const env = { MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN: '   ' };
    expect(resolveStdioApproverToken('stdio', undefined, env)).toBeUndefined();
  });
});
