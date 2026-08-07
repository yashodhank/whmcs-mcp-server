import { z } from 'zod';
import type { OperationDefinition } from '../types.js';

/** Effective catalog generation after adding descriptor-only planner operations. */
export const PLANNING_CATALOG_VERSION = 4;

const output = z.record(z.string(), z.unknown());
const clientIdInput = { clientid: z.number().int().positive() } as const;

function readDescriptor(input: {
  id: string;
  publicName: string;
  description: string;
  actions: readonly string[];
  inputSchema: z.ZodRawShape;
  calls: number;
  maxConcurrency: number;
  fallbacks?: readonly string[];
}): OperationDefinition {
  return {
    id: input.id,
    publicName: input.publicName,
    domain: input.id.split('.')[0] ?? 'planning',
    description: input.description,
    inputSchema: input.inputSchema,
    outputSchema: output,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    effects: 'read',
    riskTier: 'low',
    whmcsActions: input.actions,
    capability: { mode: 'all', probe: 'read_safe' },
    governance: { scope: null, output: 'sanitized', rawWhmcsOutput: false },
    cache: { mode: 'none' },
    cost: {
      kind: 'bounded_fanout',
      maxWhmcsCalls: input.calls,
      maxItems: 200,
      maxConcurrency: input.maxConcurrency,
    },
    auth: { toolAuthRequired: true, consumerFiltered: true },
    pagination: null,
    prerequisites: [],
    fallbacks: input.fallbacks ?? [],
    protocolFeatures: ['tools'],
    version: 1,
  };
}

function draftDescriptor(input: {
  id: string;
  publicName: string;
  scope: string;
  risk: 'medium' | 'high';
  description: string;
  paramsSchema: z.ZodType<Record<string, unknown>>;
}): OperationDefinition {
  return {
    id: input.id,
    publicName: input.publicName,
    domain: input.id.split('.')[0] ?? 'planning',
    description: input.description,
    inputSchema: {
      natural_key: z.string().min(1),
      projected_effect: z.string().min(1),
      params: input.paramsSchema,
      preconditions: z.record(z.string(), z.unknown()).optional(),
    },
    outputSchema: output,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    effects: 'draft',
    riskTier: input.risk,
    whmcsActions: [],
    capability: { mode: 'none', probe: 'none' },
    governance: { scope: input.scope, output: 'sanitized', rawWhmcsOutput: false },
    cache: { mode: 'none' },
    cost: { kind: 'constant', maxWhmcsCalls: 0, maxItems: 1 },
    auth: { toolAuthRequired: true, consumerFiltered: true },
    pagination: null,
    prerequisites: ['existing controlled-write draft boundary'],
    fallbacks: ['retain the plan as analysis and request operator input'],
    protocolFeatures: ['tools'],
    version: 1,
  };
}

/**
 * Planner-facing descriptors for representative, already-existing operations.
 * They are deliberately descriptor-only: reads continue through their current
 * governed handlers and writes can only be converted to draft_write_intent.
 */
export function planningOperationDescriptors(): readonly OperationDefinition[] {
  return [
    readDescriptor({
      id: 'clients.account_360.read',
      publicName: 'get_account_360',
      description: 'Governed, bounded account 360 read.',
      actions: [
        'GetClientsDetails',
        'GetClientsProducts',
        'GetClientsDomains',
        'GetInvoices',
        'GetOrders',
        'GetTickets',
      ],
      inputSchema: { ...clientIdInput, recent: z.number().int().min(1).max(20).default(5) },
      calls: 6,
      maxConcurrency: 1,
    }),
    readDescriptor({
      id: 'billing.reconciliation.read',
      publicName: 'get_reconciliation_snapshot',
      description: 'Governed bounded invoice and transaction reconciliation.',
      actions: ['GetInvoices', 'GetTransactions'],
      inputSchema: clientIdInput,
      calls: 2,
      maxConcurrency: 1,
      fallbacks: ['billing.ar_aging.read'],
    }),
    readDescriptor({
      id: 'billing.ar_aging.read',
      publicName: 'get_accounts_receivable_aging',
      description: 'Governed accounts-receivable aging read.',
      actions: ['GetInvoices'],
      inputSchema: clientIdInput,
      calls: 1,
      maxConcurrency: 1,
    }),
    readDescriptor({
      id: 'domains.portfolio.read',
      publicName: 'get_domain_portfolio_snapshot',
      description: 'Governed bounded domain portfolio and renewal-cost read.',
      actions: ['GetClientsDomains', 'GetTLDPricing'],
      inputSchema: clientIdInput,
      calls: 2,
      maxConcurrency: 1,
    }),
    draftDescriptor({
      id: 'services.suspend.draft',
      publicName: 'draft_service_suspend',
      scope: 'service:suspend',
      risk: 'medium',
      description: 'Create a governed suspension draft; never approve or execute it.',
      paramsSchema: z
        .object({
          serviceid: z.number().int().positive(),
          reason: z.string().min(1).optional(),
        })
        .strict(),
    }),
    draftDescriptor({
      id: 'domains.renew.draft',
      publicName: 'draft_domain_renewal',
      scope: 'domain:renew',
      risk: 'high',
      description: 'Create a governed domain-renewal draft; never approve or execute it.',
      paramsSchema: z
        .object({
          domainid: z.number().int().positive(),
          regperiod: z.number().int().positive(),
        })
        .strict(),
    }),
    draftDescriptor({
      id: 'billing.refund_record.draft',
      publicName: 'draft_refund_record',
      scope: 'billing:refund:record',
      risk: 'high',
      description: 'Create a governed refund-record draft; never approve or execute it.',
      paramsSchema: z
        .object({
          invoiceid: z.number().int().positive(),
          amount: z.union([
            z.number().finite(),
            z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/),
          ]),
          refund_type: z.enum(['Credit', 'GatewayRecord']),
          paymentmethod: z.string().min(1),
        })
        .strict(),
    }),
    draftDescriptor({
      id: 'billing.quote_create.draft',
      publicName: 'draft_quote_create',
      scope: 'billing:quote:create',
      risk: 'medium',
      description: 'Create a governed quote draft; never approve or execute it.',
      paramsSchema: z
        .object({
          subject: z.string().min(1),
          stage: z.enum(['Draft', 'Delivered', 'On Hold', 'Accepted', 'Lost', 'Dead']),
          validuntil: z.string().min(1),
          items: z
            .array(
              z
                .object({
                  description: z.string().min(1),
                  amount: z.union([
                    z.number().finite(),
                    z.string().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/),
                  ]),
                })
                .strict()
            )
            .min(1),
        })
        .strict(),
    }),
  ];
}
