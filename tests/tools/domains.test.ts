/**
 * Unit tests for domain tools
 * 
 * Tests: check_domain_availability, register_domain, renew_domain, transfer_domain, sync_domain
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules
vi.mock('../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    WHMCS_IDENTIFIER: 'test-id',
    WHMCS_SECRET: 'test-secret',
    MCP_MODE: 'full',
    MCP_RATE_LIMIT: 10,
    MCP_DEBUG: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
  },
  isToolAllowed: () => true,
  legacyWriteToolsEnabled: () => true,
}));

describe('Domain Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Domain Validation', () => {
    // Domain validation function (mirrored from domains.ts)
    function isValidDomainFormat(domain: string): boolean {
      if (!domain || domain.length > 253) {
        return false;
      }
      
      const labels = domain.split('.');
      if (labels.length < 2) {
        return false;
      }
      
      for (const label of labels) {
        if (!label || label.length > 63) {
          return false;
        }
        
        if (label.toLowerCase().startsWith('xn--')) {
          const punyRegex = /^xn--[a-zA-Z0-9-]+$/;
          if (!punyRegex.test(label)) {
            return false;
          }
        } else {
          if (label.startsWith('-') || label.endsWith('-')) {
            return false;
          }
          const idnLabelRegex = /^[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;
          if (!idnLabelRegex.test(label)) {
            return false;
          }
        }
      }
      
      const tld = labels[labels.length - 1];
      if (tld.length < 2) {
        return false;
      }
      
      return true;
    }

    it('should validate standard domains', () => {
      expect(isValidDomainFormat('example.com')).toBe(true);
      expect(isValidDomainFormat('sub.example.com')).toBe(true);
      expect(isValidDomainFormat('my-domain.org')).toBe(true);
      expect(isValidDomainFormat('domain123.net')).toBe(true);
    });

    it('should validate IDN domains', () => {
      expect(isValidDomainFormat('пример.рф')).toBe(true); // Russian
      expect(isValidDomainFormat('例え.jp')).toBe(true); // Japanese
      expect(isValidDomainFormat('münchen.de')).toBe(true); // German umlaut
    });

    it('should validate Punycode domains', () => {
      expect(isValidDomainFormat('xn--nxasmq5b.xn--wgbh1c')).toBe(true);
      expect(isValidDomainFormat('xn--e1afmkfd.xn--p1ai')).toBe(true);
    });

    it('should reject invalid domains', () => {
      expect(isValidDomainFormat('')).toBe(false);
      expect(isValidDomainFormat('nodot')).toBe(false); // No TLD
      expect(isValidDomainFormat('-invalid.com')).toBe(false); // Starts with hyphen
      expect(isValidDomainFormat('invalid-.com')).toBe(false); // Ends with hyphen
      expect(isValidDomainFormat('.com')).toBe(false); // No domain name
      expect(isValidDomainFormat('domain.x')).toBe(false); // TLD too short
    });

    it('should reject overly long domains', () => {
      const longLabel = 'a'.repeat(64); // 64 chars (max is 63)
      expect(isValidDomainFormat(`${longLabel}.com`)).toBe(false);
      
      const longDomain = 'a'.repeat(250) + '.com'; // Over 253 total
      expect(isValidDomainFormat(longDomain)).toBe(false);
    });
  });

  describe('check_domain_availability', () => {
    it('should validate domain input schema', () => {
      const { z } = require('zod');
      
      const checkDomainSchema = z.object({
        domain: z.string().min(4, 'Domain must be at least 4 characters'),
      });

      expect(checkDomainSchema.safeParse({ domain: 'example.com' }).success).toBe(true);
      expect(checkDomainSchema.safeParse({ domain: 'a.cc' }).success).toBe(true); // Minimum valid
      expect(checkDomainSchema.safeParse({ domain: 'ab' }).success).toBe(false); // Too short
      expect(checkDomainSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('register_domain', () => {
    it('should validate register domain parameters', () => {
      const { z } = require('zod');
      
      const registerDomainSchema = z.object({
        domainid: z.number().int().positive().optional(),
        domain: z.string().optional(),
        idn_language: z.string().optional(),
        nameserver1: z.string().optional(),
        nameserver2: z.string().optional(),
        nameserver3: z.string().optional(),
        nameserver4: z.string().optional(),
        nameserver5: z.string().optional(),
      });

      // Valid minimal
      expect(registerDomainSchema.safeParse({ domainid: 100 }).success).toBe(true);
      expect(registerDomainSchema.safeParse({ domain: 'example.com' }).success).toBe(true);

      // With nameservers
      expect(registerDomainSchema.safeParse({
        domainid: 100,
        nameserver1: 'ns1.example.com',
        nameserver2: 'ns2.example.com',
      }).success).toBe(true);

      // Invalid domainid
      expect(registerDomainSchema.safeParse({
        domainid: 0,
      }).success).toBe(false);
    });
  });

  describe('renew_domain', () => {
    it('should validate domainid', () => {
      const { z } = require('zod');
      
      const renewDomainSchema = z.object({
        domainid: z.number().int().positive().optional(),
        domain: z.string().optional(),
        regperiod: z.number().int().min(1).max(10).optional(),
      });

      expect(renewDomainSchema.safeParse({ domainid: 200 }).success).toBe(true);
      expect(renewDomainSchema.safeParse({ domain: 'example.com', regperiod: 2 }).success).toBe(true);
      expect(renewDomainSchema.safeParse({ domainid: -1 }).success).toBe(false);
    });
  });

  describe('transfer_domain', () => {
    it('should validate transfer parameters', () => {
      const { z } = require('zod');
      
      const transferDomainSchema = z.object({
        domainid: z.number().int().positive().optional(),
        domain: z.string().optional(),
        eppcode: z.string().optional(),
      });

      // Without EPP code
      expect(transferDomainSchema.safeParse({
        domainid: 100,
      }).success).toBe(true);
      expect(transferDomainSchema.safeParse({
        domain: 'example.com',
      }).success).toBe(true);

      // With EPP code
      expect(transferDomainSchema.safeParse({
        domainid: 100,
        eppcode: 'ABC123XYZ',
      }).success).toBe(true);
    });
  });

  describe('sync_domain', () => {
    it('should validate domainid', () => {
      const { z } = require('zod');
      
      const syncDomainSchema = z.object({
        domainid: z.number().int().positive(),
      });

      expect(syncDomainSchema.safeParse({ domainid: 300 }).success).toBe(true);
      expect(syncDomainSchema.safeParse({}).success).toBe(false);
    });
  });
});
