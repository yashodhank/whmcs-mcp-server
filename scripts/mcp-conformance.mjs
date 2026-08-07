#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// buildServer imports the validated runtime config. Use inert placeholders so
// this local-only tripwire target never needs or discovers operator secrets.
process.env.WHMCS_API_URL ??= 'https://whmcs.invalid';
process.env.WHMCS_IDENTIFIER ??= 'official-conformance-placeholder';
process.env.WHMCS_SECRET ??= 'official-conformance-placeholder';
process.env.MCP_STARTUP_HEALTHCHECK = 'off';
const { buildServer } = await import('../dist/index.js');

const PINNED_CONFORMANCE_VERSION = '0.1.16';
const SPEC_VERSION = '2025-11-25';
const SUPPORTED_SCENARIOS = [
  'server-initialize',
  'logging-set-level',
  'ping',
  'tools-list',
  'resources-list',
  'prompts-list',
];

function fail(message) {
  process.stderr.write(`MCP conformance error: ${message}\n`);
  process.exitCode = 1;
}

function runConformance(args) {
  return new Promise((resolvePromise) => {
    const child = spawn(conformanceBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolvePromise(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, 30_000);
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('error', (error) => finish({ status: null, error }));
    child.once('close', (status) =>
      finish({
        status,
        error: timedOut ? new Error('official conformance scenario exceeded 30 seconds') : undefined,
      })
    );
  });
}

const conformancePackagePath = resolve(
  'node_modules/@modelcontextprotocol/conformance/package.json'
);
let installedVersion;
try {
  installedVersion = JSON.parse(readFileSync(conformancePackagePath, 'utf8')).version;
} catch (error) {
  fail(
    `official conformance package is unavailable (${error instanceof Error ? error.message : String(error)}); run npm ci`
  );
  process.exit();
}
if (installedVersion !== PINNED_CONFORMANCE_VERSION) {
  fail(
    `expected @modelcontextprotocol/conformance ${PINNED_CONFORMANCE_VERSION}, found ${installedVersion}`
  );
  process.exit();
}

const conformanceBin = resolve('node_modules/.bin/conformance');
const listed = spawnSync(conformanceBin, ['list', '--server'], { encoding: 'utf8' });
if (listed.error || listed.status !== 0) {
  fail(
    `could not enumerate official scenarios: ${listed.error?.message ?? listed.stderr ?? `exit ${listed.status}`}`
  );
  process.exit();
}
const availableScenarios = [...listed.stdout.matchAll(/^  - ([a-z0-9-]+) /gm)].map(
  (match) => match[1]
);
const missingScenarios = SUPPORTED_SCENARIOS.filter(
  (scenario) => !availableScenarios.includes(scenario)
);
if (missingScenarios.length > 0) {
  fail(`pinned runner is missing required scenarios: ${missingScenarios.join(', ')}`);
  process.exit();
}

const unsupportedScenarios = availableScenarios.filter(
  (scenario) => !SUPPORTED_SCENARIOS.includes(scenario)
);
process.stdout.write(
  `Official MCP conformance ${installedVersion}; spec ${SPEC_VERSION}.\n` +
    `Required scenarios: ${SUPPORTED_SCENARIOS.join(', ')}.\n` +
    `Unsupported or fixture-specific scenarios (not run): ${unsupportedScenarios.join(', ')}.\n`
);

const whmcsCalls = [];
const fakeWhmcsClient = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'then') return undefined;
      return () => {
        const method = String(property);
        whmcsCalls.push(method);
        throw new Error(`WHMCS conformance tripwire invoked: ${method}`);
      };
    },
  }
);
const logger = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'child') return () => logger;
      if (property === 'getCorrelationId') return () => 'mcp-official-conformance';
      return () => undefined;
    },
  }
);
const rateLimiter = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('Rate limiter conformance tripwire invoked');
      };
    },
  }
);

const active = new Set();
const httpServer = createServer((request, response) => {
  void (async () => {
    if (request.url?.split('?')[0] !== '/mcp') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Not found' }, id: null })
      );
      return;
    }
    // Match the production HTTP default: browser-origin requests are denied
    // unless explicitly allowlisted. The localhost adapter has no allowlist.
    if (request.headers.origin) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: 'Forbidden origin' }, id: null })
      );
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end('Method Not Allowed');
      return;
    }

    const server = buildServer({ whmcsClient: fakeWhmcsClient, logger, rateLimiter });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const connection = { server, transport };
    active.add(connection);
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response);
    } catch (error) {
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal error',
            },
            id: null,
          })
        );
      }
    } finally {
      try {
        await transport.close();
      } finally {
        await server.close();
      }
      active.delete(connection);
    }
  })();
});

await new Promise((resolvePromise, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(0, '127.0.0.1', resolvePromise);
});

const address = httpServer.address();
if (address === null || typeof address === 'string') {
  fail('could not resolve local conformance adapter port');
} else {
  const outputDir = mkdtempSync(join(tmpdir(), 'whmcs-mcp-conformance-'));
  try {
    for (const scenario of SUPPORTED_SCENARIOS) {
      process.stdout.write(`\n[official-conformance] ${scenario}\n`);
      const run = await runConformance([
          'server',
          '--url',
          `http://127.0.0.1:${address.port}/mcp`,
          '--scenario',
          scenario,
          '--spec-version',
          SPEC_VERSION,
          '--output-dir',
          outputDir,
        ]);
      if (run.error || run.status !== 0) {
        fail(`${scenario} failed (${run.error?.message ?? `exit ${run.status}`})`);
        break;
      }
    }
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}

await new Promise((resolvePromise) => httpServer.close(resolvePromise));
for (const connection of active) {
  try {
    await connection.transport.close();
  } catch {
    // Best effort after the runner exits.
  }
  try {
    await connection.server.close();
  } catch {
    // Best effort after the runner exits.
  }
}

if (whmcsCalls.length > 0) {
  fail(`conformance invoked WHMCS methods: ${whmcsCalls.join(', ')}`);
}
if (process.exitCode !== 1) {
  process.stdout.write('\nOfficial MCP conformance scenarios passed; WHMCS tripwire remained clean.\n');
}
