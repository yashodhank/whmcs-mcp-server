/**
 * Canonical mappers — WHMCS ticket OPERATIONAL METADATA.
 *
 *   - GetTicketCounts    → Canonical<CanonicalTicketCounts>
 *   - GetSupportStatuses → Canonical<CanonicalSupportStatuses>
 *
 * Both are GLOBAL/admin operational-metadata reads. They are NOT client-scoped
 * and carry NO per-customer PII — only aggregate counters and the
 * status/department DISPLAY labels an operator sees in the admin support area.
 *
 * Field classification:
 *   - every numeric COUNT  → public.safe   (aggregate counters, never PII)
 *   - every status/department TITLE/LABEL → business.label (a display label,
 *     not a person's name and not generic public metadata — mirrors how
 *     ticket.ts classifies `departmentName`).
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. Ticket operational metadata is closest
 * to the existing 'ticket' entity, so both mappers emit entity: 'ticket'.
 *
 * WHMCS shapes are loosely typed and vary by build (numeric strings, single
 * object vs array, numeric-keyed wrappers). Parsed defensively with _shared.
 * See docs/PHASE_B_GOVERNANCE.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, isRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

/* ───────────────────────────  get_ticket_counts  ──────────────────────────── */

/** One per-status or per-department count row. */
export interface CanonicalTicketCount {
  /** Status title or department label this count is for. */
  label: string | null;
  /** Aggregate count of tickets. */
  count: number | null;
}

export interface CanonicalTicketCounts {
  /** Per-status counts (Open, Answered, …). */
  statuses: CanonicalTicketCount[];
  /** Per-department counts. */
  departments: CanonicalTicketCount[];
  /** Total awaiting-reply / flagged count, when WHMCS reports an aggregate. */
  awaitingReply: number | null;
  /** Grand total of tickets across all statuses, when reported. */
  total: number | null;
}

/**
 * Coerce a loosely-typed WHMCS count value (number, numeric string, or a
 * `{ count: N }` wrapper) into a number, or null when it is not count-shaped.
 */
function countOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (isRecord(value)) {
    return num(value, 'count') ?? num(value, 'tickets') ?? null;
  }
  return null;
}

/**
 * Unwrap a WHMCS count collection that may be:
 *   - a list of rows: [{ title|name, count }, …]   (wrapper key + singular)
 *   - a flat scalar map: { Open: 4, Answered: 2 }
 * into an array of { label, count } rows.
 */
function rowsFrom(
  value: unknown,
  wrapperKey: string,
  singularKey: string
): CanonicalTicketCount[] {
  // Prefer the explicit list shape (wrapperKey → singularKey[]).
  const listSource = isRecord(value) && wrapperKey in value ? value[wrapperKey] : value;
  const rows = listOf(listSource, singularKey);

  const fromRows = rows
    .filter((r) => Object.keys(r).length > 0)
    .map((r) => ({
      label: str(r, 'title') ?? str(r, 'name') ?? str(r, 'status') ?? null,
      count: countOf(r.count) ?? countOf(r.tickets) ?? null,
    }))
    .filter((r) => r.label !== null || r.count !== null);

  if (fromRows.length > 0) {
    return fromRows;
  }

  // Fall back to a flat scalar map: { Open: 4, Answered: "2" }.
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([label, v]) => ({ label, count: countOf(v) }))
      .filter((r) => r.count !== null);
  }

  return [];
}

export function mapToCanonicalTicketCounts(
  raw: unknown
): Canonical<CanonicalTicketCounts> {
  const src = asRecord(raw);

  const statuses = rowsFrom(src.statuses, 'status', 'status');
  const departments = rowsFrom(src.departments, 'department', 'department');

  const data: CanonicalTicketCounts = {
    statuses,
    departments,
    awaitingReply:
      countOf(src.awaitingreply) ??
      countOf(src.awaitingReply) ??
      countOf(src.flagged) ??
      null,
    total: countOf(src.total) ?? countOf(src.totaltickets) ?? null,
  };

  const classes = new ClassMapBuilder()
    // Counters are aggregate, never PII.
    .many(
      ['awaitingReply', 'total', 'statuses[].count', 'departments[].count'],
      'public.safe'
    )
    // Status/department titles are operator DISPLAY labels.
    .many(['statuses[].label', 'departments[].label'], 'business.label')
    // Empty-collection container leaves (when statuses/departments are []).
    .many(['statuses', 'departments'], 'public.safe')
    .build();

  return { entity: 'ticket', data, classes };
}

/* ──────────────────────────  list_support_statuses  ───────────────────────── */

/** One support-status definition: a title and its current ticket count. */
export interface CanonicalSupportStatus {
  title: string | null;
  count: number | null;
}

export interface CanonicalSupportStatuses {
  statuses: CanonicalSupportStatus[];
}

export function mapToCanonicalSupportStatuses(
  raw: unknown
): Canonical<CanonicalSupportStatuses> {
  const src = asRecord(raw);
  // GetSupportStatuses nests under statuses.status (defensive: single object,
  // numeric-keyed wrapper, or a top-level `status` key on some builds).
  const nested = isRecord(src.statuses) || Array.isArray(src.statuses)
    ? src.statuses
    : src.status;
  const rows = listOf(nested, 'status');

  const statuses: CanonicalSupportStatus[] = rows
    .filter((r) => Object.keys(r).length > 0)
    .map((r) => ({
      title: str(r, 'title') ?? str(r, 'name') ?? str(r, 'status') ?? null,
      count: countOf(r.count) ?? countOf(r.tickets) ?? null,
    }))
    .filter((r) => r.title !== null || r.count !== null);

  const classes = new ClassMapBuilder()
    .set('statuses[].title', 'business.label')
    .set('statuses[].count', 'public.safe')
    // Empty-collection container leaf (when statuses is []).
    .set('statuses', 'public.safe')
    .build();

  return { entity: 'ticket', data: { statuses }, classes };
}
