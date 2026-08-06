/**
 * Consumer registry FILE-source tests (#56).
 *
 * Proves the file-backed registry control plane:
 *  - direct loader: happy path, fail-closed on missing / non-file / empty /
 *    malformed / schema-invalid / group-or-other-accessible permissions;
 *  - getConsumerRegistry(): file takes precedence over the inline env JSON, and
 *    an edit to the file is picked up after the TTL boundary (live rotation);
 *  - a bad file THROWS rather than silently serving an empty/stale registry.
 *
 * Uses real temp files (chmod-controlled) under os.tmpdir(); the clock is
 * controlled with vi.spyOn(Date,'now') so no sleeping is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashToken,
  loadConsumerRegistryFromFile,
  ConsumerRegistryError,
} from '../../src/governance/consumers.js';
import {
  getConsumerRegistry,
  REGISTRY_CACHE_TTL_MS,
  __resetRegistryCacheForTests,
} from '../../src/governance/pipeline.js';

const TOKEN_A = 'tok-file-source-aaa';
const TOKEN_B = 'tok-file-source-bbb';
const isWindows = process.platform === 'win32';

/** Minimal valid single-consumer registry JSON. */
function registryJson(id: string, token: string): string {
  return JSON.stringify([
    {
      id,
      token_sha256: hashToken(token),
      defaultContract: 'llm_safe_summary',
      allowedContracts: ['llm_safe_summary'],
      writeCapability: 'false',
    },
  ]);
}

let dir: string;

/** Write a temp file with owner-only (0600) perms by default. */
function writeRegistryFile(contents: string, mode = 0o600): string {
  const p = join(
    dir,
    `registry-${Math.abs(hashToken(contents).charCodeAt(0))}-${contents.length}.json`
  );
  writeFileSync(p, contents, { mode });
  chmodSync(p, mode); // writeFile honours umask; force the exact mode
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whmcs-registry-'));
  __resetRegistryCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MCP_CONSUMER_REGISTRY;
  delete process.env.MCP_CONSUMER_REGISTRY_FILE;
  __resetRegistryCacheForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConsumerRegistryFromFile — happy path', () => {
  it('loads + validates a well-formed owner-only file', () => {
    const p = writeRegistryFile(registryJson('file_consumer', TOKEN_A));
    const profiles = loadConsumerRegistryFromFile(p);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe('file_consumer');
  });
});

describe('loadConsumerRegistryFromFile — fails CLOSED', () => {
  it('throws on a missing path', () => {
    expect(() => loadConsumerRegistryFromFile(join(dir, 'does-not-exist.json'))).toThrow(
      ConsumerRegistryError
    );
  });

  it('throws when the path is a directory, not a regular file', () => {
    expect(() => loadConsumerRegistryFromFile(dir)).toThrow(ConsumerRegistryError);
  });

  it('throws on an empty file (never an empty/deny-all registry)', () => {
    const p = writeRegistryFile('   ');
    expect(() => loadConsumerRegistryFromFile(p)).toThrow(/empty/i);
  });

  it('throws on malformed JSON (and never leaks the content)', () => {
    const secret = '{ not json — token_sha256_leak_canary }';
    const p = writeRegistryFile(secret);
    try {
      loadConsumerRegistryFromFile(p);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ConsumerRegistryError);
      expect((e as Error).message).not.toContain('leak_canary');
    }
  });

  it('throws on schema-invalid JSON (e.g. unknown write scope)', () => {
    const bad = JSON.stringify([
      {
        id: 'x',
        token_sha256: hashToken(TOKEN_A),
        defaultContract: 'llm_safe_summary',
        allowedContracts: ['llm_safe_summary'],
        writeCapability: 'enabled',
        allowedWriteScopes: ['not:a:real:scope'],
      },
    ]);
    const p = writeRegistryFile(bad);
    expect(() => loadConsumerRegistryFromFile(p)).toThrow(ConsumerRegistryError);
  });

  it.skipIf(isWindows)('throws when the file is group/other-accessible (chmod 644)', () => {
    const p = writeRegistryFile(registryJson('lax', TOKEN_A), 0o644);
    expect(() => loadConsumerRegistryFromFile(p)).toThrow(/owner-only|chmod 600/i);
  });

  it.skipIf(isWindows)('accepts a stricter 0400 (read-only owner) file', () => {
    const p = writeRegistryFile(registryJson('ro', TOKEN_A), 0o400);
    expect(loadConsumerRegistryFromFile(p)).toHaveLength(1);
  });
});

describe('getConsumerRegistry — file source precedence + live reload', () => {
  it('file source takes precedence over the inline env JSON', () => {
    process.env.MCP_CONSUMER_REGISTRY = registryJson('env_consumer', TOKEN_A);
    const p = writeRegistryFile(registryJson('file_consumer', TOKEN_B));
    process.env.MCP_CONSUMER_REGISTRY_FILE = p;

    vi.spyOn(Date, 'now').mockReturnValue(10_000_000);
    const reg = getConsumerRegistry();
    expect(reg).toHaveLength(1);
    expect(reg[0].id).toBe('file_consumer'); // file wins
  });

  it('an edit to the file is picked up after the TTL boundary', () => {
    const p = writeRegistryFile(registryJson('rev_a', TOKEN_A));
    process.env.MCP_CONSUMER_REGISTRY_FILE = p;

    const t0 = 20_000_000;
    const spy = vi.spyOn(Date, 'now').mockReturnValue(t0);
    const first = getConsumerRegistry();
    expect(first[0].id).toBe('rev_a');

    // Rotate the file in place (simulate live revocation/rotation).
    writeFileSync(p, registryJson('rev_b', TOKEN_B), { mode: 0o600 });
    chmodSync(p, 0o600);

    // Within TTL → still cached.
    spy.mockReturnValue(t0 + REGISTRY_CACHE_TTL_MS - 1);
    expect(getConsumerRegistry()).toBe(first);

    // Past TTL → re-read the file.
    spy.mockReturnValue(t0 + REGISTRY_CACHE_TTL_MS + 1);
    const afterTtl = getConsumerRegistry();
    expect(afterTtl).not.toBe(first);
    expect(afterTtl[0].id).toBe('rev_b');
  });

  it('a bad file THROWS from getConsumerRegistry (fails closed, no empty fallback)', () => {
    const p = writeRegistryFile('{ broken');
    process.env.MCP_CONSUMER_REGISTRY_FILE = p;
    vi.spyOn(Date, 'now').mockReturnValue(30_000_000);
    expect(() => getConsumerRegistry()).toThrow(ConsumerRegistryError);
  });

  it('an empty MCP_CONSUMER_REGISTRY_FILE falls back to the env JSON', () => {
    process.env.MCP_CONSUMER_REGISTRY_FILE = '   ';
    process.env.MCP_CONSUMER_REGISTRY = registryJson('env_only', TOKEN_A);
    vi.spyOn(Date, 'now').mockReturnValue(40_000_000);
    const reg = getConsumerRegistry();
    expect(reg[0].id).toBe('env_only');
  });
});
