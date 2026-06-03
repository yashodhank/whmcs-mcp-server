/**
 * Per-test-file setup (vitest `setupFiles`).
 *
 * Registered via `vitest.config.ts -> test.setupFiles`. Unlike
 * `tests/setup.ts` (which is `globalSetup` and runs ONCE for the whole run),
 * this module is imported into EVERY test file's module graph, so its
 * `beforeEach`/`afterEach` hooks run around every individual test in the
 * suite.
 *
 * WHY THIS EXISTS — (1) deterministic probe-cache isolation
 * ---------------------------------------------------------
 * `src/governance/capabilities.ts` keeps a process-lifetime, module-level
 * `probeCache` Map. `probeCapability()` writes resolved (often NON-
 * `supported`: `unsupported` / `not_authorized` / `degraded`) statuses into
 * it, and `getCapability()` returns a cached entry IN PREFERENCE to the
 * static `CAPABILITY_REGISTRY` seed.
 *
 * Several suites exercise `probeCapability` with mocked `read`/allowlist deps
 * (e.g. `tests/governance/capabilities.test.ts`) and poison the cache for the
 * Phase-H promoted actions (`GetTransactions`, `GetStats`, `GetToDoItems`,
 * `GetAutomationLog`). When test files share a module instance (vitest worker
 * reuse / `--isolate=false` / scheduling under load), that poisoned cache
 * survives into LATER files that rely on the static `supported` seed —
 * notably `tests/tools/aggregators.test.ts` ("outputSchema is additive…",
 * "capability-gated sections stay structured & consistent…") and
 * `tests/tools/capabilityShellTools.test.ts` — making them fail
 * non-deterministically depending purely on file order.
 *
 * Clearing the cache in a GLOBAL `beforeEach` + `afterEach` makes every test
 * start AND leave with a clean probe cache, so suite outcome is independent
 * of file ordering / worker reuse. This touches no production logic — it only
 * calls the existing test-only `__resetCapabilityCacheForTests` hook.
 *
 * WHY THIS EXISTS — (2) deterministic process.env isolation
 * ---------------------------------------------------------
 * vitest's per-file module isolation (`test.isolate: true`, the default — see
 * vitest.config.ts) gives each test FILE a fresh module graph, so module-level
 * singletons (the lazily-memoized `cachedRegistry` in pipeline.ts, the
 * `store`/`ledger`/`audit`/`approvals`/`dayAmounts` in writeFlow.ts) start
 * clean per file. BUT `process.env` is the REAL Node process environment — it
 * is NOT reset by module isolation, so a value written by one test file LEAKS
 * into the next file that runs in the same (reused) worker.
 *
 * Several suites mutate `process.env` (notably `MCP_CONSUMER_REGISTRY`, also
 * `MCP_AUDIT_TRACE` / `MCP_ENV` / `MCP_WRITE_EXECUTION_AUTHORIZED`). Some clean
 * up after themselves; some do NOT — e.g. `tests/tools/writeFlow.test.ts`
 * (sets `MCP_CONSUMER_REGISTRY` in `beforeAll`, no teardown) and
 * `tests/tools/writeFlow.oneCall.test.ts` / `writeFlow.elicitation.test.ts`
 * (set it in `beforeEach`, no `afterEach`). A leaked value is then read by
 * `getConsumerRegistry()` (pipeline.ts memoizes `process.env.MCP_CONSUMER_REGISTRY`
 * on first call) or by writeFlow's live `process.env.MCP_WRITE_EXECUTION_AUTHORIZED`
 * fallback in a LATER file — flipping consumer resolution / authorization and
 * making assertions like writeFlow.test "execute is hard-blocked in production"
 * fail ~1-in-N depending purely on file ordering / worker scheduling.
 *
 * Snapshotting `process.env` before each test and restoring it after makes
 * every test start AND leave with exactly the env it inherited, regardless of
 * whether the test (or a prior file in the same worker) forgot to clean up.
 * This is a plain object copy/restore — it touches no production logic.
 *
 * NOTE: we deliberately do NOT reset the pipeline registry cache here. Doing so
 * would require importing pipeline.ts into the GLOBAL setup module graph, which
 * interferes with the `vi.mock('../src/config.js')` hoisting that several
 * governed-path suites depend on (it pulls in a parallel, unmocked config
 * instance and breaks consumer/contract resolution). It is unnecessary anyway:
 * per-file module isolation already gives each file a fresh null cache, and the
 * env restore above removes any leaked `MCP_CONSUMER_REGISTRY` before the next
 * file reads it. Suites that toggle the registry MID-file already call the
 * existing `__resetRegistryCacheForTests` hook themselves.
 */

import { beforeEach, afterEach } from 'vitest';
import { __resetCapabilityCacheForTests } from '../src/governance/capabilities.js';

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  // Snapshot the inherited environment so any mutation a test makes can be
  // undone, even if the test itself forgets to clean up.
  envSnapshot = { ...process.env };
  __resetCapabilityCacheForTests();
});

afterEach(() => {
  // Restore process.env to its pre-test state: delete keys the test added and
  // reinstate any keys the test deleted or overwrote. This stops env from
  // bleeding across files in a reused worker (the root cause of the
  // intermittent cross-file write-flow flakiness).
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, envSnapshot);
  __resetCapabilityCacheForTests();
});
