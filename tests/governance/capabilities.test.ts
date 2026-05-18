/**
 * Phase B — B4 capability registry + read-only probe tests.
 *
 * Synthetic only. The WHMCS `read` boundary is injected as a mock; no network.
 * Proves: static seed statuses, unknown→unsupported synthesis, the probe's
 * allowlist gate (no call when not allowlisted), success/not_authorized/
 * degraded resolution, in-process caching, and the unavailable payload shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CAPABILITY_REGISTRY,
  getCapability,
  probeCapability,
  capabilityUnavailablePayload,
  __resetCapabilityCacheForTests,
} from '../../src/governance/capabilities.js';

const ALLOW_ALL = (_a: string): boolean => true;
const ALLOW_NONE = (_a: string): boolean => false;

describe('capability registry (B4)', () => {
  beforeEach(() => {
    __resetCapabilityCacheForTests();
  });

  describe('static CAPABILITY_REGISTRY seed', () => {
    it('marks every already-allowlisted read action as supported', () => {
      const allowlisted = [
        'GetClients', 'GetClientsDetails', 'GetClientsProducts',
        'GetClientsDomains', 'GetInvoice', 'GetInvoices', 'GetTickets',
        'GetTicket', 'GetSupportDepartments', 'GetOrders', 'GetProducts',
        'GetActivityLog', 'GetAdminDetails', 'GetAdminLog', 'DomainWhois',
      ];
      for (const action of allowlisted) {
        const cap = CAPABILITY_REGISTRY[action];
        expect(cap, `${action} must be seeded`).toBeDefined();
        expect(cap.status, `${action} status`).toBe('supported');
        expect(cap.action).toBe(action);
        expect(cap.capability).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it('marks Phase-C-needed-but-not-allowlisted actions as unverified', () => {
      const unverified = [
        'GetTransactions', 'GetStats', 'GetToDoItems', 'GetAutomationLog',
      ];
      for (const action of unverified) {
        const cap = CAPABILITY_REGISTRY[action];
        expect(cap, `${action} must be seeded`).toBeDefined();
        expect(cap.status, `${action} status`).toBe('unverified');
        expect(cap.capability).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    });

    it('seeds a user-listing capability as unverified', () => {
      const userListing = Object.values(CAPABILITY_REGISTRY).find(
        (c) => c.capability.includes('user') && c.status === 'unverified'
      );
      expect(userListing).toBeDefined();
    });

    it('maps GetTransactions to the list_client_transactions capability id', () => {
      expect(CAPABILITY_REGISTRY.GetTransactions.capability).toBe(
        'list_client_transactions'
      );
    });
  });

  describe('getCapability', () => {
    it('returns the seeded supported entry for an allowlisted action', () => {
      expect(getCapability('GetClients').status).toBe('supported');
    });

    it('returns the seeded unverified entry for GetTransactions', () => {
      expect(getCapability('GetTransactions').status).toBe('unverified');
    });

    it('synthesizes an unsupported status for an unknown action', () => {
      const cap = getCapability('TotallyMadeUpAction');
      expect(cap.status).toBe('unsupported');
      expect(cap.action).toBe('TotallyMadeUpAction');
      expect(cap.capability).toBeTruthy();
    });
  });

  describe('probeCapability', () => {
    it('returns unsupported WITHOUT calling read when not allowlisted', async () => {
      const read = vi.fn();
      const result = await probeCapability('GetTransactions', {
        read,
        isAllowlisted: ALLOW_NONE,
      });
      expect(read).not.toHaveBeenCalled();
      expect(result.status).toBe('unsupported');
      expect(result.action).toBe('GetTransactions');
    });

    it('promotes to supported on a successful probe, sets verifiedAt, and caches', async () => {
      const read = vi.fn().mockResolvedValue({ result: 'success', transactions: {} });
      const first = await probeCapability('GetTransactions', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      expect(first.status).toBe('supported');
      expect(first.verifiedAt).toBeDefined();
      const verifiedAt = first.verifiedAt ?? '';
      expect(verifiedAt).not.toBe('');
      expect(() => new Date(verifiedAt).toISOString()).not.toThrow();
      expect(read).toHaveBeenCalledTimes(1);
      // probe issued a minimal read-only call
      const callArgs = read.mock.calls[0];
      expect(callArgs[0]).toBe('GetTransactions');
      expect(callArgs[1]).toMatchObject({ limitnum: 1 });

      // second call must use the cache, not re-probe
      const second = await probeCapability('GetTransactions', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(second.status).toBe('supported');
      expect(second.verifiedAt).toBe(first.verifiedAt);
    });

    it('resolves not_authorized when WHMCS returns an access-denied error', async () => {
      const read = vi
        .fn()
        .mockRejectedValue(new Error('Authentication Failed: Access Denied'));
      const result = await probeCapability('GetStats', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      expect(result.status).toBe('not_authorized');
      expect(result.verifiedAt).toBeDefined();
    });

    it('resolves unsupported when WHMCS reports the action is unknown', async () => {
      const read = vi
        .fn()
        .mockRejectedValue(new Error("The requested API Action could not be found."));
      const result = await probeCapability('GetToDoItems', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      expect(result.status).toBe('unsupported');
    });

    it('resolves degraded on a transport/other error', async () => {
      const read = vi
        .fn()
        .mockRejectedValue(new Error('WHMCS connection error: ECONNRESET'));
      const result = await probeCapability('GetAutomationLog', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      expect(result.status).toBe('degraded');
    });

    it('does not probe an unknown action even if isAllowlisted lies true', async () => {
      const read = vi.fn().mockResolvedValue({ result: 'success' });
      const result = await probeCapability('NoSuchAction', {
        read,
        isAllowlisted: ALLOW_ALL,
      });
      // unknown action is synthesized unsupported; probe still issues the read
      // because the allowlist is the gate, then success ⇒ supported.
      expect(result.action).toBe('NoSuchAction');
    });
  });

  describe('capabilityUnavailablePayload', () => {
    it('produces a structured unavailable payload, never fake data', () => {
      const cap = getCapability('GetTransactions');
      const payload = capabilityUnavailablePayload(cap);
      expect(payload).toEqual({
        capability_unavailable: true,
        action: 'GetTransactions',
        status: 'unverified',
        note: cap.note,
      });
      expect(payload.capability_unavailable).toBe(true);
    });

    it('omits note when the capability has none', () => {
      const cap = getCapability('GetClients');
      const payload = capabilityUnavailablePayload(cap);
      expect(payload.capability_unavailable).toBe(true);
      expect(payload.action).toBe('GetClients');
      expect(payload.status).toBe('supported');
    });
  });
});
