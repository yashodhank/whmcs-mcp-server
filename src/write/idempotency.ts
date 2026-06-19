/**
 * Phase F — deterministic idempotency keys + a windowed ledger.
 *
 * SAFETY: pure / in-memory. No WHMCS or network calls. The ledger exists to
 * block duplicate execution + replay; it never performs the execution itself.
 *
 * A key is sha256(consumer_id | action | scope | naturalKey | windowBucket).
 * The window bucket folds time into fixed-width slots so two attempts inside
 * the same window collide (deduped) while a later window produces a fresh key.
 *
 * `scope` is part of the material because two distinct write scopes can map to
 * the SAME WHMCS action (e.g. service:price_restore and service:domain_rename
 * both → UpdateClientProduct). Without scope in the key, a price_restore and a
 * domain_rename from the same consumer with the same naturalKey in the same
 * window would collide and the second would be wrongly denied as a replay.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_WINDOW_MS = 5 * 60 * 1000;

/**
 * Deterministic sha256 hex idempotency key.
 *
 * @param consumer_id  the requesting consumer
 * @param action       WHMCS action the intent would call
 * @param scope        write scope (disambiguates scopes sharing one action)
 * @param naturalKey   caller-stable description of the target effect
 * @param windowMs     dedupe window width (defaults to 5 minutes)
 * @param nowMs        injectable clock for the window bucket (testing)
 */
export function idempotencyKey(
  consumer_id: string,
  action: string,
  scope: string,
  naturalKey: string,
  windowMs: number = DEFAULT_WINDOW_MS,
  nowMs: number = Date.now()
): string {
  const width = windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  const bucket = Math.floor(nowMs / width);
  const material = [consumer_id, action, scope, naturalKey, String(bucket)].join(' ');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

interface LedgerEntry {
  readonly result: unknown;
  readonly expiresAt: number;
}

/**
 * Redacted, persistence-safe summary of a prior write result. This is the ONLY
 * result-derived data ever written to the idempotency JSONL. It deliberately
 * omits `params`, `would_call`, and any free-form strings that could carry
 * PII / secrets — it answers "this key already executed before" with the
 * minimum non-sensitive facts a replaying caller needs.
 */
export interface PersistedReplay {
  readonly intent_id: string;
  readonly action: string;
  readonly scope: string;
  readonly executed: boolean;
  readonly verified: boolean;
  readonly at: string;
}

/**
 * Derive a PersistedReplay from a write result using a FIXED field allowlist.
 * Returns undefined when `result` is not a WriteToolResult-shaped object
 * (e.g. the `{ executing: true }` / `{ ok: true }` markers some callers and
 * tests record) — in that case nothing extra is persisted. NEVER spreads the
 * whole object; only the listed fields are read.
 */
export function toPersistedReplay(result: unknown, atIso: string): PersistedReplay | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const r = result as Record<string, unknown>;
  const intent = r.intent;
  if (typeof intent !== 'object' || intent === null) return undefined;
  const i = intent as Record<string, unknown>;
  if (typeof i.intent_id !== 'string') return undefined;
  const exec = r.execution;
  const verified =
    typeof exec === 'object' && exec !== null
      ? (exec as Record<string, unknown>).verified === true
      : false;
  return {
    intent_id: i.intent_id,
    action: typeof i.action === 'string' ? i.action : '',
    scope: typeof i.scope === 'string' ? i.scope : '',
    executed: r.executed === true,
    verified,
    at: atIso,
  };
}

/**
 * Idempotency ledger with per-key windowed expiry and OPTIONAL durable
 * backing. Detects a duplicate/replayed key and recalls the prior result.
 * Pure — never calls WHMCS.
 *
 * Durability: constructed with NO path ⇒ pure in-memory (byte-identical to
 * the legacy ledger; existing call sites/tests unaffected). With a path,
 * `{ key, expiresAt }` plus a REDACTED `PersistedReplay` envelope (intent_id /
 * action / scope / executed / verified / at — never `params`, never
 * `would_call`, never free-form strings) is persisted as JSONL. The raw result
 * payload is NEVER written. Reloaded on startup so a cross-restart replay is
 * both denied AND can recall the safe summary.
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, LedgerEntry>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly filePath?: string;

  constructor(
    windowMs: number = DEFAULT_WINDOW_MS,
    now: () => number = Date.now,
    filePath?: string
  ) {
    this.windowMs = windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
    this.now = now;
    this.filePath = filePath && filePath.trim() !== '' ? filePath : undefined;
    const file = this.filePath;
    if (file !== undefined) this.loadFromDisk(file);
  }

  /** True if the key is recorded and still inside its window. */
  seen(key: string): boolean {
    return this.live(key) !== undefined;
  }

  /** Record a key with the caller's result; (re)starts its window. */
  record(key: string, result: unknown): void {
    const expiresAt = this.now() + this.windowMs;
    this.entries.set(key, { result, expiresAt });
    const file = this.filePath;
    if (file !== undefined) {
      try {
        const replay = toPersistedReplay(result, new Date(this.now()).toISOString());
        this.persist(file, key, expiresAt, replay);
      } catch {
        /* best-effort durability: in-memory dedupe still holds this run */
      }
    }
  }

  /** The recorded result if the key is still live, else undefined. */
  getResult(key: string): unknown {
    return this.live(key)?.result;
  }

  /** Drop every expired entry. */
  prune(): void {
    const t = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= t) this.entries.delete(key);
    }
  }

  private live(key: string): LedgerEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private persist(file: string, key: string, expiresAt: number, replay?: PersistedReplay): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      const record = replay === undefined ? { key, expiresAt } : { key, expiresAt, replay };
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private loadFromDisk(file: string): void {
    if (!fs.existsSync(file)) return;
    const t = this.now();
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as {
          key: string;
          expiresAt: number;
          replay?: PersistedReplay;
        };
        // Last write wins; drop already-expired keys at load.
        if (typeof rec.key === 'string' && rec.expiresAt > t) {
          // Only the redacted replay envelope is ever persisted; the full
          // result is not. Old-format lines have no `replay` ⇒ undefined,
          // identical to legacy behaviour.
          this.entries.set(rec.key, { result: rec.replay, expiresAt: rec.expiresAt });
        }
      } catch {
        /* skip a torn final line rather than fail startup */
      }
    }
  }
}
