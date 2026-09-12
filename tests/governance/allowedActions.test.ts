import { describe, it, expect } from 'vitest';
import { isActionAllowed } from '../../src/governance/allowedActions.js';
import type { ConsumerProfile } from '../../src/governance/types.js';

function profile(actions: string[]): ConsumerProfile {
  return {
    id: 'c1',
    allowedScopes: [],
    defaultContract: 'llm_safe_summary',
    allowedContracts: ['llm_safe_summary'],
    allowedActions: actions,
    writeCapability: 'false',
    envRestrictions: [],
    anonymous: false,
  };
}

describe('isActionAllowed', () => {
  it('empty allowedActions remains unrestricted (legacy)', () => {
    expect(isActionAllowed(profile([]), 'list_client_tickets')).toBe(true);
    expect(isActionAllowed(profile([]), undefined)).toBe(true);
  });

  it('enforces a non-empty list', () => {
    const p = profile(['list_client_tickets', 'ops_ask']);
    expect(isActionAllowed(p, 'list_client_tickets')).toBe(true);
    expect(isActionAllowed(p, 'list_tickets')).toBe(true);
    expect(isActionAllowed(p, 'GetTickets')).toBe(true);
    expect(isActionAllowed(p, 'get_account_360')).toBe(false);
  });

  it('aliases get_ticket → get_ticket_thread', () => {
    expect(isActionAllowed(profile(['get_ticket']), 'get_ticket_thread')).toBe(true);
  });
});
