#!/usr/bin/env node

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMcpTestEnvironment } from './mcp-test-environment.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const builtEntry = resolve(repositoryRoot, 'dist/index.js');
const temporaryHome = mkdtempSync(join(tmpdir(), 'whmcs-mcp-symlink-entry-'));
const symlinkEntry = join(temporaryHome, 'whmcs-mcp');
symlinkSync(builtEntry, symlinkEntry);

const child = spawn(process.execPath, [symlinkEntry], {
  cwd: temporaryHome,
  env: createMcpTestEnvironment(process.env, temporaryHome),
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
let stdout = '';
let ready = false;
let timedOut = false;

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
  if (!ready && stderr.includes('MCP Server ready, connecting via stdio')) {
    ready = true;
    child.kill('SIGTERM');
  }
});

const timeout = setTimeout(() => {
  timedOut = true;
  child.kill('SIGKILL');
}, 8_000);

try {
  const result = await new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: null, error }));
    child.once('close', (code, signal) => resolvePromise({ code, signal }));
  });
  clearTimeout(timeout);

  if ('error' in result) throw result.error;
  if (timedOut) throw new Error('symlink entrypoint smoke exceeded 8 seconds');
  if (!ready) {
    throw new Error(
      `built symlink entry exited before MCP transport startup (code ${result.code}, signal ${result.signal ?? 'none'}): ${stderr}`
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `built symlink entry did not shut down cleanly (code ${result.code}, signal ${result.signal ?? 'none'}): ${stderr}`
    );
  }
  if (stdout !== '') throw new Error('symlink entrypoint wrote non-protocol data to stdout');

  process.stdout.write('Built MCP entrypoint starts through a symlink and shuts down cleanly.\n');
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  rmSync(temporaryHome, { recursive: true, force: true });
}
