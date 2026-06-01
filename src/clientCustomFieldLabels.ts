import { config } from './config.js';
import { normalizeToArray } from './whmcs/normalizers.js';

export interface WhmcsClientCustomFieldRaw {
  id: number;
  name?: string;
  label?: string;
  fieldname?: string;
  value: string;
}

/** Configured env labels override WHMCS-provided names when set. */
export function resolveClientCustomFieldLabel(cf: WhmcsClientCustomFieldRaw): string | null {
  const configured = config.MCP_CLIENT_CUSTOM_FIELD_LABELS[String(cf.id)];
  if (configured) return configured;
  return cf.label ?? cf.name ?? cf.fieldname ?? null;
}

export function mapClientCustomFieldsForLegacy(
  raw: unknown
): { id: number; label: string | null; name: string | null; value: string }[] {
  return normalizeToArray<WhmcsClientCustomFieldRaw>(raw).map((cf) => {
    const label = resolveClientCustomFieldLabel(cf);
    return {
      id: cf.id,
      label,
      name: label,
      value: cf.value,
    };
  });
}
