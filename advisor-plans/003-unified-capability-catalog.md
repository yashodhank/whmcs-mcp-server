# Plan 003: Unified capability catalog and incremental domain packs

> Written against `ebab2c5` on 2026-08-07. Requires plan 001. Drift check:
> inspect `src/index.ts:79-99`, `src/governance/capabilities.ts:77-107`,
> `src/tools/capabilityShellTools.ts:324-403`, and the catalog fixture.

## Finding

Public behavior is described independently in manual registrars, static
capability tables, schemas, governance calls, prompts/resources and write
validation. `buildRegistry()` creates a separate action registry
(`src/governance/capabilities.ts:77-99`); `get_capability_matrix` re-maps it in a
handler (`src/tools/capabilityShellTools.ts:324-386`); and `src/index.ts:79-99`
manually wires domain registrars. Large registrars and the 809-line
`validateIntent()` (`src/write/validation.ts:241`) make additions expensive and
drift-prone.

Impact: very high. Effort: large. Risk: medium. Confidence: high.

## Goal

Create one typed, versioned catalog from which the server can register tools,
describe WHMCS action support, enforce effects/risk metadata, produce client
discovery views and power the safe planner. Migrate domain-by-domain with no
public contract change.

## Catalog contract

Add `src/catalog/types.ts` with a definition conceptually containing:

```ts
interface OperationDefinition<I, O> {
  id: string;                       // stable internal id
  publicName: string;               // existing MCP name
  domain: string;
  description: string;
  inputSchema: StandardSchema<I>;
  outputSchema: StandardSchema<O>;
  effects: 'pure' | 'read' | 'draft' | 'write';
  riskTier: 'none' | 'low' | 'medium' | 'high';
  whmcsActions: readonly string[];
  capability: CapabilityRequirement;
  governance: GovernanceDescriptor;
  cache: CachePolicy;
  cost: CostHint;
  auth: AuthDescriptor;
  handler: OperationHandler<I, O>;
  version: number;
}
```

Schemas and exact types should follow installed SDK/Zod conventions. Metadata
is server-owned and immutable after startup.

## Scope

In scope:

- `src/catalog/*` — definitions, registry, validation, generated views.
- One small read domain as the first migrated pack; then repeatable migration
  rules for the remaining `src/tools/*` registrars.
- Capability matrix/probe integration.
- Per-installation capability evidence with expiry and provenance.
- Tests for duplicate names/actions, effects/annotation consistency, missing
  governance/cache policy and catalog determinism.
- Split write validation/mapping by scope only after their definitions enter the
  catalog.

Out of scope:

- Renaming tools or changing schemas.
- Runtime plugin loading from arbitrary packages/config.
- Executing code declared by external catalog data.
- Replacing governance contracts with catalog flags.
- Big-bang rewriting every registrar.

## Steps

### 1. Define and validate catalog invariants

Implement a pure startup validator. It must reject:

- duplicate public/internal names;
- `effects=write` with read-only/destructive annotations that disagree;
- write operations without a governed scope/risk tier;
- reads without allowlisted WHMCS action/capability behavior;
- cache policy on writes/drafts/probes;
- missing output governance for raw WHMCS data;
- unbounded cost hints for fan-out operations;
- schema/default values that exceed global pagination limits.

Verify with focused invalid-definition table tests.

### 2. Add a compatibility adapter

Create a helper that converts one `OperationDefinition` into the current SDK's
`registerTool` call and wraps the existing auth, logging, rate limit and result
format sequence. Migrate one low-risk capability-shell read first.

Compare the catalog fixture before/after; public name, description, schemas,
annotations and output must match. If they do not, treat that as a migration bug
unless a separate reviewed compatibility change says otherwise.

### 3. Generate capability views from the catalog

Replace duplicated static mappings gradually. Separate:

- declared support: code knows how to handle the operation;
- configured support: policy/allowlists permit it;
- observed support: the target installation proved it at a timestamp;
- effective support: client-visible intersection with deny reason.

Capability evidence key must include installation identity/config fingerprint,
action, safe probe shape and catalog version. Store status, source, observed-at,
expiry and sanitized failure class. Never key only by action as the current
module-global `probeCache` does (`src/governance/capabilities.ts:107-305`).

Probe only read-safe actions. Unknown/write actions remain unverified until an
operator-approved external test program records evidence.

### 4. Expose client-optimized discovery

Keep `get_capability_matrix` compatible, then add a versioned resource such as
`whmcs://capabilities/v2` containing:

- catalog version/ETag;
- effective operations filtered for the authenticated consumer;
- effects/risk/cost/pagination hints;
- capability evidence and expiry;
- prerequisite/fallback operation ids;
- protocol feature availability.

Do not reveal disallowed tool names or policy detail that creates an auth oracle.
Use modern catalog cache hints after plan 002; legacy clients receive the same
payload without relying on them.

### 5. Migrate domain packs incrementally

Recommended order: capability shells → system refs → ticket metadata → contacts
→ clients → domains → billing → reporting/aggregators → workflows → write flow.

Each pack owns definitions, handlers, schemas, canonical mapping and focused
tests. `src/index.ts` eventually registers packs through the catalog, not one
function per file. Keep one domain per PR and run fixture/behavior parity.

For writes, replace the monolithic `validateIntent()` and
`intentToWhmcsParams()` switch with per-scope descriptors only after parity
tests cover every scope. The dispatcher then becomes a total registry lookup;
unknown scopes fail closed, never pass parameters through unchanged.

### 6. Add catalog governance and change control

Generate human docs and machine fixtures from the validated registry. Add CI
checks that every supported WHMCS action is referenced by at least one operation
or explicitly documented internal probe, and every operation has tests.

Catalog version changes whenever public semantics change; implementation-only
refactors do not. Produce a semantic diff in PR artifacts.

## Tests

- Invariant table tests for invalid definitions.
- Catalog determinism and duplicate detection.
- Pre/post migration contract fixtures for every domain.
- Capability evidence isolation, TTL expiry and fail-closed errors.
- Consumer-filtered discovery cannot reveal unauthorized operations.
- All write scopes map to exactly one validator, mapper and WHMCS action.
- Unknown scopes/actions fail closed.

## Done criteria

- One catalog is the source for registration and capability discovery.
- Every operation declares effect, risk, auth, governance, cache and cost policy.
- Capability evidence is target-scoped, expiring and provenance-bearing.
- Large registrars can be migrated one domain at a time with contract parity.
- No write gate or governance rule moved into client-controlled metadata.
- Global gates and plan-001 contract suite pass.

## STOP conditions

- The adapter cannot preserve public schema/output exactly.
- External config can introduce executable handlers.
- Capability probing would require a mutation.
- A migration PR spans more than one large domain or mixes behavior changes.

## Maintenance

Catalog review is required for each operation addition. Run semantic catalog
diffs in CI and retain evidence schema backward compatibility for clients.
