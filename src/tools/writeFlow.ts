/**
 * Phase F — controlled write-automation FLOW tools.
 *
 * draft → validate → approve → execute(GATED) + get_write_intent.
 *
 * SAFETY INVARIANT: `execute_write_intent` runs the deny-by-default
 * risk-tiered ExecutionAuthorizer. KEYSTONE: with no new env configured
 * (kill switch off, empty MCP_PROD_WRITE_AUTHORIZED, zero caps) a production
 * request can only reach `action_not_prod_authorized` — production is fully
 * sealed, behaviour byte-identical to the legacy absolute deny. A live
 * `whmcs.mutate()` is reached ONLY after the authorizer allows AND a durable
 * audit line is persisted (fail-closed). The WhmcsClient.mutate()
 * read_only MODE_RESTRICTED block remains an independent backstop.
 *
 * Phase G+ — intent params (semantic, intent-contract shape) are translated
 * to WHMCS field shapes by src/write/paramMapping.ts immediately before
 * `whmcs.mutate(...)`. The mapper is also invoked at draft/validate/approve
 * render time to populate `would_call.whmcs_params` so operators see the
 * exact call shape pre-execution.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { AUTH_SHAPE } from '../security.js';
import {
  resolveConsumer,
  assertWriteScopeAllowed,
  consumerWriteCapability,
} from '../governance/consumers.js';
import { getProjectionEnv, getConsumerRegistry } from '../governance/pipeline.js';
import {
  WRITE_SCOPES,
  type WriteScope,
  type WriteToolResult,
  type HumanApprovalRecord,
  type AmountContext,
} from '../write/types.js';
import { createDraftIntent, IntentStore } from '../write/intents.js';
import { validateIntent } from '../write/validation.js';
import { IdempotencyLedger } from '../write/idempotency.js';
import { AuditLog, AuditPersistError, auditEvent } from '../write/audit.js';
import { defaultExecutionAuthorizer } from '../write/executionGate.js';
import {
  intentToWhmcsParams,
  mapServicePriceRestoreTarget,
  PRICE_RESTORE_RECURRING_FIELD,
} from '../write/paramMapping.js';

// Imported for T7 (price_restore execute-path uses the per-target mapper).
// Side-effect-free reference so the unused-import check stays green until T7.
void mapServicePriceRestoreTarget;

/** Defense-in-depth: ensures the per-target mapper never leaks extra keys. */
export class PriceRestoreOutputAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceRestoreOutputAssertionError';
  }
}

const PRICE_RESTORE_ALLOWED_KEYS = new Set<string>([
  'serviceid',
  PRICE_RESTORE_RECURRING_FIELD,
]);

/**
 * Scope-output assertion for `service:price_restore`. Verifies the mapper
 * produced exactly `{ serviceid, <recurring-field> }` and nothing else.
 * Throws PriceRestoreOutputAssertionError on any extra/missing key.
 */
export function assertPriceRestoreOutput(out: Record<string, unknown>): void {
  const keys = Object.keys(out);
  for (const k of keys) {
    if (!PRICE_RESTORE_ALLOWED_KEYS.has(k)) {
      throw new PriceRestoreOutputAssertionError(
        `scope-output assertion: unexpected key "${k}" in service:price_restore mapper output`
      );
    }
  }
  if (!('serviceid' in out)) {
    throw new PriceRestoreOutputAssertionError(
      'scope-output assertion: missing serviceid in service:price_restore mapper output'
    );
  }
  if (!(PRICE_RESTORE_RECURRING_FIELD in out)) {
    throw new PriceRestoreOutputAssertionError(
      `scope-output assertion: missing ${PRICE_RESTORE_RECURRING_FIELD} in service:price_restore mapper output`
    );
  }
}

/*
 * Process-local intent state (in-memory, short TTL). The audit log and
 * idempotency ledger are DURABLE when their config paths are set (empty ⇒
 * in-memory, byte-identical to legacy). The deploy restart that ships a write
 * change therefore does not wipe the audit trail or the replay guard.
 */
const store = new IntentStore();
const ledger = new IdempotencyLedger(
  undefined,
  undefined,
  config.MCP_WRITE_IDEMPOTENCY_PATH || undefined
);
const audit = new AuditLog(config.MCP_WRITE_AUDIT_PATH || undefined);

/**
 * Approver identity captured at approve-time, consumed at execute-time so the
 * authorizer can enforce "high-risk requires a human approval record". Keyed
 * by intent_id; process-local (an approval does not survive restart — a
 * high-risk action must be (re)approved in the same process that executes it).
 */
const approvals = new Map<string, HumanApprovalRecord>();

/** Per-(action,UTC-day) executed-amount tally for high-risk daily caps. */
const dayAmounts = new Map<string, number>();
function dayKey(action: string): string {
  return `${action}|${new Date().toISOString().slice(0, 10)}`;
}
function dayTotalFor(action: string): number {
  return dayAmounts.get(dayKey(action)) ?? 0;
}
function addDayAmount(action: string, amount: number): void {
  dayAmounts.set(dayKey(action), dayTotalFor(action) + amount);
}

/** Build the high-risk monetary context from intent params, if numeric. */
function amountContextFor(
  action: string,
  params: Record<string, unknown>
): AmountContext | undefined {
  const raw = params.amount;
  const amount = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return { amount: Math.abs(amount), dayTotal: dayTotalFor(action) };
}

/** Test-only: reset framework state. */
export function __resetWriteFlowForTests(): void {
  store.prune();
}

const WRITE_FLOW_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/**
 * Accurate, app-usable WriteIntent shape (mirrors `WriteIntent` in
 * write/types.ts). Declared so the SDK never strips intent fields apps
 * rely on (intent_id, state, scope, action, risk, idempotency_key,
 * timestamps). Open via `.passthrough()` so additive future fields are
 * preserved rather than dropped.
 */
const INTENT_OBJECT_SHAPE = z.looseObject({
  intent_id: z.string(),
  consumer_id: z.string(),
  scope: z.string(),
  action: z.string(),
  risk: z.string(),
  params: z.record(z.string(), z.unknown()),
  idempotency_key: z.string(),
  preconditions: z.record(z.string(), z.unknown()),
  projected_effect: z.string(),
  state: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  contract: z.string().optional(),
});

/** Accurate validation result shape (mirrors `ValidationResult`). */
const VALIDATION_OBJECT_SHAPE = z.looseObject({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      code: z.string(),
      severity: z.string(),
      message: z.string(),
    })
  ),
  compat_warnings: z.array(z.string()),
});

/**
 * Result contract for draft/validate/approve/execute. Mirrors
 * `WriteToolResult` exactly. All success fields are present so apps get a
 * stable machine-readable structure (idempotency_key, required_approvals,
 * risk_flags, execution.blocked_reason, execution.note are all declared).
 *
 * Every success field is `.optional()` and the diagnostic keys an error
 * result may carry (`isError`, `error`, `stage`, `scope`, `intent_id`,
 * `writeCapability`) are declared so an `err()` result still validates
 * against this schema WITHOUT weakening the success contract: a successful
 * call always returns every field, the optionality only tolerates the
 * MCP-permitted `isError` payload path. (Per MCP, an `isError` result is
 * not strictly validated against outputSchema, but declaring these keeps
 * the structured error machine-readable too.)
 */
const RESULT_OUTPUT_SHAPE = {
  intent: INTENT_OBJECT_SHAPE.optional(),
  stage: z.string().optional(),
  validation: VALIDATION_OBJECT_SHAPE.optional(),
  risk_flags: z.array(z.string()).optional(),
  required_approvals: z.number().optional(),
  idempotency_key: z.string().optional(),
  would_call: z
    .object({
      action: z.string(),
      // Raw intent params (transparent to drafter — same shape they submitted).
      params: z.record(z.string(), z.unknown()),
      // Phase G+: mapped WHMCS-shape params (exact pre-execution call shape)
      // so operators see the real payload before approving/executing. Optional
      // because a mapping_error defers to the validator surfacing it.
      whmcs_params: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  executed: z.boolean().optional(),
  execution: z
    .object({
      attempted: z.boolean(),
      blocked_reason: z.string().optional(),
      note: z.string().optional(),
      verified: z.boolean().optional(),
    })
    .optional(),
  // Diagnostic keys carried only by an `err()` result (success never sets these).
  isError: z.literal(true).optional(),
  error: z.string().optional(),
  scope: z.string().optional(),
  intent_id: z.string().optional(),
  writeCapability: z.string().optional(),
} as const;

function err(message: string, extra?: Record<string, unknown>) {
  const payload = { isError: true, error: message, ...(extra ?? {}) };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

function out(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** Resolve the calling consumer from the bearer token; deny by default. */
function resolveWriteConsumer(params: Record<string, unknown>) {
  const token = typeof params.auth_token === 'string' ? params.auth_token : undefined;
  return resolveConsumer(token, getProjectionEnv(), getConsumerRegistry(), {
    allowAnon: false,
  });
}

/**
 * WHMCS actions explicitly authorized for execution at runtime (default: none).
 * Reads the parsed config value rather than process.env directly so the single
 * source of truth for env parsing remains config.ts; the default is `[]` ⇒ no
 * action authorized at runtime — sealed posture preserved.
 *
 * Falls back to parsing `process.env.MCP_WRITE_EXECUTION_AUTHORIZED` if the
 * config field is absent (test environments that mock the config without the
 * new field still get the same semantics — the sealed-by-default keystone
 * holds either way).
 */
function runtimeAuthorizedActions(): readonly string[] {
  const fromConfig = (config as Record<string, unknown>).MCP_WRITE_EXECUTION_AUTHORIZED;
  if (Array.isArray(fromConfig)) return fromConfig as readonly string[];
  const raw = process.env.MCP_WRITE_EXECUTION_AUTHORIZED;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function toToolResult(
  intentRec: ReturnType<typeof createDraftIntent>,
  stage: WriteToolResult['stage'],
  extra: Partial<WriteToolResult> & { execution: WriteToolResult['execution'] }
): Record<string, unknown> {
  // Best-effort mapper preview for would_call. The validate-stage mapping_error
  // check is what FAILS a malformed intent — here we only catch so an ill-formed
  // intent at draft time still returns a structured payload to the caller.
  let whmcsParams: Record<string, unknown> | undefined;
  try {
    whmcsParams = intentToWhmcsParams(
      intentRec.scope,
      intentRec.params as Record<string, unknown>,
      { idempotency_key: intentRec.idempotency_key }
    );
  } catch {
    whmcsParams = undefined;
  }
  return {
    intent: intentRec,
    stage,
    risk_flags: [
      intentRec.risk,
      ...(intentRec.risk === 'high' ? ['requires_explicit_approval'] : []),
    ],
    required_approvals: intentRec.risk === 'high' ? 2 : 1,
    idempotency_key: intentRec.idempotency_key,
    would_call: {
      action: intentRec.action,
      params: intentRec.params,
      ...(whmcsParams !== undefined ? { whmcs_params: whmcsParams } : {}),
    },
    executed: false,
    ...extra,
  };
}

/** Accurate append-only audit event shape (mirrors `AuditEvent`). */
const AUDIT_EVENT_SHAPE = z.looseObject({
  event: z.string(),
  intent_id: z.string(),
  consumer_id: z.string(),
  scope: z.string(),
  action: z.string(),
  idempotency_key: z.string(),
  at: z.string(),
  detail: z.string().optional(),
});

/**
 * Output schema for get_write_intent (intent + append-only audit trail).
 * Success always returns both `intent` and `audit`; they are `.optional()`
 * and the `err()` diagnostic keys are declared only so an error result
 * still validates — the success contract (intent + audit) is unchanged.
 */
const INTENT_VIEW_OUTPUT_SHAPE = {
  intent: INTENT_OBJECT_SHAPE.optional(),
  audit: z.array(AUDIT_EVENT_SHAPE).optional(),
  isError: z.literal(true).optional(),
  error: z.string().optional(),
  intent_id: z.string().optional(),
} as const;

type Handler = ToolCallback<z.ZodRawShape>;

function register(
  server: McpServer,
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  logger: Logger,
  rl: RateLimiter,
  run: (
    params: Record<string, unknown>
  ) =>
    | Record<string, unknown>
    | ReturnType<typeof err>
    | Promise<Record<string, unknown> | ReturnType<typeof err>>,
  outputShape: z.ZodRawShape = RESULT_OUTPUT_SHAPE
): void {
  if (!isToolAllowed(name)) return;
  const handler: Handler = (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      log.logToolCall(name, {}, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      const r = await run(params);
      log.logToolResult(name, true, Date.now() - t0);
      return r;
    } catch (e) {
      log.logToolResult(name, false, Date.now() - t0, e instanceof Error ? e.message : String(e));
      if (e instanceof RateLimitError) return err(e.message);
      throw e;
    }
  }) as unknown as Handler;
  server.registerTool(
    name,
    {
      description,
      inputSchema: { ...inputShape, ...AUTH_SHAPE },
      outputSchema: outputShape,
      annotations: WRITE_FLOW_ANNOTATIONS,
    },
    handler
  );
}

/**
 * Phase G+ — which action may actually execute is now owned entirely by the
 * deny-by-default risk-tiered authorizer (executionGate.ts): per-environment
 * allowlist (production allowlist empty by default ⇒ sealed),
 * PROD_NEVER_EXECUTABLE backstop, and high-risk human-approval + caps. There
 * is no separate hardcoded low-risk set here anymore.
 *
 * Register the controlled-write FLOW tools. `whmcs.mutate()` is reached ONLY
 * after the authorizer allows AND a durable audit line is written; the
 * WhmcsClient read_only MODE_RESTRICTED check is an independent backstop.
 */
export function registerWriteFlowTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  register(
    server,
    'draft_write_intent',
    'Phase F: create a non-executing write intent (draft). Performs NO WHMCS mutation. Consumer + write-scope gated.',
    {
      scope: z.enum(WRITE_SCOPES),
      params: z.record(z.string(), z.unknown()),
      naturalKey: z.string().min(1),
      projected_effect: z.string().min(1),
      preconditions: z.record(z.string(), z.unknown()).optional(),
    },
    logger,
    rl,
    (p) => {
      const res = resolveWriteConsumer(p);
      if (!res.ok) return err(`consumer denied: ${res.reason}`, { stage: 'draft' });
      const scope = p.scope as WriteScope;
      const gate = assertWriteScopeAllowed(res.profile, scope);
      if (!gate.ok) return err(`write scope denied: ${gate.reason}`, { stage: 'draft', scope });
      const intent = createDraftIntent({
        consumer_id: res.profile.id,
        scope,
        params: (p.params ?? {}) as Record<string, unknown>,
        naturalKey: p.naturalKey as string,
        preconditions: (p.preconditions ?? {}) as Record<string, unknown>,
        projected_effect: p.projected_effect as string,
      });
      store.put(intent);
      audit.append(auditEvent('intent.drafted', intent));
      return out(toToolResult(intent, 'draft', { execution: { attempted: false } }));
    }
  );

  register(
    server,
    'validate_write_intent',
    'Phase F: validate a draft intent (schema/scope/precondition/WHMCS-9 compat). NO mutation.',
    { intent_id: z.string().min(1) },
    logger,
    rl,
    (p) => {
      const res = resolveWriteConsumer(p);
      if (!res.ok) return err(`consumer denied: ${res.reason}`);
      const intent = store.get(p.intent_id as string);
      if (!intent) return err('intent not found', { intent_id: p.intent_id });
      if (intent.consumer_id !== res.profile.id)
        return err('intent does not belong to this consumer', { intent_id: p.intent_id });
      const validation = validateIntent(intent, {});
      const next = store.transition(intent.intent_id, validation.ok ? 'validated' : 'rejected');
      audit.append(auditEvent(validation.ok ? 'intent.validated' : 'intent.rejected', next));
      return out(toToolResult(next, 'validate', { validation, execution: { attempted: false } }));
    }
  );

  register(
    server,
    'approve_write_intent',
    'Phase F: record an approval for a validated intent. NO mutation. Requires a consumer whose writeCapability permits approval/execution.',
    {
      intent_id: z.string().min(1),
      approver: z.string().min(1),
      decision: z.enum(['approved', 'rejected']),
      reason: z.string().optional(),
    },
    logger,
    rl,
    (p) => {
      const res = resolveWriteConsumer(p);
      if (!res.ok) return err(`consumer denied: ${res.reason}`);
      const cap = consumerWriteCapability(res.profile);
      if (cap === 'false' || cap === 'disabled' || cap === 'draft_only')
        return err('consumer not permitted to approve write intents', { writeCapability: cap });
      const intent = store.get(p.intent_id as string);
      if (!intent) return err('intent not found', { intent_id: p.intent_id });
      if (intent.consumer_id !== res.profile.id)
        return err('intent does not belong to this consumer');
      if (intent.state !== 'validated')
        return err(`intent must be validated before approval (state=${intent.state})`);
      const approved = p.decision === 'approved';
      const next = store.transition(intent.intent_id, approved ? 'approved' : 'rejected');
      if (approved) {
        // Recorded human approval — required by the authorizer for high-risk
        // (money) actions. A rejection clears any prior approval record.
        approvals.set(intent.intent_id, {
          approver: String(p.approver),
          at: new Date().toISOString(),
        });
      } else {
        approvals.delete(intent.intent_id);
      }
      audit.append(
        auditEvent(
          approved ? 'intent.approved' : 'intent.rejected',
          next,
          `by ${String(p.approver)}`
        )
      );
      return out(toToolResult(next, 'approve', { execution: { attempted: false } }));
    }
  );

  register(
    server,
    'execute_write_intent',
    'Phase G+: execute an approved intent through the deny-by-default risk-tiered authorizer. Production is SEALED unless the action is explicitly in MCP_PROD_WRITE_AUTHORIZED; high-risk (money) actions additionally require a human approval record and per-action/daily caps. PROD_NEVER_EXECUTABLE actions can never run. Durable audit is written before any mutation (fail-closed).',
    { intent_id: z.string().min(1) },
    logger,
    rl,
    async (p) => {
      const res = resolveWriteConsumer(p);
      if (!res.ok) return err(`consumer denied: ${res.reason}`);
      const intent = store.get(p.intent_id as string);
      if (!intent) return err('intent not found', { intent_id: p.intent_id });
      if (intent.consumer_id !== res.profile.id)
        return err('intent does not belong to this consumer');
      // Execution is only attemptable from an approved intent. Reporting a
      // blocked attempt must never force an illegal state transition, so a
      // non-approved intent returns the structured denial in place.
      //
      // NOTE: this early-return precedes the deny-by-default authorizer because
      // a non-approved intent can never mutate ANYWAY (kill-switch and the
      // authorizer would deny identically); short-circuiting here preserves the
      // legal state-machine transition rules (only `approved`→`executed`).
      if (intent.state !== 'approved') {
        audit.append(auditEvent('intent.execution_blocked', intent, 'intent_not_approved'));
        return out(
          toToolResult(intent, 'execute', {
            execution: { attempted: false, blocked_reason: 'intent_not_approved' },
          })
        );
      }
      const isHigh = intent.risk === 'high';
      const amountContext = isHigh
        ? amountContextFor(intent.action, intent.params as Record<string, unknown>)
        : undefined;
      const decision = defaultExecutionAuthorizer(
        {
          intent,
          env: getProjectionEnv(),
          mcpMode: config.MCP_MODE,
          consumerWriteCapability: consumerWriteCapability(res.profile),
          runtimeAuthorizedActions: runtimeAuthorizedActions(),
          killSwitch: config.MCP_WRITE_KILL_SWITCH,
          prodAuthorizedActions: config.MCP_PROD_WRITE_AUTHORIZED,
          humanApproval: approvals.get(intent.intent_id),
          amountContext,
          caps: {
            perAction: config.MCP_PROD_HIGH_RISK_PER_ACTION_CAP,
            daily: config.MCP_PROD_HIGH_RISK_DAILY_CAP,
          },
        },
        (k) => ledger.seen(k)
      );
      if (!decision.allowed) {
        const next = store.transition(intent.intent_id, 'execution_blocked');
        audit.append(auditEvent('intent.execution_blocked', next, decision.reason));
        return out(
          toToolResult(next, 'execute', {
            execution: { attempted: false, blocked_reason: decision.reason },
          })
        );
      }

      // Gates passed. FAIL-CLOSED durable audit: the "attempting mutation"
      // event must be durably written BEFORE the WHMCS call. If durable audit
      // cannot be written, refuse to execute — no unauditable mutation. (No
      // idempotency recorded and no state change, so it is safely retryable.)
      const attemptEvent = auditEvent(
        'intent.executed',
        intent,
        `attempting ${intent.action} (risk=${intent.risk}, env=${getProjectionEnv()})`
      );
      try {
        audit.appendDurable(attemptEvent);
      } catch (e) {
        if (e instanceof AuditPersistError) {
          const blocked = store.transition(intent.intent_id, 'execution_blocked');
          audit.append(auditEvent('intent.execution_blocked', blocked, 'audit_write_failed'));
          return out(
            toToolResult(blocked, 'execute', {
              execution: {
                attempted: false,
                blocked_reason: 'audit_write_failed',
                note: 'Durable audit write failed; mutation refused (fail-closed).',
              },
            })
          );
        }
        throw e;
      }

      // Record idempotency BEFORE the call so a concurrent/retry attempt is
      // treated as a replay. The WhmcsClient.mutate() read_only
      // MODE_RESTRICTED check is an independent backstop beneath this gate.
      ledger.record(intent.idempotency_key, { executing: true });
      // approved → executed: committing to the attempt (legal transition;
      // failed/verified are only reachable from `executed`).
      const executing = store.transition(intent.intent_id, 'executed');
      try {
        // Map intent-contract params → WHMCS-shape params at the very last
        // mile, so the rest of the flow (audit, validate, replay-guard) keeps
        // working with the semantic intent shape while WHMCS receives the
        // exact field names it requires (e.g. notes/userid, item flattening,
        // amountout-only refund payload — no `amountin`).
        await whmcs.mutate(
          intent.action,
          intentToWhmcsParams(intent.scope, intent.params as Record<string, unknown>, {
            idempotency_key: intent.idempotency_key,
          })
        );
      } catch (e) {
        const failed = store.transition(intent.intent_id, 'failed');
        audit.append(
          auditEvent('intent.failed', failed, e instanceof Error ? e.message : String(e))
        );
        return out(
          toToolResult(failed, 'execute', {
            executed: false,
            execution: {
              attempted: true,
              note: `Execution failed: ${e instanceof Error ? e.message : String(e)}`,
            },
          })
        );
      }
      // Executed — tally the high-risk amount toward the daily cap.
      if (isHigh && amountContext !== undefined) {
        addDayAmount(intent.action, amountContext.amount);
      }

      // Post-action verification: best-effort read-back. Never fails the
      // result if verification itself is unavailable — reports verified:false
      // and the intent stays in `executed` (only `verified` re-transitions).
      let verified = false;
      try {
        if (typeof intent.preconditions.verifyAction === 'string') {
          await whmcs.read(intent.preconditions.verifyAction, {});
          verified = true;
        }
      } catch {
        verified = false;
      }
      const finalIntent = verified ? store.transition(intent.intent_id, 'verified') : executing;
      audit.append(
        auditEvent(
          verified ? 'intent.verified' : 'intent.executed',
          finalIntent,
          verified ? 'post-action verified' : 'executed; post-action verification unavailable'
        )
      );
      return out(
        toToolResult(finalIntent, 'execute', {
          executed: true,
          execution: { attempted: true, verified },
        })
      );
    }
  );

  register(
    server,
    'get_write_intent',
    'Phase F: fetch a write intent and its append-only audit trail. Read-only.',
    { intent_id: z.string().min(1) },
    logger,
    rl,
    (p) => {
      const res = resolveWriteConsumer(p);
      if (!res.ok) return err(`consumer denied: ${res.reason}`);
      const intent = store.get(p.intent_id as string);
      if (!intent) return err('intent not found', { intent_id: p.intent_id });
      if (intent.consumer_id !== res.profile.id)
        return err('intent does not belong to this consumer');
      return out({
        intent,
        audit: audit.forIntent(intent.intent_id),
      });
    },
    INTENT_VIEW_OUTPUT_SHAPE
  );
}
