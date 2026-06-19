/**
 * Canonical mapper — WHMCS GetActivityLog row → Canonical<CanonicalActivity>.
 * Also exposes mapToCanonicalActivities for the activity.entry wrapper
 * (numeric-keyed / single-object / empty). COMPLETE; projection later.
 * See docs/design/governance.md §3 (activity/audit lines → system.audit).
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalActivity {
  activityId: number | null;
  clientId: number | null;
  date: string | null;
  user: string | null;
  description: string | null;
  ipAddress: string | null;
}

const CLASSES = new ClassMapBuilder()
  .many(['activityId', 'clientId'], 'business.identifier')
  .many(['date', 'user', 'description', 'ipAddress'], 'system.audit')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalActivity {
  return {
    activityId: num(src, 'id') ?? null,
    clientId: num(src, 'userid') ?? num(src, 'clientid') ?? null,
    date: str(src, 'date') ?? null,
    user: str(src, 'user') ?? null,
    description: str(src, 'description') ?? null,
    ipAddress: str(src, 'ipaddr') ?? str(src, 'ipaddress') ?? null,
  };
}

export function mapToCanonicalActivity(
  raw: unknown
): Canonical<CanonicalActivity> {
  return { entity: 'activity', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalActivities(
  raw: unknown
): Canonical<CanonicalActivity>[] {
  const src = asRecord(raw);
  const rows = listOf(src.activity, 'entry');
  return rows.map((r) => ({
    entity: 'activity' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
