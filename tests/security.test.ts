/**
 * Security module tests (SEC-001, SEC-002, SEC-004)
 * - stripAuthFromUri: auth params must not appear in response URIs
 */

import { describe, it, expect } from 'vitest';
import { stripAuthFromUri } from '../src/security.js';

describe('Security', () => {
  describe('stripAuthFromUri', () => {
    it('should remove token query param from URI', () => {
      const uri = new URL('whmcs://clients/123/summary?token=secret123');
      expect(stripAuthFromUri(uri)).toBe('whmcs://clients/123/summary');
    });

    it('should remove auth_token query param from URI', () => {
      const uri = new URL('whmcs://invoices/1/history?auth_token=abc');
      expect(stripAuthFromUri(uri)).toBe('whmcs://invoices/1/history');
    });

    it('should remove both token and auth_token', () => {
      const uri = new URL('whmcs://docs/ops-playbook?token=x&auth_token=y');
      expect(stripAuthFromUri(uri)).toBe('whmcs://docs/ops-playbook');
    });

    it('should preserve other query params', () => {
      const uri = new URL('whmcs://clients/5/summary?token=secret&foo=bar');
      expect(stripAuthFromUri(uri)).toBe('whmcs://clients/5/summary?foo=bar');
    });

    it('should leave URI unchanged when no auth params', () => {
      const uri = new URL('whmcs://system/activity');
      expect(stripAuthFromUri(uri)).toBe('whmcs://system/activity');
    });
  });
});
