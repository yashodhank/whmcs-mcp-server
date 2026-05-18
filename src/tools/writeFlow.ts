/**
 * Phase F — controlled write-automation FLOW tools.
 *
 * draft → validate → approve → execute(GATED) + get_write_intent.
 *
 * HARD SAFETY INVARIANT: this module never imports or calls a WHMCS
 * mutating method. `execute_write_intent` runs the deny-by-default
 * ExecutionAuthorizer; in the default posture (read_only / empty runtime
 * allowlist) it ALWAYS returns execution_blocked and performs no mutation.
 * Even when every gate passes, no live WHMCS write is wired in this
 * engagement — the tool returns a structured "authorized, not executed"
 * result. The existing WhmcsClient.mutate() MODE_RESTRICTED block remains
 * an independent backstop.
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
import { WRITE_SCOPES, type WriteScope, type WriteToolResult } from '../write/types.js';
import { createDraftIntent, IntentStore } from '../write/intents.js';
import { validateIntent } from '../write/validation.js';
import { IdempotencyLedger } from '../write/idempotency.js';
import { AuditLog, auditEvent } from '../write/audit.js';
import { defaultExecutionAuthorizer } from '../write/executionGate.js';

/* Process-local framework state (in-memory, short TTL; never persisted). */
const store = new IntentStore();
const ledger = new IdempotencyLedger();
const audit = new AuditLog();

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

const RESULT_OUTPUT_SHAPE = {
  intent: z.record(z.string(), z.unknown()),
  stage: z.string(),
  validation: z.record(z.string(), z.unknown()).optional(),
  risk_flags: z.array(z.string()),
  required_approvals: z.number(),
  idempotency_key: z.string(),
  would_call: z.object({ action: z.string(), params: z.record(z.string(), z.unknown()) }),
  executed: z.literal(false),
  execution: z.object({
    attempted: z.literal(false),
    blocked_reason: z.string().optional(),
    note: z.string().optional(),
  }),
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

/** WHMCS actions explicitly authorized for execution at runtime (default: none). */
function runtimeAuthorizedActions(): readonly string[] {
  const raw = process.env.MCP_WRITE_EXECUTION_AUTHORIZED;
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function toToolResult(
  intentRec: ReturnType<typeof createDraftIntent>,
  stage: WriteToolResult['stage'],
  extra: Partial<WriteToolResult> & { execution: WriteToolResult['execution'] }
): Record<string, unknown> {
  return {
    intent: intentRec,
    stage,
    risk_flags: [intentRec.risk, ...(intentRec.risk === 'high' ? ['requires_explicit_approval'] : [])],
    required_approvals: intentRec.risk === 'high' ? 2 : 1,
    idempotency_key: intentRec.idempotency_key,
    would_call: { action: intentRec.action, params: intentRec.params },
    executed: false,
    ...extra,
  };
}

/** Output schema for get_write_intent (intent + append-only audit trail). */
const INTENT_VIEW_OUTPUT_SHAPE = {
  intent: z.record(z.string(), z.unknown()),
  audit: z.array(z.record(z.string(), z.unknown())),
} as const;

type Handler = ToolCallback<z.ZodRawShape>;

function register(
  server: McpServer,
  name: string,
  description: string,
  inputShape: z.ZodRawShape,
  logger: Logger,
  rl: RateLimiter,
  run: (params: Record<string, unknown>) => Record<string, unknown> | ReturnType<typeof err>,
  outputShape: z.ZodRawShape = RESULT_OUTPUT_SHAPE
): void {
  if (!isToolAllowed(name)) return;
  const handler: Handler = ((params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      log.logToolCall(name, {}, false);
      if (!rl.tryConsume()) throw new RateLimitError();
      const r = run(params);
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
 * Register the Phase F controlled-write FLOW tools. `_whmcs` is accepted
 * for signature parity only — it is intentionally never used (no mutation).
 */
export function registerWriteFlowTools(
  server: McpServer,
  _whmcs: WhmcsClient,
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
      return out(
        toToolResult(intent, 'draft', { execution: { attempted: false } })
      );
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
      audit.append(
        auditEvent(validation.ok ? 'intent.validated' : 'intent.rejected', next)
      );
      return out(
        toToolResult(next, 'validate', { validation, execution: { attempted: false } })
      );
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
    'Phase F: request execution of an approved intent. GATED & deny-by-default — in the read-only posture this NEVER mutates WHMCS and returns execution_blocked.',
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
      // Execution is only attemptable from an approved intent. Reporting a
      // blocked attempt must never force an illegal state transition, so a
      // non-approved intent returns the structured denial in place.
      if (intent.state !== 'approved') {
        audit.append(
          auditEvent('intent.execution_blocked', intent, 'intent_not_approved')
        );
        return out(
          toToolResult(intent, 'execute', {
            execution: { attempted: false, blocked_reason: 'intent_not_approved' },
          })
        );
      }
      const decision = defaultExecutionAuthorizer(
        {
          intent,
          env: getProjectionEnv(),
          mcpMode: config.MCP_MODE,
          consumerWriteCapability: consumerWriteCapability(res.profile),
          runtimeAuthorizedActions: runtimeAuthorizedActions(),
        },
        (k) => ledger.seen(k)
      );
      if (!decision.allowed) {
        const next = store.transition(intent.intent_id, 'execution_blocked');
        audit.append(
          auditEvent('intent.execution_blocked', next, decision.reason)
        );
        return out(
          toToolResult(next, 'execute', {
            execution: { attempted: false, blocked_reason: decision.reason },
          })
        );
      }
      // Gates passed — but live WHMCS mutation is intentionally NOT wired in
      // this engagement. Record the idempotency key and return a structured
      // "authorized, not executed" result. No whmcs.mutate() call exists here.
      ledger.record(intent.idempotency_key, { authorized: true });
      const next = store.transition(intent.intent_id, 'execution_blocked');
      audit.append(
        auditEvent('intent.execution_blocked', next, 'authorized_but_execution_not_wired')
      );
      return out(
        toToolResult(next, 'execute', {
          execution: {
            attempted: false,
            blocked_reason: undefined,
            note: 'Authorized by gate, but no live production write path is implemented. Separate explicit runtime execution authorization + wiring required.',
          },
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
