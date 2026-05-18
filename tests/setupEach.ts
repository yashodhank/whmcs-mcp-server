/**
 * Per-test-file setup (vitest `setupFiles`).
 *
 * Registered via `vitest.config.ts -> test.setupFiles`. Unlike
 * `tests/setup.ts` (which is `globalSetup` and runs ONCE for the whole run),
 * this module is imported into EVERY test file's module graph, so its
 * `beforeEach`/`afterEach` hooks run around every individual test in the
 * suite.
 *
 * WHY THIS EXISTS — deterministic probe-cache isolation
 * ------------------------------------------------------
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
 */

import { beforeEach, afterEach } from 'vitest';
import { __resetCapabilityCacheForTests } from '../src/governance/capabilities.js';

beforeEach(() => {
  __resetCapabilityCacheForTests();
});

afterEach(() => {
  __resetCapabilityCacheForTests();
});
