/**
 * Tests for src/security/panScanner.ts
 *
 * Covers Luhn validation, PAN regex matching (with various separators),
 * recursive scanning of nested structures, edge-case rejection, and the
 * assertNoPAN guard.
 */

import { describe, it, expect } from 'vitest';
import {
  isValidLuhn,
  scanForPAN,
  assertNoPAN,
  PANDetectedError,
} from '../../src/security/panScanner.js';

// Well-known test card numbers (all pass Luhn)
const TEST_CARDS = {
  visa: '4111111111111111',
  mastercard: '5500000000000004',
  amex: '378282246310005',
  discover: '6011111111111117',
};

describe('PAN Scanner', () => {
  // -----------------------------------------------------------------
  // Luhn algorithm
  // -----------------------------------------------------------------
  describe('isValidLuhn', () => {
    it('should return true for valid Luhn numbers', () => {
      for (const pan of Object.values(TEST_CARDS)) {
        expect(isValidLuhn(pan), `expected ${pan} to pass Luhn`).toBe(true);
      }
    });

    it('should return false for invalid Luhn numbers', () => {
      // Random 16-digit strings that fail Luhn
      const invalids = [
        '1234567890123456',
        '0000000000000001',
        '9999999999999999',
      ];
      for (const bad of invalids) {
        expect(isValidLuhn(bad), `expected ${bad} to fail Luhn`).toBe(false);
      }
    });

    it('should return false for empty string', () => {
      expect(isValidLuhn('')).toBe(false);
    });
  });

  // -----------------------------------------------------------------
  // scanForPAN
  // -----------------------------------------------------------------
  describe('scanForPAN', () => {
    it('should detect well-known test card numbers', () => {
      for (const pan of Object.values(TEST_CARDS)) {
        const hits = scanForPAN(pan);
        expect(hits).toContain(pan);
      }
    });

    it('should detect PAN with spaces', () => {
      const hits = scanForPAN('4111 1111 1111 1111');
      expect(hits).toContain('4111111111111111');
    });

    it('should detect PAN with dashes', () => {
      const hits = scanForPAN('4111-1111-1111-1111');
      expect(hits).toContain('4111111111111111');
    });

    it('should NOT flag short numbers (< 13 digits)', () => {
      const hits = scanForPAN('123456789012'); // 12 digits
      expect(hits).toHaveLength(0);
    });

    it('should detect PAN embedded in longer text', () => {
      const text = 'Payment with card 4111111111111111 was processed';
      const hits = scanForPAN(text);
      expect(hits).toContain('4111111111111111');
    });

    it('should scan nested objects recursively', () => {
      const data = {
        customer: {
          name: 'Alice',
          payment: {
            cardNumber: '5500000000000004',
            expiry: '12/30',
          },
        },
      };
      const hits = scanForPAN(data);
      expect(hits).toContain('5500000000000004');
    });

    it('should scan arrays recursively', () => {
      const data = ['no card here', ['4111111111111111']];
      const hits = scanForPAN(data);
      expect(hits).toContain('4111111111111111');
    });

    it('should handle non-string values safely (numbers, booleans, null)', () => {
      const data = {
        amount: 99.99,
        active: true,
        meta: null,
        count: 0,
      };
      const hits = scanForPAN(data);
      expect(hits).toHaveLength(0);
    });

    it('should return empty array for undefined input', () => {
      const hits = scanForPAN(undefined);
      expect(hits).toHaveLength(0);
    });

    it('should NOT flag numbers that fail Luhn even if 16 digits', () => {
      const hits = scanForPAN('1234567890123456');
      expect(hits).toHaveLength(0);
    });

    it('should still detect dashed/spaced 16-digit PANs after regex tightening', () => {
      expect(scanForPAN('4111-1111-1111-1111')).toContain('4111111111111111');
      expect(scanForPAN('4111 1111 1111 1111')).toContain('4111111111111111');
    });

    // ---------------------------------------------------------------
    // Bounded scan (DoS amplification guard) — fail-safe, never throws
    // ---------------------------------------------------------------
    it('should not throw and should terminate on a huge separator-heavy string', () => {
      // Adversarial input: lots of digits and separators, far over the cap.
      const adversarial = '1 2 3 4 5 -'.repeat(200_000); // ~2.2M chars
      let hits: string[] = [];
      expect(() => {
        hits = scanForPAN(adversarial);
      }).not.toThrow();
      // No valid Luhn PAN here, so nothing detected — and it must finish.
      expect(hits).toHaveLength(0);
    });

    it('should not throw on extremely deep nesting (fail-safe stop)', () => {
      // Build nesting deeper than MAX_DEPTH; a PAN beyond the depth bound is
      // simply not scanned (fail-safe) rather than causing a throw.
      let nested: unknown = '4111111111111111';
      for (let i = 0; i < 50; i++) {
        nested = { next: nested };
      }
      expect(() => scanForPAN(nested)).not.toThrow();
    });

    it('should still detect a PAN within the depth bound', () => {
      const data = { a: { b: { c: { d: '4111111111111111' } } } };
      expect(scanForPAN(data)).toContain('4111111111111111');
    });
  });

  // -----------------------------------------------------------------
  // assertNoPAN
  // -----------------------------------------------------------------
  describe('assertNoPAN', () => {
    it('should throw PANDetectedError when params contain a valid PAN', () => {
      expect(() =>
        assertNoPAN({ notes: 'card 4111111111111111' })
      ).toThrow(PANDetectedError);
    });

    it('should throw with a safe message that does NOT include the PAN', () => {
      try {
        assertNoPAN({ cc: '5500000000000004' });
        expect.fail('Expected PANDetectedError');
      } catch (err) {
        expect(err).toBeInstanceOf(PANDetectedError);
        const error = err as PANDetectedError;
        expect(error.message).not.toContain('5500000000000004');
        expect(error.message).toContain('credit card number detected');
        expect(error.name).toBe('PANDetectedError');
      }
    });

    it('should NOT throw for clean objects', () => {
      expect(() =>
        assertNoPAN({
          clientid: 123,
          email: 'alice@example.com',
          notes: 'Normal text with no card data',
        })
      ).not.toThrow();
    });

    it('should NOT throw when params are empty', () => {
      expect(() => assertNoPAN({})).not.toThrow();
    });

    it('should detect PAN in deeply nested params', () => {
      expect(() =>
        assertNoPAN({
          level1: {
            level2: {
              level3: ['378282246310005'],
            },
          },
        })
      ).toThrow(PANDetectedError);
    });
  });
});
