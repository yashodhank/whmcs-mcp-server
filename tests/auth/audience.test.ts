import { describe, it, expect } from 'vitest';
import {
  audienceForConsumer,
  audienceForPrincipal,
  parseStaffConsumerIds,
} from '../../src/auth/audience.js';

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

describe('audienceForPrincipal', () => {
  it('staff via OIDC sub even when consumer id is not listed', () => {
    const consumers = parseStaffConsumerIds('');
    const subs = parseStaffConsumerIds('whmcs-user-42');
    expect(
      audienceForPrincipal({ consumerId: 'grok-client', oidcSub: 'whmcs-user-42' }, consumers, subs)
    ).toBe('staff');
    expect(
      audienceForPrincipal({ consumerId: 'grok-client', oidcSub: 'other' }, consumers, subs)
    ).toBe('customer');
  });

  it('never takes audience from a caller-supplied field — only listed ids/subs', () => {
    expect(
      audienceForPrincipal({ consumerId: 'staff', oidcSub: 'staff' }, new Set(), new Set())
    ).toBe('customer');
  });
});
