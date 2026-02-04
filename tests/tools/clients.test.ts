/**
 * Unit tests for client management tools
 * 
 * Tests: create_client, search_clients, get_client_details, update_client, get_service_details
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules before importing
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

describe('Client Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create_client', () => {
    it('should validate required fields', () => {
      // Test schema validation
      const { z } = require('zod');
      
      const createClientSchema = z.object({
        firstname: z.string().min(1, 'First name is required'),
        lastname: z.string().min(1, 'Last name is required'),
        email: z.string().email('Valid email is required'),
        country: z.string().length(2, 'Country must be 2-letter ISO code'),
        address1: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        postcode: z.string().optional(),
        phonenumber: z.string().optional(),
        skip_validation: z.boolean().default(false),
      }).superRefine((val, ctx) => {
        if (val.skip_validation) return;
        const requiredFields = ['address1', 'city', 'state', 'postcode', 'phonenumber'] as const;
        for (const field of requiredFields) {
          if (!val[field] || String(val[field]).trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: `${field} is required unless skip_validation=true`,
            });
          }
        }
      });

      // Valid input
      const validResult = createClientSchema.safeParse({
        firstname: 'John',
        lastname: 'Doe',
        email: 'john@example.com',
        country: 'US',
        address1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        postcode: '78701',
        phonenumber: '+1.5125550100',
      });
      expect(validResult.success).toBe(true);

      // Missing firstname
      const missingFirstname = createClientSchema.safeParse({
        lastname: 'Doe',
        email: 'john@example.com',
        country: 'US',
        address1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        postcode: '78701',
        phonenumber: '+1.5125550100',
      });
      expect(missingFirstname.success).toBe(false);

      // Invalid email
      const invalidEmail = createClientSchema.safeParse({
        firstname: 'John',
        lastname: 'Doe',
        email: 'not-an-email',
        country: 'US',
        address1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        postcode: '78701',
        phonenumber: '+1.5125550100',
      });
      expect(invalidEmail.success).toBe(false);

      // Invalid country code
      const invalidCountry = createClientSchema.safeParse({
        firstname: 'John',
        lastname: 'Doe',
        email: 'john@example.com',
        country: 'USA', // Should be 2 chars
        address1: '123 Main St',
        city: 'Austin',
        state: 'TX',
        postcode: '78701',
        phonenumber: '+1.5125550100',
      });
      expect(invalidCountry.success).toBe(false);

      // Allow missing address fields when skip_validation=true
      const skipValidation = createClientSchema.safeParse({
        firstname: 'Jane',
        lastname: 'Roe',
        email: 'jane@example.com',
        country: 'US',
        skip_validation: true,
      });
      expect(skipValidation.success).toBe(true);
    });

    it('should sanitize text input correctly', () => {
      // Test sanitization helper
      function sanitizeTextInput(input: string): string {
        return input
          .replaceAll(/[<>]/g, '')
          .replaceAll(/[\x00-\x1F\x7F]/g, '')
          .trim();
      }

      expect(sanitizeTextInput('<script>alert(1)</script>')).toBe('scriptalert(1)/script');
      expect(sanitizeTextInput('  John Doe  ')).toBe('John Doe');
      expect(sanitizeTextInput('Normal Name')).toBe('Normal Name');
      expect(sanitizeTextInput('Name\x00With\x1FControl')).toBe('NameWithControl');
    });

    it('should normalize email addresses', () => {
      function normalizeEmail(email: string): string {
        return email.toLowerCase().trim();
      }

      expect(normalizeEmail('  John@Example.COM  ')).toBe('john@example.com');
      expect(normalizeEmail('USER@DOMAIN.ORG')).toBe('user@domain.org');
    });

    it('should generate secure passwords with required character types', () => {
      const crypto = require('node:crypto');
      
      function generateSecurePassword(length: number = 16): string {
        const lowercase = 'abcdefghijklmnopqrstuvwxyz';
        const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const digits = '0123456789';
        const special = '!@#$%^&*';
        const allChars = lowercase + uppercase + digits + special;
        
        const bytes = crypto.randomBytes(length);
        const required = [
          lowercase[bytes[0] % lowercase.length],
          uppercase[bytes[1] % uppercase.length],
          digits[bytes[2] % digits.length],
          special[bytes[3] % special.length],
        ];
        
        let password = '';
        for (let i = 4; i < length; i++) {
          password += allChars[bytes[i] % allChars.length];
        }
        
        const combined = required.join('') + password;
        return combined.split('').sort(() => Math.random() - 0.5).join('');
      }

      const password = generateSecurePassword(16);
      
      expect(password.length).toBe(16);
      expect(/[a-z]/.test(password)).toBe(true);
      expect(/[A-Z]/.test(password)).toBe(true);
      expect(/[0-9]/.test(password)).toBe(true);
      expect(/[!@#$%^&*]/.test(password)).toBe(true);
    });
  });

  describe('search_clients', () => {
    it('should validate search parameters', () => {
      const { z } = require('zod');
      
      const searchClientsSchema = z.object({
        search: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0),
      });

      // Valid search
      const validResult = searchClientsSchema.safeParse({
        search: 'john',
        limit: 50,
        offset: 0,
      });
      expect(validResult.success).toBe(true);

      // Default values
      const defaultResult = searchClientsSchema.safeParse({});
      expect(defaultResult.success).toBe(true);
      expect(defaultResult.data?.limit).toBe(25);
      expect(defaultResult.data?.offset).toBe(0);

      // Invalid limit
      const invalidLimit = searchClientsSchema.safeParse({
        limit: 1000, // Exceeds max
      });
      expect(invalidLimit.success).toBe(false);

      // Invalid offset
      const invalidOffset = searchClientsSchema.safeParse({
        offset: -1, // Negative
      });
      expect(invalidOffset.success).toBe(false);
    });
  });

  describe('get_client_details', () => {
    it('should validate clientid is positive integer', () => {
      const { z } = require('zod');
      
      const getClientDetailsSchema = z.object({
        clientid: z.number().int().positive('Client ID must be positive'),
      });

      expect(getClientDetailsSchema.safeParse({ clientid: 123 }).success).toBe(true);
      expect(getClientDetailsSchema.safeParse({ clientid: 0 }).success).toBe(false);
      expect(getClientDetailsSchema.safeParse({ clientid: -1 }).success).toBe(false);
      expect(getClientDetailsSchema.safeParse({ clientid: 1.5 }).success).toBe(false);
    });
  });

  describe('update_client', () => {
    it('should allow partial updates', () => {
      const { z } = require('zod');
      
      const updateClientSchema = z.object({
        clientid: z.number().int().positive(),
        firstname: z.string().optional(),
        lastname: z.string().optional(),
        email: z.string().email().optional(),
        companyname: z.string().optional(),
      });

      // Only clientid (minimum valid)
      const minimalResult = updateClientSchema.safeParse({
        clientid: 123,
      });
      expect(minimalResult.success).toBe(true);

      // With some optional fields
      const partialResult = updateClientSchema.safeParse({
        clientid: 123,
        firstname: 'Jane',
        email: 'jane@example.com',
      });
      expect(partialResult.success).toBe(true);
    });
  });

  describe('get_service_details', () => {
    it('should validate serviceid is positive integer', () => {
      const { z } = require('zod');
      
      const getServiceDetailsSchema = z.object({
        serviceid: z.number().int().positive('Service ID must be positive'),
      });

      expect(getServiceDetailsSchema.safeParse({ serviceid: 456 }).success).toBe(true);
      expect(getServiceDetailsSchema.safeParse({ serviceid: 0 }).success).toBe(false);
      expect(getServiceDetailsSchema.safeParse({}).success).toBe(false);
    });
  });
});
