/**
 * Phase F — DENY-BY-DEFAULT execution gate tests.
 *
 * Proves each independent denial reason in priority order, that the gate
 * allows ONLY when every condition passes (full mode, approved intent,
 * execution_allowed consumer, action runtime-authorized, no replay), and
 * that the real default posture (read_only, empty runtime allowlist) is
 * ALWAYS denied. Pure — no WHMCS.
 */

import { describe, it, expect } from 'vitest';
import { createDraftIntent, IntentStore } from '../../src/write/intents.js';
import { defaultExecutionAuthorizer } from '../../src/write/executionGate.js';
import type { ExecutionRequest, WriteIntent } from '../../src/write/types.js';

function approvedIntent(): WriteIntent {
  const store = new IntentStore();
  const intent = createDraftIntent({
    consumer_id: 'c1',
    scope: 'client_note:write',
    params: { clientid: 1, note: 'n' },
    naturalKey: 'k',
    preconditions: {},
    projected_effect: 'note',
  });
  store.put(intent);
  store.transition(intent.intent_id, 'validated');
  return store.transition(intent.intent_id, 'approved');
}

function fullyOpenReq(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  const intent = approvedIntent();
  return {
    intent,
    env: 'staging',
    mcpMode: 'full',
    consumerWriteCapability: 'execution_allowed',
    runtimeAuthorizedActions: [intent.action],
    ...overrides,
  };
}

describe('defaultExecutionAuthorizer', () => {
  it('denies read_only_mode when mcpMode is read_only', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq({ mcpMode: 'read_only' }));
    expect(d).toEqual({ allowed: false, reason: 'read_only_mode' });
  });

  it('denies intent_not_approved when intent is not approved', () => {
    const draft = createDraftIntent({
      consumer_id: 'c1',
      scope: 'ticket:create',
      params: { subject: 's', message: 'm' },
      naturalKey: 'k',
      preconditions: {},
      projected_effect: 'p',
    });
    const d = defaultExecutionAuthorizer(fullyOpenReq({ intent: draft }));
    expect(d).toEqual({ allowed: false, reason: 'intent_not_approved' });
  });

  it('denies consumer_not_execution_allowed for a non-execution_allowed consumer', () => {
    const d = defaultExecutionAuthorizer(
      fullyOpenReq({ consumerWriteCapability: 'draft_only' }),
    );
    expect(d).toEqual({ allowed: false, reason: 'consumer_not_execution_allowed' });
  });

  it('denies action_not_runtime_authorized when action absent from allowlist', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq({ runtimeAuthorizedActions: [] }));
    expect(d).toEqual({ allowed: false, reason: 'action_not_runtime_authorized' });
  });

  it('denies idempotency_replay when alreadyExecuted predicate is true', () => {
    const req = fullyOpenReq();
    const d = defaultExecutionAuthorizer(req, () => true);
    expect(d).toEqual({ allowed: false, reason: 'idempotency_replay' });
  });

  it('allows ONLY when every gate passes', () => {
    const d = defaultExecutionAuthorizer(fullyOpenReq(), () => false);
    expect(d).toEqual({ allowed: true });
  });

  it('ALWAYS denies in the real default posture (read_only, empty allowlist)', () => {
    const intent = approvedIntent();
    const posture: ExecutionRequest = {
      intent,
      env: 'production',
      mcpMode: 'read_only',
      consumerWriteCapability: 'execution_allowed',
      runtimeAuthorizedActions: [],
    };
    const d = defaultExecutionAuthorizer(posture);
    expect(d.allowed).toBe(false);
  });
});
