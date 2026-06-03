/**
 * Unit tests for billing tools
 * 
 * Tests: get_invoice, mark_invoice_paid, record_refund, capture_payment, create_invoice, add_credit, apply_credit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildDeterministicPaymentTransId,
  buildDeterministicRefundTransId,
} from '../../src/tools/billing.js';

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

describe('Billing Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get_invoice', () => {
    it('should validate invoice IDs are positive integers', () => {
      const { z } = require('zod');
      const invoiceIdSchema = z.number().int().positive('Invoice ID must be positive');

      const getInvoiceSchema = z
        .object({
          invoiceid: invoiceIdSchema
            .or(z.array(invoiceIdSchema).min(1).max(100))
            .optional(),
          invoiceids: z.array(invoiceIdSchema).min(1).max(100).optional(),
        })
        .superRefine((value, ctx) => {
          if (value.invoiceid !== undefined || value.invoiceids !== undefined) {
            return;
          }
          ctx.addIssue({
            code: 'custom',
            message: 'invoiceid or invoiceids is required',
          });
        });

      expect(getInvoiceSchema.safeParse({ invoiceid: 100 }).success).toBe(true);
      expect(getInvoiceSchema.safeParse({ invoiceid: [100, 101, 102] }).success).toBe(true);
      expect(getInvoiceSchema.safeParse({ invoiceids: [100, 101, 102] }).success).toBe(true);
      expect(getInvoiceSchema.safeParse({ invoiceid: 0 }).success).toBe(false);
      expect(getInvoiceSchema.safeParse({ invoiceid: -5 }).success).toBe(false);
      expect(getInvoiceSchema.safeParse({ invoiceid: [] }).success).toBe(false);
      expect(getInvoiceSchema.safeParse({ invoiceids: [] }).success).toBe(false);
      expect(getInvoiceSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('mark_invoice_paid', () => {
    it('should validate invoiceid', () => {
      const { z } = require('zod');
      
      const markInvoicePaidSchema = z.object({
        invoiceid: z.number().int().positive('Invoice ID must be positive'),
        gateway: z.string().optional(),
        transid: z.string().optional(),
        amount: z.number().positive().optional(),
        fees: z.number().nonnegative().optional(),
        date: z.string().optional(),
        send_email: z.boolean().default(false),
      });

      expect(markInvoicePaidSchema.safeParse({ invoiceid: 200 }).success).toBe(true);
      expect(markInvoicePaidSchema.safeParse({ invoiceid: 200, gateway: 'mailin' }).success).toBe(true);
      expect(markInvoicePaidSchema.safeParse({}).success).toBe(false);
    });

    it('generates deterministic synthetic transid for same logical payment payload', () => {
      const a = buildDeterministicPaymentTransId({
        invoiceid: 200,
        gateway: 'stripe',
        amount: 120.5,
        fees: 0,
        date: 'auto',
      });
      const b = buildDeterministicPaymentTransId({
        invoiceid: 200,
        gateway: 'stripe',
        amount: 120.5,
        fees: 0,
        date: 'auto',
      });
      const c = buildDeterministicPaymentTransId({
        invoiceid: 200,
        gateway: 'stripe',
        amount: 121,
        fees: 0,
        date: 'auto',
      });

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith('MCP-PAY-200-')).toBe(true);
    });
  });

  describe('record_refund', () => {
    it('should validate refund parameters', () => {
      const { z } = require('zod');
      
      const recordRefundSchema = z.object({
        invoiceid: z.number().int().positive(),
        amount: z.number().positive('Refund amount must be greater than 0'),
        refund_type: z.enum(['Credit', 'GatewayRecord']),
        reason: z.string().optional(),
        paymentmethod: z.string().optional(),
        apply_to_invoice: z.boolean().default(false),
        confirm_large_refund: z.boolean().optional(),
      });

      // Valid refund
      const validResult = recordRefundSchema.safeParse({
        invoiceid: 100,
        amount: 50.00,
        refund_type: 'Credit',
      });
      expect(validResult.success).toBe(true);

      // Invalid amount (zero)
      const zeroAmount = recordRefundSchema.safeParse({
        invoiceid: 100,
        amount: 0,
        refund_type: 'Credit',
      });
      expect(zeroAmount.success).toBe(false);

      // Invalid amount (negative)
      const negativeAmount = recordRefundSchema.safeParse({
        invoiceid: 100,
        amount: -50,
        refund_type: 'Credit',
      });
      expect(negativeAmount.success).toBe(false);

      // Invalid refund type
      const invalidType = recordRefundSchema.safeParse({
        invoiceid: 100,
        amount: 50,
        refund_type: 'Unknown',
      });
      expect(invalidType.success).toBe(false);
    });

    it('should require confirmation for large refunds', () => {
      const LARGE_REFUND_THRESHOLD = 1000;
      
      function requiresConfirmation(amount: number, confirmed?: boolean): boolean {
        return amount > LARGE_REFUND_THRESHOLD && !confirmed;
      }

      expect(requiresConfirmation(500)).toBe(false);
      expect(requiresConfirmation(1500)).toBe(true);
      expect(requiresConfirmation(1500, true)).toBe(false);
      expect(requiresConfirmation(1000)).toBe(false); // Exactly at threshold
      expect(requiresConfirmation(1001)).toBe(true);
    });

    it('generates deterministic synthetic refund transid for idempotent replay', () => {
      const a = buildDeterministicRefundTransId({
        invoiceid: 100,
        idempotencyKey: 'record_refund:100:12345',
      });
      const b = buildDeterministicRefundTransId({
        invoiceid: 100,
        idempotencyKey: 'record_refund:100:12345',
      });
      const c = buildDeterministicRefundTransId({
        invoiceid: 100,
        idempotencyKey: 'record_refund:100:12346',
      });

      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith('REFUND-100-')).toBe(true);
    });
  });

  describe('capture_payment', () => {
    it('should validate capture parameters', () => {
      const { z } = require('zod');
      
      const capturePaymentSchema = z.object({
        invoiceid: z.number().int().positive(),
        cvv: z.string().optional(),
        force: z.boolean().default(false),
      });

      // Valid capture
      expect(capturePaymentSchema.safeParse({
        invoiceid: 100,
      }).success).toBe(true);

      // With CVV
      expect(capturePaymentSchema.safeParse({
        invoiceid: 100,
        cvv: '123',
      }).success).toBe(true);

      // With force
      const forceResult = capturePaymentSchema.safeParse({
        invoiceid: 100,
        force: true,
      });
      expect(forceResult.success).toBe(true);
      expect(forceResult.data?.force).toBe(true);

      // Default force is false
      const defaultResult = capturePaymentSchema.safeParse({
        invoiceid: 100,
      });
      expect(defaultResult.data?.force).toBe(false);
    });
  });

  describe('create_invoice', () => {
    it('should validate invoice creation parameters', () => {
      const { z } = require('zod');
      
      const createInvoiceSchema = z.object({
        userid: z.number().int().positive(),
        paymentmethod: z.string().optional(),
        sendinvoice: z.boolean().default(false),
        items: z.array(z.object({
          description: z.string(),
          amount: z.number(),
          taxed: z.boolean().default(false),
        })).min(1, 'At least one line item is required'),
      });

      // Valid invoice with items
      const validResult = createInvoiceSchema.safeParse({
        userid: 123,
        items: [
          { description: 'Service Fee', amount: 100 },
          { description: 'Setup Fee', amount: 50, taxed: true },
        ],
      });
      expect(validResult.success).toBe(true);

      // Missing items
      const noItems = createInvoiceSchema.safeParse({
        userid: 123,
        items: [],
      });
      expect(noItems.success).toBe(false);

      // Missing userid
      const noUser = createInvoiceSchema.safeParse({
        items: [{ description: 'Fee', amount: 10 }],
      });
      expect(noUser.success).toBe(false);
    });
  });

  describe('add_credit', () => {
    it('should validate credit parameters', () => {
      const { z } = require('zod');
      
      const addCreditSchema = z.object({
        clientid: z.number().int().positive(),
        amount: z.number().positive('Amount must be positive'),
        description: z.string().default('Credit added via API'),
      });

      // Valid credit
      const validResult = addCreditSchema.safeParse({
        clientid: 123,
        amount: 100,
      });
      expect(validResult.success).toBe(true);
      expect(validResult.data?.description).toBe('Credit added via API');

      // With custom description
      const customDesc = addCreditSchema.safeParse({
        clientid: 123,
        amount: 50,
        description: 'Promotional credit',
      });
      expect(customDesc.data?.description).toBe('Promotional credit');

      // Invalid amount
      expect(addCreditSchema.safeParse({
        clientid: 123,
        amount: -10,
      }).success).toBe(false);
    });
  });

  describe('apply_credit', () => {
    it('should validate apply credit parameters', () => {
      const { z } = require('zod');
      
      const applyCreditSchema = z.object({
        invoiceid: z.number().int().positive(),
        amount: z.number().positive().optional(),
      });

      // Valid with specific amount
      expect(applyCreditSchema.safeParse({
        invoiceid: 100,
        amount: 50,
      }).success).toBe(true);

      // Valid without amount (apply max)
      expect(applyCreditSchema.safeParse({
        invoiceid: 100,
      }).success).toBe(true);

      // Invalid invoiceid
      expect(applyCreditSchema.safeParse({
        invoiceid: 0,
      }).success).toBe(false);
    });
  });
});
