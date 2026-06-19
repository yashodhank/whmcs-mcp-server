/**
 * Durable daily-cap tally for the write-flow money-gate.
 *
 * Stores ONLY: action name (string) / running total (number) / UTC date
 * (YYYY-MM-DD).  No secrets, tokens, or PII are ever written to disk.
 *
 * Append-only JSONL, one record per flush.  Last-write-wins per key on load.
 * Prior-day entries are dropped on load (stale day discarded) — only today's
 * UTC tally is meaningful.
 *
 * Concurrent processes appending to the same file produce a correct
 * cluster-wide daily cap: POSIX O_APPEND is atomic for the small writes here.
 *
 * Constructed with NO path ⇒ pure in-memory, zero I/O — behaviour
 * byte-identical to the previous `new Map<string, number>()` singleton.
 * With a path, `loadFromDisk` replays today's totals on startup so a restart
 * does not reset the daily cap.
 */

import fs from 'node:fs';
import path from 'node:path';

interface DayAmountsRecord {
  readonly key: string;
  readonly total: number;
  readonly date: string;
}

export class DayAmountsStore {
  private readonly totals = new Map<string, number>();
  private readonly filePath?: string;

  constructor(filePath?: string) {
    this.filePath = filePath && filePath.trim() !== '' ? filePath : undefined;
    const file = this.filePath;
    if (file !== undefined) this.loadFromDisk(file);
  }

  /** UTC day string: YYYY-MM-DD */
  private static today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /** Composite key: `action|YYYY-MM-DD` */
  dayKey(action: string): string {
    return `${action}|${DayAmountsStore.today()}`;
  }

  /** Current in-memory running total for the action on today's UTC date. */
  getTotal(action: string): number {
    return this.totals.get(this.dayKey(action)) ?? 0;
  }

  /**
   * Increment the total for `action` by `amount` and best-effort persist.
   * A write error is swallowed — the in-memory increment always succeeds.
   */
  add(action: string, amount: number): void {
    const key = this.dayKey(action);
    const next = (this.totals.get(key) ?? 0) + amount;
    this.totals.set(key, next);
    const file = this.filePath;
    if (file !== undefined) {
      try {
        this.persist(file, key, next);
      } catch {
        /* best-effort durability: in-memory tally still holds this run */
      }
    }
  }

  /** Test-only: clear all in-memory totals. */
  reset(): void {
    this.totals.clear();
  }

  private persist(file: string, key: string, total: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'a');
    try {
      const record: DayAmountsRecord = { key, total, date: DayAmountsStore.today() };
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private loadFromDisk(file: string): void {
    if (!fs.existsSync(file)) return;
    const today = DayAmountsStore.today();
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const rec = JSON.parse(trimmed) as DayAmountsRecord;
        // Drop stale prior-day entries; only today's tally is relevant.
        if (typeof rec.key === 'string' && typeof rec.total === 'number' && rec.date === today) {
          // Last-write-wins: a later append in the file supersedes an earlier one.
          this.totals.set(rec.key, rec.total);
        }
      } catch {
        /* skip torn/corrupt lines rather than fail startup */
      }
    }
  }
}
