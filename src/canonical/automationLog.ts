/**
 * Canonical mapper — WHMCS GetAutomationLog entry → Canonical<...Entry>.
 * Also exposes mapToCanonicalAutomationLogEntries for the automationlog.entry
 * wrapper (numeric-keyed / single-object / empty). COMPLETE; projection later.
 *
 * GetAutomationLog is a GLOBAL/admin read: the cron automation history, NOT a
 * client-scoped action. The response carries a `stats` summary plus a list of
 * log entries; the list key/singular vary by WHMCS build so we are tolerant
 * (wrapper key `automationlog`, default singular `entry`).
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. An automation-log entry is an admin
 * operational/audit record → closest frozen entity is 'activity'. The cron
 * `output` line is operational/audit text → system.audit; name/status/times
 * are public.safe; id is a business.identifier.
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalAutomationLogEntry {
  entryId: number | null;
  name: string | null;
  startTime: string | null;
  endTime: string | null;
  status: string | null;
  output: string | null;
}

const CLASSES = new ClassMapBuilder()
  .set('entryId', 'business.identifier')
  .many(['name', 'status', 'startTime', 'endTime'], 'public.safe')
  .set('output', 'system.audit')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalAutomationLogEntry {
  return {
    entryId: num(src, 'id') ?? null,
    name: str(src, 'name') ?? null,
    startTime: str(src, 'starttime') ?? null,
    endTime: str(src, 'endtime') ?? null,
    status: str(src, 'status') ?? null,
    output: str(src, 'output') ?? null,
  };
}

export function mapToCanonicalAutomationLogEntry(
  raw: unknown
): Canonical<CanonicalAutomationLogEntry> {
  return { entity: 'activity', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalAutomationLogEntries(
  raw: unknown
): Canonical<CanonicalAutomationLogEntry>[] {
  const src = asRecord(raw);
  const rows = listOf(src.automationlog, 'entry');
  return rows.map((r) => ({
    entity: 'activity' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
