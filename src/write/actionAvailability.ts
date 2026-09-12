/**
 * Static write-action availability catalog.
 *
 * Tags each `WriteScope` → WHMCS action mapping with API-surface metadata so
 * operators/agents can determine which granted scopes are actually executable
 * on the current WHMCS install WITHOUT probing production with real mutations.
 *
 * The catalog is SERVER-OWNED and additive. Scopes are NEVER removed from
 * grants or allowlists based on this data — availability is informational and
 * used by `list_write_scope_availability` / planning discovery to surface
 * non-executable scopes alongside their granted status.
 *
 * PURE: no I/O, no env reads, no logging. Imports only frozen maps from
 * `./types.js` and the version-profile type.
 */

import {
  SCOPE_ACTION,
  SCOPE_RISK,
  WRITE_SCOPES,
  type WriteRisk,
  type WriteScope,
} from './types.js';
import type { WhmcsVersionFamily } from '../whmcs/versionProfile.js';

/* ─────────────────────────  Types  ──────────────────────────────────────── */

/**
 * How the scope's mapped WHMCS action reaches the WHMCS installation.
 *
 * - `admin_api`  — standard External Admin API action (e.g. AddClientNote).
 * - `custom`     — composite/workflow action implemented in the MCP server
 *                  (e.g. CREDIT_TRANSFER_ACTION); never passed to whmcs.mutate.
 * - `db_direct`  — requires a direct DB connection (DSN); no Admin API path.
 * - `none`       — the mapped action name does not exist in the WHMCS API at
 *                  all (e.g. UpdateBillableItem — declared in scope map but
 *                  not a real API action).
 */
export type ApiSurface = 'admin_api' | 'custom' | 'db_direct' | 'none';

/**
 * Dynamic availability classification for a scope on the current install.
 *
 * - `executable`     — the API action exists and is reachable (role is a
 *                      separate concern — see `role_note`).
 * - `missing_api`    — the mapped WHMCS action does not exist in any known
 *                      WHMCS version.
 * - `version_gated`  — the action's behavior is blocked or fundamentally
 *                      changed on the detected WHMCS family (e.g.
 *                      billing:invoice:update on 9.x for non-draft invoices).
 * - `needs_infra`    — requires infrastructure not available via the Admin API
 *                      (e.g. DB DSN for direct-DB scopes, or a custom executor
 *                      for composite actions).
 * - `role_unknown`   — API action exists but role permission has not been
 *                      probed; the action may be denied at runtime.
 */
export type AvailabilityStatus =
  | 'executable'
  | 'missing_api'
  | 'version_gated'
  | 'needs_infra'
  | 'role_unknown';

/**
 * Static per-scope metadata — server-owned, immutable, not dependent on the
 * live WHMCS install. The dynamic `availability` is computed at query time
 * from these fields + the detected version family.
 */
export interface WriteActionMeta {
  readonly scope: WriteScope;
  readonly action: string;
  readonly risk: WriteRisk;
  readonly api_surface: ApiSurface;
  /** False when the WHMCS API has no action by this name in any version. */
  readonly whmcs_api_exists: boolean;
  /**
   * Version families on which this action is known to be unavailable or
   * fundamentally behavior-changed (e.g. `['9.x']` for invoice immutability).
   * Empty when the action is not version-gated.
   */
  readonly unavailable_on: readonly WhmcsVersionFamily[];
  /** Human-readable note distinguishing role vs version vs missing-API gaps. */
  readonly note: string;
}

/* ─────────────────────────  Static catalog  ─────────────────────────────── */

function meta(
  scope: WriteScope,
  overrides: Partial<
    Pick<WriteActionMeta, 'api_surface' | 'whmcs_api_exists' | 'unavailable_on' | 'note'>
  > = {}
): WriteActionMeta {
  return {
    scope,
    action: SCOPE_ACTION[scope],
    risk: SCOPE_RISK[scope],
    api_surface: overrides.api_surface ?? 'admin_api',
    whmcs_api_exists: overrides.whmcs_api_exists ?? true,
    unavailable_on: overrides.unavailable_on ?? [],
    note: overrides.note ?? '',
  };
}

/**
 * Complete static availability metadata for every declared WriteScope.
 * Keyed by scope string for O(1) lookup.
 */
export const WRITE_ACTION_CATALOG: Readonly<Record<WriteScope, WriteActionMeta>> = {
  // ── Standard Admin API scopes (no special gates) ────────────────────────
  'client_note:write': meta('client_note:write'),
  'ticket:create': meta('ticket:create'),
  'ticket:reply': meta('ticket:reply'),
  'ticket:status': meta('ticket:status'),
  'ticket:note': meta('ticket:note'),
  'billing:invoice:create': meta('billing:invoice:create'),
  'billing:payment:add': meta('billing:payment:add'),
  'billing:credit:add': meta('billing:credit:add'),
  'billing:refund:record': meta('billing:refund:record'),
  'service:price_restore': meta('service:price_restore'),
  'service:domain_rename': meta('service:domain_rename'),
  'service:suspend': meta('service:suspend'),
  'service:unsuspend': meta('service:unsuspend'),
  'service:terminate': meta('service:terminate'),
  'domain:nameservers:update': meta('domain:nameservers:update'),
  'billing:payment:capture': meta('billing:payment:capture'),
  'billing:credit:apply': meta('billing:credit:apply'),
  'domain:register': meta('domain:register'),
  'domain:renew': meta('domain:renew'),
  'order:accept': meta('order:accept'),
  'order:create': meta('order:create'),
  'client:create': meta('client:create'),
  'client:update': meta('client:update'),
  'service:change_package': meta('service:change_package'),
  'service:product:set': meta('service:product:set'),
  'service:customfields:update': meta('service:customfields:update'),
  'service:upgrade': meta('service:upgrade'),
  'domain:idprotect:toggle': meta('domain:idprotect:toggle'),
  'domain:lock:toggle': meta('domain:lock:toggle'),
  'client:contact:add': meta('client:contact:add'),
  'client:contact:update': meta('client:contact:update'),
  'billing:billable_item:add': meta('billing:billable_item:add'),
  'billing:quote:create': meta('billing:quote:create'),
  'billing:quote:update': meta('billing:quote:update'),
  'billing:quote:send': meta('billing:quote:send'),
  'billing:quote:accept': meta('billing:quote:accept'),
  'order:cancel': meta('order:cancel'),
  'order:pending': meta('order:pending'),
  'domain:epp:request': meta('domain:epp:request'),
  'domain:record:update': meta('domain:record:update'),
  'support:cancel_request:add': meta('support:cancel_request:add'),
  'client:close': meta('client:close'),
  'client:contact:delete': meta('client:contact:delete'),

  // ── ticket:merge — Admin API action exists but commonly role-denied ─────
  'ticket:merge': meta('ticket:merge', {
    note:
      'MergeTicket exists in the WHMCS API but is not in the default API permission set. ' +
      'The API credential role must explicitly permit "mergeticket". ' +
      'Role denial returns "Invalid Permissions" — this is a role gap, not a version gap.',
  }),

  // ── billing:invoice:update — version-gated on 9.x ──────────────────────
  'billing:invoice:update': meta('billing:invoice:update', {
    unavailable_on: ['9.x'],
    note:
      'On WHMCS 9.x non-draft invoices are immutable; corrections require credit/debit notes. ' +
      'UpdateInvoice still exists but is limited to draft invoices on 9.x.',
  }),

  // ── billing:billable_item:update — API action does NOT exist ────────────
  'billing:billable_item:update': meta('billing:billable_item:update', {
    api_surface: 'none',
    whmcs_api_exists: false,
    note:
      'UpdateBillableItem is NOT a real WHMCS API action (confirmed on 8.13.7 and 9.x). ' +
      'The official API provides only AddBillableItem. Feature requests for ' +
      'Get/Update/Delete Billable Items remain open. This is not a version delta.',
  }),

  // ── Composite / custom executor ─────────────────────────────────────────
  'billing:credit:transfer': meta('billing:credit:transfer', {
    api_surface: 'custom',
    note:
      'Composite cross-client credit transfer executed via the MCP credit-transfer executor, ' +
      'not a single WHMCS API action. Requires the custom executor to be wired.',
  }),

  // ── DB-direct scopes (no Admin API path) ────────────────────────────────
  'service:transfer_owner': meta('service:transfer_owner', {
    api_surface: 'db_direct',
    note:
      'Service ownership transfer is a direct-DB write (no Admin API path). ' +
      'Requires MCP_WHMCS_DSN configured; sealed by default.',
  }),
  'billing:invoice:reassign': meta('billing:invoice:reassign', {
    api_surface: 'db_direct',
    note:
      'Invoice reassignment is a direct-DB write (no Admin API path). ' +
      'Requires MCP_WHMCS_DSN configured; sealed by default.',
  }),
} as const;

/* ─────────────────────────  Dynamic availability  ───────────────────────── */

export interface ScopeAvailabilityEntry {
  readonly scope: WriteScope;
  readonly action: string;
  readonly risk: WriteRisk;
  readonly api_surface: ApiSurface;
  readonly whmcs_api_exists: boolean;
  readonly grant_status: 'granted' | 'not_granted';
  readonly availability: AvailabilityStatus;
  readonly executable: boolean;
  readonly reason: string;
  readonly note: string;
}

/**
 * Compute the dynamic availability of a single scope given the current WHMCS
 * version family. Pure — no I/O.
 */
export function resolveAvailability(
  catalogEntry: WriteActionMeta,
  versionFamily: WhmcsVersionFamily
): { availability: AvailabilityStatus; executable: boolean; reason: string } {
  if (!catalogEntry.whmcs_api_exists) {
    return {
      availability: 'missing_api',
      executable: false,
      reason: `${catalogEntry.action} is not a valid WHMCS API action`,
    };
  }

  if (catalogEntry.api_surface === 'db_direct') {
    return {
      availability: 'needs_infra',
      executable: false,
      reason: 'Requires direct DB connection (MCP_WHMCS_DSN); no Admin API path',
    };
  }

  if (catalogEntry.api_surface === 'custom') {
    return {
      availability: 'needs_infra',
      executable: false,
      reason: 'Composite/custom executor; not a single Admin API call',
    };
  }

  if (
    catalogEntry.unavailable_on.length > 0 &&
    versionFamily !== 'unknown' &&
    catalogEntry.unavailable_on.includes(versionFamily)
  ) {
    return {
      availability: 'version_gated',
      executable: false,
      reason: `Action behavior is restricted on WHMCS ${versionFamily}`,
    };
  }

  return {
    availability: 'executable',
    executable: true,
    reason: 'Admin API action exists and is not version-gated on this install',
  };
}

/**
 * Build the full availability matrix for all declared write scopes, given the
 * consumer's granted scopes and the detected WHMCS version family.
 */
export function buildAvailabilityMatrix(
  grantedScopes: ReadonlySet<string>,
  versionFamily: WhmcsVersionFamily
): readonly ScopeAvailabilityEntry[] {
  return WRITE_SCOPES.map((scope) => {
    const catalogEntry = WRITE_ACTION_CATALOG[scope];
    const { availability, executable, reason } = resolveAvailability(catalogEntry, versionFamily);
    return {
      scope,
      action: catalogEntry.action,
      risk: catalogEntry.risk,
      api_surface: catalogEntry.api_surface,
      whmcs_api_exists: catalogEntry.whmcs_api_exists,
      grant_status: grantedScopes.has(scope) ? ('granted' as const) : ('not_granted' as const),
      availability,
      executable,
      reason,
      note: catalogEntry.note,
    };
  });
}
