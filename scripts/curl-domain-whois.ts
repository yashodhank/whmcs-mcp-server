#!/usr/bin/env tsx
/**
 * Call WHMCS DomainWhois using curl (direct HTTP, no Node/axios).
 * Compare with debug-domain-whois.ts (Node) and MCP to isolate root cause.
 *
 * Usage: npm run curl:domain-whois [domain]
 * Default domain: dsri-marks.com
 *
 * Writes POST body to a temp file so credentials are not visible in process list.
 */

import { config, getWhmcsApiEndpoint } from '../src/config.js';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

const DEFAULT_DOMAIN = 'dsri-marks.com';

async function main(): Promise<void> {
  const domain = process.argv[2] || DEFAULT_DOMAIN;
  const endpoint = getWhmcsApiEndpoint();

  const body = new URLSearchParams({
    action: 'DomainWhois',
    identifier: config.WHMCS_IDENTIFIER,
    secret: config.WHMCS_SECRET,
    responsetype: 'json',
    domain,
  } as Record<string, string>).toString();

  const bodyFile = join(tmpdir(), `whmcs-whois-${randomBytes(8).toString('hex')}.txt`);
  try {
    writeFileSync(bodyFile, body, 'utf8');
  } catch (e) {
    console.error('Failed to write temp file:', e);
    process.exit(1);
  }

  return new Promise((resolve, reject) => {
    const curl = spawn(
      'curl',
      [
        '-s',
        '-w',
        '\n\nHTTP_CODE:%{http_code}',
        '-X',
        'POST',
        endpoint,
        '-H',
        'Content-Type: application/x-www-form-urlencoded',
        '--data-binary',
        `@${bodyFile}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let out = '';
    let err = '';
    curl.stdout.on('data', (chunk) => (out += chunk.toString()));
    curl.stderr.on('data', (chunk) => (err += chunk.toString()));
    curl.on('close', (code) => {
      try {
        unlinkSync(bodyFile);
      } catch {
        // ignore
      }
      if (err) console.error('curl stderr:', err);
      process.stdout.write(out);
      resolve();
    });
    curl.on('error', (e) => {
      try {
        unlinkSync(bodyFile);
      } catch {
        // ignore
      }
      console.error('curl error:', e.message);
      reject(e);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
