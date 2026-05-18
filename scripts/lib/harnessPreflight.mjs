/**
 * Reliability-sprint Track A — PURE harness preflight helpers.
 *
 * These functions gate the read-only L0–L6 production test program
 * (`scripts/mcp-production-test-program.mjs`) BEFORE any workflow case
 * runs. They are intentionally pure (no I/O, no spawned server, no live
 * WHMCS, no governance imports) so they are fully unit-testable.
 *
 * Two failure modes are detected up front and surfaced as a structured
 * `harness_config_error` (a HARNESS setup fault — NOT a product defect,
 * mapped to P2 in src/testProgram/rca.ts):
 *
 *   1. A TEST_CASES tool name that is not in the live MCP `tools/list`
 *      (eliminates hardcoded tool-name drift, e.g. the historical
 *      `get_support_departments` → real `get_ticket_departments`).
 *
 *   2. Governance ON but the harness has no consumer token AND no
 *      `MCP_CONSUMER_REGISTRY`: every governed read would return a
 *      blanket `{ isError:true, status:'consumer_denied', ... no_token }`
 *      which must NOT be mislabeled as auth_or_network / pagination_drift
 *      product failures. Fail fast instead.
 *
 * This module is plain `.mjs`: tsc `npm run typecheck` only globs
 * `src/**` and ESLint only globs `src/ tests/`, so it is neither typed
 * nor linted here; its behavior is locked by tests/testProgram/.
 */

const HARNESS_KIND = 'harness_config_error';

/** Parse the boolean env convention used by src/config.ts (`'true'`/`'1'`). */
function envTrue(value) {
  return value === 'true' || value === '1';
}

/**
 * Validate every requested TEST_CASES tool name against the live
 * `tools/list` registry. Fails fast (no case execution) on any miss.
 *
 * @param {readonly string[]} requested  tool names referenced by TEST_CASES
 * @param {readonly string[]} live       names from `client.listTools()`
 * @returns {{ok:true,validated:string[]}
 *          |{ok:false,kind:'harness_config_error',message:string,missing:string[]}}
 */
export function validateToolNames(requested, live) {
  const liveSet = new Set(live);
  const seen = new Set();
  const ordered = [];
  for (const name of requested) {
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  const missing = ordered.filter((name) => !liveSet.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      kind: HARNESS_KIND,
      missing,
      message:
        `harness tool-name drift: ${missing.join(', ')} not registered in ` +
        `the live MCP tools/list (live registry has ${live.length} tools). ` +
        `Fix TEST_CASES to use a real registered tool name before running cases.`,
    };
  }
  return { ok: true, validated: ordered };
}

/**
 * Governance preflight. Decides — purely from env — whether the harness
 * may proceed and, if governed, which bearer token to inject into
 * governed tool-call args.
 *
 * Resolution:
 *   - governance OFF / unset  → legacy/default path, no token injection.
 *   - governance ON  + token + registry → proceed, inject bearer.
 *   - governance ON  + (missing token OR missing registry)
 *                              → fail fast as harness_config_error.
 *
 * The token is taken from `HARNESS_CONSUMER_TOKEN` (a synthetic, test-only
 * value supplied by the harness operator — never a real secret).
 *
 * @param {Record<string,string|undefined>} env
 * @returns {{ok:true,governanceEnabled:boolean,injectToken:(string|undefined)}
 *          |{ok:false,kind:'harness_config_error',message:string}}
 */
export function governancePreflight(env) {
  const governanceEnabled = envTrue(env.MCP_GOVERNANCE_ENABLED);

  if (!governanceEnabled) {
    return { ok: true, governanceEnabled: false, injectToken: undefined };
  }

  const token =
    typeof env.HARNESS_CONSUMER_TOKEN === 'string' &&
    env.HARNESS_CONSUMER_TOKEN.length > 0
      ? env.HARNESS_CONSUMER_TOKEN
      : undefined;
  const registry =
    typeof env.MCP_CONSUMER_REGISTRY === 'string' &&
    env.MCP_CONSUMER_REGISTRY.length > 0
      ? env.MCP_CONSUMER_REGISTRY
      : undefined;

  if (token === undefined || registry === undefined) {
    const lacking = [
      token === undefined ? 'consumer token (HARNESS_CONSUMER_TOKEN)' : null,
      registry === undefined ? 'consumer registry (MCP_CONSUMER_REGISTRY)' : null,
    ]
      .filter(Boolean)
      .join(' and ');
    return {
      ok: false,
      kind: HARNESS_KIND,
      message:
        `governance ON but no ${lacking} available to the harness: every ` +
        `governed read tool would return a blanket consumer_denied/no_token. ` +
        `Refusing to run cases and emit blanket denials as product failures. ` +
        `Supply a synthetic HARNESS_CONSUMER_TOKEN + MCP_CONSUMER_REGISTRY, ` +
        `or disable governance for the legacy path.`,
    };
  }

  return { ok: true, governanceEnabled: true, injectToken: token };
}
