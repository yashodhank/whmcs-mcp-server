import { describe, it, expect } from 'vitest';
import { audienceForConsumer, parseStaffConsumerIds } from '../../src/auth/audience.js';

describe('audienceForConsumer', () => {
  it('fail-closed: empty allow-list is never staff', () => {
    expect(audienceForConsumer('operator-reconcile', new Set())).toBe('customer');
    expect(audienceForConsumer(undefined, parseStaffConsumerIds(''))).toBe('customer');
  });

  it('staff only when consumer id is listed', () => {
    const ids = parseStaffConsumerIds('operator-reconcile, billing_app');
    expect(audienceForConsumer('operator-reconcile', ids)).toBe('staff');
    expect(audienceForConsumer('llm_chat', ids)).toBe('customer');
  });
});
