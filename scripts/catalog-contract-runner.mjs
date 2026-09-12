#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpTestEnvironment } from './mcp-test-environment.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryHome = mkdtempSync(join(tmpdir(), 'whmcs-catalog-contract-'));
const mode = process.argv.includes('--write') ? '--write' : '--check';

try {
  const result = spawnSync(
    process.execPath,
    [
      resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
      resolve(repositoryRoot, 'scripts/catalog-semantic-diff.ts'),
      mode,
    ],
    {
      cwd: repositoryRoot,
      env: createMcpTestEnvironment(process.env, temporaryHome),
      stdio: 'inherit',
    }
  );
  if (result.error !== undefined) throw result.error;
  if ((result.status ?? 1) !== 0) {
    process.exitCode = result.status ?? 1;
  } else if (mode === '--write') {
    const mcp = spawnSync(
      process.execPath,
      [
        resolve(repositoryRoot, 'node_modules/tsx/dist/cli.mjs'),
        resolve(repositoryRoot, 'scripts/write-mcp-catalog-fixture.ts'),
      ],
      {
        cwd: repositoryRoot,
        env: createMcpTestEnvironment(process.env, temporaryHome),
        stdio: 'inherit',
      }
    );
    if (mcp.error !== undefined) throw mcp.error;
    process.exitCode = mcp.status ?? 1;
  } else {
    process.exitCode = 0;
  }
} finally {
  rmSync(temporaryHome, { recursive: true, force: true });
}
