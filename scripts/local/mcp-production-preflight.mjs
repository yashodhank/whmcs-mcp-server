#!/usr/bin/env node

import { existsSync, statSync, accessSync, constants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const repo = resolve(new URL('../..', import.meta.url).pathname);
const envPath = process.env.MCP_PREFLIGHT_ENV_FILE || (existsSync(`${repo}/.env.production`) ? `${repo}/.env.production` : `${repo}/.env`);
const env = existsSync(envPath) ? parse(readFileSync(envPath, 'utf8')) : {};
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });
const present = (key) => typeof env[key] === 'string' && env[key].trim() !== '';

check('env_file', existsSync(envPath), existsSync(envPath) ? 'selected' : 'missing');
check('production_mode', env.MCP_ENV === 'production', `MCP_ENV=${env.MCP_ENV || 'unset'}`);
check('governance_enabled', env.MCP_GOVERNANCE_ENABLED === 'true', `MCP_GOVERNANCE_ENABLED=${env.MCP_GOVERNANCE_ENABLED || 'unset'}`);
check('whmcs_api_credentials', present('WHMCS_API_URL') && present('WHMCS_IDENTIFIER') && present('WHMCS_SECRET'), 'presence-only');
check('kill_switch_off', env.MCP_WRITE_KILL_SWITCH !== 'true', `MCP_WRITE_KILL_SWITCH=${env.MCP_WRITE_KILL_SWITCH || 'false'}`);
check('consumer_registry_source', present('MCP_CONSUMER_REGISTRY_FILE') || present('MCP_CONSUMER_REGISTRY'), 'owner-only file or inline registry configured');
if (present('MCP_CONSUMER_REGISTRY_FILE')) {
  const path = env.MCP_CONSUMER_REGISTRY_FILE.trim();
  let mode = null;
  try { mode = statSync(path).mode & 0o777; } catch {}
  check('consumer_registry_file', mode === 0o600, mode === null ? 'missing/unreadable' : `mode=${mode.toString(8)}`);
}
check('write_allowlist', present('MCP_PROD_WRITE_AUTHORIZED_FILE') || present('MCP_PROD_WRITE_AUTHORIZED'), 'presence-only');
for (const key of ['MCP_WRITE_AUDIT_PATH', 'MCP_WRITE_IDEMPOTENCY_PATH', 'MCP_WRITE_DAY_AMOUNTS_PATH']) {
  if (!present(key)) { check(key, false, 'unset'); continue; }
  const path = env[key].trim();
  try { accessSync(path, constants.W_OK); check(key, true, 'writable'); }
  catch { check(key, false, 'missing or not writable'); }
}
const failed = checks.filter((item) => !item.ok);
console.log(JSON.stringify({ ok: failed.length === 0, env_file: envPath, checks }, null, 2));
process.exitCode = failed.length === 0 ? 0 : 1;
