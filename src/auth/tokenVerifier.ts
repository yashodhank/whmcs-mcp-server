/**
 * OAuth 2.1 access-token verifier (Component 2 of docs/OAUTH_DESIGN.md).
 *
 * Validates RFC 9068 JWT access tokens issued by a configured authorization
 * server (AS) and presented to this MCP resource server (RS) over the HTTP
 * transport. The verifier enforces the security must-haves from the design doc:
 *
 *   - SIGNATURE: verified against the AS's JWKS (RFC 7517), fetched over HTTPS
 *     by `jose.createRemoteJWKSet` (which also handles key rotation + caching).
 *   - alg: `jose.jwtVerify` rejects `alg:none` by default — we never relax that.
 *   - iss:  must be one of `cfg.issuers`. We read the token's `iss` (UNTRUSTED)
 *     only to PICK which JWKS to verify against; `jose.jwtVerify` still
 *     cryptographically enforces `iss ∈ cfg.issuers` after signature checking.
 *   - aud:  must equal `cfg.audience` (RFC 8707). This is non-negotiable: it
 *     stops a token minted for a DIFFERENT resource server from being replayed
 *     here (token passthrough / confused-deputy).
 *   - exp/nbf: enforced by `jose.jwtVerify`, with optional clock tolerance.
 *
 * On ANY failure we return `{ ok: false, reason }` with a short reason string
 * and NEVER echo token contents (design doc: 401 bodies must not leak tokens).
 *
 * Self-contained: the only dependency is `jose`. For tests, a `jwksResolver`
 * hook can be supplied in the config to inject a LOCAL key set (no network).
 */

import {
  jwtVerify,
  createRemoteJWKSet,
  decodeJwt,
  type JWTPayload,
  type JWTVerifyGetKey,
  errors as joseErrors,
} from 'jose';

/** A resolver returns the JWKS key-getter for a given (trusted-after-verify) issuer. */
export type JwksResolver = (issuer: string) => JWTVerifyGetKey;

export interface TokenVerifierConfig {
  /** Allowed authorization-server issuer URLs. A token's `iss` must be one of these. */
  issuers: string[];
  /** This resource server's canonical URI. A token's `aud` must equal this (RFC 8707). */
  audience: string;
  /** Optional explicit JWKS URI per issuer; defaults to `${iss}/.well-known/jwks.json`. */
  jwksUriByIssuer?: Record<string, string>;
  /** Clock skew tolerance (seconds) for exp/nbf. Default 0. */
  clockToleranceSec?: number;
  /**
   * Test/DI hook: supply a JWKS key-getter directly (e.g. a local `jose`
   * key set) so verification needs no network. When provided it is used
   * INSTEAD of `createRemoteJWKSet`. Production code omits this.
   */
  jwksResolver?: JwksResolver;
}

/** Normalized claims surfaced to callers after a successful verification. */
export interface VerifiedClaims {
  sub?: string;
  client_id?: string;
  /** Raw space-delimited scope string, if present (RFC 8693 / RFC 9068). */
  scope?: string;
  /** Normalized scope list (from `scope` string, else `scopes` array). */
  scopes?: string[];
  aud?: string | string[];
  iss?: string;
  [k: string]: unknown;
}

export type VerifyResult =
  | { ok: true; claims: VerifiedClaims }
  | { ok: false; reason: string };

export interface TokenVerifier {
  verify(token: string): Promise<VerifyResult>;
}

/** Default JWKS endpoint for an issuer per the OAuth/OIDC convention. */
function defaultJwksUri(issuer: string): string {
  // Avoid producing a double slash when the issuer ends with `/`.
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  return `${base}/.well-known/jwks.json`;
}

/**
 * Normalize OAuth scopes. Prefer the RFC 9068 space-delimited `scope` string;
 * fall back to a `scopes` array claim. Returns `undefined` when neither is
 * present so callers can distinguish "no scopes claim" from "empty".
 */
function normalizeScopes(payload: JWTPayload): string[] | undefined {
  const scope = payload.scope;
  if (typeof scope === 'string') {
    const list = scope.split(/\s+/).filter((s) => s.length > 0);
    return list;
  }
  const scopes = payload.scopes;
  if (Array.isArray(scopes)) {
    return scopes.filter((s): s is string => typeof s === 'string');
  }
  return undefined;
}

/** Map a thrown error to a short, non-leaky reason string. */
function reasonFor(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) return 'token_expired';
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    // claim is e.g. 'iss', 'aud', 'nbf' — safe (no token contents).
    const claim = (err as { claim?: string }).claim;
    if (claim === 'iss') return 'issuer_not_allowed';
    if (claim === 'aud') return 'audience_mismatch';
    if (claim === 'nbf') return 'token_not_yet_valid';
    return 'claim_validation_failed';
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'signature_verification_failed';
  }
  if (err instanceof joseErrors.JWSInvalid || err instanceof joseErrors.JWTInvalid) {
    return 'malformed_token';
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed) return 'alg_not_allowed';
  if (err instanceof joseErrors.JWKSNoMatchingKey) return 'no_matching_key';
  return 'verification_failed';
}

/**
 * Build the verifier. JWKS key-getters are created lazily and cached PER
 * ISSUER (so `createRemoteJWKSet`'s internal HTTP cache / rotation is reused
 * across requests rather than refetched each time).
 */
export function createTokenVerifier(cfg: TokenVerifierConfig): TokenVerifier {
  if (!Array.isArray(cfg.issuers) || cfg.issuers.length === 0) {
    throw new Error('TokenVerifierConfig.issuers must be a non-empty array');
  }
  if (typeof cfg.audience !== 'string' || cfg.audience.length === 0) {
    throw new Error('TokenVerifierConfig.audience must be a non-empty string');
  }

  const allowedIssuers = new Set(cfg.issuers);
  const clockTolerance = cfg.clockToleranceSec ?? 0;
  const jwksCache = new Map<string, JWTVerifyGetKey>();

  function getJwks(issuer: string): JWTVerifyGetKey {
    const cached = jwksCache.get(issuer);
    if (cached) return cached;
    let getter: JWTVerifyGetKey;
    if (cfg.jwksResolver) {
      getter = cfg.jwksResolver(issuer);
    } else {
      const uri = cfg.jwksUriByIssuer?.[issuer] ?? defaultJwksUri(issuer);
      getter = createRemoteJWKSet(new URL(uri));
    }
    jwksCache.set(issuer, getter);
    return getter;
  }

  async function verify(token: string): Promise<VerifyResult> {
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, reason: 'missing_token' };
    }

    // Read `iss` from the token WITHOUT trusting it — used only to PICK the
    // JWKS to verify against. The cryptographic `issuer` check below still
    // enforces iss ∈ cfg.issuers after signature verification.
    let untrustedIss: string | undefined;
    try {
      untrustedIss = decodeJwt(token).iss;
    } catch {
      return { ok: false, reason: 'malformed_token' };
    }

    if (typeof untrustedIss !== 'string' || !allowedIssuers.has(untrustedIss)) {
      // No point fetching a JWKS for an issuer we'd reject anyway.
      return { ok: false, reason: 'issuer_not_allowed' };
    }

    try {
      const jwks = getJwks(untrustedIss);
      const { payload } = await jwtVerify(token, jwks, {
        issuer: cfg.issuers,
        audience: cfg.audience,
        clockTolerance,
      });

      const claims: VerifiedClaims = { ...payload };
      const scopes = normalizeScopes(payload);
      if (scopes !== undefined) claims.scopes = scopes;
      return { ok: true, claims };
    } catch (err) {
      return { ok: false, reason: reasonFor(err) };
    }
  }

  return { verify };
}
