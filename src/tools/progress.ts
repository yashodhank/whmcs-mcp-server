/**
 * Shared MCP progress-notification helper (spec 2025-11-25).
 *
 * Used by the slow fan-out tools — read aggregators (`aggregators.ts`) and the
 * composite write-drafting workflows (`workflows.ts`) — to emit live
 * `notifications/progress` so a client sees forward motion during a multi-second
 * operation instead of a silent wait.
 *
 * DESIGN INVARIANTS (do not weaken — they keep progress a zero-risk add-on):
 *  - FEATURE-DETECT / NO-OP: emits ONLY when the client supplied a
 *    `progressToken` in the request `_meta` AND the transport exposes
 *    `sendNotification`. Absent either, every method is a silent no-op, so the
 *    default path is byte-identical whether or not progress is requested.
 *  - NEVER THROWS: emission is fire-and-forget, wrapped in try/catch (sync) and
 *    a rejection handler (async), so a misbehaving transport can never turn a
 *    tool into a failure.
 *  - NO PII / SECRETS: messages are short labels + counts only.
 */

/**
 * The slice of the SDK `RequestHandlerExtra` (`ToolCallback` 2nd arg) this
 * module needs. Kept as a narrow structural type so we depend only on the two
 * fields we use and stay forward-compatible with the SDK's wider shape.
 */
export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (notification: {
    method: 'notifications/progress';
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<unknown>;
}

/**
 * Cumulative progress emitter. Construct with the expected number of steps
 * (revisable via `setTotal` once a fan-out count is known), then call `step()`
 * per completed unit and `finish()` at the end.
 */
export class ToolProgress {
  private readonly token: string | number | undefined;
  private readonly send: ProgressExtra['sendNotification'] | undefined;
  private done = 0;
  private total: number;

  constructor(total: number, extra?: ProgressExtra) {
    this.total = Math.max(0, total);
    const token = extra?._meta?.progressToken;
    // Feature-detect: only arm when BOTH a token and a sender are present.
    if (
      (typeof token === 'string' || typeof token === 'number') &&
      typeof extra?.sendNotification === 'function'
    ) {
      this.token = token;
      this.send = extra.sendNotification;
    }
  }

  /** True when the client armed progress (token + sender present). */
  get active(): boolean {
    return this.send !== undefined && this.token !== undefined;
  }

  /**
   * Revise the expected total once a dynamic fan-out count is known (e.g. the
   * number of candidates after a portfolio read). Never lowers below work
   * already reported done. No-op when inactive.
   */
  setTotal(total: number): void {
    if (!this.active) return;
    this.total = Math.max(this.done, total);
  }

  /**
   * Mark one unit complete and emit cumulative progress ("label X/total").
   * No-op when inactive; never throws.
   */
  step(label: string): void {
    if (!this.active) return;
    this.done = Math.min(this.done + 1, this.total);
    this.emit(`${label} ${String(this.done)}/${String(this.total)}`);
  }

  /** Alias of {@link step} — reads naturally for fixed-section aggregators. */
  section(label: string): void {
    this.step(label);
  }

  /**
   * Force a terminal `progress === total` ping so the final notification always
   * reports completion. No-op when inactive.
   */
  finish(label = 'complete'): void {
    if (!this.active) return;
    this.done = this.total;
    this.emit(`${label} ${String(this.total)}/${String(this.total)}`);
  }

  private emit(message: string): void {
    if (this.send === undefined || this.token === undefined) return;
    try {
      void Promise.resolve(
        this.send({
          method: 'notifications/progress',
          params: {
            progressToken: this.token,
            progress: this.done,
            total: this.total,
            message,
          },
        })
      ).catch(() => {
        // Swallow async transport errors — progress is best-effort only.
      });
    } catch {
      // Swallow sync throws — progress must never break a tool.
    }
  }
}
