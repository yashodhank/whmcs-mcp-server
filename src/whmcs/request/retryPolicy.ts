import type { ClassifiedWhmcsError } from './classifier.js';

export const DEFAULT_READ_ATTEMPT_BUDGET = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1000;
export const DEFAULT_BACKOFF_MAX_MS = 10000;

export function shouldRetryRead(
  classified: Readonly<ClassifiedWhmcsError>,
  effect: 'read' | 'write',
  attempt: number,
  attemptBudget: number,
  retryEnabled: boolean
): boolean {
  return (
    effect === 'read' &&
    retryEnabled &&
    classified.retryable &&
    !classified.cancelled &&
    attempt < attemptBudget
  );
}

export function getBackoffDelay(
  completedAttempt: number,
  random: () => number = Math.random
): number {
  const exponentialDelay = DEFAULT_BACKOFF_BASE_MS * Math.pow(2, completedAttempt - 1);
  const jitter = random() * DEFAULT_BACKOFF_BASE_MS;
  return Math.min(exponentialDelay + jitter, DEFAULT_BACKOFF_MAX_MS);
}

export async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('Aborted', 'AbortError');
  }
  await new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(
        signal?.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError')
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
