import { z } from 'zod';
import type { OperationDefinition } from '../types.js';

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
}): OperationDefinition {
  return {
    id: input.id,
    publicName: input.publicName,
    domain: input.id.split('.')[0] ?? 'planning',
    description: input.description,
    inputSchema: {
      natural_key: z.string().min(1),
      projected_effect: z.string().min(1),
      params: z.record(z.string(), z.unknown()),
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
    }),
    draftDescriptor({
      id: 'domains.renew.draft',
      publicName: 'draft_domain_renewal',
      scope: 'domain:renew',
      risk: 'high',
      description: 'Create a governed domain-renewal draft; never approve or execute it.',
    }),
    draftDescriptor({
      id: 'billing.refund_record.draft',
      publicName: 'draft_refund_record',
      scope: 'billing:refund:record',
      risk: 'high',
      description: 'Create a governed refund-record draft; never approve or execute it.',
    }),
    draftDescriptor({
      id: 'billing.quote_create.draft',
      publicName: 'draft_quote_create',
      scope: 'billing:quote:create',
      risk: 'medium',
      description: 'Create a governed quote draft; never approve or execute it.',
    }),
  ];
}
