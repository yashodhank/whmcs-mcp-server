# Plan 007: Durable daily-cap tally (`dayAmounts`) for the write-flow money-gate

> Executor: follow step by step, run every verification, honor STOP conditions, do not improvise. Do NOT update `plans/README.md` (reviewer maintains it).
>
> **Scope note (read first):** this plan was deliberately NARROWED from the original investigation. The original also proposed persisting the `approvals` map — that was DROPPED. Reason: the IntentStore is intentionally ephemeral (15-min TTL, re-drafted on loss), so on a restart the intent is gone and `execute_write_intent` rejects with "intent not found" before any persisted approval is consulted — making approval-persistence moot, while adding a forged-approval-file attack surface the "approve in the same process" rule exists to prevent. Approvals stay process-local. ONLY `dayAmounts` is made durable here, because a restart zeroing the daily-cap tally is a real cap-bypass (restart → full daily budget available again).

## Status
- Priority: P2 · Effort: S–M · Risk: MED (touches the money-gate) · Depends on: none · Category: security/correctness
- Planned at: `main` HEAD (re-stamp at execution via `git rev-parse --short HEAD`), 2026-06-19

## Why this matters
`dayAmounts` (`src/tools/writeFlow.ts:189`) is the in-memory running total of high-risk monetary spend per `(action, UTC-day)`, used to enforce `MCP_PROD_HIGH_RISK_DAILY_CAP`. It is process-local, so a restart resets it to zero and the full daily cap becomes available again. An adversary able to induce restarts (crash-loop via malformed input, a deploy mid-window) can multiply the daily cap. This makes the tally durable — following the exact pattern the `IdempotencyLedger`/`AuditLog` already use — gated behind a new env path, **byte-identical to today when the path is unset** (the keystone invariant).

## Current state (file:line)
- `src/tools/writeFlow.ts:189` — `const dayAmounts = new Map<string, number>();`
- `:190` `dayKey(action)` (includes UTC date), `:193` `dayTotalFor(action)`, `:196-198` `addDayAmount(action, amount)`, `:201-209` `amountContextFor` builds `AmountContext { dayTotal: dayTotalFor(action) }` for the authorizer. The batch executor also reads/writes `dayAmounts` directly (`PriceRestoreBatchArgs` at `:527`, used in `executePriceRestoreBatch` ~`:629-761`, passed at `:1035`).
- Durable pattern to follow: `src/write/idempotency.ts` (constructor takes optional `filePath`; unset ⇒ pure in-memory; `loadFromDisk` reads JSONL; `persist` = `mkdirSync` recursive + `openSync('a')` + `writeSync(JSON.stringify+"\n")` + `fsyncSync` + `closeSync`, errors swallowed). Config pattern: `src/config.ts:218-229` (`MCP_WRITE_AUDIT_PATH`/`MCP_WRITE_IDEMPOTENCY_PATH`, `z.preprocess(... z.string().default(''))`).
- Keystone invariant (preserve verbatim): `src/tools/writeFlow.ts:6-13` — "with no new env configured … behaviour byte-identical to the legacy absolute deny — production is fully sealed."

## Commands
| Purpose | Command | Expected |
|---|---|---|
| deps | `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"; npm ci --no-audit --no-fund` | ok |
| typecheck | `npm run typecheck` | exit 0 |
| lint | `npm run lint` | exit 0 |
| tests | `WHMCS_API_URL=https://t/includes/api.php WHMCS_IDENTIFIER=t WHMCS_SECRET=t npm test` | all pass |

## Scope
**In:** create `src/write/dayAmountsStore.ts`; add `MCP_WRITE_DAY_AMOUNTS_PATH` to `src/config.ts`; wire it into `src/tools/writeFlow.ts` (replace the `dayAmounts` Map + helpers; thread through `executePriceRestoreBatch`/`PriceRestoreBatchArgs`); extend `__resetWriteFlowForTests`; new tests in `tests/write/durability.test.ts`.
**Out:** `approvals` map (stays process-local — do NOT persist it), the IntentStore, `executionGate.ts`/`types.ts`/`validation.ts`, audit/idempotency classes, the `write` one-call path.

## Steps
1. **Drift check:** `grep -n "const dayAmounts = new Map" src/tools/writeFlow.ts` (expect ~189); `grep -n "MCP_WRITE_IDEMPOTENCY_PATH" src/config.ts`. If moved >±5 lines, re-read before proceeding.
2. **Create `src/write/dayAmountsStore.ts`** — class `DayAmountsStore`, constructor `(filePath?: string)`: unset ⇒ pure in-memory (no I/O, no file); with path ⇒ `loadFromDisk`. Methods: `getTotal(action): number` (in-memory map via `dayKey`), `add(action, amount): void` (increment + best-effort persist `{ key, total, date: YYYY-MM-DD }`), `dayKey(action)` includes `new Date().toISOString().slice(0,10)`, `loadFromDisk` last-write-wins per key and **drops entries whose `date` ≠ today UTC** (stale day discarded), `reset()` test-only. Persist via the idempotency.ts fsync pattern; swallow write errors. File header: document that it stores only action/total/date (no secrets) and the concurrent-append note. **Verify:** `npm run typecheck`.
3. **Config:** add `MCP_WRITE_DAY_AMOUNTS_PATH` (`z.preprocess(...z.string().default(''))`) alongside the existing write paths. Do NOT hard-require it in the `superRefine` (a missing tally is fail-safe: the cap still enforces per-run; worst case it restarts from zero — same as today). Add a comment saying operators with `MCP_PROD_HIGH_RISK_DAILY_CAP` set SHOULD set it. **Verify:** `npm run typecheck`.
4. **Wire into writeFlow.ts:** replace `const dayAmounts = new Map…` + `dayTotalFor`/`addDayAmount` with `const dayAmountsStore = new DayAmountsStore(config.MCP_WRITE_DAY_AMOUNTS_PATH || undefined);` and route `dayTotalFor→getTotal`, `addDayAmount→add`. For `executePriceRestoreBatch`/`PriceRestoreBatchArgs` (`:527`): prefer passing the `DayAmountsStore`; if that touches >5 raw-Map call sites, expose a minimal `getMap(): Map<string,number>` shim and document as debt (per STOP #3). **Verify:** `grep -n "new Map<string, number>" src/tools/writeFlow.ts` returns nothing for the module-level singleton; `npm run typecheck`.
5. **`__resetWriteFlowForTests`** (`:212`): also call `dayAmountsStore.reset()`. Test-only.
6. **Tests** (`tests/write/durability.test.ts`, mirror the IdempotencyLedger tests): (a) no path ⇒ in-memory, writes no file; (b) persists + reloads same-day total across a simulated restart (new instance from same file); (c) stale prior-day entry ignored on reload (`getTotal`→0); (d) write error on unwritable path is swallowed (no throw). **Verify:** `npx vitest run tests/write/durability.test.ts`.
7. **Full suite + keystone smoke:** `npm test`; specifically `npx vitest run tests/tools/writeFlow.prodsafety.test.ts` must pass (unset env ⇒ unchanged behavior).

## Done criteria
- [ ] typecheck + lint + full `npm test` green
- [ ] `grep -n "const dayAmounts = new Map" src/tools/writeFlow.ts` → nothing
- [ ] `grep -n "MCP_WRITE_DAY_AMOUNTS_PATH" src/config.ts` → ≥1
- [ ] `approvals` map is UNCHANGED (still `new Map<string, HumanApprovalRecord>()`, still process-local) — `grep -n "new Map<string, HumanApprovalRecord>" src/tools/writeFlow.ts` still matches
- [ ] new durability tests exist and pass; prodsafety suite passes
- [ ] only in-scope files changed

## STOP conditions
1. Implementing this would change behavior when `MCP_WRITE_DAY_AMOUNTS_PATH` is unset (must be byte-identical) — STOP.
2. You find yourself persisting the `approvals` map or the IntentStore — STOP (explicitly out of scope per the scope note).
3. The `PriceRestoreBatchArgs` refactor needs >5 batch call-site changes — use the `getMap()` shim instead and note it; if even that is messy, STOP.
4. Any format other than append-only JSONL + per-write `fsyncSync` — STOP.
5. Drift moved the targets substantially — STOP and re-read.

## Maintenance notes
- File grows append-only; only today's entry is read (prior-day lines ignored on load). **Compaction — DECIDED WON'T-DO (2026-06-19):** functional impact is nil (load already filters to today; growth is slow), and a live compactor that mis-orders a truncate risks erasing a day's cap tally → cap bypass. Not worth the downside. If file size ever becomes a real ops issue, the ONLY sanctioned form is a startup rewrite (write today's surviving totals to a temp file, atomic rename) — never a live/concurrent compactor.
- Concurrent processes share the file; combined total is correct (a cluster-wide daily cap). POSIX `O_APPEND` is atomic for these small writes.
- Stores only action name / numeric total / UTC date — no secrets.
- **Durable approvals — DECIDED WON'T-DO (2026-06-19):** confirmed an anti-feature. The IntentStore is intentionally ephemeral (15-min TTL), so on restart the intent is gone and `execute_write_intent` rejects with "intent not found" BEFORE any persisted approval is consulted — making approval persistence moot while adding a forged-on-disk-approval attack surface. Only reconsider if the IntentStore is ever made durable, and only with cryptographically signed approval records (separate, reviewed design). Left process-local intentionally.
