/**
 * WHMCS event receiver — POST /events/whmcs.
 *
 * Accepts signed JSON payloads from the WHMCS PHP hook addon, verifies the
 * HMAC-SHA256 signature, drops duplicates within a configurable window, and
 * forwards accepted events to a notifier URL (best-effort, async).
 *
 * Security: the HMAC secret comes from env (MCP_EVENT_HMAC_SECRET), never git.
 * The notifier forward is fire-and-forget — a downstream failure never fails
 * the WHMCS hook response after the event is accepted and logged.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../logging.js';

/** Allowlisted event types that the receiver will accept. */
export const ALLOWED_EVENTS: ReadonlySet<string> = new Set([
  'invoice.paid',
  'ticket.opened',
  'service.suspended',
  'module.create_failed',
  'domain.grace_or_expired',
]);

export interface EventPayload {
  readonly event: string;
  readonly timestamp: string;
  readonly event_id: string;
  readonly payload: Record<string, unknown>;
}

const MAX_BODY_BYTES = 256 * 1024; // 256 KiB — hook payloads are tiny

/**
 * Verify HMAC-SHA256 signature. The header format is `sha256=<hex>`.
 * Uses timing-safe comparison to prevent oracle attacks.
 */
export function verifySignature(body: string, signatureHeader: string, secret: string): boolean {
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length);
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
}

export interface DedupStore {
  has(eventId: string): boolean;
  add(eventId: string): void;
}

/**
 * In-memory dedup store with a sliding expiry window.
 * Entries older than `windowMs` are swept lazily.
 */
export function createDedupStore(windowMs: number): DedupStore {
  if (windowMs <= 0) {
    return {
      has: () => false,
      add: (_eventId: string) => {
        /* no-op: dedup disabled */
      },
    };
  }
  const seen = new Map<string, number>();
  let lastSweep = Date.now();

  function sweep(): void {
    const now = Date.now();
    if (now - lastSweep < windowMs / 2) return;
    lastSweep = now;
    const cutoff = now - windowMs;
    for (const [id, ts] of seen) {
      if (ts < cutoff) seen.delete(id);
    }
  }

  return {
    has(eventId: string): boolean {
      sweep();
      return seen.has(eventId);
    },
    add(eventId: string): void {
      seen.set(eventId, Date.now());
    },
  };
}

export interface EventReceiverDeps {
  readonly logger: Logger;
  readonly hmacSecret: string;
  readonly notifierUrl: string;
  readonly dedupWindowMs: number;
}

export interface EventReceiver {
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonResponse(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function forwardToNotifier(url: string, event: EventPayload, logger: Logger): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      logger.warn('Event notifier forward failed', {
        status: resp.status,
        event_type: event.event,
        event_id: event.event_id,
      });
    }
  } catch (err) {
    logger.warn('Event notifier forward error', {
      error: err instanceof Error ? err.message : String(err),
      event_type: event.event,
      event_id: event.event_id,
    });
  }
}

export function createEventReceiver(deps: EventReceiverDeps): EventReceiver {
  const { logger, hmacSecret, notifierUrl, dedupWindowMs } = deps;
  const dedup = createDedupStore(dedupWindowMs);

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST') {
        jsonResponse(res, 405, { error: 'Method not allowed' });
        return;
      }

      if (!hmacSecret) {
        jsonResponse(res, 503, { error: 'Event receiver not configured' });
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readBody(req);
      } catch {
        jsonResponse(res, 413, { error: 'Payload too large' });
        return;
      }

      const sigHeader =
        typeof req.headers['x-mcp-signature'] === 'string'
          ? req.headers['x-mcp-signature']
          : undefined;

      if (!sigHeader || !verifySignature(rawBody, sigHeader, hmacSecret)) {
        jsonResponse(res, 401, { error: 'Invalid signature' });
        return;
      }

      let event: EventPayload;
      try {
        event = JSON.parse(rawBody) as EventPayload;
      } catch {
        jsonResponse(res, 400, { error: 'Invalid JSON' });
        return;
      }

      if (typeof event.event !== 'string' || typeof event.event_id !== 'string') {
        jsonResponse(res, 400, { error: 'Missing required fields' });
        return;
      }

      if (!ALLOWED_EVENTS.has(event.event)) {
        jsonResponse(res, 422, { error: 'Event type not in allowlist' });
        return;
      }

      if (dedup.has(event.event_id)) {
        jsonResponse(res, 200, { status: 'duplicate', event_id: event.event_id });
        return;
      }

      dedup.add(event.event_id);

      logger.info('WHMCS event accepted', {
        event_type: event.event,
        event_id: event.event_id,
      });

      jsonResponse(res, 202, { status: 'accepted', event_id: event.event_id });

      if (notifierUrl) {
        void forwardToNotifier(notifierUrl, event, logger);
      }
    },
  };
}
