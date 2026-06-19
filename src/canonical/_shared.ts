/**
 * Shared, dependency-light helpers for the B1 canonical mappers.
 *
 * All accessors take `unknown` and narrow defensively — WHMCS responses are
 * loosely typed (strings for numbers, `{}` for empty arrays, single-object
 * instead of arrays, nested singular wrappers). NO `any` is used anywhere:
 * every value is narrowed from `unknown` before use.
 *
 * See docs/design/governance.md §2/§3 and src/governance/types.ts (frozen).
 */

import { normalizeToArray } from '../whmcs/normalizers.js';
import type { FieldClass, FieldClassMap } from '../governance/types.js';

/** True for a non-null, non-array plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null && typeof value === 'object' && !Array.isArray(value)
  );
}

/** Coerce any WHMCS value to a record we can read, or an empty record. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Read a string-ish field. WHMCS sends numbers/strings/null inconsistently. */
export function str(
  source: Record<string, unknown>,
  key: string
): string | undefined {
  const v = source[key];
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return undefined;
}

/** Read a number-ish field. WHMCS frequently sends numeric strings. */
export function num(
  source: Record<string, unknown>,
  key: string
): number | undefined {
  const v = source[key];
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : undefined;
  }
  if (typeof v === 'string' && v.trim() !== '') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Read a boolean-ish field (WHMCS uses 1/0, "true"/"false", "on"/"off"). */
export function bool(
  source: Record<string, unknown>,
  key: string
): boolean | undefined {
  const v = source[key];
  if (typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'number') {
    return v !== 0;
  }
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(t)) {
      return true;
    }
    if (['0', 'false', 'off', 'no', ''].includes(t)) {
      return false;
    }
  }
  return undefined;
}

/**
 * Unwrap a WHMCS list that may be:
 *   - a proper array
 *   - a numeric-keyed object {"0":..,"1":..}
 *   - an empty object {} / empty array []
 *   - a single object (not wrapped in an array)
 *   - nested under a singular key: { reply: [...] }, { item: {...} }
 *
 * `singularKey` is the WHMCS inner key (reply, item, transaction, …). If the
 * value is a wrapper object exposing that key, we descend into it first.
 */
export function listOf(
  value: unknown,
  singularKey?: string
): Record<string, unknown>[] {
  let target: unknown = value;

  if (
    singularKey !== undefined &&
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, singularKey)
  ) {
    target = value[singularKey];
  }

  return normalizeToArray<unknown>(target).map((entry) => asRecord(entry));
}

/**
 * Builds a FieldClassMap. Construction is additive and the result is frozen;
 * callers MUST classify every path they emit into `data` (completeness is the
 * governance contract — an unmapped path is treated as RESTRICTED downstream).
 */
export class ClassMapBuilder {
  private readonly map: Record<string, FieldClass> = {};

  set(path: string, cls: FieldClass): this {
    this.map[path] = cls;
    return this;
  }

  /** Bulk-assign many paths to one class. */
  many(paths: readonly string[], cls: FieldClass): this {
    for (const p of paths) {
      this.map[p] = cls;
    }
    return this;
  }

  build(): FieldClassMap {
    return Object.freeze({ ...this.map });
  }
}
