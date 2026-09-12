import { describe, it, expect } from 'vitest';
import {
  WRITE_ACTION_CATALOG,
  buildAvailabilityMatrix,
  resolveAvailability,
  type WriteActionMeta,
} from '../../src/write/actionAvailability.js';
import {
  WRITE_SCOPES,
  SCOPE_ACTION,
  SCOPE_RISK,
  DB_DIRECT_ACTION,
  CREDIT_TRANSFER_ACTION,
} from '../../src/write/types.js';
import type { WhmcsVersionFamily } from '../../src/whmcs/versionProfile.js';

describe('WRITE_ACTION_CATALOG', () => {
  it('has an entry for every declared WriteScope', () => {
    for (const scope of WRITE_SCOPES) {
      expect(WRITE_ACTION_CATALOG[scope]).toBeDefined();
      expect(WRITE_ACTION_CATALOG[scope].scope).toBe(scope);
    }
  });

  it('matches SCOPE_ACTION for every scope', () => {
    for (const scope of WRITE_SCOPES) {
      expect(WRITE_ACTION_CATALOG[scope].action).toBe(SCOPE_ACTION[scope]);
    }
  });

  it('matches SCOPE_RISK for every scope', () => {
    for (const scope of WRITE_SCOPES) {
      expect(WRITE_ACTION_CATALOG[scope].risk).toBe(SCOPE_RISK[scope]);
    }
  });

  it('marks billing:billable_item:update as non-existent API', () => {
    const entry = WRITE_ACTION_CATALOG['billing:billable_item:update'];
    expect(entry.whmcs_api_exists).toBe(false);
    expect(entry.api_surface).toBe('none');
    expect(entry.note).toMatch(/not a real WHMCS API action/i);
  });

  it('marks DB_DIRECT_ACTION scopes as db_direct', () => {
    for (const scope of WRITE_SCOPES) {
      if (SCOPE_ACTION[scope] === DB_DIRECT_ACTION) {
        expect(WRITE_ACTION_CATALOG[scope].api_surface).toBe('db_direct');
      }
    }
  });

  it('marks CREDIT_TRANSFER_ACTION scope as custom', () => {
    for (const scope of WRITE_SCOPES) {
      if (SCOPE_ACTION[scope] === CREDIT_TRANSFER_ACTION) {
        expect(WRITE_ACTION_CATALOG[scope].api_surface).toBe('custom');
      }
    }
  });

  it('marks billing:invoice:update as version-gated on 9.x', () => {
    const entry = WRITE_ACTION_CATALOG['billing:invoice:update'];
    expect(entry.unavailable_on).toContain('9.x');
  });

  it('ticket:merge has an informational note about role permissions', () => {
    const entry = WRITE_ACTION_CATALOG['ticket:merge'];
    expect(entry.whmcs_api_exists).toBe(true);
    expect(entry.api_surface).toBe('admin_api');
    expect(entry.note).toMatch(/role/i);
  });
});

describe('resolveAvailability', () => {
  const standardAdminApi: WriteActionMeta = {
    scope: 'client_note:write',
    action: 'AddClientNote',
    risk: 'low',
    api_surface: 'admin_api',
    whmcs_api_exists: true,
    unavailable_on: [],
    note: '',
  };

  const missingApi: WriteActionMeta = {
    scope: 'billing:billable_item:update',
    action: 'UpdateBillableItem',
    risk: 'medium',
    api_surface: 'none',
    whmcs_api_exists: false,
    unavailable_on: [],
    note: 'Not a real API',
  };

  const versionGated: WriteActionMeta = {
    scope: 'billing:invoice:update',
    action: 'UpdateInvoice',
    risk: 'medium',
    api_surface: 'admin_api',
    whmcs_api_exists: true,
    unavailable_on: ['9.x'],
    note: 'Immutable non-draft on 9.x',
  };

  const dbDirect: WriteActionMeta = {
    scope: 'service:transfer_owner',
    action: DB_DIRECT_ACTION,
    risk: 'high',
    api_surface: 'db_direct',
    whmcs_api_exists: true,
    unavailable_on: [],
    note: 'Needs DSN',
  };

  const custom: WriteActionMeta = {
    scope: 'billing:credit:transfer',
    action: CREDIT_TRANSFER_ACTION,
    risk: 'high',
    api_surface: 'custom',
    whmcs_api_exists: true,
    unavailable_on: [],
    note: 'Custom executor',
  };

  it('returns executable for a standard admin API action on 8.13', () => {
    const result = resolveAvailability(standardAdminApi, '8.13');
    expect(result.availability).toBe('executable');
    expect(result.executable).toBe(true);
  });

  it('returns executable for a standard admin API action on unknown', () => {
    const result = resolveAvailability(standardAdminApi, 'unknown');
    expect(result.availability).toBe('executable');
    expect(result.executable).toBe(true);
  });

  it('returns missing_api for non-existent WHMCS API action', () => {
    const result = resolveAvailability(missingApi, '8.13');
    expect(result.availability).toBe('missing_api');
    expect(result.executable).toBe(false);
    expect(result.reason).toMatch(/not a valid WHMCS API action/i);
  });

  it('returns missing_api regardless of version family', () => {
    for (const family of ['8.13', '8.x', '9.x', 'unknown'] as WhmcsVersionFamily[]) {
      const result = resolveAvailability(missingApi, family);
      expect(result.availability).toBe('missing_api');
      expect(result.executable).toBe(false);
    }
  });

  it('returns version_gated on the affected version family', () => {
    const result = resolveAvailability(versionGated, '9.x');
    expect(result.availability).toBe('version_gated');
    expect(result.executable).toBe(false);
  });

  it('returns executable on a non-affected version family', () => {
    const result = resolveAvailability(versionGated, '8.13');
    expect(result.availability).toBe('executable');
    expect(result.executable).toBe(true);
  });

  it('returns executable for version-gated scope when family is unknown', () => {
    const result = resolveAvailability(versionGated, 'unknown');
    expect(result.availability).toBe('executable');
    expect(result.executable).toBe(true);
  });

  it('returns needs_infra for db_direct scopes', () => {
    const result = resolveAvailability(dbDirect, '8.13');
    expect(result.availability).toBe('needs_infra');
    expect(result.executable).toBe(false);
  });

  it('returns needs_infra for custom executor scopes', () => {
    const result = resolveAvailability(custom, '8.13');
    expect(result.availability).toBe('needs_infra');
    expect(result.executable).toBe(false);
  });
});

describe('buildAvailabilityMatrix', () => {
  it('returns an entry for every WRITE_SCOPE', () => {
    const all = new Set<string>(WRITE_SCOPES);
    const matrix = buildAvailabilityMatrix(all, '8.13');
    expect(matrix.length).toBe(WRITE_SCOPES.length);
    for (const entry of matrix) {
      expect(WRITE_SCOPES).toContain(entry.scope);
    }
  });

  it('marks granted scopes correctly', () => {
    const granted = new Set<string>(['client_note:write', 'ticket:create']);
    const matrix = buildAvailabilityMatrix(granted, '8.13');
    const noteEntry = matrix.find((e) => e.scope === 'client_note:write')!;
    const ticketEntry = matrix.find((e) => e.scope === 'ticket:create')!;
    const otherEntry = matrix.find((e) => e.scope === 'billing:invoice:create')!;
    expect(noteEntry.grant_status).toBe('granted');
    expect(ticketEntry.grant_status).toBe('granted');
    expect(otherEntry.grant_status).toBe('not_granted');
  });

  describe('8.13 profile', () => {
    const all = new Set<string>(WRITE_SCOPES);
    const matrix = buildAvailabilityMatrix(all, '8.13');

    it('billable_item:update is granted but missing_api / non-executable', () => {
      const entry = matrix.find((e) => e.scope === 'billing:billable_item:update')!;
      expect(entry.grant_status).toBe('granted');
      expect(entry.availability).toBe('missing_api');
      expect(entry.executable).toBe(false);
    });

    it('billing:invoice:update is executable on 8.13', () => {
      const entry = matrix.find((e) => e.scope === 'billing:invoice:update')!;
      expect(entry.availability).toBe('executable');
      expect(entry.executable).toBe(true);
    });

    it('ticket:merge is executable (role is a separate concern)', () => {
      const entry = matrix.find((e) => e.scope === 'ticket:merge')!;
      expect(entry.availability).toBe('executable');
      expect(entry.executable).toBe(true);
      expect(entry.note).toMatch(/role/i);
    });

    it('service:transfer_owner needs infra', () => {
      const entry = matrix.find((e) => e.scope === 'service:transfer_owner')!;
      expect(entry.availability).toBe('needs_infra');
      expect(entry.executable).toBe(false);
    });
  });

  describe('9.x profile', () => {
    const all = new Set<string>(WRITE_SCOPES);
    const matrix = buildAvailabilityMatrix(all, '9.x');

    it('billing:invoice:update is version-gated on 9.x', () => {
      const entry = matrix.find((e) => e.scope === 'billing:invoice:update')!;
      expect(entry.availability).toBe('version_gated');
      expect(entry.executable).toBe(false);
    });

    it('billable_item:update is still missing_api (not a version delta)', () => {
      const entry = matrix.find((e) => e.scope === 'billing:billable_item:update')!;
      expect(entry.availability).toBe('missing_api');
      expect(entry.executable).toBe(false);
    });

    it('standard scopes remain executable on 9.x', () => {
      const entry = matrix.find((e) => e.scope === 'client_note:write')!;
      expect(entry.availability).toBe('executable');
      expect(entry.executable).toBe(true);
    });
  });

  describe('unknown profile', () => {
    const all = new Set<string>(WRITE_SCOPES);
    const matrix = buildAvailabilityMatrix(all, 'unknown');

    it('version-gated scopes are treated as executable when version is unknown', () => {
      const entry = matrix.find((e) => e.scope === 'billing:invoice:update')!;
      expect(entry.availability).toBe('executable');
      expect(entry.executable).toBe(true);
    });
  });
});
