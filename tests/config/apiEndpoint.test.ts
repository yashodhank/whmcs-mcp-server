/**
 * resolveWhmcsApiEndpoint — tolerant WHMCS endpoint normalization.
 * Regression guard for the 2026-06-19 doubled-path outage (Plan 022): a full-URL
 * WHMCS_API_URL produced /includes/api.php/includes/api.php, which WHMCS 200s but
 * routes to an admin-session handler → "An admin user is required" on every call.
 */
import { describe, it, expect } from 'vitest';
import { resolveWhmcsApiEndpoint } from '../../src/config.js';

const E = 'https://h.example.com/includes/api.php';

describe('resolveWhmcsApiEndpoint', () => {
  it('appends the API path to a bare origin', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com')).toBe(E);
  });
  it('strips a trailing slash then appends', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/')).toBe(E);
  });
  it('strips multiple trailing slashes', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com///')).toBe(E);
  });
  it('does NOT double when the full endpoint is given', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/includes/api.php')).toBe(E);
  });
  it('does NOT double when the full endpoint has a trailing slash', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/includes/api.php/')).toBe(E);
  });
  it('preserves case on an already-full endpoint (no second append)', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/Includes/Api.php')).toBe(
      'https://h.example.com/Includes/Api.php'
    );
  });
  it('trims surrounding whitespace', () => {
    expect(resolveWhmcsApiEndpoint('  https://h.example.com  ')).toBe(E);
  });
  it('preserves a sub-path install (WHMCS not at web root)', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/billing')).toBe(
      'https://h.example.com/billing/includes/api.php'
    );
  });
  it('does not double for a sub-path install already pointing at the endpoint', () => {
    expect(resolveWhmcsApiEndpoint('https://h.example.com/billing/includes/api.php')).toBe(
      'https://h.example.com/billing/includes/api.php'
    );
  });
});
