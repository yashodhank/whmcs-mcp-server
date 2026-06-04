/**
 * Tests for src/security/entityOwnership.ts
 *
 * Uses a lightweight mock of WhmcsClient (only the `read` method is
 * required by EntityOwnershipChecker).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  EntityOwnershipChecker,
  EntityOwnershipError,
} from '../../src/security/entityOwnership.js';
import type { WhmcsClient } from '../../src/whmcs/WhmcsClient.js';

/**
 * Minimal mock that satisfies the `read` method used by the checker.
 * Returns the standalone `read` mock alongside the typed client so tests
 * assert on `read` directly (avoids `unbound-method` on a class method ref).
 */
function createMockWhmcs() {
  const read = vi.fn();
  const client = { read } as unknown as WhmcsClient;
  return { client, read };
}

describe('EntityOwnershipChecker', () => {
  let checker: EntityOwnershipChecker;
  let read: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const mock = createMockWhmcs();
    read = mock.read;
    checker = new EntityOwnershipChecker(mock.client);
  });

  // -----------------------------------------------------------------
  // resolveInvoiceOwner
  // -----------------------------------------------------------------
  describe('resolveInvoiceOwner', () => {
    it('should resolve userid from GetInvoice response', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        invoiceid: 101,
        userid: 42,
      });

      const owner = await checker.resolveInvoiceOwner(101);
      expect(owner).toBe(42);
      expect(read).toHaveBeenCalledWith('GetInvoice', { invoiceid: 101 });
    });

    it('should handle string userid by coercing to number', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        invoiceid: 102,
        userid: '55',
      });

      const owner = await checker.resolveInvoiceOwner(102);
      expect(owner).toBe(55);
    });

    it('should return null when API throws (entity not found)', async () => {
      read.mockRejectedValueOnce(new Error('Invoice Not Found'));

      const owner = await checker.resolveInvoiceOwner(999);
      expect(owner).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // resolveTicketOwner
  // -----------------------------------------------------------------
  describe('resolveTicketOwner', () => {
    it('should resolve userid from GetTicket response', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        ticketid: 201,
        userid: 7,
      });

      const owner = await checker.resolveTicketOwner(201);
      expect(owner).toBe(7);
      expect(read).toHaveBeenCalledWith('GetTicket', { ticketid: 201 });
    });

    it('should return null when API throws (entity not found)', async () => {
      read.mockRejectedValueOnce(new Error('Ticket Not Found'));

      const owner = await checker.resolveTicketOwner(999);
      expect(owner).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // assertEntityOwnership
  // -----------------------------------------------------------------
  describe('assertEntityOwnership', () => {
    it('should pass when owner matches the allowed list', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        invoiceid: 101,
        userid: 42,
      });

      await expect(
        checker.assertEntityOwnership('invoice', 101, [42, 55])
      ).resolves.toBeUndefined();
    });

    it('should throw EntityOwnershipError when owner not in allowed list', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        invoiceid: 101,
        userid: 42,
      });

      await expect(checker.assertEntityOwnership('invoice', 101, [99, 100])).rejects.toThrow(
        EntityOwnershipError
      );
    });

    it('should throw EntityOwnershipError when entity not found (null owner)', async () => {
      read.mockRejectedValueOnce(new Error('Invoice Not Found'));

      await expect(checker.assertEntityOwnership('invoice', 999, [42])).rejects.toThrow(
        EntityOwnershipError
      );
    });

    it('should include entity type and id in error message', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        ticketid: 201,
        userid: 7,
      });

      try {
        await checker.assertEntityOwnership('ticket', 201, [99]);
        expect.fail('Expected EntityOwnershipError');
      } catch (err) {
        expect(err).toBeInstanceOf(EntityOwnershipError);
        const error = err as EntityOwnershipError;
        expect(error.name).toBe('EntityOwnershipError');
        expect(error.message).toContain('ticket');
        expect(error.message).toContain('201');
      }
    });
  });

  // -----------------------------------------------------------------
  // Caching
  // -----------------------------------------------------------------
  describe('caching', () => {
    it('should use cached result on second call (no extra read)', async () => {
      read.mockResolvedValueOnce({
        result: 'success',
        invoiceid: 101,
        userid: 42,
      });

      // First call — hits the API
      const first = await checker.resolveInvoiceOwner(101);
      expect(first).toBe(42);
      expect(read).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      const second = await checker.resolveInvoiceOwner(101);
      expect(second).toBe(42);
      expect(read).toHaveBeenCalledTimes(1); // still 1
    });

    it('should cache invoice and ticket independently', async () => {
      read
        .mockResolvedValueOnce({ result: 'success', invoiceid: 101, userid: 42 })
        .mockResolvedValueOnce({ result: 'success', ticketid: 101, userid: 7 });

      const invoiceOwner = await checker.resolveInvoiceOwner(101);
      const ticketOwner = await checker.resolveTicketOwner(101);

      expect(invoiceOwner).toBe(42);
      expect(ticketOwner).toBe(7);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });
});
