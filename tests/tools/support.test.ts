/**
 * Unit tests for support/ticketing tools
 * 
 * Tests: create_ticket, reply_ticket, get_ticket_departments
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// ============================================================================
// Reliability sprint Track C — get_ticket_departments outputSchema +
// structuredContent contract (RCA #4 class). These tests register the real
// tool against a fake MCP server harness, mock whmcs.read with synthetic
// fixtures, and assert the registered outputSchema validates the returned
// structuredContent while the human-readable text is preserved.
// ============================================================================

vi.mock('../../src/config.js', () => ({
  config: {
    WHMCS_API_URL: 'https://test.whmcs.com',
    MCP_MODE: 'full',
    MCP_GOVERNANCE_ENABLED: false,
    MCP_ENV: 'production',
    MCP_ALLOW_ANON_LLM: false,
    MCP_MAX_PAGE_SIZE: 100,
    MCP_TOOL_ALLOWLIST: [],
  },
  isToolAllowed: () => true,
  legacyWriteToolsEnabled: () => true,
}));
vi.mock('../../src/security.js', () => ({
  AUTH_SHAPE: {},
  ensureToolAuth: () => null,
  isClientMode: () => false,
  requireClientModeClientId: () => null,
  ensureClientOwnership: () => null,
}));

import { z } from 'zod';
import { registerSupportTools } from '../../src/tools/support.js';
import * as pipeline from '../../src/governance/pipeline.js';

function depsHarness() {
  const handlers: Record<string, any> = {};
  const configs: Record<string, any> = {};
  const server = {
    // get_ticket_departments must use registerTool so it can declare an
    // outputSchema (write tools keep the legacy .tool() signature).
    registerTool: (n: string, cfg: any, cb: any) => {
      handlers[n] = cb;
      configs[n] = cfg;
    },
    tool: (n: string, _d: string, _s: any, cb: any) => {
      handlers[n] = cb;
    },
  };
  const childLogger: Record<string, unknown> = {
    logToolCall: vi.fn(),
    logToolResult: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  };
  childLogger.child = (): Record<string, unknown> => childLogger;
  const logger: Record<string, unknown> = {
    child: (): Record<string, unknown> => childLogger,
  };
  const rateLimiter: Record<string, unknown> = { tryConsume: () => true };
  return { server, handlers, configs, logger, rateLimiter };
}

describe('get_ticket_departments — outputSchema + structuredContent contract', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('declares a Zod outputSchema on the registered tool', () => {
    const h = depsHarness();
    registerSupportTools(h.server as any, { read: vi.fn() } as any, h.logger, h.rateLimiter);
    expect(h.handlers.get_ticket_departments).toBeTypeOf('function');
    expect(h.configs.get_ticket_departments?.outputSchema).toBeTruthy();
    // Read-only, non-destructive global read.
    expect(h.configs.get_ticket_departments.annotations.readOnlyHint).toBe(true);
    expect(h.configs.get_ticket_departments.annotations.destructiveHint).toBe(false);
  });

  it('successful department list ⇒ schema-valid structuredContent, text preserved', async () => {
    const h = depsHarness();
    const read = vi.fn().mockResolvedValue({
      result: 'success',
      totalresults: 2,
      departments: {
        department: [
          { id: 1, name: 'Technical Support', description: 'Tech', awaitingreply: 5, opentickets: 12 },
          { id: 2, name: 'Billing', description: 'Money', awaitingreply: 0, opentickets: 3 },
        ],
      },
    });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);

    const res = await h.handlers.get_ticket_departments({});
    expect(read).toHaveBeenCalledWith('GetSupportDepartments');

    // structuredContent present and schema-valid.
    expect(res.structuredContent).toBeDefined();
    const schema = z.object(h.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    const parsed = schema.safeParse(res.structuredContent);
    expect(parsed.success, JSON.stringify(parsed)).toBe(true);

    expect(res.structuredContent.total).toBe(2);
    expect(res.structuredContent.departments).toHaveLength(2);
    expect(res.structuredContent.departments[0]).toMatchObject({
      id: 1,
      name: 'Technical Support',
      description: 'Tech',
      awaiting_reply: 5,
      open_tickets: 12,
    });

    // Text preserved byte-identical to the legacy payload.
    const expectedText = JSON.stringify({
      total: 2,
      departments: [
        { id: 1, name: 'Technical Support', description: 'Tech', awaiting_reply: 5, open_tickets: 12 },
        { id: 2, name: 'Billing', description: 'Money', awaiting_reply: 0, open_tickets: 3 },
      ],
    });
    expect(res.content[0].text).toBe(expectedText);
    expect(JSON.parse(res.content[0].text)).toEqual(res.structuredContent);
  });

  it('empty department list ⇒ schema-valid { total:0, departments:[] }', async () => {
    const h = depsHarness();
    const read = vi.fn().mockResolvedValue({ result: 'success', totalresults: 0, departments: { department: [] } });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);

    const res = await h.handlers.get_ticket_departments({});
    const schema = z.object(h.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    expect(schema.safeParse(res.structuredContent).success).toBe(true);
    expect(res.structuredContent).toEqual({ total: 0, departments: [] });
  });

  it('malformed / partial WHMCS response ⇒ no throw, schema-valid degraded structuredContent', async () => {
    const h = depsHarness();
    // Missing departments wrapper entirely + missing totalresults.
    const read = vi.fn().mockResolvedValue({ result: 'success' });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);

    const res = await h.handlers.get_ticket_departments({});
    const schema = z.object(h.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    expect(schema.safeParse(res.structuredContent).success).toBe(true);
    expect(res.structuredContent).toEqual({ total: 0, departments: [] });

    // Partial department records (missing optional fields) still schema-valid.
    const read2 = vi.fn().mockResolvedValue({
      departments: { department: [{ id: 7, name: 'Sales' }] },
    });
    const h2 = depsHarness();
    registerSupportTools(h2.server as any, { read: read2 } as any, h2.logger, h2.rateLimiter);
    const res2 = await h2.handlers.get_ticket_departments({});
    const schema2 = z.object(h2.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    expect(schema2.safeParse(res2.structuredContent).success).toBe(true);
    expect(res2.structuredContent.total).toBe(1);
    expect(res2.structuredContent.departments[0]).toMatchObject({ id: 7, name: 'Sales' });
  });

  it('governance DISABLED ⇒ schema-valid structuredContent, byte-identical text', async () => {
    vi.spyOn(pipeline, 'governanceEnabled').mockReturnValue(false);
    const h = depsHarness();
    const read = vi.fn().mockResolvedValue({
      totalresults: 1,
      departments: { department: [{ id: 1, name: 'Support', description: 'd', awaitingreply: 2, opentickets: 4 }] },
    });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);

    const res = await h.handlers.get_ticket_departments({});
    const schema = z.object(h.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    expect(schema.safeParse(res.structuredContent).success).toBe(true);

    const expectedText = JSON.stringify({
      total: 1,
      departments: [{ id: 1, name: 'Support', description: 'd', awaiting_reply: 2, open_tickets: 4 }],
    });
    expect(res.content[0].text).toBe(expectedText);
    expect(res.structuredContent).toEqual(JSON.parse(expectedText));
  });

  it('governance ENABLED (pure global read) ⇒ schema-valid structuredContent, projection N/A for non-PII global config', async () => {
    // get_ticket_departments is a global, non-client, non-PII read (only
    // department ids/names/counts). It has no canonical entity/contract, so
    // the governed path returns the same legacy-shaped structured payload
    // (nothing to project/mask). Both ON and OFF must be schema-valid.
    vi.spyOn(pipeline, 'governanceEnabled').mockReturnValue(true);
    const h = depsHarness();
    const read = vi.fn().mockResolvedValue({
      totalresults: 1,
      departments: { department: [{ id: 9, name: 'Abuse', description: 'a', awaitingreply: 1, opentickets: 2 }] },
    });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);

    const res = await h.handlers.get_ticket_departments({});
    expect(res.structuredContent).toBeDefined();
    const schema = z.object(h.configs.get_ticket_departments.outputSchema as z.ZodRawShape);
    expect(schema.safeParse(res.structuredContent).success).toBe(true);
    expect(res.structuredContent.total).toBe(1);
    expect(res.structuredContent.departments[0]).toMatchObject({ id: 9, name: 'Abuse' });
    // No client/PII fields ever present in department data.
    const text = res.content[0].text;
    expect(text).not.toMatch(/email|password|sk_live|clientid/i);
  });

  it('outputSchema validation invariant: z.object(config.outputSchema).safeParse(structuredContent).success === true', async () => {
    const h = depsHarness();
    const read = vi.fn().mockResolvedValue({
      totalresults: 3,
      departments: {
        department: [
          { id: 1, name: 'A' },
          { id: 2, name: 'B', description: 'b' },
          { id: 3, name: 'C', awaitingreply: 0, opentickets: 0 },
        ],
      },
    });
    registerSupportTools(h.server as any, { read } as any, h.logger, h.rateLimiter);
    const res = await h.handlers.get_ticket_departments({});
    const config = h.configs.get_ticket_departments;
    expect(z.object(config.outputSchema as z.ZodRawShape).safeParse(res.structuredContent).success).toBe(true);
  });
});
