/**
 * Phase B — B3 Consumer registry + bearer-token resolution.
 *
 * An integration consumer authenticates with a per-consumer bearer token. This
 * module turns the env-only `MCP_CONSUMER_REGISTRY` (a zod-validated JSON
 * string) into typed `ConsumerProfile[]`, then resolves an inbound bearer token
 * to a profile.
 *
 * Security invariants (see docs/PHASE_B_GOVERNANCE.md §5):
 *  - Token values/hashes live ONLY in env, never committed.
 *  - Tokens are compared by sha256 hash; the raw token is never stored, logged,
 *    nor placed in any resolution result or thrown error.
 *  - An unknown / missing / bad token NEVER yields a privileged profile.
 *  - The anonymous fallback is a deliberate, separately-configured profile
 *    pinned to `llm_safe_summary`; it is refused entirely in production and only
 *    honoured in local/staging when the caller opts in (`allowAnon`).
 *
 * Only token→profile mapping comes from env. Contracts, field-class maps,
 * capability defs and output schemas remain in committed, typed, tested TS.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import {
  CONTRACT_NAMES,
  WRITE_CAPABILITIES,
  type ConsumerDenyReason,
  type ConsumerProfile,
  type ConsumerResolution,
  type ProjectionEnv,
  type WriteCapability,
} from './types.js';
import { WRITE_SCOPES } from '../write/types.js';

/** The env var (JSON string) holding the per-deployment consumer registry. */
export const CONSUMER_REGISTRY_ENV = 'MCP_CONSUMER_REGISTRY';

/** Contract the deliberate anonymous fallback profile must be pinned to. */
const ANON_PINNED_CONTRACT = 'llm_safe_summary' as const;

const projectionEnvSchema = z.enum(['local', 'staging', 'production']);
const contractNameSchema = z.enum(CONTRACT_NAMES);
const writeCapabilitySchema = z.enum(WRITE_CAPABILITIES);

/**
 * Phase F (additive): a single write scope, validated against the frozen
 * `WRITE_SCOPES` seam from src/write/types.ts. An unknown scope string is
 * rejected at parse time with a clear message — this only models which write
 * scopes a consumer is *authorized* for; it never enables execution.
 */
const writeScopeSchema = z.enum(WRITE_SCOPES);

/**
 * One registry entry. `token_sha256` is the lowercase hex sha256 of the raw
 * bearer token — the raw token is never accepted here.
 */
const consumerEntrySchema = z
  .object({
    id: z.string().min(1, 'consumer id is required'),
    token_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'token_sha256 must be a lowercase 64-char sha256 hex digest'),
    allowedScopes: z.array(z.string().min(1)).default([]),
    defaultContract: contractNameSchema,
    allowedContracts: z.array(contractNameSchema).default([]),
    allowedActions: z.array(z.string().min(1)).default([]),
    writeCapability: writeCapabilitySchema,
    // Phase F (additive, OPTIONAL): write scopes this consumer is authorized
    // for. Absent ⇒ [] (default-deny: no write scope authorized). Each entry
    // must be a known WRITE_SCOPES value — an unknown scope fails parse fast.
    allowedWriteScopes: z.array(writeScopeSchema).default([]),
    envRestrictions: z.array(projectionEnvSchema).default([]),
    anonymous: z.boolean().default(false),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (!entry.allowedContracts.includes(entry.defaultContract)) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedContracts'],
        message: `allowedContracts must include the defaultContract '${entry.defaultContract}'`,
      });
    }
    if (entry.anonymous) {
      // A deliberate anonymous profile must be pinned to llm_safe_summary only,
      // so an unknown/no token can never reach anything privileged via fallback.
      if (entry.defaultContract !== ANON_PINNED_CONTRACT) {
        ctx.addIssue({
          code: 'custom',
          path: ['defaultContract'],
          message: `anonymous consumer must be pinned to '${ANON_PINNED_CONTRACT}'`,
        });
      }
      const extraContracts = entry.allowedContracts.filter((c) => c !== ANON_PINNED_CONTRACT);
      if (extraContracts.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['allowedContracts'],
          message: `anonymous consumer may only allow '${ANON_PINNED_CONTRACT}'`,
        });
      }
    }
  });

const consumerRegistrySchema = z
  .array(consumerEntrySchema)
  .superRefine((entries, ctx) => {
    const seenIds = new Set<string>();
    const seenHashes = new Set<string>();
    let anonCount = 0;
    entries.forEach((entry, index) => {
      if (seenIds.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate consumer id '${entry.id}'`,
        });
      }
      seenIds.add(entry.id);
      if (seenHashes.has(entry.token_sha256)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'token_sha256'],
          message: 'duplicate token_sha256 across consumers',
        });
      }
      seenHashes.add(entry.token_sha256);
      if (entry.anonymous) anonCount += 1;
    });
    if (anonCount > 1) {
      ctx.addIssue({
        code: 'custom',
        path: [],
        message: 'at most one anonymous consumer entry is permitted',
      });
    }
  });

type ConsumerEntry = z.infer<typeof consumerEntrySchema>;

/**
 * A loaded profile keeps the token hash for lookup; never the raw token.
 *
 * Least-invasive approach (the public `ConsumerProfile` in governance/types.ts
 * is frozen): `allowedWriteScopes` is attached HERE, on the internal loaded
 * profile object, and read back through the typed accessors below
 * (`consumerWriteScopes` / `consumerWriteCapability` / `consumerCanDraft`).
 * The internal `tokenSha256` is still stripped from externally-visible
 * profiles by `resolveConsumer`; `allowedWriteScopes` is intentionally
 * retained on the resolved profile so callers can gate writes.
 */
interface LoadedProfile extends ConsumerProfile {
  readonly tokenSha256: string;
  readonly allowedWriteScopes: readonly string[];
}

/** Error thrown when the registry env var is missing/invalid. Never echoes the raw env value. */
export class ConsumerRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsumerRegistryError';
  }
}

/**
 * sha256 hex digest of a raw bearer token. Deterministic and stable. The raw
 * token is consumed only to produce the digest and is never retained.
 */
export function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

function toProfile(entry: ConsumerEntry): LoadedProfile {
  return {
    id: entry.id,
    allowedScopes: entry.allowedScopes,
    defaultContract: entry.defaultContract,
    allowedContracts: entry.allowedContracts,
    allowedActions: entry.allowedActions,
    writeCapability: entry.writeCapability,
    envRestrictions: entry.envRestrictions,
    anonymous: entry.anonymous,
    tokenSha256: entry.token_sha256,
    allowedWriteScopes: entry.allowedWriteScopes,
  };
}

/**
 * Read the loaded entry's `allowedWriteScopes` off a (possibly resolved)
 * profile. Default-deny: any profile that did not declare write scopes —
 * including every legacy profile — yields `[]`. NEVER infers scopes.
 */
export function consumerWriteScopes(profile: ConsumerProfile): readonly string[] {
  const scopes: readonly string[] | undefined = (profile as Partial<LoadedProfile>)
    .allowedWriteScopes;
  return scopes ?? [];
}

/** The consumer's modeled write capability. Inert by itself (no execution). */
export function consumerWriteCapability(profile: ConsumerProfile): WriteCapability {
  return profile.writeCapability;
}

/**
 * Whether the consumer may draft writes at all: any capability other than the
 * hard-off `'false'` / `'disabled'`. This models authorization only; it does
 * NOT mean a write will execute (execution is gated separately, deny-by-default).
 */
export function consumerCanDraft(profile: ConsumerProfile): boolean {
  const cap = profile.writeCapability;
  return cap !== 'false' && cap !== 'disabled';
}

/** Outcome of the per-consumer write-scope gate. */
export type WriteScopeAssertion =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'scope_not_allowed' | 'write_capability_false' };

/**
 * Pure, default-deny per-consumer write-scope gate other layers call before
 * proposing a write. NEVER infers scopes and NEVER enables execution — it only
 * answers "is this consumer authorized for this write scope?".
 *
 *  - `writeCapability` is `'false'`/`'disabled'`  → deny `write_capability_false`
 *  - `scope` ∉ the consumer's `allowedWriteScopes` → deny `scope_not_allowed`
 *  - otherwise                                     → ok
 *
 * `ok:true` is authorization data ONLY: a consumer with `execution_allowed`
 * and listed scopes is still inert unless separate runtime execution
 * authorization exists (intentionally absent in the default posture).
 */
export function assertWriteScopeAllowed(
  profile: ConsumerProfile,
  scope: string
): WriteScopeAssertion {
  if (!consumerCanDraft(profile)) {
    return { ok: false, reason: 'write_capability_false' };
  }
  if (!consumerWriteScopes(profile).includes(scope)) {
    return { ok: false, reason: 'scope_not_allowed' };
  }
  return { ok: true };
}

/**
 * Parse + validate `MCP_CONSUMER_REGISTRY`. Fails fast (throws
 * `ConsumerRegistryError`) on malformed JSON or schema violations, mirroring
 * the fail-fast style of `src/config.ts`. An absent/empty var yields `[]`
 * (no consumers configured — every token then resolves via the deny path).
 *
 * The raw env value is NEVER included in thrown error messages.
 */
export function loadConsumerRegistry(env: NodeJS.ProcessEnv): ConsumerProfile[] {
  const raw = env[CONSUMER_REGISTRY_ENV];
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConsumerRegistryError(
      `${CONSUMER_REGISTRY_ENV} is not valid JSON. Provide a JSON array of consumer entries.`
    );
  }

  const result = consumerRegistrySchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new ConsumerRegistryError(
      `${CONSUMER_REGISTRY_ENV} failed validation:\n${detail}`
    );
  }

  return result.data.map(toProfile);
}

function isLoadedProfile(p: ConsumerProfile): p is LoadedProfile {
  return typeof (p as LoadedProfile).tokenSha256 === 'string';
}

function deny(reason: ConsumerDenyReason): ConsumerResolution {
  return { ok: false, reason };
}

/** A profile is the valid anonymous fallback only if pinned to llm_safe_summary. */
function isUsableAnonProfile(p: ConsumerProfile): boolean {
  return p.anonymous && p.defaultContract === ANON_PINNED_CONTRACT;
}

function envForbidden(profile: ConsumerProfile, env: ProjectionEnv): boolean {
  return profile.envRestrictions.length > 0 && !profile.envRestrictions.includes(env);
}

/**
 * Resolve an inbound bearer token to a consumer profile.
 *
 *  - No / empty token → `no_token` (unless the anonymous fallback applies).
 *  - Known token hash → that profile, unless its `envRestrictions` exclude
 *    `env` → `env_forbidden`.
 *  - Unknown token → `unknown_token` (unless the anonymous fallback applies).
 *
 * Anonymous fallback (no/unknown token): only when a registry entry with
 * `anonymous:true` exists AND it is pinned to `llm_safe_summary` AND
 * `opts.allowAnon` is true AND `env !== 'production'`. In production an
 * unknown/no token with a configured anon entry is `anonymous_disabled`;
 * a privileged profile is NEVER granted to an unknown/no token.
 */
export function resolveConsumer(
  token: string | undefined,
  env: ProjectionEnv,
  registry: ConsumerProfile[],
  opts: { allowAnon: boolean }
): ConsumerResolution {
  const hasToken = typeof token === 'string' && token.length > 0;

  if (hasToken) {
    const hash = hashToken(token);
    const match = registry.find(
      (p) => isLoadedProfile(p) && p.tokenSha256 === hash
    );
    if (match) {
      if (envForbidden(match, env)) {
        return deny('env_forbidden');
      }
      // Strip the internal token hash from the externally-visible profile.
      const { tokenSha256: _omit, ...publicProfile } = match as LoadedProfile;
      void _omit;
      return { ok: true, profile: publicProfile };
    }
    // Known-shape but unrecognised token → fall through to the anonymous /
    // unknown-token decision below. NEVER fall back to a privileged profile.
  }

  // No token, or an unrecognised token. The anonymous fallback is only ever
  // *attempted* when the caller explicitly opts in (`allowAnon`). If it is not
  // opted into, the honest deny reason is the base no_token / unknown_token —
  // regardless of whether an anon entry happens to be configured.
  const baseReason: ConsumerDenyReason = hasToken ? 'unknown_token' : 'no_token';
  if (!opts.allowAnon) {
    return deny(baseReason);
  }

  const anonProfile = registry.find(isUsableAnonProfile);
  if (anonProfile === undefined) {
    // Anon explicitly requested, but no deliberate (llm_safe_summary-pinned)
    // anonymous entry exists. NEVER borrow a privileged profile.
    return deny(baseReason);
  }

  // A deliberate anonymous profile exists and anon was requested, but the
  // anonymous path is hard-disabled in production.
  if (env === 'production') {
    return deny('anonymous_disabled');
  }

  return { ok: true, profile: anonProfile };
}
