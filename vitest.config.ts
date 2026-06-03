import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Test environment
    environment: 'node',

    // Per-file isolation: each test FILE gets a fresh module graph so
    // module-level singletons (pipeline.ts `cachedRegistry`, writeFlow.ts
    // `store`/`ledger`/`audit`/`approvals`/`dayAmounts`, capabilities.ts
    // `probeCache`) cannot bleed across files within a reused worker. This is
    // the vitest default; pinned explicitly so a future config change can't
    // silently disable it and reintroduce cross-file flakiness. NOTE: isolation
    // does NOT reset `process.env` (the real process environment) — that is
    // handled by the snapshot/restore in tests/setupEach.ts.
    isolate: true,

    // Test file patterns
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    
    // Exclude patterns
    exclude: ['node_modules', 'dist'],
    
    // Timeout for tests (10 seconds per test)
    testTimeout: 10000,
    
    // Hook timeout (30 seconds for setup/teardown)
    hookTimeout: 30000,
    
    // Global setup file (runs ONCE for the whole run — env validation).
    globalSetup: './tests/setup.ts',

    // Per-test-file setup (imported into EVERY test file's module graph).
    // Registers global beforeEach/afterEach that clear the module-level
    // capability `probeCache`, so suite outcome is deterministic regardless
    // of file order / worker reuse. See tests/setupEach.ts.
    setupFiles: ['./tests/setupEach.ts'],

    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
    
    // Reporter
    reporters: ['verbose'],
  },
});
