/**
 * Canonical mapper — WHMCS GetToDoItems row → Canonical<CanonicalToDoItem>.
 * Also exposes mapToCanonicalToDoItems for the todoitems.todoitem wrapper
 * (numeric-keyed / single-object / empty). COMPLETE; projection later.
 *
 * GetToDoItems is a GLOBAL/admin read: the staff to-do board, NOT a
 * client-scoped action. The fields are admin-entered and operational.
 *
 * Canonical-entity assumption: the frozen CanonicalEntity union
 * (governance/types.ts) is NOT extended. A to-do item is an admin operational
 * record; the closest frozen entity is 'activity' (an admin/audit-shaped
 * record). The admin-typed `title`/`description` are untrusted free text;
 * `id`/`adminid` are identifiers; `date`/`duedate`/`status` are public.safe.
 * See docs/design/governance.md §3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalToDoItem {
  todoId: number | null;
  adminId: number | null;
  date: string | null;
  title: string | null;
  description: string | null;
  status: string | null;
  dueDate: string | null;
}

const CLASSES = new ClassMapBuilder()
  .many(['todoId', 'adminId'], 'business.identifier')
  .many(['title', 'description'], 'untrusted.free_text')
  .many(['date', 'dueDate', 'status'], 'public.safe')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalToDoItem {
  return {
    todoId: num(src, 'id') ?? null,
    adminId: num(src, 'adminid') ?? num(src, 'admin') ?? null,
    date: str(src, 'date') ?? null,
    title: str(src, 'title') ?? null,
    description: str(src, 'description') ?? null,
    status: str(src, 'status') ?? null,
    dueDate: str(src, 'duedate') ?? null,
  };
}

export function mapToCanonicalToDoItem(
  raw: unknown
): Canonical<CanonicalToDoItem> {
  return { entity: 'activity', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalToDoItems(
  raw: unknown
): Canonical<CanonicalToDoItem>[] {
  const src = asRecord(raw);
  const rows = listOf(src.todoitems, 'todoitem');
  return rows.map((r) => ({
    entity: 'activity' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
