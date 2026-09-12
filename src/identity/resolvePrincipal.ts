/**
 * Map a WHMCS User (email / optional clientid) to client records.
 *
 * Production API roles typically deny `GetUsers`. Identity therefore uses
 * allowlisted `GetClients` + `GetClientsDetails` (8.0+ `users` array when
 * present). Never guess a clientid when more than one client matches.
 */

import type { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { asRecord, isRecord, listOf, num, str } from '../canonical/_shared.js';

export interface LinkedClient {
  readonly clientid: number;
  readonly email?: string;
  readonly name?: string;
  readonly status?: string;
  readonly isOwner?: boolean;
}

export interface PrincipalResolution {
  readonly email?: string;
  readonly source: 'get_clients_details' | 'get_clients_search' | 'clientid';
  readonly clients: readonly LinkedClient[];
  readonly picker_required: boolean;
  readonly get_users: 'not_used';
  readonly note: string;
}

const GET_USERS_NOTE =
  'GetUsers is not on the read allowlist for this build (prod role historically not_authorized). Identity uses GetClients / GetClientsDetails. Never guess clientid when picker_required is true.';

function mapClientRecord(raw: Record<string, unknown>): LinkedClient | undefined {
  const clientid = num(raw, 'id') ?? num(raw, 'clientid') ?? num(raw, 'userid');
  if (clientid === undefined) return undefined;
  const first = str(raw, 'firstname') ?? '';
  const last = str(raw, 'lastname') ?? '';
  const name = `${first} ${last}`.trim() || str(raw, 'companyname') || str(raw, 'fullname');
  return {
    clientid,
    email: str(raw, 'email'),
    name: name === '' ? undefined : name,
    status: str(raw, 'status'),
  };
}

function clientsFromDetailsUsers(details: Record<string, unknown>): LinkedClient[] {
  const users = listOf(details.users, 'user');
  const out: LinkedClient[] = [];
  for (const user of users) {
    if (!isRecord(user)) continue;
    const nested = listOf(user.clients, 'client');
    for (const c of nested) {
      if (!isRecord(c)) continue;
      const id = num(c, 'id') ?? num(c, 'clientid');
      if (id === undefined) continue;
      out.push({
        clientid: id,
        isOwner: c.isOwner === true || c.isOwner === 1 || c.isOwner === '1',
        email: str(user, 'email'),
        name: `${str(user, 'firstname') ?? ''} ${str(user, 'lastname') ?? ''}`.trim() || undefined,
      });
    }
  }
  return out;
}

export async function resolvePrincipal(
  whmcs: WhmcsClient,
  input: { email?: string; clientid?: number }
): Promise<PrincipalResolution> {
  const email = input.email?.trim();
  if (email !== undefined && email !== '') {
    return resolveByEmail(whmcs, email);
  }

  if (input.clientid !== undefined) {
    const details = asRecord(
      await whmcs.read('GetClientsDetails', { clientid: input.clientid, stats: false })
    );
    const mapped = mapClientRecord(details);
    const fromUsers = clientsFromDetailsUsers(details);
    const clients = fromUsers.length > 0 ? fromUsers : mapped !== undefined ? [mapped] : [];
    return {
      email: str(details, 'email'),
      source: 'clientid',
      clients,
      picker_required: clients.length !== 1,
      get_users: 'not_used',
      note: GET_USERS_NOTE,
    };
  }

  return {
    source: 'get_clients_search',
    clients: [],
    picker_required: true,
    get_users: 'not_used',
    note: GET_USERS_NOTE,
  };
}

async function resolveByEmail(whmcs: WhmcsClient, email: string): Promise<PrincipalResolution> {
  try {
    const details = asRecord(await whmcs.read('GetClientsDetails', { email, stats: false }));
    const fromUsers = clientsFromDetailsUsers(details);
    const mapped = mapClientRecord(details);
    const clients = fromUsers.length > 0 ? fromUsers : mapped !== undefined ? [mapped] : [];
    if (clients.length > 0) {
      return {
        email,
        source: 'get_clients_details',
        clients,
        picker_required: clients.length !== 1,
        get_users: 'not_used',
        note: GET_USERS_NOTE,
      };
    }
  } catch {
    /* fall through to search */
  }

  const search = asRecord(await whmcs.read('GetClients', { search: email, limitnum: 25 }));
  const rows = listOf(search.clients, 'client');
  const clients: LinkedClient[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const mapped = mapClientRecord(row);
    if (mapped !== undefined) clients.push(mapped);
  }
  return {
    email,
    source: 'get_clients_search',
    clients,
    picker_required: clients.length !== 1,
    get_users: 'not_used',
    note: GET_USERS_NOTE,
  };
}

export function requireSingleClient(
  resolution: PrincipalResolution,
  requestedClientId?: number
): { ok: true; clientid: number } | { ok: false; reason: string; resolution: PrincipalResolution } {
  if (requestedClientId !== undefined) {
    const match = resolution.clients.find((c) => c.clientid === requestedClientId);
    if (match === undefined) {
      return {
        ok: false,
        reason: `clientid ${requestedClientId} is not in the resolved principal's client list`,
        resolution,
      };
    }
    return { ok: true, clientid: requestedClientId };
  }
  if (resolution.clients.length !== 1) {
    return {
      ok: false,
      reason: 'picker_required: supply clientid; never guess among multiple WHMCS clients',
      resolution,
    };
  }
  return { ok: true, clientid: resolution.clients[0].clientid };
}
