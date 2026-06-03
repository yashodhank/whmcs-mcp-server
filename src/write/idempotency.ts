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
 * Idempotency ledger with per-key windowed expiry and OPTIONAL durable
 * backing. Detects a duplicate/replayed key and recalls the prior result.
 * Pure — never calls WHMCS.
 *
 * Durability: constructed with NO path ⇒ pure in-memory (byte-identical to
 * the legacy ledger; existing call sites/tests unaffected). With a path, only
 * `{ key, expiresAt }` is persisted as JSONL (NEVER the result payload — it
 * may carry sensitive data, and replay denial only needs the key+window).
 * Reloaded on startup so a replay is still caught across the deploy restart.
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
        this.persist(file, key, expiresAt);
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

  private persist(file: string, key: string, expiresAt: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify({ key, expiresAt }) + '\n');
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
        const rec = JSON.parse(trimmed) as { key: string; expiresAt: number };
        // Last write wins; drop already-expired keys at load.
        if (typeof rec.key === 'string' && rec.expiresAt > t) {
          // result is intentionally not persisted; undefined on reload.
          this.entries.set(rec.key, { result: undefined, expiresAt: rec.expiresAt });
        }
      } catch {
        /* skip a torn final line rather than fail startup */
      }
    }
  }
}
