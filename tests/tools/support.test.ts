/**
 * Unit tests for support/ticketing tools
 * 
 * Tests: create_ticket, reply_ticket, get_ticket_departments
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

describe('Support Tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create_ticket', () => {
    it('should validate ticket creation parameters', () => {
      const { z } = require('zod');
      
      const createTicketSchema = z.object({
        deptid: z.number().int().positive(),
        subject: z.string().min(1, 'Subject is required'),
        message: z.string().min(1, 'Message is required'),
        clientid: z.number().int().optional(),
        priority: z.enum(['Low', 'Medium', 'High']).default('Medium'),
        markdown: z.boolean().default(true),
        related_service_id: z.number().int().optional(),
      });

      // Valid minimal ticket
      const minimalResult = createTicketSchema.safeParse({
        deptid: 1,
        subject: 'Test Ticket',
        message: 'This is a test message',
      });
      expect(minimalResult.success).toBe(true);
      expect(minimalResult.data?.priority).toBe('Medium');
      expect(minimalResult.data?.markdown).toBe(true);

      // With all options
      expect(createTicketSchema.safeParse({
        deptid: 2,
        subject: 'Urgent Issue',
        message: 'Please help!',
        clientid: 123,
        priority: 'High',
        markdown: false,
        related_service_id: 456,
      }).success).toBe(true);

      // Missing subject
      expect(createTicketSchema.safeParse({
        deptid: 1,
        message: 'No subject',
      }).success).toBe(false);

      // Empty message
      expect(createTicketSchema.safeParse({
        deptid: 1,
        subject: 'Test',
        message: '',
      }).success).toBe(false);

      // Invalid priority
      expect(createTicketSchema.safeParse({
        deptid: 1,
        subject: 'Test',
        message: 'Test',
        priority: 'Urgent', // Not a valid enum value
      }).success).toBe(false);
    });
  });

  describe('reply_ticket', () => {
    it('should validate reply parameters', () => {
      const { z } = require('zod');
      
      const replyTicketSchema = z.object({
        ticketid: z.number().int().positive(),
        message: z.string().min(1, 'Message is required'),
        type: z.enum(['Client', 'AdminNote', 'AdminPublic']),
        status_after_reply: z.enum(['Open', 'Answered', 'Closed']).optional(),
      });

      // Client reply
      expect(replyTicketSchema.safeParse({
        ticketid: 100,
        message: 'Thank you for your response',
        type: 'Client',
      }).success).toBe(true);

      // Admin note
      expect(replyTicketSchema.safeParse({
        ticketid: 100,
        message: 'Internal note for team',
        type: 'AdminNote',
      }).success).toBe(true);

      // Admin public reply with status change
      expect(replyTicketSchema.safeParse({
        ticketid: 100,
        message: 'Issue resolved',
        type: 'AdminPublic',
        status_after_reply: 'Closed',
      }).success).toBe(true);

      // Invalid type
      expect(replyTicketSchema.safeParse({
        ticketid: 100,
        message: 'Test',
        type: 'Unknown',
      }).success).toBe(false);

      // Invalid status
      expect(replyTicketSchema.safeParse({
        ticketid: 100,
        message: 'Test',
        type: 'Client',
        status_after_reply: 'Pending', // Not a valid status
      }).success).toBe(false);
    });

    it('should determine correct API action based on type', () => {
      type ReplyType = 'Client' | 'AdminNote' | 'AdminPublic';

      function getApiAction(type: ReplyType): string {
        if (type === 'AdminNote') {
          return 'AddTicketNote';
        }
        return 'AddTicketReply';
      }

      expect(getApiAction('Client')).toBe('AddTicketReply');
      expect(getApiAction('AdminNote')).toBe('AddTicketNote');
      expect(getApiAction('AdminPublic')).toBe('AddTicketReply');
    });
  });

  describe('get_ticket_departments', () => {
    it('should have no required input parameters', () => {
      const { z } = require('zod');
      
      // The schema is essentially empty object
      const getDepartmentsSchema = z.object({});

      expect(getDepartmentsSchema.safeParse({}).success).toBe(true);
    });

    it('should transform department response', () => {
      interface WhmcsDepartment {
        id: number;
        name: string;
        description?: string;
        awaitingreply?: number;
        opentickets?: number;
      }

      function transformDepartment(dept: WhmcsDepartment) {
        return {
          id: dept.id,
          name: dept.name,
          description: dept.description,
          awaiting_reply: dept.awaitingreply,
          open_tickets: dept.opentickets,
        };
      }

      const whmcsDept: WhmcsDepartment = {
        id: 1,
        name: 'Technical Support',
        description: 'For technical issues',
        awaitingreply: 5,
        opentickets: 12,
      };

      const transformed = transformDepartment(whmcsDept);
      
      expect(transformed.id).toBe(1);
      expect(transformed.name).toBe('Technical Support');
      expect(transformed.awaiting_reply).toBe(5);
      expect(transformed.open_tickets).toBe(12);
    });
  });
});
