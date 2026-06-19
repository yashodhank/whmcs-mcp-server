/**
 * Unit tests for error handling module
 */

import { describe, it, expect } from 'vitest';
import {
  getHumanReadableError,
  getErrorGuidance,
  sanitizeErrorMessage,
  ERROR_CODES,
} from '../src/errors.js';

describe('errors', () => {
  describe('getHumanReadableError', () => {
    it('should add guidance for known error patterns', () => {
      const result = getHumanReadableError('Client Not Found');
      expect(result).toContain('Client Not Found');
      expect(result).toContain('💡 Suggestion:');
      expect(result).toContain('search_clients');
    });

    it('should handle case-insensitive matching', () => {
      const result = getHumanReadableError('ACCESS DENIED');
      expect(result).toContain('💡 Suggestion:');
    });

    it('should return original message for unknown errors', () => {
      const originalMsg = 'Some unknown error';
      expect(getHumanReadableError(originalMsg)).toBe(originalMsg);
    });
  });

  describe('getErrorGuidance', () => {
    it('should return guidance for known patterns', () => {
      const guidance = getErrorGuidance('rate limit exceeded');
      expect(guidance).toBeDefined();
      expect(guidance).toContain('Wait');
    });

    it('should return undefined for unknown patterns', () => {
      expect(getErrorGuidance('unknown xyz error')).toBeUndefined();
    });
  });

  describe('sanitizeErrorMessage', () => {
    it('should redact sensitive patterns', () => {
      const sensitive = 'Error with identifier=secret123 and password=pass456';
      const sanitized = sanitizeErrorMessage(sensitive);
      expect(sanitized).not.toContain('secret123');
      expect(sanitized).not.toContain('pass456');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should preserve non-sensitive content', () => {
      const safe = 'Client 123 not found';
      expect(sanitizeErrorMessage(safe)).toBe(safe);
    });

    it('should redact the WHMCS accesskey query parameter', () => {
      const sensitive = 'Request failed: accesskey=AbC123xyz returned 500';
      const sanitized = sanitizeErrorMessage(sensitive);
      expect(sanitized).not.toContain('AbC123xyz');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact JSON-style credential fields', () => {
      const sensitive =
        'WHMCS error body: {"secret":"sk_live_9f8e7d","identifier":"id_4242","password":"hunter2"}';
      const sanitized = sanitizeErrorMessage(sensitive);
      expect(sanitized).not.toContain('sk_live_9f8e7d');
      expect(sanitized).not.toContain('id_4242');
      expect(sanitized).not.toContain('hunter2');
      expect(sanitized).toContain('[REDACTED]');
    });

    it('should redact Authorization Bearer and Basic headers', () => {
      const bearer = sanitizeErrorMessage(
        'connect failed (Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig)'
      );
      expect(bearer).not.toContain('eyJhbGciOiJIUzI1NiJ9.payload.sig');
      expect(bearer).toContain('[REDACTED]');
      const basic = sanitizeErrorMessage('header Authorization: Basic dXNlcjpwYXNz then EOF');
      expect(basic).not.toContain('dXNlcjpwYXNz');
      expect(basic).toContain('[REDACTED]');
    });
  });

  describe('ERROR_CODES', () => {
    it('should have expected error codes', () => {
      expect(ERROR_CODES.VALIDATION_FAILED).toBe('VALIDATION_FAILED');
      expect(ERROR_CODES.RATE_LIMITED).toBe('RATE_LIMITED');
      expect(ERROR_CODES.MODE_RESTRICTED).toBe('MODE_RESTRICTED');
    });
  });
});
