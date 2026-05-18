/**
 * Test helper: assert a Canonical<T> classmap covers EVERY leaf path in
 * `data`, with array elements collapsed to `[]` (e.g. `replies[].message`).
 *
 * Completeness is the governance contract — an unclassified emitted path is a
 * B1 defect (it would be treated RESTRICTED downstream and silently dropped).
 */
import { expect } from 'vitest';
import type { Canonical } from '../../src/governance/types.js';

function leafPaths(value: unknown, prefix: string, out: Set<string>): void {
  if (Array.isArray(value)) {
    // Collapse every element under one `[]` path segment.
    if (value.length === 0) {
      out.add(prefix === '' ? '[]' : prefix);
      return;
    }
    for (const el of value) {
      leafPaths(el, prefix === '' ? '[]' : `${prefix}[]`, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      out.add(prefix);
      return;
    }
    for (const k of keys) {
      leafPaths(obj[k], prefix === '' ? k : `${prefix}.${k}`, out);
    }
    return;
  }
  out.add(prefix);
}

export function assertClassmapComplete(c: Canonical<unknown>): void {
  const paths = new Set<string>();
  leafPaths(c.data, '', paths);
  const missing = [...paths].filter(
    (p) => p !== '' && !(p in c.classes)
  );
  expect(missing, `unclassified data paths: ${missing.join(', ')}`).toEqual(
    []
  );
}
