/**
 * Lazy WHMCS version probe via WhmcsDetails.
 *
 * Classifies the install as 8.13.x, other 8.x, or 9.x+. Cached in-process for
 * 15 minutes; used by write validation advisories and the capability matrix.
 * Does not block startup unless the caller opts into strict healthcheck elsewhere.
 */

import type { WhmcsClient } from './WhmcsClient.js';
import { asRecord, str } from '../canonical/_shared.js';

export type WhmcsVersionFamily = '8.13' | '8.x' | '9.x' | 'unknown';

export interface WhmcsVersionProfile {
  readonly family: WhmcsVersionFamily;
  readonly version: string | null;
  readonly release: string | null;
  readonly probedAt: string;
}

const CACHE_TTL_MS = 15 * 60 * 1000;

let cached: { profile: WhmcsVersionProfile; expiresAtMs: number } | undefined;

function parseFamily(version: string | null): WhmcsVersionFamily {
  if (version === null || version.trim() === '') {
    return 'unknown';
  }
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (major >= 9) return '9.x';
  if (major === 8) {
    if (/^8\.13(?:\.|$)/.test(version)) return '8.13';
    return '8.x';
  }
  return 'unknown';
}

function extractVersion(raw: unknown): { version: string | null; release: string | null } {
  const src = asRecord(raw);
  const whmcs = 'whmcs' in src ? asRecord(src.whmcs) : src;
  return {
    version: str(whmcs, 'version') ?? null,
    release: str(whmcs, 'canonicalversion') ?? str(whmcs, 'release') ?? null,
  };
}

/** Reset module cache. Test-only. */
export function _resetVersionProfileCacheForTests(): void {
  cached = undefined;
}

/**
 * Return a cached version profile, probing WhmcsDetails on first need.
 * Probe failures yield `family: 'unknown'` without throwing.
 */
export async function getWhmcsVersionProfile(
  client: WhmcsClient,
  now: () => number = Date.now
): Promise<WhmcsVersionProfile> {
  const t = now();
  if (cached !== undefined && t < cached.expiresAtMs) {
    return cached.profile;
  }

  let version: string | null = null;
  let release: string | null = null;
  try {
    const raw = await client.read<Record<string, unknown>>('WhmcsDetails', {});
    ({ version, release } = extractVersion(raw));
  } catch {
    /* fail-soft — unknown family */
  }

  const profile: WhmcsVersionProfile = {
    family: parseFamily(version),
    version,
    release,
    probedAt: new Date(t).toISOString(),
  };
  cached = { profile, expiresAtMs: t + CACHE_TTL_MS };
  return profile;
}

export function isAtLeast9(profile: WhmcsVersionProfile): boolean {
  return profile.family === '9.x';
}

export function is813(profile: WhmcsVersionProfile): boolean {
  return profile.family === '8.13';
}
