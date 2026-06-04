/**
 * Entity Ownership IDOR (Insecure Direct Object Reference) Protection.
 *
 * In client-scoped MCP mode, every entity access must be ownership-checked
 * to prevent one client from reading or modifying another client's
 * invoices / tickets / etc.  This module resolves entity→owner mappings
 * via the WHMCS API and caches them for the process lifetime so repeated
 * lookups for the same entity do not hit the backend again.
 */

import type { WhmcsClient } from '../whmcs/WhmcsClient.js';

/**
 * Custom error thrown when an entity does not belong to any of the
 * allowed client IDs.
 */
export class EntityOwnershipError extends Error {
  override readonly name = 'EntityOwnershipError';

  constructor(entityType: string, entityId: number) {
    super(`Access denied: ${entityType} ${entityId} does not belong to the allowed client scope`);
  }
}

/** Supported entity types for ownership resolution. */
export type OwnedEntityType = 'invoice' | 'ticket';

/**
 * Resolves and caches entity-to-client ownership, then asserts that
 * the resolved owner is within the caller's allowed client set.
 */
export class EntityOwnershipChecker {
  private readonly whmcs: WhmcsClient;

  /**
   * Process-lifetime cache.
   * Key format: `"invoice:123"` or `"ticket:456"`.
   * Value: the owning `userid` (client ID).
   */
  private readonly cache = new Map<string, number>();

  constructor(whmcs: WhmcsClient) {
    this.whmcs = whmcs;
  }

  // -------------------------------------------------------------------
  // Resolvers
  // -------------------------------------------------------------------

  /**
   * Resolve the owning client ID for an invoice.
   *
   * @param invoiceid - WHMCS invoice ID.
   * @returns The `userid` that owns the invoice, or `null` if the
   *          invoice does not exist / the API call fails.
   */
  async resolveInvoiceOwner(invoiceid: number): Promise<number | null> {
    return this.resolveOwner('invoice', invoiceid, 'GetInvoice', { invoiceid });
  }

  /**
   * Resolve the owning client ID for a ticket.
   *
   * @param ticketid - WHMCS ticket ID.
   * @returns The `userid` that owns the ticket, or `null` if the
   *          ticket does not exist / the API call fails.
   */
  async resolveTicketOwner(ticketid: number): Promise<number | null> {
    return this.resolveOwner('ticket', ticketid, 'GetTicket', { ticketid });
  }

  // -------------------------------------------------------------------
  // Assertion
  // -------------------------------------------------------------------

  /**
   * Assert that an entity belongs to one of the allowed client IDs.
   *
   * @param entityType  - `'invoice'` or `'ticket'`.
   * @param entityId    - The numeric entity ID.
   * @param allowedClientIds - Client IDs the current session is scoped to.
   * @throws {EntityOwnershipError} When the resolved owner is not in the
   *         allowed set, or when the entity cannot be found.
   */
  async assertEntityOwnership(
    entityType: OwnedEntityType,
    entityId: number,
    allowedClientIds: number[]
  ): Promise<void> {
    let ownerId: number | null;

    switch (entityType) {
      case 'invoice':
        ownerId = await this.resolveInvoiceOwner(entityId);
        break;
      case 'ticket':
        ownerId = await this.resolveTicketOwner(entityId);
        break;
      default: {
        // Exhaustiveness guard — should never be reached.
        const _exhaustive: never = entityType;
        throw new Error(`Unknown entity type: ${String(_exhaustive)}`);
      }
    }

    if (ownerId === null || !allowedClientIds.includes(ownerId)) {
      throw new EntityOwnershipError(entityType, entityId);
    }
  }

  // -------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------

  /**
   * Generic resolver with caching.
   */
  private async resolveOwner(
    entityType: OwnedEntityType,
    entityId: number,
    action: string,
    params: Record<string, unknown>
  ): Promise<number | null> {
    const cacheKey = `${entityType}:${entityId}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    try {
      const result = await this.whmcs.read<Record<string, unknown>>(action, params);
      const userid =
        typeof result.userid === 'number'
          ? result.userid
          : typeof result.userid === 'string'
            ? Number(result.userid)
            : null;

      if (userid !== null && Number.isFinite(userid)) {
        this.cache.set(cacheKey, userid);
        return userid;
      }

      return null;
    } catch {
      // Entity not found or API error — treat as unresolvable.
      return null;
    }
  }
}
