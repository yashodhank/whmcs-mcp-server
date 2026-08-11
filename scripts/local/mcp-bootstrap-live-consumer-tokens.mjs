#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function trim(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function ensureDirectory(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function assertOwnerOnly(path) {
  if (process.platform === 'win32') return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`insecure file mode for ${path}: ${mode.toString(8)}; require 0600`);
  }
}

function writeTokenFile(label, token, filePath) {
  const result = {
    label,
    path: filePath,
    mode: null,
    hadToken: token !== undefined,
    skipped: false,
    replaced: false,
  };

  if (token === undefined) {
    result.skipped = true;
    if (existsSync(filePath)) {
      assertOwnerOnly(filePath);
      result.mode = (statSync(filePath).mode & 0o777).toString(8);
    }
    return result;
  }

  ensureDirectory(filePath);
  writeFileSync(filePath, `${token}\n`, {
    encoding: 'utf8',
    flag: 'w',
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
  result.replaced = true;
  result.mode = (statSync(filePath).mode & 0o777).toString(8);
  return result;
}

const home = process.env.HOME || process.env.USERPROFILE || '';
const defaultDir = home ? resolve(home, '.config', 'whmcs-mcp') : resolve('/tmp', 'whmcs-mcp');
const checks = [
  {
    label: 'executor',
    tokenEnv: 'MCP_DEFAULT_CONSUMER_AUTH_TOKEN',
    fileEnv: 'MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE',
    fallbackFile: resolve(defaultDir, 'live-consumer-executor.token'),
  },
  {
    label: 'approver',
    tokenEnv: 'MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN',
    fileEnv: 'MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE',
    fallbackFile: resolve(defaultDir, 'live-consumer-approver.token'),
  },
];

const results = [];
const errors = [];

for (const item of checks) {
  const token = trim(process.env[item.tokenEnv]);
  const filePath = trim(process.env[item.fileEnv]) || item.fallbackFile;
  const absolute = resolve(filePath);
  try {
    results.push(writeTokenFile(item.label, token, absolute));
    if (!existsSync(absolute)) {
      results[results.length - 1].skipped = true;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({ label: item.label, path: absolute, message });
  }
}

for (const result of results) {
  const marker = result.skipped ? 'skip' : result.replaced ? 'write' : 'ready';
  console.info(
    `${marker}: ${result.label} token file ${result.path} (mode ${result.mode ?? 'unknown'}${result.hadToken ? ', refreshed' : ''})`
  );
}

if (errors.length > 0) {
  for (const item of errors) {
    console.error(`error: ${item.label}: ${item.message}`);
  }
  process.exit(1);
}

console.info('ok: live consumer token bootstrap completed');
console.info(
  'tip: export MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE and MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE if you want stable explicit env references'
);
process.exitCode = 0;
