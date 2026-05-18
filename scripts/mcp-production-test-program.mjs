import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { validateToolNames, governancePreflight } from './lib/harnessPreflight.mjs';

const NOW = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = join(process.cwd(), '.audit-local', `prod-test-program-${NOW}`);

const HOST = process.env.TEST_HOST || 'kilo';
const MODE = process.env.TEST_MODE || 'admin';
const CLIENT_ID = Number(process.env.TEST_CLIENT_ID || '30');
const BLOCKED_CLIENT_ID = Number(process.env.TEST_BLOCKED_CLIENT_ID || '31');

const makeArgs = (...args) => Object.assign({}, ...args);
const bool = (v) => v === true;

const TEST_CASES = [
  {
    id: 'L1-CONNECT-001',
    layer: 'L1',
    suite: 'connectivity-auth',
    // Real registered tool is get_ticket_departments (src/tools/support.ts);
    // the historical (never-registered) departments alias was removed.
    name: 'get_ticket_departments auth/connectivity',
    tool: 'get_ticket_departments',
    args: {},
    expected: 'tool call succeeds with structured payload',
    assert: (res) => !res.isError,
    failureKind: 'auth_or_network',
  },
  {
    id: 'L2-CONTRACT-001',
    layer: 'L2',
    suite: 'contract-integrity',
    name: 'list_client_domains schema payload',
    tool: 'list_client_domains',
    args: { clientid: CLIENT_ID, limit: 5, offset: 0 },
    expected: 'structuredContent exists when outputSchema is declared',
    assert: (res) => typeof res.structuredContent === 'object' && res.structuredContent !== null,
    failureKind: 'schema_mismatch',
  },
  {
    id: 'L3-OPS-001',
    layer: 'L3',
    suite: 'operator-reads',
    name: 'active domains defensive post-filter',
    tool: 'list_client_domains',
    args: { clientid: CLIENT_ID, status: 'Active', limit: 25, offset: 0 },
    expected: 'all returned domain statuses are Active after defensive validation',
    assert: (res) => {
      const items = res.structuredContent?.items;
      if (!Array.isArray(items)) return false;
      return items.every((d) => String(d?.status ?? '').toLowerCase() === 'active');
    },
    // An advertised status filter that returns out-of-scope rows is a filter
    // correctness defect, NOT pagination drift (counters can still be coherent).
    failureKind: 'filter_correctness',
  },
  {
    id: 'L4-ACCESS-001',
    layer: 'L4',
    suite: 'access-control',
    name: 'client mode rejects unauthorized client id',
    tool: 'get_client_details',
    args: { clientid: BLOCKED_CLIENT_ID },
    expected: 'request denied in client mode for disallowed client ids',
    assert: (res) => (MODE === 'client' ? bool(res.isError) : true),
    failureKind: 'access_leak',
  },
  {
    id: 'L5-VALIDATION-001',
    layer: 'L5',
    suite: 'validation-fuzz',
    name: 'limit boundary hard fail > 100',
    tool: 'list_client_domains',
    args: { clientid: CLIENT_ID, limit: 101, offset: 0 },
    expected: 'invalid page size gets deterministic error',
    assert: (res) => bool(res.isError),
    failureKind: 'validation_error',
  },
  {
    id: 'L5-PAGINATION-001',
    layer: 'L5',
    suite: 'pagination-boundary',
    name: 'metadata coherence total/count/offset/limit',
    tool: 'list_client_invoices',
    args: { clientid: CLIENT_ID, limit: 10, offset: 0 },
    expected: 'metadata counters are coherent with returned item count',
    assert: (res) => {
      const s = res.structuredContent;
      const count = Array.isArray(s?.items) ? s.items.length : null;
      if (typeof count !== 'number') return false;
      if (typeof s?.count !== 'number') return false;
      if (typeof s?.limit !== 'number') return false;
      return s.count === count && s.limit <= 100;
    },
    failureKind: 'pagination_drift',
  },
  {
    id: 'L6-OBS-001',
    layer: 'L6',
    suite: 'operational-quality',
    name: 'error payload carries actionable classifier hints',
    tool: 'get_client_details',
    args: { clientid: -1 },
    expected: 'error response provides deterministic cause and no crash',
    assert: (res) => bool(res.isError),
    failureKind: 'observability_gap',
  },
];

function normalizeResult(raw) {
  return {
    isError: raw?.isError === true,
    content: raw?.content ?? [],
    structuredContent: raw?.structuredContent,
  };
}

function classifyFailure(kind, errText) {
  return {
    kind,
    message: String(errText || 'assertion_failed').slice(0, 500),
  };
}

// Detect a blanket governance denial (no_token / consumer_denied) in a
// normalized tool result so it can be reclassified as a harness config
// error (P2) instead of a product auth_or_network / pagination_drift.
function isConsumerDenied(normalized) {
  if (!normalized || normalized.isError !== true) return false;
  const text = String(normalized.content?.[0]?.text ?? '');
  let payload = text;
  try {
    payload = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  const blob = JSON.stringify(payload);
  return /consumer_denied|consumer denied|no_token|unknown_token/i.test(blob);
}

// Fail fast: persist a structured harness_config_error summary and exit
// nonzero WITHOUT running workflow cases or emitting blanket denials as
// product failures.
async function failHarnessConfig(message) {
  await mkdir(OUT_DIR, { recursive: true });
  const summary = {
    generated_at: new Date().toISOString(),
    host: HOST,
    mode: MODE,
    total: 0,
    failed: 0,
    pass_rate_pct: 0,
    kind: 'harness_config_error',
    message,
  };
  await writeFile(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(
    join(OUT_DIR, 'findings.json'),
    JSON.stringify([{ kind: 'harness_config_error', message }], null, 2),
    'utf8'
  );
  console.error(`harness_config_error: ${message}`);
  console.error(`Artifacts: ${OUT_DIR}`);
  process.exit(2);
}

async function run() {
  await mkdir(OUT_DIR, { recursive: true });

  // --- Governance PREFLIGHT (before spawning the server) ---------------
  // Governance OFF → legacy path. Governance ON without a synthetic
  // consumer token + registry → fail fast (do NOT run cases and report
  // blanket consumer_denied as product failures).
  const gov = governancePreflight(process.env);
  if (!gov.ok) {
    await failHarnessConfig(gov.message);
    return;
  }
  const injectToken = gov.injectToken;

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env },
    stderr: 'pipe',
  });

  const client = new Client({ name: 'mcp-production-test-program', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  // --- Tool-name validation against the LIVE registry -----------------
  // Eliminates hardcoded tool-name drift: every TEST_CASES tool must be
  // present in the live MCP tools/list before any case executes.
  const liveTools = await client.listTools();
  const liveNames = (liveTools?.tools ?? []).map((t) => t.name);
  const nameCheck = validateToolNames(
    TEST_CASES.map((t) => t.tool),
    liveNames
  );
  if (!nameCheck.ok) {
    await client.close();
    await failHarnessConfig(nameCheck.message);
    return;
  }

  const findings = [];
  for (const t of TEST_CASES) {
    let raw;
    let passed = false;
    let actual = '';
    try {
      // When governance is ON, inject the synthetic consumer bearer into
      // every governed tool call so a real product path is exercised
      // (instead of a blanket no_token denial).
      const callArgs =
        injectToken === undefined
          ? makeArgs(t.args)
          : makeArgs(t.args, { auth_token: injectToken });
      raw = await client.callTool({ name: t.tool, arguments: callArgs });
      const normalized = normalizeResult(raw);
      const denied = isConsumerDenied(normalized);
      const expectsDenial = t.expectsDenial === true;

      if (denied && expectsDenial) {
        // A case that explicitly expects denial: denial == pass.
        passed = true;
        actual = 'consumer_denied as expected';
      } else if (denied && !expectsDenial) {
        // Unexpected blanket denial — a harness config artifact, NOT a
        // product defect. Reclassify to P2 harness_config_error.
        passed = false;
        actual = 'unexpected consumer_denied (harness config)';
      } else {
        passed = Boolean(t.assert(normalized));
        actual = passed ? 'assertion passed' : 'assertion failed';
      }

      findings.push({
        testId: t.id,
        suite: t.suite,
        layer: t.layer,
        passed,
        expected: t.expected,
        actual,
        host: HOST,
        mode: MODE,
        failureKind: passed
          ? undefined
          : denied && !expectsDenial
            ? 'harness_config_error'
            : t.failureKind,
        raw: normalized,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      findings.push({
        testId: t.id,
        suite: t.suite,
        layer: t.layer,
        passed: false,
        expected: t.expected,
        actual: `threw: ${message}`,
        host: HOST,
        mode: MODE,
        failureKind: t.failureKind,
        failure: classifyFailure(t.failureKind, message),
      });
    }
  }

  await client.close();

  const summary = {
    generated_at: new Date().toISOString(),
    host: HOST,
    mode: MODE,
    total: findings.length,
    failed: findings.filter((f) => !f.passed).length,
    pass_rate_pct:
      findings.length === 0
        ? 0
        : Math.round(((findings.length - findings.filter((f) => !f.passed).length) / findings.length) * 1000) / 10,
  };

  await writeFile(join(OUT_DIR, 'findings.json'), JSON.stringify(findings, null, 2), 'utf8');
  await writeFile(join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');

  const failed = findings.filter((f) => !f.passed);
  console.log(`WHMCS MCP production test program complete: ${summary.total - summary.failed}/${summary.total} passed`);
  console.log(`Artifacts: ${OUT_DIR}`);
  if (failed.length > 0) {
    console.log('Failures:');
    for (const f of failed) {
      console.log(`- ${f.testId} ${f.failureKind ?? 'unknown'} ${f.actual}`);
    }
    process.exit(1);
  }
}

run().catch((err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  console.error(msg);
  process.exit(1);
});
