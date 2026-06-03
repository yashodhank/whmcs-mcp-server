/**
 * Phase F — draft write-intent factory + in-memory IntentStore.
 *
 * SAFETY: pure / in-memory. A WriteIntent is a non-executing DESCRIPTION of a
 * proposed mutation. Nothing here calls WHMCS or any mutating action; risk +
 * action are read from the FROZEN SCOPE_RISK / SCOPE_ACTION maps in types.ts.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  SCOPE_ACTION,
  SCOPE_RISK,
  WRITE_INTENT_STATES,
  type WriteIntent,
  type WriteIntentState,
  type WriteScope,
} from './types.js';
import { idempotencyKey } from './idempotency.js';
import type { ContractName } from '../governance/types.js';

const DEFAULT_TTL_MS = 15 * 60 * 1000;

export interface CreateDraftIntentInput {
  readonly consumer_id: string;
  readonly scope: WriteScope;
  readonly params: Readonly<Record<string, unknown>>;
  /** Caller-stable description of the target effect (drives idempotency). */
  readonly naturalKey: string;
  readonly preconditions: Readonly<Record<string, unknown>>;
  readonly projected_effect: string;
  readonly contract?: ContractName;
  /** Idempotency dedupe window width (ms). */
  readonly windowMs?: number;
  /** Draft time-to-live (ms) before it is prunable. */
  readonly ttlMs?: number;
}

/**
 * Build a `state='draft'` WriteIntent: fresh uuid id, ISO created/expires
 * timestamps, risk + action derived from the frozen scope maps, and a
 * deterministic idempotency_key. No WHMCS contact.
 */
export function createDraftIntent(
  input: CreateDraftIntentInput,
  now: () => number = Date.now,
): WriteIntent {
  const createdMs = now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const action = SCOPE_ACTION[input.scope];
  const risk = SCOPE_RISK[input.scope];
  return {
    intent_id: uuidv4(),
    consumer_id: input.consumer_id,
    scope: input.scope,
    action,
    risk,
    params: input.params,
    idempotency_key: idempotencyKey(
      input.consumer_id,
      action,
      input.scope,
      input.naturalKey,
      input.windowMs,
      createdMs,
    ),
    preconditions: input.preconditions,
    projected_effect: input.projected_effect,
    state: 'draft',
    created_at: new Date(createdMs).toISOString(),
    expires_at: new Date(createdMs + ttlMs).toISOString(),
    ...(input.contract === undefined ? {} : { contract: input.contract }),
  };
}

/** Legal next-states for the validated write intent state machine. */
const TRANSITIONS: Readonly<Record<WriteIntentState, readonly WriteIntentState[]>> = {
  draft: ['validated', 'rejected'],
  validated: ['approved', 'rejected'],
  rejected: [],
  approved: ['execution_blocked', 'executed'],
  execution_blocked: [],
  executed: ['verified', 'failed'],
  verified: [],
  failed: [],
};

function isWriteIntentState(value: string): value is WriteIntentState {
  return (WRITE_INTENT_STATES as readonly string[]).includes(value);
}

/**
 * In-memory intent store with a validated state machine + TTL prune. No
 * persistence and no WHMCS — this only tracks proposed mutations.
 */
export class IntentStore {
  private readonly intents = new Map<string, WriteIntent>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  put(intent: WriteIntent): void {
    this.intents.set(intent.intent_id, intent);
  }

  get(intent_id: string): WriteIntent | undefined {
    return this.intents.get(intent_id);
  }

  /**
   * Move an intent to `nextState` iff the transition is legal for its
   * current state. Throws on an unknown intent or an illegal transition.
   */
  transition(intent_id: string, nextState: WriteIntentState): WriteIntent {
    const current = this.intents.get(intent_id);
    if (current === undefined) {
      throw new Error(`IntentStore: unknown intent_id "${intent_id}"`);
    }
    const target: string = nextState;
    if (!isWriteIntentState(target)) {
      throw new Error(`IntentStore: invalid target state "${target}"`);
    }
    const allowed = TRANSITIONS[current.state];
    if (!allowed.includes(nextState)) {
      throw new Error(
        `IntentStore: illegal transition ${current.state} -> ${nextState}`,
      );
    }
    const next: WriteIntent = { ...current, state: nextState };
    this.intents.set(intent_id, next);
    return next;
  }

  /** Drop intents whose expires_at is in the past. */
  prune(): void {
    const t = this.now();
    for (const [id, intent] of this.intents) {
      if (Date.parse(intent.expires_at) <= t) this.intents.delete(id);
    }
  }
}
