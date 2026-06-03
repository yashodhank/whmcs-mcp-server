/**
 * MCP Adoption #10 — HTTP transport AUTH BRIDGE (security-critical).
 *
 * The Streamable HTTP transport reuses the SAME per-consumer bearer tokens as
 * stdio: every HTTP request must carry `Authorization: Bearer <token>`, which we
 * validate against the EXISTING consumer registry via `resolveConsumer(...,
 * { allowAnon: false })` BEFORE any bytes reach the SDK transport. This is a
 * thin, in-house bridge — NOT an OAuth2.1 authorization server. Full
 * OAuth2.1/PRM/CIMD is a documented follow-up (docs/MCP_ADOPTION.md #9).
 *
 * Two gates, both fail-closed, evaluated per request:
 *  1. Origin (DNS-rebinding guard, spec). If the request carries an `Origin`
 *     header it MUST be in the allowlist, else 403. Absent Origin (native/CLI
 *     clients) is allowed through to the auth gate. An empty allowlist ⇒ NO
 *     cross-origin request is permitted (default-deny).
 *  2. Bearer auth. A missing/malformed/unrecognised token ⇒ 401 with a
 *     `WWW-Authenticate: Bearer` header and NO body that could leak detail.
 *
 * SECURITY INVARIANTS:
 *  - The raw token is NEVER logged, returned, or placed in any error/response.
 *  - Origin is checked BEFORE auth so a cross-origin attacker cannot probe
 *    token validity.
 *  - resolveConsumer is the single source of truth — same code path as stdio.
 */

import { resolveConsumer } from '../governance/consumers.js';
import type {
  ConsumerProfile,
  ConsumerResolution,
  ProjectionEnv,
} from '../governance/types.js';

/** Result of the per-request authorization decision. */
export type AuthDecision =
  | { readonly ok: true; readonly profile: ConsumerProfile }
  | {
      readonly ok: false;
      readonly status: 401 | 403;
      /** Short, NON-leaking client-safe reason (no token, no internals). */
      readonly publicMessage: string;
      /** Whether to emit `WWW-Authenticate: Bearer` (401 only). */
      readonly wwwAuthenticate: boolean;
    };

/**
 * Extract the raw bearer token from an `Authorization: Bearer <token>` header.
 * Case-insensitive scheme; tolerant of surrounding whitespace. Returns
 * `undefined` when the header is missing, not a Bearer scheme, or empty.
 * The Authorization header may legally arrive as a string[] — reject that
 * ambiguous case rather than guess.
 */
export function extractBearerToken(
  authorizationHeader: string | string[] | undefined
): string | undefined {
  if (typeof authorizationHeader !== 'string') return undefined;
  const match = /^\s*Bearer\s+(.+?)\s*$/i.exec(authorizationHeader);
  if (!match) return undefined;
  const token = match[1];
  return token.length > 0 ? token : undefined;
}

/**
 * Origin gate (DNS-rebinding protection). Returns `true` when the request may
 * proceed to the auth gate.
 *  - No Origin header present ⇒ allowed (native/CLI MCP clients send none).
 *  - Origin present ⇒ must be an exact match in `allowedOrigins`.
 *  - `allowedOrigins` empty ⇒ any present Origin is rejected (default-deny).
 */
export function isOriginAllowed(
  originHeader: string | string[] | undefined,
  allowedOrigins: readonly string[]
): boolean {
  if (originHeader === undefined) return true;
  const origin: string = Array.isArray(originHeader) ? (originHeader[0] ?? '') : originHeader;
  if (origin === '') return true;
  return allowedOrigins.includes(origin);
}

/**
 * The complete per-request decision: Origin first (403), then bearer auth
 * (401). On success the resolved (token-hash-stripped) consumer profile is
 * returned so the caller can carry it for governance. NEVER allows anonymous.
 */
export function authorizeHttpRequest(params: {
  readonly authorizationHeader: string | string[] | undefined;
  readonly originHeader: string | string[] | undefined;
  readonly env: ProjectionEnv;
  readonly registry: ConsumerProfile[];
  readonly allowedOrigins: readonly string[];
}): AuthDecision {
  // Gate 1 — Origin (before auth, so a cross-origin caller cannot probe tokens).
  if (!isOriginAllowed(params.originHeader, params.allowedOrigins)) {
    return {
      ok: false,
      status: 403,
      publicMessage: 'Forbidden: origin not allowed',
      wwwAuthenticate: false,
    };
  }

  // Gate 2 — bearer auth via the EXISTING consumer registry. allowAnon:false so
  // no/unknown token can never resolve to a profile.
  const token = extractBearerToken(params.authorizationHeader);
  const resolution: ConsumerResolution = resolveConsumer(
    token,
    params.env,
    params.registry,
    { allowAnon: false }
  );

  if (!resolution.ok) {
    return {
      ok: false,
      status: 401,
      // Deliberately generic — never reveal whether the token was absent vs
      // present-but-invalid, and never echo the token.
      publicMessage: 'Unauthorized',
      wwwAuthenticate: true,
    };
  }

  return { ok: true, profile: resolution.profile };
}
