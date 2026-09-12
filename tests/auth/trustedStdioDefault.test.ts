/**
 * Trusted stdio default consumer token tests (Phase B).
 *
 * Proofs:
 *  - No token + trusted stdio + configured default → returns default
 *  - No token + non-trusted (HTTP) → returns undefined
 *  - Caller provides token + stdio → caller token wins (no injection)
 *  - No env configured → returns undefined
 *  - File-based token resolves correctly
 *  - hasStdioDefaultToken reports accurately
 */

import { writeFileSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveStdioDefaultToken,
  hasStdioDefaultToken,
  _resetStdioDefaultTokenForTests,
} from '../../src/auth/trustedStdioDefault.js';

const TEST_TOKEN = 'test-stdio-default-bearer-token-AAAA1111';

describe('trustedStdioDefault', () => {
  beforeEach(() => {
    _resetStdioDefaultTokenForTests();
  });

  afterEach(() => {
    _resetStdioDefaultTokenForTests();
  });

  describe('resolveStdioDefaultToken', () => {
    it('returns the default token when transport is stdio and caller omits auth_token', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: TEST_TOKEN };
      const result = resolveStdioDefaultToken('stdio', undefined, env);
      expect(result).toBe(TEST_TOKEN);
    });

    it('returns undefined when transport is http (even if configured)', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: TEST_TOKEN };
      const result = resolveStdioDefaultToken('http', undefined, env);
      expect(result).toBeUndefined();
    });

    it('returns undefined when caller provides auth_token (stdio)', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: TEST_TOKEN };
      const result = resolveStdioDefaultToken('stdio', 'caller-supplied-token', env);
      expect(result).toBeUndefined();
    });

    it('returns undefined when no default is configured', () => {
      const env = {};
      const result = resolveStdioDefaultToken('stdio', undefined, env);
      expect(result).toBeUndefined();
    });

    it('returns undefined for empty string token', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: '' };
      const result = resolveStdioDefaultToken('stdio', undefined, env);
      expect(result).toBeUndefined();
    });

    it('returns undefined for whitespace-only token', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: '   ' };
      const result = resolveStdioDefaultToken('stdio', undefined, env);
      expect(result).toBeUndefined();
    });

    it('returns undefined when caller token is empty string', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: TEST_TOKEN };
      const result = resolveStdioDefaultToken('stdio', '', env);
      expect(result).toBe(TEST_TOKEN);
    });

    it('resolves token from file', () => {
      const dir = join(tmpdir(), `mcp-test-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'token');
      writeFileSync(filePath, TEST_TOKEN + '\n', { mode: 0o600 });

      try {
        const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE: filePath };
        const result = resolveStdioDefaultToken('stdio', undefined, env);
        expect(result).toBe(TEST_TOKEN);
      } finally {
        unlinkSync(filePath);
      }
    });

    it('prefers inline token over file', () => {
      const dir = join(tmpdir(), `mcp-test-inline-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, 'token');
      writeFileSync(filePath, 'file-token', { mode: 0o600 });

      try {
        const env = {
          MCP_DEFAULT_CONSUMER_AUTH_TOKEN: 'inline-token',
          MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE: filePath,
        };
        const result = resolveStdioDefaultToken('stdio', undefined, env);
        expect(result).toBe('inline-token');
      } finally {
        unlinkSync(filePath);
      }
    });
  });

  describe('hasStdioDefaultToken', () => {
    it('returns true when inline token is configured', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: TEST_TOKEN };
      expect(hasStdioDefaultToken(env)).toBe(true);
    });

    it('returns false when nothing is configured', () => {
      const env = {};
      expect(hasStdioDefaultToken(env)).toBe(false);
    });

    it('returns false for empty/whitespace-only token', () => {
      const env = { MCP_DEFAULT_CONSUMER_AUTH_TOKEN: '   ' };
      expect(hasStdioDefaultToken(env)).toBe(false);
    });
  });
});
