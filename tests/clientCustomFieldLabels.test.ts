import { describe, it, expect, vi, beforeEach } from 'vitest';

const labels = vi.hoisted(() => ({ current: {} as Record<string, string> }));

vi.mock('../src/config.js', () => ({
  config: {
    get MCP_CLIENT_CUSTOM_FIELD_LABELS() {
      return labels.current;
    },
  },
}));

import {
  resolveClientCustomFieldLabel,
  mapClientCustomFieldsForLegacy,
} from '../src/clientCustomFieldLabels.js';

describe('client custom field labels', () => {
  beforeEach(() => {
    labels.current = {};
  });

  it('configured env label overrides WHMCS-provided names', () => {
    labels.current = { '12': 'Tax ID (configured)' };
    expect(
      resolveClientCustomFieldLabel({
        id: 12,
        value: 'x',
        fieldname: 'WHMCS Field Name',
        name: 'WHMCS Name',
        label: 'WHMCS Label',
      })
    ).toBe('Tax ID (configured)');
  });

  it('falls back to WHMCS names when no configured label', () => {
    expect(
      resolveClientCustomFieldLabel({
        id: 12,
        value: 'x',
        fieldname: 'fieldname wins last',
        name: 'name',
        label: 'label',
      })
    ).toBe('label');
  });

  it('maps legacy custom_fields with label and name', () => {
    labels.current = { '3': 'Override' };
    const out = mapClientCustomFieldsForLegacy([
      { id: 3, fieldname: 'Original', value: 'v' },
    ]);
    expect(out).toEqual([{ id: 3, label: 'Override', name: 'Override', value: 'v' }]);
  });
});
