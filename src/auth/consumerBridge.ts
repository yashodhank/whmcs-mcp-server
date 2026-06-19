/**
 * OAuth → ConsumerProfile bridge (docs/design/oauth.md, component 5).
 *
 * The HTTP transport's validated bearer token populates `extra.authInfo`
 * (SDK). This module maps that token's *claims* to an existing
 * `ConsumerProfile` so ALL downstream governance — field-class projection,
 * write authorizer, audit — runs unchanged. It only swaps the *resolution
 * source* (OAuth claims) for the registry-token path; it does not replace any
 * governance logic.
 *
 * Safety invariants (mirroring `resolveConsumer`'s deny-by-default posture):
 *  - The OAuth `client_id` (falling back to `sub`) is matched against a
 *    registry `ConsumerProfile.id`. The OAuth client_id IS the consumer id.
 *  - A match returns that exact registry profile, carrying its contracts,
 *    `allowedWriteScopes`, and `writeCapability` — nothing is synthesized.
 *  - No match (or empty/garbage claims) ⇒ `null`. A privileged profile is
 *    NEVER fabricated for an unmatched client. Deny by default.
 *
 * PURE: no I/O. The registry is loaded once at startup by the caller (via
 * `loadConsumerRegistry`) and passed in here.
 */

import type { ConsumerProfile } from '../governance/types.js';

/**
 * The subset of validated OAuth/JWT claims this bridge consumes. Extra claims
 * are tolerated (index signature) but ignored. These claims are assumed to
 * have ALREADY been verified (signature, iss, exp/nbf, aud) by the token
 * validation layer (component 2) before reaching this bridge.
 */
export interface OAuthClaims {
  /** Subject — the authenticated principal. Fallback identity. */
  readonly sub?: string;
  /** OAuth client id — the primary consumer-identity claim. */
  readonly client_id?: string;
  /** Granted OAuth scopes (space-delimited string or array, per AS). */
  readonly scopes?: readonly string[];
  readonly [k: string]: unknown;
}

/** A non-empty string is required to be a usable identity claim. */
function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * Runtime guard for a usable claims object. Declared types promise an
 * `OAuthClaims`, but this bridge sits at a trust boundary (claims come from a
 * decoded token), so we still defend against `null`/non-object inputs — a
 * malformed payload must deny, never throw. Typed via `unknown` so the guard
 * is genuine at runtime.
 */
function isClaimsObject(value: unknown): value is OAuthClaims {
  return typeof value === 'object' && value !== null;
}

/**
 * Resolve verified OAuth claims to a registry `ConsumerProfile`.
 *
 * Resolution order: `claims.client_id`, then `claims.sub`. The first
 * non-empty value is matched (exact, case-sensitive) against a profile `id`
 * in the supplied registry.
 *
 *  - Match found  → that profile (carries contracts, allowedWriteScopes,
 *    writeCapability — used as-is by downstream governance).
 *  - No match, or no usable identity claim → `null` (deny by default).
 *
 * NEVER synthesizes or borrows a privileged profile for an unmatched client.
 */
export function consumerFromClaims(
  claims: OAuthClaims,
  registry: ConsumerProfile[]
): ConsumerProfile | null {
  if (!isClaimsObject(claims)) {
    return null;
  }

  const identity = nonEmptyString(claims.client_id)
    ? claims.client_id
    : nonEmptyString(claims.sub)
      ? claims.sub
      : undefined;

  if (identity === undefined) {
    return null;
  }

  const match = registry.find((profile) => profile.id === identity);
  return match ?? null;
}

/**
 * Extract the granted OAuth scopes from claims, for per-tool scope
 * enforcement at the gate. This is SEPARATE from the profile's
 * `allowedWriteScopes` (which is the consumer's authorized write surface):
 * the OAuth scopes are what the *token* was actually granted, and both must
 * be satisfied.
 *
 * Tolerant of AS variation: accepts a string array, or a single
 * space-delimited string (the RFC 6749 `scope` representation). Non-string
 * entries are dropped; empty/missing ⇒ `[]`.
 */
export function consumerScopes(claims: OAuthClaims): string[] {
  if (!isClaimsObject(claims)) {
    return [];
  }

  const raw: unknown = claims.scopes;

  if (Array.isArray(raw)) {
    return raw.filter(nonEmptyString);
  }

  if (nonEmptyString(raw)) {
    return raw.split(/\s+/).filter((s) => s.length > 0);
  }

  return [];
}
