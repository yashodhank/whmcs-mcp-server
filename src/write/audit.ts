/**
 * Phase G+ — append-only audit log with optional durable JSONL backing.
 *
 * SAFETY: records consumer_id, scope, action and the idempotency_key — NEVER
 * tokens, secrets or PII (params are redacted upstream and are not copied into
 * events). No WHMCS contact.
 *
 * Durability: constructed with NO path ⇒ pure in-memory (byte-identical to the
 * legacy behaviour; existing call sites/tests unaffected). Constructed WITH a
 * path ⇒ events are also appended to a JSONL file and reloaded on startup so
 * the trail survives the MCP restart that deploying a write change requires.
 *
 *   - `append`      : in-memory + best-effort durable line (errors swallowed;
 *                     used for non-critical lifecycle events).
 *   - `appendDurable`: persist-or-THROW, then in-memory. Used at the
 *                     production execution commit point so an unauditable
 *                     production mutation fails CLOSED.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { AuditEvent, AuditEventType, WriteIntent } from './types.js';

/** Map an AUDIT_EVENT_TYPE onto the matching intent fields. */
export function auditEvent(
  type: AuditEventType,
  intent: WriteIntent,
  detail?: string,
  at: string = new Date().toISOString()
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

/** Raised when a durable audit write fails (drives fail-closed execution). */
export class AuditPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditPersistError';
  }
}

/** Append-only audit log. Insertion order is preserved; entries never mutate. */
export class AuditLog {
  private readonly events: AuditEvent[] = [];
  private readonly filePath?: string;

  /** @param filePath optional JSONL path; absent ⇒ pure in-memory. */
  constructor(filePath?: string) {
    this.filePath = filePath && filePath.trim() !== '' ? filePath : undefined;
    const file = this.filePath;
    if (file !== undefined) this.loadFromDisk(file);
  }

  /** In-memory append + best-effort durable line (persist errors swallowed). */
  append(event: AuditEvent): void {
    this.events.push(event);
    const file = this.filePath;
    if (file !== undefined) {
      try {
        this.persist(file, event);
      } catch {
        /* best-effort: non-critical lifecycle events must never throw */
      }
    }
  }

  /**
   * Durable append: persist FIRST (throws AuditPersistError on failure), then
   * record in memory. Use before committing a production mutation so an
   * unauditable write is refused (fail-closed).
   */
  appendDurable(event: AuditEvent): void {
    const file = this.filePath;
    if (file !== undefined) {
      try {
        this.persist(file, event);
      } catch (e) {
        throw new AuditPersistError(
          `durable audit write failed: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
    this.events.push(event);
  }

  forIntent(intent_id: string): AuditEvent[] {
    return this.events.filter((e) => e.intent_id === intent_id);
  }

  all(): AuditEvent[] {
    return [...this.events];
  }

  private persist(file: string, event: AuditEvent): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(event) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private loadFromDisk(file: string): void {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        this.events.push(JSON.parse(trimmed) as AuditEvent);
      } catch {
        /* skip a torn final line rather than fail startup */
      }
    }
  }
}
