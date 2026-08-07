import { buildCacheKey } from './readCache.js';

export const READ_POLICY_VERSION = 'v1';

export type ReadFreshnessClass = 'reference' | 'short' | 'never';

export interface ReadCachePolicy {
  version: string;
  freshness: ReadFreshnessClass;
  ttlMs: number;
  cacheable: boolean;
  coalescible: boolean;
  tags: readonly string[];
}

const NEVER_CACHE_PATTERNS = /activity|log|admin|stats|health|probe/i;
const SHORT_CACHE_PATTERNS = /client|invoice|ticket|service|hosting|domain|order/i;

function valueTag(name: string, value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const rendered = String(value);
  return rendered.length <= 64 ? `${name}:${rendered}` : undefined;
}

export function cacheTagsFor(
  action: string,
  params: Readonly<Record<string, unknown>>
): readonly string[] {
  const tags = [`action:${action}`];
  for (const name of ['clientid', 'userid', 'invoiceid', 'ticketid', 'serviceid', 'hostingid']) {
    const tag = valueTag(name, params[name]);
    if (tag) tags.push(tag);
  }
  return tags;
}

export function resolveReadCachePolicy(
  action: string,
  params: Readonly<Record<string, unknown>>,
  configuredActions: ReadonlySet<string>,
  configuredTtlMs: number
): ReadCachePolicy {
  const never = NEVER_CACHE_PATTERNS.test(action);
  const configured = configuredActions.has(action);
  const freshness: ReadFreshnessClass = never
    ? 'never'
    : SHORT_CACHE_PATTERNS.test(action)
      ? 'short'
      : 'reference';
  return {
    version: READ_POLICY_VERSION,
    freshness,
    ttlMs: configured && !never ? configuredTtlMs : 0,
    cacheable: configured && configuredTtlMs > 0 && !never,
    // Coalescing is intentionally narrower than "all reads": only the same
    // allowlisted actions whose caching posture has been explicitly configured.
    coalescible: configured && !never,
    tags: cacheTagsFor(action, params),
  };
}

export function buildReadCoordinationKey(
  installation: string,
  action: string,
  params: Readonly<Record<string, unknown>>,
  policyVersion: string,
  rawDataScope: string
): string {
  return `${installation}|${policyVersion}|${rawDataScope}|${buildCacheKey(action, params)}`;
}

/** Known successful mutations invalidate the narrowest provable local tags. */
export function mutationInvalidationTags(
  action: string,
  params: Readonly<Record<string, unknown>>
): readonly string[] | undefined {
  if (!/^(UpdateClient|AddContact|UpdateContact|DeleteContact)$/i.test(action)) return undefined;
  const clientTag = valueTag('clientid', params.clientid ?? params.userid);
  return clientTag ? [clientTag] : undefined;
}
