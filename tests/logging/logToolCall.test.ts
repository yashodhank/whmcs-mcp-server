import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: { MCP_ENV: 'local', MCP_DEBUG: false },
}));

import { businessIdsOnly } from '../../src/logging.js';

describe('businessIdsOnly', () => {
  it('keeps ids and job, drops search/subject', () => {
    expect(
      businessIdsOnly({
        clientid: 9,
        job: 'billing_card',
        search: 'secret query',
        subject: 'ticket body',
        auth_token: 'tok',
      })
    ).toEqual({ clientid: 9, job: 'billing_card' });
  });
});
