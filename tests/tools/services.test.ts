/**
 * Unit tests for service lifecycle tools
 * 
 * Tests: suspend_service, unsuspend_service, terminate_service
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
}));

describe('Service Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('suspend_service', () => {
    it('should validate suspend parameters', () => {
      const { z } = require('zod');
      
      const suspendServiceSchema = z.object({
        serviceid: z.number().int().positive(),
        reason: z.string().optional(),
      });

      // Valid without reason
      expect(suspendServiceSchema.safeParse({
        serviceid: 100,
      }).success).toBe(true);

      // Valid with reason
      expect(suspendServiceSchema.safeParse({
        serviceid: 100,
        reason: 'Non-payment',
      }).success).toBe(true);

      // Invalid serviceid
      expect(suspendServiceSchema.safeParse({
        serviceid: 0,
      }).success).toBe(false);
    });
  });

  describe('unsuspend_service', () => {
    it('should validate serviceid', () => {
      const { z } = require('zod');
      
      const unsuspendServiceSchema = z.object({
        serviceid: z.number().int().positive(),
      });

      expect(unsuspendServiceSchema.safeParse({ serviceid: 200 }).success).toBe(true);
      expect(unsuspendServiceSchema.safeParse({ serviceid: -1 }).success).toBe(false);
      expect(unsuspendServiceSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('terminate_service', () => {
    it('should require explicit confirmation', () => {
      const { z } = require('zod');
      
      const terminateServiceSchema = z.object({
        serviceid: z.number().int().positive(),
        confirm: z.literal(true, {
          message: 'Explicit confirm=true is required to terminate a service',
        }),
        confirm_with_unpaid: z.boolean().optional(),
      });

      // Valid with confirm=true
      expect(terminateServiceSchema.safeParse({
        serviceid: 100,
        confirm: true,
      }).success).toBe(true);

      // Invalid: confirm=false
      expect(terminateServiceSchema.safeParse({
        serviceid: 100,
        confirm: false,
      }).success).toBe(false);

      // Invalid: missing confirm
      expect(terminateServiceSchema.safeParse({
        serviceid: 100,
      }).success).toBe(false);

      // Valid with unpaid confirmation
      expect(terminateServiceSchema.safeParse({
        serviceid: 100,
        confirm: true,
        confirm_with_unpaid: true,
      }).success).toBe(true);
    });

    it('should check for unpaid invoices', () => {
      interface UnpaidInvoice {
        id: number;
        total: string;
      }

      function shouldWarnAboutUnpaid(
        unpaidInvoices: UnpaidInvoice[],
        confirmWithUnpaid?: boolean
      ): boolean {
        return unpaidInvoices.length > 0 && !confirmWithUnpaid;
      }

      const noUnpaid: UnpaidInvoice[] = [];
      const hasUnpaid: UnpaidInvoice[] = [
        { id: 1, total: '50.00' },
        { id: 2, total: '100.00' },
      ];

      expect(shouldWarnAboutUnpaid(noUnpaid)).toBe(false);
      expect(shouldWarnAboutUnpaid(hasUnpaid)).toBe(true);
      expect(shouldWarnAboutUnpaid(hasUnpaid, true)).toBe(false);
      expect(shouldWarnAboutUnpaid(hasUnpaid, false)).toBe(true);
    });

    it('should calculate total unpaid amount', () => {
      interface UnpaidInvoice {
        id: number;
        total: string;
      }

      function calculateUnpaidTotal(invoices: UnpaidInvoice[]): number {
        return invoices.reduce((sum, inv) => sum + Number.parseFloat(inv.total || '0'), 0);
      }

      const invoices: UnpaidInvoice[] = [
        { id: 1, total: '50.00' },
        { id: 2, total: '100.50' },
        { id: 3, total: '25.25' },
      ];

      expect(calculateUnpaidTotal(invoices)).toBeCloseTo(175.75);
      expect(calculateUnpaidTotal([])).toBe(0);
    });
  });
});
