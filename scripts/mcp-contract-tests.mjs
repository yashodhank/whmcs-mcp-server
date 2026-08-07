#!/usr/bin/env node

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONTRACT_CATALOG_ENV, createMcpTestEnvironment } from './mcp-test-environment.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const temporaryHome = mkdtempSync(join(tmpdir(), 'whmcs-mcp-contracts-'));
const hostileParent = {
  ...process.env,
  WHMCS_SECRET: 'parent-secret-must-not-reach-child',
  MCP_TOOL_ALLOWLIST: 'search_clients',
  MCP_ENABLE_LEGACY_WRITE_TOOLS: 'true',
  MCP_PROTOCOL_RUNTIME: 'legacy',
  MCP_MAX_PAGE_SIZE: '499',
  MCP_CONTRACT_PARENT_SECRET_SENTINEL: 'must-not-reach-child',
};
const childEnvironment = createMcpTestEnvironment(hostileParent, temporaryHome);

writeFileSync(
  join(temporaryHome, '.env.production'),
  [
    'WHMCS_SECRET=dotenv-secret-must-not-load',
    'MCP_TOOL_ALLOWLIST=search_clients',
    'MCP_ENABLE_LEGACY_WRITE_TOOLS=true',
    'MCP_MAX_PAGE_SIZE=499',
    '',
  ].join('\n'),
  { mode: 0o600 }
);

function runChild(label, entry, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd ?? repositoryRoot,
      env: childEnvironment,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? 120_000);

    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(new Error(`${label} could not start: ${error.message}`));
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`${label} exceeded ${options.timeoutMs ?? 120_000}ms`));
      } else if (code !== 0) {
        reject(new Error(`${label} failed (code ${code}, signal ${signal ?? 'none'})`));
      } else {
        resolvePromise();
      }
    });
  });
}

try {
  await runChild(
    'hermetic MCP build',
    resolve(repositoryRoot, 'node_modules/tsup/dist/cli-default.js'),
    ['src/index.ts', '--format', 'esm', '--dts', '--clean'],
    { timeoutMs: 120_000 }
  );
  const environmentProbe = [
    `const expected = ${JSON.stringify(CONTRACT_CATALOG_ENV)};`,
    'if (process.env.MCP_CONTRACT_PARENT_SECRET_SENTINEL !== undefined) process.exit(81);',
    "if (process.env.WHMCS_SECRET !== 'mcp-contract-placeholder') process.exit(82);",
    "for (const [key, value] of Object.entries(expected)) if ((process.env[key] ?? '') !== value) process.exit(83);",
    "if (process.env.MCP_PROTOCOL_RUNTIME !== 'v2') process.exit(84);",
  ].join('');
  await runChild('minimal child-environment probe', '-e', [environmentProbe], {
    cwd: temporaryHome,
    timeoutMs: 10_000,
  });
  await runChild(
    'hostile-shell and dotenv catalog sentinel',
    resolve(repositoryRoot, 'scripts/mcp-catalog-environment-sentinel.mjs'),
    [],
    { cwd: temporaryHome, timeoutMs: 30_000 }
  );
  await runChild(
    'built symlink entrypoint smoke',
    resolve(repositoryRoot, 'scripts/mcp-entrypoint-symlink-smoke.mjs'),
    [],
    { timeoutMs: 30_000 }
  );
  await runChild(
    'MCP contract tests',
    resolve(repositoryRoot, 'node_modules/vitest/vitest.mjs'),
    [
      'run',
      'tests/mcp/catalogContract.test.ts',
      'tests/mcp/transportContract.test.ts',
      'tests/mcp/entryPoint.test.ts',
      'tests/mcp/dualEraRuntime.test.ts',
      'tests/http/auth.test.ts',
      'tests/http/transport.test.ts',
    ],
    { timeoutMs: 180_000 }
  );
} finally {
  rmSync(temporaryHome, { recursive: true, force: true });
}
