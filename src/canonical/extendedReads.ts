/**
 * Generic canonical passthrough for extended WHMCS read actions.
 * Keeps field classes conservative (public.safe) until domain packs migrate.
 */

import { asRecord, str, ClassMapBuilder } from './_shared.js';
import type { Canonical } from '../governance/types.js';

const EXTENDED_CLASSES = new ClassMapBuilder().build();

function passthroughEntity(
  entity: Canonical<unknown>['entity'],
  raw: unknown,
  pick?: (src: Record<string, unknown>) => Record<string, unknown>
): Canonical<Record<string, unknown>> {
  const src = asRecord(raw);
  return {
    entity,
    data: pick ? pick(src) : { ...src },
    classes: EXTENDED_CLASSES,
  };
}

export function mapToCanonicalDomainNameservers(raw: unknown): Canonical<Record<string, unknown>> {
  const src = asRecord(raw);
  return passthroughEntity('domain', src, (s) => ({
    domainid: str(s, 'domainid'),
    ns1: str(s, 'ns1'),
    ns2: str(s, 'ns2'),
    ns3: str(s, 'ns3'),
    ns4: str(s, 'ns4'),
    ns5: str(s, 'ns5'),
  }));
}

export function mapToCanonicalDomainLockingStatus(
  raw: unknown
): Canonical<Record<string, unknown>> {
  const src = asRecord(raw);
  return passthroughEntity('domain', src, (s) => ({
    domainid: str(s, 'domainid'),
    lockstatus: str(s, 'lockstatus'),
  }));
}

export function mapToCanonicalTicketNotes(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('ticket', raw);
}

export function mapToCanonicalOrderStatuses(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('order', raw);
}

export function mapToCanonicalPromotions(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('order', raw);
}

export function mapToCanonicalClientsAddons(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('service', raw);
}

export function mapToCanonicalCancelledPackages(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('service', raw);
}

export function mapToCanonicalAffiliates(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('client', raw);
}

export function mapToCanonicalUserPermissions(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('client', raw);
}

export function mapToCanonicalEmailTemplates(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('activity', raw);
}

export function mapToCanonicalAdminUsers(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('activity', raw);
}

export function mapToCanonicalDomainWhoisInfo(raw: unknown): Canonical<Record<string, unknown>> {
  return passthroughEntity('domain', raw);
}
