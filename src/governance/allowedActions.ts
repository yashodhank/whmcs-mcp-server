/**
 * Consumer `allowedActions` matching.
 *
 * Empty `allowedActions` remains unrestricted (legacy). A non-empty list is
 * enforced: the required tool, capability id, or WHMCS action must match
 * exactly or via a documented alias. Decorative lists that do not include
 * the invoked surface are denied.
 */

import { CAPABILITY_REGISTRY } from './capabilities.js';
import type { ConsumerProfile } from './types.js';

/** Historical example-registry names → live tool / capability ids. */
const ACTION_ALIASES: Readonly<Partial<Record<string, readonly string[]>>> = {
  list_tickets: ['list_client_tickets', 'GetTickets'],
  list_client_tickets: ['list_tickets', 'GetTickets'],
  get_ticket: ['get_ticket_thread', 'GetTicket'],
  get_ticket_thread: ['get_ticket', 'GetTicket'],
  list_activity_log: ['GetActivityLog'],
  ops_ask: ['ops_ask'],
  mcp_doctor: ['mcp_doctor', 'get_mcp_doctor'],
};

function expand(token: string): Set<string> {
  const out = new Set<string>([token]);
  const aliases = ACTION_ALIASES[token];
  if (aliases !== undefined) {
    for (const alias of aliases) out.add(alias);
  }
  if (Object.hasOwn(CAPABILITY_REGISTRY, token)) {
    const cap = CAPABILITY_REGISTRY[token];
    out.add(cap.capability);
    out.add(cap.action);
  }
  for (const status of Object.values(CAPABILITY_REGISTRY)) {
    if (status.capability === token || status.action === token) {
      out.add(status.capability);
      out.add(status.action);
    }
  }
  return out;
}

/**
 * Whether `requiredAction` is permitted for this profile.
 * Empty `allowedActions` ⇒ unrestricted (legacy). Missing requiredAction ⇒ skip.
 */
export function isActionAllowed(
  profile: ConsumerProfile,
  requiredAction: string | undefined
): boolean {
  if (requiredAction === undefined || requiredAction.trim() === '') return true;
  if (profile.allowedActions.length === 0) return true;
  const needed = expand(requiredAction);
  for (const granted of profile.allowedActions) {
    const have = expand(granted);
    for (const token of needed) {
      if (have.has(token)) return true;
    }
  }
  return false;
}

export function actionDeniedMessage(requiredAction: string, consumerId: string): string {
  return `action denied: consumer '${consumerId}' is not granted '${requiredAction}'`;
}
