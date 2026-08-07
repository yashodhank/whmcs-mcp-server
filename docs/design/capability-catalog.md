# Unified capability catalog

Status: implemented foundation and first incremental pack as of 2026-08-07.

The catalog is a server-owned, typed control-plane description of MCP
operations. It does not load handlers from configuration and it does not grant
authorization. Runtime policy, governance projection, controlled-write gates,
the kill switch, and the `WhmcsClient` read/mutation boundaries remain the
enforcement points.

## Implemented slice

`src/catalog/` now provides:

- immutable `OperationDefinition` metadata for effects, risk, WHMCS actions,
  capability probing, governance, caching, bounded cost, authentication,
  pagination and protocol requirements;
- startup validation for duplicate identities and unsafe or contradictory
  metadata;
- a compatibility adapter that maps a definition to the existing MCP SDK
  `registerTool` call;
- one migrated capability-pack operation, `get_capability_matrix`, whose public
  name, description, schemas, annotations and runtime payload remain covered by
  the Plan 001 catalog fixture;
- one authoritative declaration list for every allowlisted WHMCS read action,
  including the two internal/enrichment actions that are intentionally absent
  from the legacy matrix;
- target-scoped, expiring capability evidence with source, timestamps,
  sanitized failure class, catalog version, and a hash of the safe probe shape;
  and
- deterministic machine metadata plus an additive discovery resource at
  `whmcs://capabilities/v2`.

The first pack is intentionally small. The five promoted/unverified capability
shell handlers remain in their existing registrar, as do all other domains.
The implementation must not be described as a completed big-bang migration.

## Startup invariants

Catalog construction fails before transport connection when a definition has:

- a duplicate internal id or public tool name;
- annotations that contradict pure/read/draft/write effects;
- a write without a governed scope and medium/high risk;
- a read without declared WHMCS actions and explicit probe behavior;
- result caching on drafts, writes, or probe operations;
- raw WHMCS output without a governance boundary;
- an unbounded fan-out cost; or
- pagination defaults or maxima outside the global page cap.

The catalog metadata is frozen after validation. Zod schemas and executable
handlers remain code-owned; external data cannot introduce executable logic.

## Capability evidence

Evidence is never keyed by WHMCS action alone. Its key includes opaque hashes
for the installation and relevant configuration, the catalog version, action,
and safe probe shape. Evidence expires and the lookup falls back to declared
status. Unknown actions fail closed without invoking the read boundary.

Only read-safe declared actions may use the in-process probe. Write actions and
actions requiring operator validation use external evidence; catalog metadata
does not convert a probe into authorization. Fingerprints, not raw URLs,
identifiers, tokens or credentials, appear in evidence records.

## Discovery behavior

`whmcs://capabilities/v2` returns a versioned payload and deterministic ETag
with the effective cataloged operations, effects, risk, cost, pagination,
prerequisites, fallbacks and protocol features. Global tool exposure is applied
before an operation appears.

Modern HTTP resource reads carry a bounded, immutable grant list derived from
the transport-authenticated `ConsumerProfile`. Discovery maps declared WHMCS
action or capability grants to capability ids and intersects them with global
exposure. Body arguments never supply identity or grants. Legacy and stdio
resource reads have no authenticated transport profile, so consumer-filtered
operations remain omitted (fail closed). The current migrated operation is
pure and non-consumer-specific. Legacy clients can still read the same JSON
payload.

## Change control and next packs

Run:

```bash
npm run catalog:check
npm run mcp:test:contracts
```

`catalog:check` compares the validated machine view with
`tests/fixtures/catalog/capability-catalog-v2.json` and reports added, removed,
or changed operation ids. Use `npm run catalog:update` only for an intentional,
reviewed semantic change. CI runs both the semantic catalog and public MCP
contracts.

Migrate one pack per focused PR in this order: remaining capability shells,
system references, ticket metadata, contacts, clients, domains, billing,
reporting/aggregators, workflows, then controlled writes. Each migration must
prove public catalog and handler parity before deleting its legacy registrar.
Unknown actions and scopes remain fail-closed.

Controlled writes are not migrated in this slice. Future write definitions are
descriptors only: they may not move approval, execution, kill-switch, consumer
scope, audit, idempotency, or authorization logic into client metadata. The
opt-in legacy direct-mutate tools remain an explicitly documented exception and
are not to be expanded by catalog work.

Direct database access remains limited to the guarded, opt-in owner-transfer
write transaction. This catalog does not authorize general WHMCS database
reads or any other direct-database path.
