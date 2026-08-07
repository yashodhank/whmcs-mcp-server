import { NOOP_WHMCS_TELEMETRY, type WhmcsTelemetry } from '../observability/whmcsTelemetry.js';

export interface CoordinatedReadOptions {
  key: string;
  actionClass: 'reference' | 'account' | 'invoice' | 'ticket' | 'probe' | 'other';
  consumerKey?: string;
  signal?: AbortSignal;
  deadlineAt?: number;
  coalesce: boolean;
}

interface QueuedTask<T> {
  run: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  cancelled: boolean;
  actionClass: CoordinatedReadOptions['actionClass'];
  enqueuedAt: number;
}

interface SharedRead<T> {
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}

function deadlineError(): Error {
  const error = new Error('WHMCS request deadline exceeded');
  error.name = 'TimeoutError';
  return error;
}

function cancellationError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('Aborted', 'AbortError');
}

function attachCallerSignal(
  signal: AbortSignal | undefined,
  deadlineAt: number | undefined,
  onAbort: (reason: Error) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => {
    onAbort(cancellationError(signal));
  };
  if (signal?.aborted) queueMicrotask(abort);
  else signal?.addEventListener('abort', abort, { once: true });
  if (deadlineAt !== undefined) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0)
      queueMicrotask(() => {
        onAbort(deadlineError());
      });
    else
      timer = setTimeout(() => {
        onAbort(deadlineError());
      }, remaining);
  }
  return () => {
    signal?.removeEventListener('abort', abort);
    if (timer) clearTimeout(timer);
  };
}

/**
 * Per-installation, fair, abortable scheduler with optional in-flight read
 * coalescing. Mutations are not accepted by this API or its types.
 */
export class ReadCoordinator {
  private readonly maxConcurrency: number;
  private readonly telemetry: WhmcsTelemetry;
  private readonly queues = new Map<string, QueuedTask<unknown>[]>();
  private readonly consumers: string[] = [];
  private readonly inflight = new Map<string, SharedRead<unknown>>();
  private active = 0;
  private cursor = 0;
  private lastConsumer: string | undefined;

  constructor(opts: { maxConcurrency: number; telemetry?: WhmcsTelemetry }) {
    this.maxConcurrency = Math.max(1, Math.floor(opts.maxConcurrency));
    this.telemetry = opts.telemetry ?? NOOP_WHMCS_TELEMETRY;
  }

  run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: CoordinatedReadOptions
  ): Promise<T> {
    if (options.signal?.aborted) return Promise.reject(cancellationError(options.signal));
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
      return Promise.reject(deadlineError());
    }
    if (!options.coalesce) {
      const controller = new AbortController();
      const cleanup = attachCallerSignal(options.signal, options.deadlineAt, (reason) => {
        controller.abort(reason);
      });
      return this.schedule(() => operation(controller.signal), {
        ...options,
        signal: controller.signal,
      }).finally(cleanup);
    }

    const existing = this.inflight.get(options.key) as SharedRead<T> | undefined;
    if (existing) {
      existing.subscribers += 1;
      this.telemetry.record({
        phase: 'coalesce',
        outcome: 'joined',
        effect: 'read',
        actionClass: options.actionClass,
      });
      return this.subscribe(existing, options);
    }

    const controller = new AbortController();
    const shared: SharedRead<T> = {
      controller,
      subscribers: 1,
      settled: false,
      promise: Promise.resolve(undefined as T),
    };
    shared.promise = this.schedule(() => operation(controller.signal), {
      ...options,
      signal: controller.signal,
      deadlineAt: undefined,
    }).finally(() => {
      shared.settled = true;
      this.inflight.delete(options.key);
    });
    this.inflight.set(options.key, shared as SharedRead<unknown>);
    this.telemetry.record({
      phase: 'coalesce',
      outcome: 'started',
      effect: 'read',
      actionClass: options.actionClass,
    });
    return this.subscribe(shared, options);
  }

  private subscribe<T>(shared: SharedRead<T>, options: CoordinatedReadOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void): void => {
        if (finished) return;
        finished = true;
        cleanup();
        shared.subscribers -= 1;
        if (!shared.settled && shared.subscribers === 0) {
          shared.controller.abort(cancellationError(options.signal));
        }
        callback();
      };
      const cleanup = attachCallerSignal(options.signal, options.deadlineAt, (reason) => {
        finish(() => {
          reject(reason);
        });
      });
      shared.promise.then(
        (value) => {
          finish(() => {
            resolve(structuredClone(value));
          });
        },
        (error: unknown) => {
          finish(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        }
      );
    });
  }

  private schedule<T>(operation: () => Promise<T>, options: CoordinatedReadOptions): Promise<T> {
    const consumer = options.consumerKey || 'default';
    return new Promise<T>((resolve, reject) => {
      const task: QueuedTask<T> = {
        run: operation,
        resolve,
        reject,
        signal: options.signal,
        cancelled: false,
        actionClass: options.actionClass,
        enqueuedAt: Date.now(),
      };
      const onAbort = (): void => {
        if (task.cancelled) return;
        task.cancelled = true;
        this.removeQueuedTask(consumer, task as QueuedTask<unknown>);
        task.reject(cancellationError(options.signal));
        this.pump();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const wrappedResolve = task.resolve;
      const wrappedReject = task.reject;
      task.resolve = (value) => {
        options.signal?.removeEventListener('abort', onAbort);
        wrappedResolve(value);
      };
      task.reject = (reason) => {
        options.signal?.removeEventListener('abort', onAbort);
        wrappedReject(reason);
      };
      const queue = this.queues.get(consumer) ?? [];
      queue.push(task as QueuedTask<unknown>);
      this.queues.set(consumer, queue);
      if (!this.consumers.includes(consumer)) this.consumers.push(consumer);
      this.telemetry.record({
        phase: 'queue',
        outcome: 'started',
        effect: 'read',
        actionClass: options.actionClass,
        queueDepth: this.queued,
      });
      this.pump();
    });
  }

  private removeQueuedTask(consumer: string, task: QueuedTask<unknown>): void {
    const queue = this.queues.get(consumer);
    if (queue === undefined) return;
    const taskIndex = queue.indexOf(task);
    if (taskIndex < 0) return;
    queue.splice(taskIndex, 1);
    if (queue.length > 0) return;

    this.queues.delete(consumer);
    const consumerIndex = this.consumers.indexOf(consumer);
    if (consumerIndex < 0) return;
    this.consumers.splice(consumerIndex, 1);
    if (consumerIndex < this.cursor) this.cursor -= 1;
    if (this.consumers.length === 0 || this.cursor >= this.consumers.length) this.cursor = 0;
  }

  private nextTask(): QueuedTask<unknown> | undefined {
    if (this.lastConsumer) {
      const previous = this.consumers.indexOf(this.lastConsumer);
      if (previous >= 0) this.cursor = (previous + 1) % this.consumers.length;
    }
    while (this.consumers.length > 0) {
      this.cursor %= this.consumers.length;
      const consumer = this.consumers[this.cursor];
      const queue = this.queues.get(consumer);
      const task = queue?.shift();
      if (!queue || queue.length === 0) {
        this.queues.delete(consumer);
        this.consumers.splice(this.cursor, 1);
      } else {
        this.cursor = (this.cursor + 1) % this.consumers.length;
      }
      if (!task || task.cancelled || task.signal?.aborted) continue;
      this.lastConsumer = consumer;
      return task;
    }
    return undefined;
  }

  private pump(): void {
    while (this.active < this.maxConcurrency) {
      const task = this.nextTask();
      if (!task) return;
      this.active += 1;
      this.telemetry.record({
        phase: 'queue',
        outcome: 'success',
        effect: 'read',
        actionClass: task.actionClass,
        durationMs: Date.now() - task.enqueuedAt,
        queueDepth: this.queued,
      });
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get queued(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  get inflightCount(): number {
    return this.inflight.size;
  }
}
