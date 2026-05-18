import { describe, it, expect } from 'vitest';
import {
  buildDefectLedger,
  severityForFinding,
  summarizeByLayer,
  type TestFinding,
} from '../../src/testProgram/rca.js';

const base: Omit<TestFinding, 'testId' | 'layer' | 'suite' | 'passed' | 'expected' | 'actual' | 'host' | 'mode'> = {};

describe('testProgram rca', () => {
  it('maps finding severity by failure kind and pass/fail', () => {
    const passed: TestFinding = {
      ...base,
      testId: 'T-1',
      suite: 'operator-reads',
      layer: 'L3',
      passed: true,
      expected: 'ok',
      actual: 'ok',
      host: 'kilo',
      mode: 'admin',
    };
    const failed: TestFinding = {
      ...base,
      testId: 'T-2',
      suite: 'contract',
      layer: 'L2',
      passed: false,
      expected: 'schema valid',
      actual: 'no structuredContent',
      host: 'kilo',
      mode: 'admin',
      failureKind: 'schema_mismatch',
    };
    expect(severityForFinding(passed)).toBe('P2');
    expect(severityForFinding(failed)).toBe('P0');
  });

  it('builds a severity-sorted defect ledger with grouped evidence', () => {
    const findings: TestFinding[] = [
      {
        ...base,
        testId: 'L2-C01',
        suite: 'contract',
        layer: 'L2',
        passed: false,
        expected: 'schema-valid structuredContent',
        actual: 'text-only output',
        host: 'kilo',
        mode: 'admin',
        failureKind: 'schema_mismatch',
      },
      {
        ...base,
        testId: 'L4-A02',
        suite: 'access-control',
        layer: 'L4',
        passed: false,
        expected: 'deny cross-client id',
        actual: 'returned client 31 data',
        host: 'claude_code',
        mode: 'client',
        failureKind: 'access_leak',
      },
      {
        ...base,
        testId: 'L5-R01',
        suite: 'resilience',
        layer: 'L5',
        passed: false,
        expected: 'deterministic timeout class',
        actual: 'generic error',
        host: 'claude_desktop',
        mode: 'admin',
        failureKind: 'auth_or_network',
      },
    ];

    const ledger = buildDefectLedger(findings);
    expect(ledger).toHaveLength(3);
    expect(ledger[0]?.severity).toBe('P0');
    expect(ledger[2]?.severity).toBe('P1');
    expect(ledger[0]?.defectId).toBe('DEF-SCHEMA_MISMATCH');
    expect(ledger[1]?.defectId).toBe('DEF-ACCESS_LEAK');
    expect(ledger[2]?.defectId).toBe('DEF-AUTH_OR_NETWORK');
    expect(ledger[0]?.impactedTests).toEqual(['L2-C01']);
  });

  it('summarizes pass-rate per layer for heatmap generation', () => {
    const findings: TestFinding[] = [
      {
        ...base,
        testId: 'L0-1',
        suite: 'config',
        layer: 'L0',
        passed: true,
        expected: 'valid config',
        actual: 'valid config',
        host: 'kilo',
        mode: 'admin',
      },
      {
        ...base,
        testId: 'L2-1',
        suite: 'contract',
        layer: 'L2',
        passed: false,
        expected: 'schema valid',
        actual: 'schema mismatch',
        host: 'kilo',
        mode: 'admin',
        failureKind: 'schema_mismatch',
      },
      {
        ...base,
        testId: 'L2-2',
        suite: 'contract',
        layer: 'L2',
        passed: true,
        expected: 'schema valid',
        actual: 'schema valid',
        host: 'claude_code',
        mode: 'admin',
      },
    ];
    const summary = summarizeByLayer(findings);
    const l0 = summary.find((s) => s.layer === 'L0');
    const l2 = summary.find((s) => s.layer === 'L2');
    expect(l0).toEqual({ layer: 'L0', total: 1, failed: 0, passRatePct: 100 });
    expect(l2).toEqual({ layer: 'L2', total: 2, failed: 1, passRatePct: 50 });
  });
});
