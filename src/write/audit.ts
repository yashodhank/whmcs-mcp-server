/**
 * Phase F — append-only, in-memory audit log.
 *
 * SAFETY: pure / in-memory. Records consumer_id, scope, action and the
 * idempotency_key — NEVER tokens or secrets (params are redacted upstream
 * and are not copied into events). No WHMCS contact.
 */

import type { AuditEvent, AuditEventType, WriteIntent } from './types.js';

/** Map an AUDIT_EVENT_TYPE onto the matching intent fields. */
export function auditEvent(
  type: AuditEventType,
  intent: WriteIntent,
  detail?: string,
  at: string = new Date().toISOString(),
): AuditEvent {
  return {
    event: type,
    intent_id: intent.intent_id,
    consumer_id: intent.consumer_id,
    scope: intent.scope,
    action: intent.action,
    idempotency_key: intent.idempotency_key,
    at,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** Append-only audit log. Insertion order is preserved; entries never mutate. */
export class AuditLog {
  private readonly events: AuditEvent[] = [];

  append(event: AuditEvent): void {
    this.events.push(event);
  }

  forIntent(intent_id: string): AuditEvent[] {
    return this.events.filter((e) => e.intent_id === intent_id);
  }

  all(): AuditEvent[] {
    return [...this.events];
  }
}
