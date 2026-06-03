/**
 * Phase B — B4 capability registry + read-only probe.
 *
 * Per WHMCS action the server keeps a declared capability status. Tools and
 * aggregators consult `getCapability` BEFORE calling WHMCS; `unverified`
 * entries may be promoted exactly once via a single small read-only `probeCapability`
 * call whose result is cached in-process. Probes respect the existing read
 * allowlist (`assertReadAction` / the injected `isAllowlisted`): an action that
 * is not allowlisted is reported `unsupported` and NEVER called. We never fake
 * data and never broadly expand the read allowlist here — see
 * docs/PHASE_B_GOVERNANCE.md §6.
 *
 * This module imports the FROZEN seam `./types.js` only and owns no other state.
 */

import type {
  CapabilityStatus,
  CapabilityStatusValue,
  CapabilityUnavailable,
} from './types.js';

/* ───────────────────────────  Static registry  ──────────────────────────── */

/**
 * Capability ids are snake_case identifiers a consumer references in
 * `ConsumerProfile.allowedActions`. The action→capability mapping is stable and
 * committed; consumers depend on these names, not on WHMCS action spellings.
 */
const SUPPORTED_READS: readonly (readonly [action: string, capability: string])[] = [
  ['GetClients', 'list_clients'],
  ['GetClientsDetails', 'get_client_details'],
  ['GetClientsProducts', 'list_client_products'],
  ['GetClientsDomains', 'list_client_domains'],
  ['GetInvoice', 'get_invoice'],
  ['GetInvoices', 'list_invoices'],
  ['GetTickets', 'list_tickets'],
  ['GetTicket', 'get_ticket'],
  ['GetSupportDepartments', 'list_support_departments'],
  ['GetOrders', 'list_orders'],
  ['GetProducts', 'list_products'],
  ['GetActivityLog', 'list_activity_log'],
  ['GetAdminDetails', 'get_admin_details'],
  ['GetAdminLog', 'list_admin_log'],
  ['DomainWhois', 'domain_whois'],
  // Phase H — promoted after read-only probes confirmed `supported` on
  // Dev WHMCS 8, Dev WHMCS 9, AND production read-only.
  ['GetTransactions', 'list_client_transactions'],
  ['GetStats', 'get_system_stats'],
  ['GetToDoItems', 'list_todo_items'],
  ['GetAutomationLog', 'list_automation_log'],
];

/**
 * Remaining unverified. GetUsers probes returned `degraded` on Dev W8,
 * Dev W9 AND production (likely an API-role gap — see
 * docs/getusers-investigation.md). NOT promoted, NOT allowlisted; the
 * shell keeps returning a structured capability_unavailable. Never faked.
 */
const UNVERIFIED_READS: readonly (readonly [action: string, capability: string])[] = [
  ['GetUsers', 'list_users'],
  // Track A — infrastructure / reference reads. Allowlisted (actionPolicy.ts)
  // so the governed tools function, but NOT yet prod-probed, so honestly
  // declared `unverified`. The read tools still work (capability status is
  // informational, as with the list_* tools); an operator probe can promote
  // these to `supported`.
  ['GetServers', 'get_server_health'],
  ['GetTLDPricing', 'get_tld_pricing'],
  // Track A (batch 2)
  ['GetContacts', 'get_client_contacts'],
  ['GetPayMethods', 'get_pay_methods'],
  ['GetCredits', 'get_credits'],
  ['GetTicketCounts', 'get_ticket_counts'],
  ['GetSupportStatuses', 'list_support_statuses'],
  // Track A (batch 3)
  ['GetQuotes', 'get_quotes'],
  ['GetCurrencies', 'get_currencies'],
  ['GetPaymentMethods', 'list_payment_methods'],
  ['WhmcsDetails', 'get_whmcs_details'],
];

function buildRegistry(): Record<string, CapabilityStatus> {
  const registry: Record<string, CapabilityStatus> = {};
  for (const [action, capability] of SUPPORTED_READS) {
    registry[action] = {
      action,
      status: 'supported',
      capability,
      note: 'Allowlisted read action, supported by this server build.',
    };
  }
  for (const [action, capability] of UNVERIFIED_READS) {
    registry[action] = {
      action,
      status: 'unverified',
      capability,
      note: 'Needed by Phase C but not yet allowlisted; probe to verify before use.',
    };
  }
  return registry;
}

/** Static, declared capability per WHMCS action the server cares about. */
export const CAPABILITY_REGISTRY: Record<string, CapabilityStatus> =
  buildRegistry();

/* ─────────────────────────────  In-process cache  ───────────────────────── */

/**
 * Probe results are memoised for the lifetime of the process. The registry
 * itself is never mutated; resolved statuses live here.
 */
const probeCache = new Map<string, CapabilityStatus>();

/** Test-only hook to clear the in-process probe cache. Not for production use. */
export function __resetCapabilityCacheForTests(): void {
  probeCache.clear();
}

/* ─────────────────────────────  Lookups  ─────────────────────────────────── */

/**
 * Derive a stable snake_case capability id for an action that is not in the
 * static registry, so structured "unavailable" payloads still carry a name.
 */
function synthesizeCapabilityId(action: string): string {
  const snake = action
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');
  return snake.length > 0 ? snake : 'unknown_action';
}

/**
 * Return the current capability status for an action. A cached probe result
 * wins over the static seed. An unknown action is synthesized as `unsupported`
 * (the most conservative status) — it is never silently treated as supported.
 */
export function getCapability(action: string): CapabilityStatus {
  const cached = probeCache.get(action);
  if (cached !== undefined) {
    return cached;
  }
  if (Object.hasOwn(CAPABILITY_REGISTRY, action)) {
    return CAPABILITY_REGISTRY[action];
  }
  return {
    action,
    status: 'unsupported',
    capability: synthesizeCapabilityId(action),
    note: 'Action is not in the capability registry.',
  };
}

/* ─────────────────────────────  Probe  ───────────────────────────────────── */

/** Dependencies injected into the probe so it never owns transport/policy. */
export interface ProbeDeps {
  /** Read-only WHMCS boundary (WhmcsClient.read). */
  read: (action: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** True iff the action is in the existing read allowlist (assertReadAction). */
  isAllowlisted: (action: string) => boolean;
}

const ACCESS_DENIED_PATTERNS = [
  'access denied',
  'permission',
  'not permitted',
  'unauthor', // unauthorized / unauthorised
  'authentication failed',
  'invalid permission',
];

const UNKNOWN_ACTION_PATTERNS = [
  'action could not be found',
  'action not found',
  'invalid action',
  'unknown action',
  'requested api action',
];

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}

function readResultIsError(value: unknown): { isError: boolean; message: string } {
  if (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    (value as { result: unknown }).result === 'error'
  ) {
    const msg =
      'message' in value &&
      typeof (value as { message: unknown }).message === 'string'
        ? (value as { message: string }).message
        : '';
    return { isError: true, message: msg };
  }
  return { isError: false, message: '' };
}

function classifyFailure(
  action: string,
  capability: string,
  message: string,
  verifiedAt: string
): CapabilityStatus {
  const lower = message.toLowerCase();
  if (ACCESS_DENIED_PATTERNS.some((p) => lower.includes(p))) {
    return {
      action,
      status: 'not_authorized',
      capability,
      verifiedAt,
      note: 'WHMCS denied access for the configured API credentials.',
    };
  }
  if (UNKNOWN_ACTION_PATTERNS.some((p) => lower.includes(p))) {
    return {
      action,
      status: 'unsupported',
      capability,
      verifiedAt,
      note: 'WHMCS reports this action does not exist on the install.',
    };
  }
  return {
    action,
    status: 'degraded',
    capability,
    verifiedAt,
    note: 'Probe could not be completed (transport/other error).',
  };
}

/**
 * Issue at most ONE minimal read-only probe to resolve an `unverified`
 * capability, caching the result in-process.
 *
 * - Not allowlisted ⇒ `unsupported`, and `read` is NOT called.
 * - Success ⇒ `supported` with `verifiedAt`.
 * - `result:'error'` (or thrown) with access-denied/permission text ⇒
 *   `not_authorized`.
 * - `result:'error'` (or thrown) with unknown-action text ⇒ `unsupported`.
 * - transport / any other error ⇒ `degraded`.
 *
 * The first resolved status is cached; subsequent calls short-circuit and do
 * not re-probe.
 */
export async function probeCapability(
  action: string,
  deps: ProbeDeps,
  params?: Record<string, unknown>
): Promise<CapabilityStatus> {
  const cached = probeCache.get(action);
  if (cached !== undefined) {
    return cached;
  }

  const base = getCapability(action);
  const capability = base.capability;

  // Allowlist is the hard gate — never call read() for a non-allowlisted
  // action; report unsupported without expanding the allowlist.
  if (!deps.isAllowlisted(action)) {
    const unsupported: CapabilityStatus = {
      action,
      status: 'unsupported',
      capability,
      note: 'Action is not in the read allowlist; not probed.',
    };
    probeCache.set(action, unsupported);
    return unsupported;
  }

  const verifiedAt = new Date().toISOString();
  const probeParams: Record<string, unknown> = { limitnum: 1, ...params };

  let resolved: CapabilityStatus;
  try {
    const response = await deps.read(action, probeParams);
    const { isError, message } = readResultIsError(response);
    resolved = isError
      ? classifyFailure(action, capability, message, verifiedAt)
      : {
          action,
          status: 'supported',
          capability,
          verifiedAt,
          note: 'Probe succeeded against the live WHMCS install.',
        };
  } catch (error) {
    resolved = classifyFailure(
      action,
      capability,
      extractErrorMessage(error),
      verifiedAt
    );
  }

  probeCache.set(action, resolved);
  return resolved;
}

/* ─────────────────────────────  Unavailable payload  ────────────────────── */

/**
 * `retriable` is true only for statuses where a fresh operator probe could
 * plausibly change the outcome. `unsupported`/`not_authorized` are terminal
 * for this build; `supported`/`fallback_available` are not "unavailable" but
 * are kept representable (false — nothing to retry).
 */
const RETRIABLE_STATUSES: ReadonlySet<CapabilityStatusValue> = new Set<
  CapabilityStatusValue
>(['unverified', 'degraded']);

/**
 * Short, STABLE next-step hints per status. Stable strings let an app branch
 * or display without parsing free-form notes. These describe the operator's
 * next step only — they never imply fabricated data.
 */
const GUIDANCE_BY_STATUS: Readonly<Record<CapabilityStatusValue, string>> = {
  supported:
    'Capability is supported; this payload should not normally be emitted.',
  unsupported:
    'Action is not supported on this WHMCS install or build; do not retry.',
  not_authorized:
    'The configured WHMCS API credentials lack permission for this action; an operator must adjust API role permissions.',
  unverified:
    'Action not yet verified on this WHMCS install; an operator must run a read-only probe.',
  degraded:
    'A previous probe failed for a transport/other reason; an operator may retry the read-only probe.',
  fallback_available:
    'A safe fallback is available for this capability (reserved status).',
};

/**
 * Structured payload a tool returns when a capability is not usable. This is
 * the ONLY thing a governed tool emits for an unsupported / not_authorized /
 * unverified / degraded capability — never fabricated data.
 *
 * The first four fields are unchanged (frozen seam). `capability`, `retriable`
 * and `guidance` are additive, making the response app-handleable without any
 * change to safety behavior.
 */
export function capabilityUnavailablePayload(
  c: CapabilityStatus
): CapabilityUnavailable {
  const payload: {
    capability_unavailable: true;
    action: string;
    status: CapabilityStatusValue;
    note?: string;
    capability?: string;
    retriable?: boolean;
    guidance?: string;
  } = {
    capability_unavailable: true,
    action: c.action,
    status: c.status,
    capability: c.capability,
    retriable: RETRIABLE_STATUSES.has(c.status),
    guidance: GUIDANCE_BY_STATUS[c.status],
  };
  if (c.note !== undefined) {
    payload.note = c.note;
  }
  return payload;
}
