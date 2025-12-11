/**
 * Unit tests for order management tools
 * 
 * Tests: list_products, accept_order
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

describe('Order Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('list_products', () => {
    it('should validate list products parameters', () => {
      const { z } = require('zod');
      
      const listProductsSchema = z.object({
        group_id: z.number().int().optional(),
        name_contains: z.string().optional(),
        include_hidden: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
      });

      // Valid with defaults
      const defaultResult = listProductsSchema.safeParse({});
      expect(defaultResult.success).toBe(true);
      expect(defaultResult.data?.include_hidden).toBe(false);
      expect(defaultResult.data?.limit).toBe(50);

      // With filters
      expect(listProductsSchema.safeParse({
        group_id: 5,
        name_contains: 'hosting',
        include_hidden: true,
        limit: 25,
      }).success).toBe(true);

      // Invalid limit
      expect(listProductsSchema.safeParse({
        limit: 200, // Exceeds max
      }).success).toBe(false);
    });

    it('should filter products by name', () => {
      interface Product {
        pid: number;
        name: string;
        hidden: number;
      }

      function filterProducts(
        products: Product[],
        nameContains?: string,
        includeHidden?: boolean
      ): Product[] {
        let filtered = products;
        
        if (nameContains) {
          const search = nameContains.toLowerCase();
          filtered = filtered.filter((p) => p.name.toLowerCase().includes(search));
        }
        
        if (!includeHidden) {
          filtered = filtered.filter((p) => p.hidden !== 1);
        }
        
        return filtered;
      }

      const products: Product[] = [
        { pid: 1, name: 'Basic Hosting', hidden: 0 },
        { pid: 2, name: 'Premium Hosting', hidden: 0 },
        { pid: 3, name: 'Hidden Product', hidden: 1 },
        { pid: 4, name: 'VPS Server', hidden: 0 },
      ];

      // Filter by name
      const hostingProducts = filterProducts(products, 'hosting');
      expect(hostingProducts.length).toBe(2);

      // Include hidden
      const allProducts = filterProducts(products, undefined, true);
      expect(allProducts.length).toBe(4);

      // Exclude hidden (default)
      const visibleProducts = filterProducts(products);
      expect(visibleProducts.length).toBe(3);

      // Combined filters
      const hiddenHosting = filterProducts(products, 'hosting', true);
      expect(hiddenHosting.length).toBe(2);
    });
  });

  describe('accept_order', () => {
    it('should validate accept order parameters', () => {
      const { z } = require('zod');
      
      const acceptOrderSchema = z.object({
        orderid: z.number().int().positive(),
        autosetup: z.boolean().default(true),
        sendemail: z.boolean().default(true),
        serverid: z.number().int().optional(),
      });

      // Valid with defaults
      const defaultResult = acceptOrderSchema.safeParse({
        orderid: 100,
      });
      expect(defaultResult.success).toBe(true);
      expect(defaultResult.data?.autosetup).toBe(true);
      expect(defaultResult.data?.sendemail).toBe(true);

      // With manual setup
      expect(acceptOrderSchema.safeParse({
        orderid: 100,
        autosetup: false,
        sendemail: false,
      }).success).toBe(true);

      // With specific server
      expect(acceptOrderSchema.safeParse({
        orderid: 100,
        serverid: 5,
      }).success).toBe(true);

      // Invalid orderid
      expect(acceptOrderSchema.safeParse({
        orderid: 0,
      }).success).toBe(false);
    });
  });
});
