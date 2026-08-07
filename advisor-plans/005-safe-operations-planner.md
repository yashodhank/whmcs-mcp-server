# Plan 005: Safe operations brainstorming skill and PlanIR compiler

> Written against `ebab2c5` on 2026-08-07. Requires plan 003; plan 002 is
> recommended before modern MRTR UX. Drift check: inspect
> `src/prompts/whmcsPrompts.ts:41-412`, workflow/write-flow tools, the capability
> resource, and every write scope/catalog version.

## Finding

The repo has nine static prompts and four draft-only workflow tools, but no
shared representation for an operator goal, alternative strategies,
prerequisites, risk/cost, evidence and fallback. Clients must infer this from
tool descriptions and may over-fetch, select unsupported actions or jump too
quickly toward writes. Adding intelligence directly to handlers would be unsafe:
model reasoning must not become authorization.

Impact: very high. Effort: large. Risk: medium. Confidence: medium-high.

## Goal

Add a versatile WHMCS operations brainstorming skill that runs in the MCP host
and uses deterministic server primitives to compile a natural-language goal into
a typed `PlanIR`. It can compare strategies, estimate cost, gather safe evidence
and create governed draft intents, but it cannot approve or execute writes.

## Architecture

```text
User goal
  │
  ▼
Host prompt / skill (LLM brainstorms alternatives)
  │ structured candidate plan
  ▼
Server plan compiler (deterministic validation)
  ├─ capability catalog + fresh evidence
  ├─ consumer/governance policy
  ├─ dependency/effect/risk/cost checks
  └─ PlanIR with executable=false
          │
          ├─ safe reads can run with bounded concurrency
          └─ write steps may become draft_write_intent only
                    │
              existing validate/approve/execute ceremony
```

The host owns creative reasoning. The server owns facts, validation and policy.
Do not add server-side sampling/direct LLM-provider calls.

## PlanIR contract

Create a versioned schema under `src/planning/` with:

- goal, assumptions and requested outcome;
- alternatives with rationale and trade-offs;
- ordered DAG steps using stable catalog operation ids;
- typed inputs or unresolved slots;
- effect/risk tier, capability status/evidence age, estimated WHMCS calls and
  expected latency class;
- preconditions, postconditions and verification operation;
- data contract/consumer requirement;
- failure mode, fallback and compensation note;
- `execution_mode: analyse | read_only | draft_only`;
- `executable: false` at plan level;
- catalog version, plan hash, expiry and provenance.

Never embed auth tokens, credentials or raw PII. Unknown/unresolved values remain
typed slots; the model must not invent ids or capability proof.

## Scope

Expected files:

- `src/planning/types.ts`, `schema.ts`, `compiler.ts`, `validator.ts`,
  `costModel.ts`, `riskModel.ts`.
- `src/tools/planning.ts` — pure/read/draft-only planning tools.
- `src/prompts/whmcsPrompts.ts` or a new prompt pack — host-side skill prompt.
- `src/resources/planning.ts` — capability/PlanIR guidance resources.
- `tests/planning/*` — golden scenarios, policy and adversarial tests.
- docs/client examples for Claude/Cursor/other generic MCP hosts.

Out of scope:

- Autonomous approval or execution.
- Server-side model sampling/provider keys.
- Free-form operation names or dynamic code.
- Long-term memory of client data without a separately approved encrypted store.
- Treating estimates as billing/accounting facts.

## Steps

### 1. Define planner threat model and invariants

Document threats: prompt injection in ticket text, hallucinated ids, stale
capabilities, plan replay, confused deputy across consumers, scope escalation,
hidden writes in “read” workflows, excessive fan-out and PII leakage.

Pin invariants:

- compilation is deterministic and pure for the same catalog/evidence/context;
- only catalog operation ids are accepted;
- consumer context comes from transport, never PlanIR;
- every step's declared effect must match catalog effect;
- stale/unverified capability produces a blocked/preflight step, not optimism;
- no write operation is runnable in `analyse`/`read_only`;
- `draft_only` can call only the existing draft entry point;
- approve/execute operations are excluded from planner-generated steps;
- untrusted WHMCS free text is quoted data, never planner instruction.

### 2. Implement the PlanIR schema and pure compiler

Compiler input: candidate PlanIR, authenticated planning context, effective
catalog, capability evidence and limits. Output: accepted normalized plan or a
structured list of issues with severity, path, reason and suggested safe repair.

Validation includes DAG cycle detection, dependency ordering, slot types,
effects/risk consistency, max calls, max fan-out, pagination bounds, capability
freshness, consumer scopes/contracts, plan TTL and catalog version.

Compute a canonical hash after normalization. A later draft action must present
the same unexpired hash/catalog version or recompile.

### 3. Add deterministic planning tools

Recommended minimal surface:

- `inspect_operation_catalog` — filtered, client-safe capability/cost view;
- `compile_operation_plan` — validates candidate PlanIR, no WHMCS call;
- `preflight_operation_plan` — performs only allowlisted safe reads/probes and
  returns refreshed evidence plus blockers;
- `draft_operation_plan` — converts eligible write steps into existing governed
  draft intents and returns ids; always `executed:false`.

Avoid a generic `run_plan` tool in this phase. Reads may be orchestrated later
through a bounded executor, but writes remain visibly separate drafts.

### 4. Build the host-side brainstorming prompt/skill

Add one parameterized MCP prompt, e.g. `plan_whmcs_operation`, that instructs the
host model to:

1. restate the goal and missing facts;
2. request the filtered catalog;
3. produce 2-3 materially different strategies when useful;
4. compare safety, latency, API-call cost and reversibility;
5. choose one and emit candidate PlanIR;
6. compile and repair it until valid;
7. preflight only with user-requested mode;
8. stop at analysis or drafts unless the user separately enters the existing
   approval/execution ceremony.

Prompt output is untrusted until compiled. The server must not parse prose as an
operation. For modern clients, MRTR may collect missing non-secret slots or a
choice among alternatives; declining/cancelling returns a non-executable plan.

### 5. Add client intelligence and versatility

Provide examples for clients that support different subsets:

- basic client: tool catalog + compile calls;
- prompt-aware client: invokes brainstorming prompt;
- modern client: `server/discover`, catalog cache hints and MRTR;
- task-aware client: future background preflight reads only after a durable
  task-store design;
- offline/simulate: compile against a signed/exported catalog snapshot, clearly
  marked stale and non-executable.

Add completions for operation ids and safe reference ids only where the client
protocol supports them. Completions must be consumer-filtered, paginated and
governed; never return secret/free-text fields.

### 6. Add golden and adversarial evaluation suite

Golden scenarios:

- account 360 diagnosis (read only);
- renewal-risk triage (read + drafts);
- month-end reconciliation with partial failures;
- suspend-for-nonpayment proposal (high-risk draft, never execute);
- unsupported WHMCS action with fallback;
- ambiguous client name requiring id selection;
- stale catalog/capability evidence requiring recompile.

Adversarial cases:

- ticket body says to ignore policy/execute a refund;
- candidate changes consumer/token fields;
- hidden write mislabeled as read;
- cyclic/excessive fan-out plan;
- replay after TTL/catalog change;
- cross-client id under a portal consumer;
- quote/refund amounts in malformed syntax;
- partial-read failure followed by unsafe write inference.

Assertions focus on compiler behavior, not exact LLM prose. The prompt can have
offline fixture tests; do not make CI depend on a hosted model.

### 7. Roll out in modes

1. shadow: compile plans and log aggregate issue categories, no preflight;
2. analyse: return accepted PlanIR only;
3. read-only preflight: bounded safe reads;
4. draft-only: explicitly enabled consumers may create draft intents;
5. future: task-backed long preflights after durable task architecture.

Expose plan correlation/hash in audit logs without inputs/PII. Track compile
acceptance, repair count, stale capability blocks, calls avoided, preflight
latency, draft count and zero execute count.

## Tests

- Schema/property tests for malformed DAGs, slots, effects and limits.
- Policy tests for every consumer/risk/mode combination.
- Prompt-injection and identity-confusion adversarial fixtures.
- Golden plans for the representative workflows.
- Plan hash/TTL/catalog-version replay tests.
- `draft_operation_plan` creates drafts only and never calls `mutate()`.
- Governance projection tests on catalog, completions and preflight output.
- Offline prompt tests with no external model/network.

## Done criteria

- A user can brainstorm alternatives and receive a compiled, explainable PlanIR.
- Unsupported/stale/unauthorized steps fail with actionable blockers/fallbacks.
- Safe read preflight is bounded and cancellable.
- Write steps can create only governed draft intents; execution count remains
  provably zero in planner tests and telemetry.
- Basic, prompt-aware and modern clients have documented integration examples.
- Global, contract, catalog and adversarial gates pass.

## STOP conditions

- The planner needs server-side model credentials or parses free-form prose into
  execution without schema validation.
- A proposed convenience path approves or executes a write.
- Capability evidence cannot be tied to installation/catalog version/expiry.
- Client identity or authorization appears inside candidate PlanIR.
- Evaluation depends on nondeterministic hosted-model output.

## Maintenance

Version PlanIR and publish migration notes. Every catalog operation addition
must update planner effect/risk/cost tests. Review golden/adversarial scenarios
after incidents and quarterly architecture changes.
