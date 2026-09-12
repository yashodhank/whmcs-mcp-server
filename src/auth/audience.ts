/**
 * Staff vs customer audience.
 *
 * Audience is derived from the authenticated consumer id and
 * `MCP_STAFF_CONSUMER_IDS`. It is never taken from a tool argument or the
 * model. An empty staff allow-list means nobody is staff (fail closed).
 */

export type JobAudience = 'staff' | 'customer';

export function parseStaffConsumerIds(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
}

export function audienceForConsumer(
  consumerId: string | undefined,
  staffConsumerIds: ReadonlySet<string>
): JobAudience {
  if (consumerId !== undefined && staffConsumerIds.has(consumerId)) return 'staff';
  return 'customer';
}
