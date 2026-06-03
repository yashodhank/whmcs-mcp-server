/**
 * Canonical mapper — WHMCS `GetServers` (optionally enriched with
 * `GetHealthStatus`) server row → Canonical<CanonicalServer>.
 *
 * A server record is OPERATIONAL infrastructure data, not per-customer PII:
 *  - id / serverId → business.identifier
 *  - name / hostname → business.label (display labels for an operator/console)
 *  - ipAddress / assignedIps → system.diagnostic (an internal network detail;
 *    NOT a person's `pii.address`. Diagnostic so it is dropped for LLM/client
 *    contracts but visible to operators — see contracts.ts).
 *  - active / disabled / type / module / status → system.status
 *  - maxAccounts / activeServices / loadPercent → public.safe (aggregate counters)
 *  - statusText (free-form health string) → untrusted.free_text
 *
 * NO secrets are emitted: WHMCS `GetServers` never returns server passwords via
 * this path, and we deliberately do not map any credential-ish field.
 *
 * Canonical entity: the frozen CanonicalEntity union is extended with 'server'
 * (an infrastructure entity). WHMCS list shapes are inconsistent (servers may be
 * a single object, numbers may be strings) — parsed defensively with _shared.
 *
 * See docs/PHASE_B_GOVERNANCE.md §2/§3.
 */
import type { Canonical } from '../governance/types.js';
import { asRecord, str, num, bool, listOf, ClassMapBuilder } from './_shared.js';

export interface CanonicalServer {
  serverId: number | null;
  name: string | null;
  hostname: string | null;
  ipAddress: string | null;
  assignedIps: string | null;
  active: boolean | null;
  disabled: boolean | null;
  type: string | null;
  module: string | null;
  maxAccounts: number | null;
  activeServices: number | null;
  loadPercent: number | null;
  statusText: string | null;
}

const CLASSES = new ClassMapBuilder()
  .set('serverId', 'business.identifier')
  .many(['name', 'hostname'], 'business.label')
  // IPs are an internal network detail, not a person's postal address.
  .many(['ipAddress', 'assignedIps'], 'system.diagnostic')
  .many(['active', 'disabled', 'type', 'module'], 'system.status')
  .many(['maxAccounts', 'activeServices', 'loadPercent'], 'public.safe')
  .set('statusText', 'untrusted.free_text')
  .build();

function mapOne(src: Record<string, unknown>): CanonicalServer {
  return {
    serverId: num(src, 'id') ?? num(src, 'serverid') ?? null,
    name: str(src, 'name') ?? str(src, 'servername') ?? null,
    hostname: str(src, 'hostname') ?? null,
    ipAddress: str(src, 'ipaddress') ?? str(src, 'ip') ?? null,
    assignedIps: str(src, 'assignedips') ?? null,
    active: bool(src, 'active') ?? null,
    disabled: bool(src, 'disabled') ?? null,
    type: str(src, 'type') ?? str(src, 'servertype') ?? null,
    module: str(src, 'module') ?? null,
    maxAccounts:
      num(src, 'maxallowedaccounts') ?? num(src, 'maxaccounts') ?? null,
    activeServices:
      num(src, 'activeservices') ?? num(src, 'noofactiveaccounts') ?? null,
    // WHMCS reports load variously; accept several documented spellings.
    loadPercent:
      num(src, 'percentused') ??
      num(src, 'loadpercent') ??
      num(src, 'load') ??
      null,
    statusText: str(src, 'statusmsg') ?? str(src, 'status') ?? null,
  };
}

export function mapToCanonicalServer(raw: unknown): Canonical<CanonicalServer> {
  return { entity: 'server', data: mapOne(asRecord(raw)), classes: CLASSES };
}

export function mapToCanonicalServers(
  raw: unknown
): Canonical<CanonicalServer>[] {
  const src = asRecord(raw);
  // GetServers nests under servers.server (defensive: single object too).
  // Some builds flatten to a top-level `server` key — accept that too, but
  // never treat the whole response object as a server row.
  const rows = listOf(src.servers, 'server');
  const finalRows = rows.length === 0 ? listOf(src.server, 'server') : rows;
  return finalRows.map((r) => ({
    entity: 'server' as const,
    data: mapOne(r),
    classes: CLASSES,
  }));
}
