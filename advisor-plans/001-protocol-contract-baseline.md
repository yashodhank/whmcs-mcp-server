# Plan 001: Safety baseline, protocol contracts and conformance

> Written against `ebab2c5` on 2026-08-07. Drift check: compare `package.json`,
> `src/index.ts`, `src/http/httpServer.ts`, and every tool/resource/prompt
> registrar changed since this SHA. If public names or schemas changed, refresh
> fixtures before implementation.

## Finding

The server has broad behavior but no single executable compatibility contract.
`src/index.ts:51-111` manually registers the complete surface, while
`package.json:17-25` runs unit/lint/type gates but no official MCP conformance or
catalog snapshot. A breaking SDK/transport migration is therefore not safely
separable from accidental public-surface drift.

The 2026-08-07 baseline verification also is not fully green: 1,395 runnable
tests pass and the build succeeds, but `format:check` reports seven pre-existing
files and `npm audit --audit-level=high` reports 10 known vulnerabilities (six
high), including the direct Axios dependency and transitive packages beneath the
v1 MCP SDK/toolchain. Those must be remediated in isolated commits before green
conformance becomes the migration baseline.

Impact: high. Effort: medium. Risk: low-medium. Confidence: high.

## Goal

Restore a clean, reviewable safety baseline, then create deterministic tests and
fixtures that pin the public MCP contract under both the current stdio and
Streamable HTTP paths. Dependency remediation may change package/lock versions;
runtime source behavior remains unchanged.

## Scope

In scope:

- `tests/mcp/contractHarness.ts` — reusable in-process client/server harness.
- `tests/mcp/catalogContract.test.ts` — tool, prompt and resource catalog.
- `tests/mcp/transportContract.test.ts` — initialization, call, cancellation,
  auth denial and HTTP ownership behavior.
- `tests/fixtures/mcp/catalog-v1.json` — reviewed stable public contract.
- `scripts/mcp-conformance.mjs` — pinned official conformance entry point.
- `package.json` — `test:mcp:contract` and `test:mcp:conformance` scripts.
- `package.json`, lockfile — targeted patched versions for current advisories.
- The seven files named by the baseline `format:check`, in a mechanical-only
  formatting commit with a zero-semantic-diff review.
- `docs/design/mcp-adoption.md` — record the new baseline and correct its stale
  statement at lines 10-11 that 2026-07-28/v2 are pre-release.

Out of scope:

- SDK major-version changes (plan 002); a patched v1 minor may be used only when
  its compatibility suite is identical.
- Handler refactors or schema changes.
- Live WHMCS calls.
- Treating the full fixture as an approval mechanism; intentional changes still
  require human review of the diff.

## Steps

### 0. Restore a trustworthy green baseline

Use `npm audit --json` to record direct versus transitive paths and fixed
versions. Upgrade only targeted packages; do not run an unreviewed blanket
`npm audit fix`. Priorities:

- direct Axios to the first patched stable version compatible with tests;
- v1 MCP SDK to a patched v1 release if that removes vulnerable Hono adapters
  without pulling the v2 migration into this plan;
- patched dev-tool transitive packages or explicit narrow overrides only when
  their owners have not published a compatible top-level release.

Regenerate the lockfile normally, inspect `npm ls`, run the complete suite and
the catalog fixture. If any advisory has no compatible patch, document exposure,
reachability and a time-bounded exception; do not call the gate green.

Separately, apply Prettier only to the seven files reported by the baseline:
`src/whmcs/WhmcsDb.ts`, `src/write/transferCascade.ts`,
`src/write/validation.ts`, `tests/write/transferCascade.test.ts`,
`tests/write/transferOwnerTypes.test.ts`,
`tests/write/transferOwnerValidation.test.ts`, and
`tests/write/whmcsDb.test.ts`. Commit this as mechanical formatting, review with
whitespace-insensitive diff, and do not mix it with dependency changes.

Verify:

```bash
npm run precommit
npm run build
npm audit --audit-level=high
```

All must exit zero before continuing. If dependency remediation needs a major
SDK migration, stop and execute it under plan 002 after first adding the
contract harness on the vulnerable-but-behavior-pinned v1 baseline.

### 1. Define the compatibility matrix

Add a small table to `docs/design/mcp-adoption.md` with rows for:

- stdio, 2025-era initialize, anonymous/shared-token posture;
- HTTP, 2025-era initialize + session owner binding;
- HTTP OAuth resource metadata and scope denial;
- governed and governance-disabled output shapes;
- future HTTP/stdio 2026-era stateless requests (initially `NOT SUPPORTED`).

Record client name, protocol era, auth mode, expected status and test file. Do
not promise modern support before plan 002.

Verify: the document names `2026-07-28` as current and Tasks as an extension,
not an experimental core primitive.

### 2. Build an in-process contract harness

Extract test-only helpers that call the exported `buildServer()` from
`src/index.ts:51` with fake `WhmcsClient`, `Logger` and `RateLimiter`
dependencies. Use SDK client transports rather than invoking callbacks
directly, so schema negotiation and structured result validation are exercised.

The fake WHMCS adapter must:

- return deterministic action-specific fixtures;
- record action/params without secrets;
- fail if a mutation is attempted unless the test explicitly enables it;
- expose a controllable deferred response for cancellation/progress tests.

Verify: a smoke call to one read tool traverses the MCP transport and records
exactly one fake WHMCS read.

### 3. Snapshot normalized catalogs

Request `tools/list`, `prompts/list`, `resources/list` and resource templates.
Normalize only unstable ordering/description whitespace. Preserve names,
input/output JSON Schemas, annotations, resource URIs and prompt arguments.

Store one reviewed JSON fixture. Add assertions for invariants that snapshots
alone hide:

- tool names are unique;
- every declared `outputSchema` accepts its handler's `structuredContent`;
- write tools are not marked read-only;
- resource URIs and prompt names are unique;
- no schema property accepts `auth_token` as transport identity in HTTP tests;
- every registered tool is represented exactly once.

Verify: deliberately remove one tool in a local mutation and confirm the test
fails with the missing name, then revert that mutation.

### 4. Add transport/auth behavior tests

Pin the current fail-closed ordering in `src/http/httpServer.ts:229-420`:

- invalid origin is rejected before token validation;
- missing/invalid bearer is 401 with protected-resource metadata when OAuth is
  enabled;
- a different consumer cannot reuse another session id;
- malformed or oversized JSON never reaches a handler;
- OAuth scope denial occurs before tool execution;
- body-supplied identity is overwritten by transport identity;
- shutdown closes active transports.

For stdio, verify stdout remains protocol-only and server logs use stderr.

### 5. Pin official conformance execution

Add a script that invokes a pinned revision/container/version of the official
MCP conformance suite, never an unpinned `latest`. If the suite does not expose
a stable CLI for the installed v1 server, document the exact upstream revision
and keep the command optional in local development but required in plan 002 CI.

Verify:

```bash
npm run test:mcp:contract
npm run test:mcp:conformance
```

The second command must either pass or exit non-zero with an explicit documented
unsupported-scenario list; it must not silently skip everything.

### 6. CI integration

Add the deterministic contract suite to `.github/workflows/ci.yml`. Keep any
network-dependent conformance pull in a separate job with dependency caching
and a pinned artifact. Publish the compatibility report as an artifact.

Verify the existing gate and the two new commands.

## Tests

- Catalog fixture detects public additions/removals/schema changes.
- Governed and legacy `structuredContent` validate.
- HTTP auth/origin/session tests exercise negative paths.
- Mutation tripwire proves a read contract test cannot write.
- Conformance runner reports scenarios and failures explicitly.

## Done criteria

- One command verifies the public catalog and core transport behavior.
- The current v1 server has a saved compatibility report.
- `docs/design/mcp-adoption.md` no longer describes the released protocol and
  SDK as a draft/alpha.
- Runtime source semantics are unchanged; dependency and formatting diffs are
  isolated, reviewed and fully tested.
- `format:check` and high-severity dependency audit are green with no silent
  exception.
- Global verification gate passes.

## STOP conditions

- The harness requires production credentials or a live WHMCS instance.
- Snapshot normalization removes schemas, annotations or output contracts.
- Official conformance cannot be pinned reproducibly; document a spike instead
  of adding a best-effort green check.

## Maintenance

Public-surface PRs must update the fixture in the same commit and explain the
semantic diff in the PR body. Never auto-accept fixture changes in CI.
