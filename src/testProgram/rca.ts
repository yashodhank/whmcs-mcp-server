export type Severity = 'P0' | 'P1' | 'P2';

export interface TestFinding {
  readonly testId: string;
  readonly suite: string;
  readonly layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6';
  readonly passed: boolean;
  readonly expected: string;
  readonly actual: string;
  readonly host: 'kilo' | 'claude_code' | 'claude_desktop';
  readonly mode: 'admin' | 'client';
  readonly failureKind?:
    | 'schema_mismatch'
    | 'access_leak'
    | 'write_bypass'
    | 'auth_or_network'
    | 'pagination_drift'
    | 'filter_correctness'
    | 'ordering_nondeterministic'
    | 'validation_error'
    | 'rate_limit_or_timeout'
    | 'observability_gap'
    | 'harness_config_error'
    | 'unknown';
}

export interface DefectLedgerEntry {
  readonly defectId: string;
  readonly severity: Severity;
  readonly title: string;
  readonly hypothesis: string;
  readonly impactedTests: string[];
  readonly impactedHosts: string[];
  readonly likelyRootCause: string;
  readonly recommendation: string;
}

const FAILURE_PRIORITY: Record<NonNullable<TestFinding['failureKind']>, Severity> = {
  schema_mismatch: 'P0',
  access_leak: 'P0',
  write_bypass: 'P0',
  auth_or_network: 'P1',
  pagination_drift: 'P1',
  filter_correctness: 'P1',
  ordering_nondeterministic: 'P2',
  validation_error: 'P1',
  rate_limit_or_timeout: 'P1',
  observability_gap: 'P2',
  // A consumer/no-token denial or a tool-name/registry mismatch is a harness
  // misconfiguration, not a product defect — never P0/P1, so it can never
  // inflate defect severity or be mislabeled auth_or_network/pagination_drift.
  harness_config_error: 'P2',
  unknown: 'P2',
};

function unique<T>(list: readonly T[]): T[] {
  return [...new Set(list)];
}

export function severityForFinding(finding: TestFinding): Severity {
  if (finding.passed) return 'P2';
  return FAILURE_PRIORITY[finding.failureKind ?? 'unknown'];
}

function titleFor(kind: NonNullable<TestFinding['failureKind']>): string {
  switch (kind) {
    case 'schema_mismatch':
      return 'Tool output contract violation';
    case 'access_leak':
      return 'Cross-client data leakage risk';
    case 'write_bypass':
      return 'Read-only mode write bypass';
    case 'auth_or_network':
      return 'Authentication/network diagnostics gap';
    case 'pagination_drift':
      return 'Pagination metadata inconsistency';
    case 'filter_correctness':
      return 'Advertised filter not applied (inert filter)';
    case 'ordering_nondeterministic':
      return 'Non-deterministic ordering across runs';
    case 'validation_error':
      return 'Input validation/sanitization weakness';
    case 'rate_limit_or_timeout':
      return 'Resilience weakness under stress';
    case 'observability_gap':
      return 'Operator observability/logging gap';
    case 'harness_config_error':
      return 'Test harness configuration error (not a product defect)';
    default:
      return 'Unclassified behavioral defect';
  }
}

function hypothesisFor(kind: NonNullable<TestFinding['failureKind']>): string {
  switch (kind) {
    case 'schema_mismatch':
      return 'Legacy/governed response paths diverge and skip structuredContent normalization.';
    case 'access_leak':
      return 'Client-mode authorization gate is missing or inconsistently enforced across handlers.';
    case 'write_bypass':
      return 'Write execution policy is not centralized before action dispatch.';
    case 'auth_or_network':
      return 'Transport/auth failures are collapsed into ambiguous errors without deterministic taxonomy.';
    case 'pagination_drift':
      return 'Pagination counters are computed from different source windows or post-filter steps.';
    case 'filter_correctness':
      return 'A filter parameter is accepted/advertised but not applied to the result set (inert filter), so out-of-scope rows are returned.';
    case 'ordering_nondeterministic':
      return 'Sort key is unstable or not fully deterministic across equal timestamps.';
    case 'validation_error':
      return 'Validation is not uniformly applied before downstream API invocation/logging.';
    case 'rate_limit_or_timeout':
      return 'Retry/backoff policy and timeout boundaries are missing or unsafe under burst load.';
    case 'observability_gap':
      return 'Error context lacks correlation identifiers and stage-aware diagnostics.';
    case 'harness_config_error':
      return 'The harness invoked the server with governance ON but no consumer token/registry (blanket no_token/consumer_denied), or referenced a tool name absent from the live registry — a harness setup fault, not server behavior.';
    default:
      return 'Failure does not map to current taxonomy and requires triage expansion.';
  }
}

function recommendationFor(kind: NonNullable<TestFinding['failureKind']>): string {
  switch (kind) {
    case 'schema_mismatch':
      return 'Add schema-contract CI gate to reject handlers that return text-only payloads when outputSchema exists.';
    case 'access_leak':
      return 'Enforce centralized client-id guard and add deny-by-default tests per tool.';
    case 'write_bypass':
      return 'Require read_only/write-policy check at one shared dispatch boundary with explicit audit record.';
    case 'auth_or_network':
      return 'Adopt deterministic auth/network error taxonomy with actionable operator messages.';
    case 'pagination_drift':
      return 'Compute total/count/offset/limit from one canonical view after filtering and before projection.';
    case 'filter_correctness':
      return 'Apply every accepted filter to the result set (or reject it), and add a golden test asserting no out-of-scope rows are returned.';
    case 'ordering_nondeterministic':
      return 'Add tie-breaker sort keys and page-boundary golden tests.';
    case 'validation_error':
      return 'Centralize input sanitation/length limits and redact unsafe echoes in logs.';
    case 'rate_limit_or_timeout':
      return 'Add bounded retries for transient failures with explicit no-retry list for deterministic errors.';
    case 'observability_gap':
      return 'Emit correlation id, phase, and failure kind in every structured error.';
    case 'harness_config_error':
      return 'Fix the harness: supply a synthetic consumer token + MCP_CONSUMER_REGISTRY when governance is ON, validate tool names against the live tools/list, and exclude this from product defect severity.';
    default:
      return 'Expand taxonomy and add a regression test for this new defect class.';
  }
}

export function buildDefectLedger(findings: readonly TestFinding[]): DefectLedgerEntry[] {
  const failed = findings.filter((f) => !f.passed);
  const grouped = new Map<string, TestFinding[]>();
  for (const finding of failed) {
    const key = finding.failureKind ?? 'unknown';
    const list = grouped.get(key) ?? [];
    list.push(finding);
    grouped.set(key, list);
  }

  const entries: DefectLedgerEntry[] = [];
  for (const [kind, list] of grouped.entries()) {
    const typedKind = kind as NonNullable<TestFinding['failureKind']>;
    const severity = FAILURE_PRIORITY[typedKind];
    entries.push({
      defectId: `DEF-${typedKind.toUpperCase()}`,
      severity,
      title: titleFor(typedKind),
      hypothesis: hypothesisFor(typedKind),
      impactedTests: unique(list.map((f) => f.testId)).sort(),
      impactedHosts: unique(list.map((f) => f.host)).sort(),
      likelyRootCause: hypothesisFor(typedKind),
      recommendation: recommendationFor(typedKind),
    });
  }

  const rank = { P0: 0, P1: 1, P2: 2 };
  return entries.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export interface LayerSummary {
  readonly layer: TestFinding['layer'];
  readonly total: number;
  readonly failed: number;
  readonly passRatePct: number;
}

export function summarizeByLayer(findings: readonly TestFinding[]): LayerSummary[] {
  const layers: TestFinding['layer'][] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6'];
  return layers.map((layer) => {
    const current = findings.filter((f) => f.layer === layer);
    const total = current.length;
    const failed = current.filter((f) => !f.passed).length;
    const passRatePct = total === 0 ? 0 : Math.round(((total - failed) / total) * 1000) / 10;
    return { layer, total, failed, passRatePct };
  });
}
