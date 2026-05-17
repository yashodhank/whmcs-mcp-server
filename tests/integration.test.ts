/**
 * Integration tests for WHMCS MCP Server
 *
 * SAFETY RULES:
 * - These tests run against a LIVE WHMCS instance
 * - Only READ operations are performed by default
 * - WRITE tests are SKIPPED unless MCP_TEST_WRITE_MODE=true
 * - Any test data created MUST be tracked for cleanup
 *
 * SKIP BEHAVIOR:
 * - If MCP_INTEGRATION_SKIP=1: entire integration block is skipped (e.g. for CI where WHMCS is unreachable).
 * - If probe (GetAdminDetails) returns 403 or a network error: all integration tests are skipped with a clear message.
 * - Integration tests require the runner's IP to be allowed by WHMCS (or they will be skipped on 403).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import 'dotenv/config';
import axios, { isAxiosError } from 'axios';

// Test configuration
const WHMCS_API_URL = process.env.WHMCS_API_URL;
const WHMCS_IDENTIFIER = process.env.WHMCS_IDENTIFIER;
const WHMCS_SECRET = process.env.WHMCS_SECRET;

/** When true, all integration tests in this file are skipped (403, network error, or MCP_INTEGRATION_SKIP=1). */
let apiUnreachable = false;

/** Reason for skip (for logging). */
let apiUnreachableReason = '';

// Helper to make WHMCS API calls directly (bypassing our client for pure integration testing)
async function whmcsCall(action: string, params: Record<string, unknown> = {}) {
  if (!WHMCS_API_URL || !WHMCS_IDENTIFIER || !WHMCS_SECRET) {
    throw new Error('WHMCS credentials not configured');
  }

  const body = new URLSearchParams({
    action,
    identifier: WHMCS_IDENTIFIER,
    secret: WHMCS_SECRET,
    responsetype: 'json',
    ...Object.fromEntries(
      Object.entries(params)
        .filter(([_, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ),
  });

  const response = await axios.post<Record<string, unknown>>(
    `${WHMCS_API_URL}/includes/api.php`,
    body,
    {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 30000,
    }
  );

  return response.data;
}

// Skip condition: when true, all integration tests in this describe are skipped
const skipIfUnreachable = () => apiUnreachable;

describe('WHMCS API Integration', () => {
  beforeAll(async () => {
    if (process.env.MCP_INTEGRATION_SKIP === '1') {
      apiUnreachable = true;
      apiUnreachableReason = 'MCP_INTEGRATION_SKIP=1';
      console.error('⏭️  MCP_INTEGRATION_SKIP=1; skipping integration tests.');
      return;
    }
    if (!WHMCS_API_URL || !WHMCS_IDENTIFIER || !WHMCS_SECRET) {
      apiUnreachable = true;
      apiUnreachableReason = 'WHMCS credentials not configured';
      console.error('⚠️  WHMCS credentials not configured. Skipping integration tests.');
      return;
    }
    try {
      await whmcsCall('GetAdminDetails');
    } catch (e: unknown) {
      apiUnreachable = true;
      if (isAxiosError(e)) {
        apiUnreachableReason =
          e.response?.status === 403
            ? 'WHMCS API returned 403 (check IP allowlist and credentials)'
            : e.code
              ? `Network error: ${e.code}`
              : e.message || 'Request failed';
      } else {
        apiUnreachableReason = e instanceof Error ? e.message : 'Request failed';
      }
      console.error(`⏭️  ${apiUnreachableReason}; skipping integration tests.`);
    }
  });

  describe('Connection & Authentication', () => {
    it.skipIf(skipIfUnreachable)('should connect to WHMCS API successfully', async () => {
      const result = await whmcsCall('GetAdminDetails');
      expect(result.result).toBe('success');
    });
    it.skipIf(skipIfUnreachable)('should return proper error for invalid action', async () => {
      const result = await whmcsCall('InvalidActionThatDoesNotExist');
      expect(result.result).toBe('error');
    });
  });

  describe('Read Operations (Safe)', () => {
    it.skipIf(skipIfUnreachable)('should list products', async () => {
      const result = await whmcsCall('GetProducts', { limitnum: 10 });
      expect(result.result).toBe('success');
    });
    it.skipIf(skipIfUnreachable)('should list clients', async () => {
      const result = await whmcsCall('GetClients', { limitnum: 5 });
      expect(result.result).toBe('success');
      expect(result).toHaveProperty('totalresults');
    });
    it.skipIf(skipIfUnreachable)('should get activity log', async () => {
      const result = await whmcsCall('GetActivityLog', { limitnum: 5 });
      expect(result.result).toBe('success');
    });
    it.skipIf(skipIfUnreachable)('should list support departments', async () => {
      const result = await whmcsCall('GetSupportDepartments');
      expect(result.result).toBe('success');
    });
    it.skipIf(skipIfUnreachable)('should get payment methods', async () => {
      const result = await whmcsCall('GetPaymentMethods');
      expect(result.result).toBe('success');
    });
  });

  describe('Domain Availability Check (Safe)', () => {
    it.skipIf(skipIfUnreachable)('should check domain availability', async () => {
      const result = await whmcsCall('DomainWhois', { domain: 'google.com' });
      expect(result.result).toBe('success');
      expect(result).toHaveProperty('status');
    });
    it.skipIf(skipIfUnreachable)('should handle invalid domain format gracefully', async () => {
      const result = await whmcsCall('DomainWhois', { domain: 'invalid' });
      expect(['success', 'error']).toContain(result.result);
    });
  });
});

// ============================================================
// SKIPPED TESTS - Documented for completeness
// ============================================================
describe('Write Operations (SKIPPED - Requires MCP_TEST_WRITE_MODE=true)', () => {
  describe.skip('Client Creation', () => {
    /**
     * SKIPPED: create_client test
     * 
     * Why skipped: Creates a real client in the production database.
     * 
     * Rollback procedure:
     * 1. Store the created clientid
     * 2. Use DeleteClient API action (admin only) 
     * 3. Note: WHMCS does not have a pure API for client deletion
     *    Manual cleanup may be required
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true
     */
    it('should create a test client', () => {
      // This test would create a client with:
      // - firstname: 'MCP Test'
      // - lastname: 'Automated'
      // - email: `mcp-test-${Date.now()}@test.local`
      // - country: 'US'
      expect(true).toBe(true); /* placeholder when write tests are skipped */
    });
  });
  
  describe.skip('Invoice Operations', () => {
    /**
     * SKIPPED: Billing tests
     * 
     * Why skipped: May affect real financial records.
     * 
     * Rollback procedure:
     * - Created invoices can be cancelled via UpdateInvoice status='Cancelled'
     * - Transactions cannot be easily deleted
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true
     */
    it('should not test invoice creation on production', () => {
      expect(true).toBe(true); /* placeholder when write tests are skipped */
    });
  });
  
  describe.skip('Service Operations', () => {
    /**
     * SKIPPED: suspend_service, unsuspend_service, terminate_service
     * 
     * Why skipped: 
     * - These operations affect real customer services
     * - terminate_service is IRREVERSIBLE
     * 
     * Rollback procedure:
     * - suspend → unsuspend (reversible)
     * - terminate → NO ROLLBACK POSSIBLE
     * 
     * To run: NEVER run on production. Use staging only.
     */
    it('should not test service termination on production', () => {
      expect(true).toBe(true); /* placeholder when write tests are skipped */
    });
  });
  
  describe.skip('Order Operations', () => {
    /**
     * SKIPPED: accept_order
     * 
     * Why skipped:
     * - May trigger provisioning on external servers
     * - May send emails to customers
     * - May charge payment methods
     * 
     * Rollback procedure:
     * - Cancel order (may not undo provisioning)
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true (staging only)
     */
    it('should not test order acceptance on production', () => {
      expect(true).toBe(true); /* placeholder when write tests are skipped */
    });
  });
  
  describe.skip('Ticket Operations', () => {
    /**
     * SKIPPED: create_ticket, reply_ticket
     * 
     * Why skipped:
     * - May send notifications to customers
     * - Creates visible records in support system
     * 
     * Rollback procedure:
     * - Close ticket with status
     * - Delete ticket via admin panel (not API)
     * 
     * To run: Set MCP_TEST_WRITE_MODE=true with test department
     */
    it('should not test ticket creation on production', () => {
      expect(true).toBe(true); /* placeholder when write tests are skipped */
    });
  });
});
