/**
 * OAuth 2.1 scope vocabulary + enforcement helpers — component 4 of the OAuth
 * resource-server design (see docs/design/oauth.md).
 *
 * This module defines the small, coarse OAuth scope vocabulary the resource
 * server advertises (PRM `scopes_supported`) and that access tokens carry, and
 * maps it onto the EXISTING governance: the write-scope risk tiers frozen in
 * `src/write/types.ts` (`WRITE_SCOPES`, `SCOPE_RISK`, `WriteRisk`).
 *
 * Design choice: OAuth scopes are COARSE (one per risk tier) rather than one
 * per fine-grained write-scope. A token thus carries at most four scopes and
 * the AS/consumer surface stays small; the fine-grained per-action gate is the
 * in-house governance layer (intent validation + execution authorizer), which
 * is unchanged. This file is the bridge: given a fine-grained write-scope, it
 * tells you which coarse OAuth scope a caller must hold.
 *
 * Everything here is PURE: no I/O, no env reads, no logging. It MAY import the
 * frozen maps from `src/write/types.js` read-only.
 */

import { SCOPE_RISK, type WriteRisk } from '../write/types.js';

/* ───────────────────────────  Vocabulary  ───────────────────────────────── */

/**
 * The complete OAuth scope vocabulary this resource server recognises. Ordered
 * least → most privileged. Advertised via PRM `scopes_supported`.
 */
export const OAUTH_SCOPES = [
  'whmcs:read',
  'whmcs:write:low',
  'whmcs:write:medium',
  'whmcs:write:high',
] as const;

export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * Privilege hierarchy, most → least privileged. A held scope IMPLIES every
 * scope at or below its position: `whmcs:write:high` ⊇ medium ⊇ low ⊇ read.
 * Read is the floor (a pure read token implies only read). Frozen.
 */
const SCOPE_RANK: Readonly<Partial<Record<string, number>>> = {
  'whmcs:write:high': 3,
  'whmcs:write:medium': 2,
  'whmcs:write:low': 1,
  'whmcs:read': 0,
} as const;

/** Safe default required scope for an unknown / unmapped write-scope. */
const UNKNOWN_REQUIRED_SCOPE: OAuthScope = 'whmcs:write:high';

/* ───────────────────────────  Required-scope mapping  ───────────────────── */

/** Every read tool requires the single read scope. */
export function requiredScopeForRead(): string {
  return 'whmcs:read';
}

/** Map a write risk tier to its coarse OAuth scope. */
export function requiredScopeForWrite(risk: WriteRisk): string {
  return `whmcs:write:${risk}`;
}

/**
 * Map a fine-grained governance write-scope (e.g. `billing:refund:record`) to
 * the OAuth scope a caller must hold, by looking up its risk tier in the frozen
 * `SCOPE_RISK` map. Unknown / unmapped write-scopes fail CLOSED: they require
 * the most-privileged scope (`whmcs:write:high`) so a typo or a newly added
 * scope is never silently treated as low-privilege.
 */
export function requiredScopeForWriteScope(writeScope: string): string {
  // `SCOPE_RISK` is typed with total `WriteScope` keys, so an indexed lookup is
  // typed non-optional; widen to a partial record so the runtime miss (an
  // unknown string key) is visible to the type system and the guard is real.
  const byString: Readonly<Partial<Record<string, WriteRisk>>> = SCOPE_RISK;
  const risk = byString[writeScope];
  if (risk === undefined) {
    return UNKNOWN_REQUIRED_SCOPE;
  }
  return requiredScopeForWrite(risk);
}

/* ───────────────────────────  Enforcement  ──────────────────────────────── */

/**
 * Does the set of GRANTED scopes satisfy the REQUIRED scope, honouring the
 * privilege hierarchy?
 *
 * A granted scope satisfies the requirement when its rank is ≥ the required
 * scope's rank, so a higher write tier satisfies any lower-tier requirement and
 * the read requirement; the read scope satisfies ONLY the read requirement.
 * Unknown granted scopes are ignored (fail closed — they grant nothing). An
 * unknown / unrecognised required scope can never be satisfied (also closed).
 */
export function hasRequiredScope(
  granted: readonly string[],
  required: string,
): boolean {
  const requiredRank = SCOPE_RANK[required];
  if (requiredRank === undefined) {
    // Unrecognised requirement → cannot be satisfied (fail closed).
    return false;
  }
  for (const g of granted) {
    const grantedRank = SCOPE_RANK[g];
    if (grantedRank !== undefined && grantedRank >= requiredRank) {
      return true;
    }
  }
  return false;
}

/**
 * Normalise an inbound scope list (e.g. the space-delimited `scope` claim, or
 * `extra.authInfo.scopes`) into a clean array: trim each entry, drop empties,
 * dedupe (first occurrence wins, order preserved). Pure passthrough — it does
 * NOT filter to the known vocabulary (an unknown scope simply grants nothing at
 * the `hasRequiredScope` gate).
 */
export function grantedFromScopes(scopeList: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of scopeList) {
    const s = raw.trim();
    if (s === '' || seen.has(s)) {
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}
