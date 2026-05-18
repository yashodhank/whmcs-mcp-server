/**
 * B5 — governance pipeline: the single output-boundary primitive.
 *
 * Wires B1 (canonical) + B2 (contracts/projection) + B3 (consumer registry):
 *   raw WHMCS  →  Canonical<T>  →  resolve consumer (bearer token)
 *              →  pick contract (consumer-resolved, never caller-arbitrary)
 *              →  project() once, at the boundary  →  MCP result.
 *
 * `governProjection` is PURE (all deps explicit) and fully unit-tested.
 * The config-bound wrappers are thin glue around it.
 */

import { config } from '../config.js';
import {
  type Canonical,
  type ConsumerProfile,
  type ContractName,
  type ProjectionEnv,
  ProjectionEnvError,
} from './types.js';
import { loadConsumerRegistry, resolveConsumer } from './consumers.js';
import { getContract } from './contracts.js';
import { project } from './projection.js';

/** Map the validated MCP_ENV to a ProjectionEnv (identical union). */
export function getProjectionEnv(): ProjectionEnv {
  return config.MCP_ENV;
}

/**
 * Resolve the contract to apply. A caller-supplied request is honoured ONLY
 * if the resolved consumer profile permits it; otherwise the profile default.
 * Projection is never driven by an arbitrary caller-supplied contract name.
 */
export function pickContract(
  profile: ConsumerProfile,
  requested?: string
): ContractName {
  if (
    requested !== undefined &&
    (profile.allowedContracts as readonly string[]).includes(requested)
  ) {
    return requested as ContractName;
  }
  return profile.defaultContract;
}

export type GovernStatus =
  | 'projected'
  | 'consumer_denied'
  | 'contract_env_forbidden';

export interface GovernResult {
  readonly ok: boolean;
  readonly status: GovernStatus;
  readonly data?: Record<string, unknown>;
  readonly error?: string;
  readonly consumer_id?: string;
  readonly contract?: ContractName;
}

/**
 * PURE core. No config / process.env access — all inputs explicit.
 */
export function governProjection<T>(args: {
  canonical: Canonical<T>;
  authToken: string | undefined;
  env: ProjectionEnv;
  registry: ConsumerProfile[];
  allowAnon: boolean;
  requestedContract?: string;
}): GovernResult {
  const resolution = resolveConsumer(args.authToken, args.env, args.registry, {
    allowAnon: args.allowAnon,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      status: 'consumer_denied',
      error: `consumer denied: ${resolution.reason}`,
    };
  }

  const profile = resolution.profile;
  const contractName = pickContract(profile, args.requestedContract);
  const contract = getContract(contractName);

  try {
    const data = project(args.canonical, contract, args.env);
    return {
      ok: true,
      status: 'projected',
      data,
      consumer_id: profile.id,
      contract: contractName,
    };
  } catch (e) {
    if (e instanceof ProjectionEnvError) {
      return {
        ok: false,
        status: 'contract_env_forbidden',
        error: e.message,
        consumer_id: profile.id,
        contract: contractName,
      };
    }
    throw e;
  }
}

export interface GovernListResult {
  readonly ok: boolean;
  readonly status: GovernStatus;
  readonly items?: Record<string, unknown>[];
  readonly error?: string;
  readonly consumer_id?: string;
  readonly contract?: ContractName;
}

/**
 * PURE list core. Resolves the consumer ONCE, then projects every row
 * through the resolved contract using a per-row canonical mapper. A denied
 * consumer or env-forbidden contract yields no rows (structured failure).
 */
export function governListProjection(args: {
  rows: readonly unknown[];
  mapItem: (raw: unknown) => Canonical<unknown>;
  authToken: string | undefined;
  env: ProjectionEnv;
  registry: ConsumerProfile[];
  allowAnon: boolean;
  requestedContract?: string;
}): GovernListResult {
  const resolution = resolveConsumer(args.authToken, args.env, args.registry, {
    allowAnon: args.allowAnon,
  });
  if (!resolution.ok) {
    return {
      ok: false,
      status: 'consumer_denied',
      error: `consumer denied: ${resolution.reason}`,
    };
  }

  const profile = resolution.profile;
  const contractName = pickContract(profile, args.requestedContract);
  const contract = getContract(contractName);

  try {
    const items = args.rows.map((raw) =>
      project(args.mapItem(raw), contract, args.env)
    );
    return {
      ok: true,
      status: 'projected',
      items,
      consumer_id: profile.id,
      contract: contractName,
    };
  } catch (e) {
    if (e instanceof ProjectionEnvError) {
      return {
        ok: false,
        status: 'contract_env_forbidden',
        error: e.message,
        consumer_id: profile.id,
        contract: contractName,
      };
    }
    throw e;
  }
}

/**
 * PURE backward-compat gate. When governance is disabled the caller's
 * existing legacy payload is returned verbatim (zero behavior change for
 * apps/tests); when enabled the governed result is produced. The `govern`
 * thunk is only invoked when enabled.
 */
export function applyGovernanceOrLegacy(args: {
  enabled: boolean;
  legacy: unknown;
  govern: () => GovernedToolResult;
}): GovernedToolResult {
  if (!args.enabled) {
    return {
      content: [{ type: 'text', text: JSON.stringify(args.legacy) }],
    } as GovernedToolResult;
  }
  return args.govern();
}

/* ───────────────────────  config-bound thin wrappers  ─────────────────────── */

/** Whether the consumer-aware projection boundary is active (opt-in). */
export function governanceEnabled(): boolean {
  return config.MCP_GOVERNANCE_ENABLED;
}

let cachedRegistry: ConsumerProfile[] | null = null;

/** Lazily load + cache the consumer registry from env (B3 owns parsing). */
export function getConsumerRegistry(): ConsumerProfile[] {
  cachedRegistry ??= loadConsumerRegistry(process.env);
  return cachedRegistry;
}

/** Test-only: clear the memoized registry. */
export function __resetRegistryCacheForTests(): void {
  cachedRegistry = null;
}

export interface GovernedToolResult {
  content: { type: 'text'; text: string }[];
  /** Absent for legacy passthrough; present for governed output (B7). */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * The output boundary for a governed read tool. Maps + projects + formats
 * both structuredContent (B7) and human-readable content. A denied consumer
 * or env-forbidden contract returns a structured error — never data.
 */
export function governedToolResult<T>(args: {
  canonical: Canonical<T>;
  authToken: string | undefined;
  requestedContract?: string;
}): GovernedToolResult {
  const r = governProjection({
    canonical: args.canonical,
    authToken: args.authToken,
    env: getProjectionEnv(),
    registry: getConsumerRegistry(),
    allowAnon: config.MCP_ALLOW_ANON_LLM,
    requestedContract: args.requestedContract,
  });

  if (!r.ok) {
    const payload = { isError: true, error: r.error, status: r.status };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }

  const payload = {
    entity: args.canonical.entity,
    consumer: r.consumer_id,
    contract: r.contract,
    data: r.data,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Output boundary for a governed LIST tool. Projects each row through the
 * resolved consumer contract and merges the projected items into the
 * caller's envelope (total/count/offset/limit/extra). Denied consumer →
 * structured error, never rows.
 */
export function governedListResult(args: {
  rows: readonly unknown[];
  mapItem: (raw: unknown) => Canonical<unknown>;
  envelope: Record<string, unknown>;
  authToken: string | undefined;
  requestedContract?: string;
}): GovernedToolResult {
  const r = governListProjection({
    rows: args.rows,
    mapItem: args.mapItem,
    authToken: args.authToken,
    env: getProjectionEnv(),
    registry: getConsumerRegistry(),
    allowAnon: config.MCP_ALLOW_ANON_LLM,
    requestedContract: args.requestedContract,
  });

  if (!r.ok) {
    const payload = { isError: true, error: r.error, status: r.status };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }

  const payload = {
    consumer: r.consumer_id,
    contract: r.contract,
    items: r.items,
    ...args.envelope,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
