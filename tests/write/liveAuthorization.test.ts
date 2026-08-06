import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LiveAuthorizationError,
  loadLiveProductionAuthorization,
} from '../../src/write/liveAuthorization.js';

function withFile(contents: string, mode = 0o600): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'whmcs-live-auth-'));
  const path = join(dir, 'authorized.json');
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('loadLiveProductionAuthorization', () => {
  it('loads a JSON array of scopes', () => {
    const file = withFile('["client:create", "billing:quote:create"]');
    try {
      expect(loadLiveProductionAuthorization(file.path)).toEqual([
        'client:create',
        'billing:quote:create',
      ]);
    } finally {
      file.cleanup();
    }
  });

  it('accepts the named object form for operator readability', () => {
    const file = withFile('{"authorized":["client:create"]}');
    try {
      expect(loadLiveProductionAuthorization(file.path)).toEqual(['client:create']);
    } finally {
      file.cleanup();
    }
  });

  it('observes edits immediately without a cache or restart', () => {
    const file = withFile('["client:create"]');
    try {
      expect(loadLiveProductionAuthorization(file.path)).toEqual(['client:create']);
      writeFileSync(file.path, '["billing:quote:create"]');
      expect(loadLiveProductionAuthorization(file.path)).toEqual(['billing:quote:create']);
    } finally {
      file.cleanup();
    }
  });

  it('fails closed for malformed or schema-invalid content', () => {
    for (const contents of ['{broken', '[1]', '{"authorized":"client:create"}']) {
      const file = withFile(contents);
      try {
        expect(() => loadLiveProductionAuthorization(file.path)).toThrow(LiveAuthorizationError);
      } finally {
        file.cleanup();
      }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects group/other-readable files', () => {
    const file = withFile('["client:create"]', 0o644);
    try {
      expect(() => loadLiveProductionAuthorization(file.path)).toThrow(/owner-only|chmod 600/i);
    } finally {
      file.cleanup();
    }
  });
});
