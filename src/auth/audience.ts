/**
 * Staff vs customer audience.
 *
 * Audience is derived from the authenticated consumer id and optional OIDC
 * `sub` against `MCP_STAFF_CONSUMER_IDS` ∪ `MCP_STAFF_OIDC_SUBS`. It is never
 * taken from a tool argument or the model. Empty allow-lists mean nobody is
 * staff (fail closed).
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

export const parseStaffOidcSubs = parseStaffConsumerIds;

export function audienceForPrincipal(
  input: { consumerId?: string; oidcSub?: string },
  staffConsumerIds: ReadonlySet<string>,
  staffOidcSubs: ReadonlySet<string> = new Set()
): JobAudience {
  const consumerId = input.consumerId;
  const oidcSub = input.oidcSub;
  if (consumerId !== undefined && staffConsumerIds.has(consumerId)) return 'staff';
  if (consumerId !== undefined && staffOidcSubs.has(consumerId)) return 'staff';
  if (oidcSub !== undefined && staffOidcSubs.has(oidcSub)) return 'staff';
  return 'customer';
}

export function audienceForConsumer(
  consumerId: string | undefined,
  staffConsumerIds: ReadonlySet<string>
): JobAudience {
  return audienceForPrincipal({ consumerId }, staffConsumerIds);
}
