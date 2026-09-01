/**
 * NEXUS extended read tools — broad-tier WHMCS API coverage (read-only, governed).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, AUTH_SHAPE } from '../security.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
import {
  mapToCanonicalAdminUsers,
  mapToCanonicalAffiliates,
  mapToCanonicalCancelledPackages,
  mapToCanonicalClientsAddons,
  mapToCanonicalDomainLockingStatus,
  mapToCanonicalDomainNameservers,
  mapToCanonicalDomainWhoisInfo,
  mapToCanonicalEmailTemplates,
  mapToCanonicalOrderStatuses,
  mapToCanonicalPromotions,
  mapToCanonicalTicketNotes,
  mapToCanonicalUserPermissions,
} from '../canonical/extendedReads.js';
import type { Canonical } from '../governance/types.js';

function errorResult(message: string): GovernedToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: message }) }],
    isError: true,
  };
}

interface ReadSpec {
  readonly tool: string;
  readonly action: string;
  readonly description: string;
  readonly schema: z.ZodObject<z.ZodRawShape>;
  readonly buildParams: (p: Record<string, unknown>) => Record<string, unknown>;
  readonly mapper: (raw: unknown) => Canonical<unknown>;
}

function registerExtendedRead(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter,
  spec: ReadSpec
): void {
  if (!isToolAllowed(spec.tool)) return;

  const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
    const params = rawParams as z.infer<typeof spec.schema> & { auth_token?: string };
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;
      log.logToolCall(spec.tool, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const apiParams = spec.buildParams(params as Record<string, unknown>);
      const result = await whmcs.read<Record<string, unknown>>(spec.action, apiParams);
      const canonical = spec.mapper(result);

      log.logToolResult(spec.tool, true, Date.now() - t0);
      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy: { entity: canonical.entity, data: canonical.data },
        govern: () =>
          governedToolResult({
            canonical,
            authToken: typeof params.auth_token === 'string' ? params.auth_token : undefined,
            requestedContract: typeof params.contract === 'string' ? params.contract : undefined,
          }),
      });
    } catch (e) {
      log.logToolResult(
        spec.tool,
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError) return errorResult(e.message);
      if (e instanceof WhmcsBusinessError) return errorResult(e.message);
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    spec.tool,
    {
      description: spec.description,
      inputSchema: { ...spec.schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}

const contractField = {
  contract: z
    .string()
    .optional()
    .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
};

export function registerExtendedReadTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  const domainIdSchema = z.object({
    domainid: z.number().int().positive(),
    ...contractField,
  });
  const ticketIdSchema = z.object({
    ticketid: z.number().int().positive(),
    ...contractField,
  });
  const clientIdSchema = z.object({
    clientid: z.number().int().positive(),
    ...contractField,
  });
  const userIdSchema = z.object({
    userid: z.number().int().positive(),
    ...contractField,
  });
  const emptySchema = z.object({ ...contractField });

  const specs: ReadSpec[] = [
    {
      tool: 'get_domain_nameservers',
      action: 'DomainGetNameservers',
      description: 'Read nameserver hosts for a domain (DomainGetNameservers).',
      schema: domainIdSchema,
      buildParams: (p) => ({ domainid: p.domainid }),
      mapper: mapToCanonicalDomainNameservers,
    },
    {
      tool: 'get_domain_locking_status',
      action: 'DomainGetLockingStatus',
      description: 'Read registrar transfer-lock status for a domain.',
      schema: domainIdSchema,
      buildParams: (p) => ({ domainid: p.domainid }),
      mapper: mapToCanonicalDomainLockingStatus,
    },
    {
      tool: 'get_ticket_notes',
      action: 'GetTicketNotes',
      description: 'Read internal notes for a support ticket.',
      schema: ticketIdSchema,
      buildParams: (p) => ({ ticketid: p.ticketid }),
      mapper: mapToCanonicalTicketNotes,
    },
    {
      tool: 'list_order_statuses',
      action: 'GetOrderStatuses',
      description: 'List configured order statuses.',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalOrderStatuses,
    },
    {
      tool: 'list_promotions',
      action: 'GetPromotions',
      description: 'List active promotion codes.',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalPromotions,
    },
    {
      tool: 'list_client_addons',
      action: 'GetClientsAddons',
      description: 'List addon services for a client.',
      schema: clientIdSchema,
      buildParams: (p) => ({ clientid: p.clientid }),
      mapper: mapToCanonicalClientsAddons,
    },
    {
      tool: 'list_cancelled_packages',
      action: 'GetCancelledPackages',
      description: 'List cancelled product/package definitions.',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalCancelledPackages,
    },
    {
      tool: 'list_affiliates',
      action: 'GetAffiliates',
      description: 'List affiliate accounts.',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalAffiliates,
    },
    {
      tool: 'get_user_permissions',
      action: 'GetUserPermissions',
      description: 'Read permission map for a WHMCS user account.',
      schema: userIdSchema,
      buildParams: (p) => ({ userid: p.userid }),
      mapper: mapToCanonicalUserPermissions,
    },
    {
      tool: 'list_email_templates',
      action: 'GetEmailTemplates',
      description: 'List configured email templates.',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalEmailTemplates,
    },
    {
      tool: 'list_admin_users',
      action: 'GetAdminUsers',
      description: 'List WHMCS admin users (non-secret fields only).',
      schema: emptySchema,
      buildParams: () => ({}),
      mapper: mapToCanonicalAdminUsers,
    },
    {
      tool: 'get_domain_whois_info',
      action: 'DomainGetWhoisInfo',
      description: 'Read stored WHOIS/contact info for a domain record.',
      schema: domainIdSchema,
      buildParams: (p) => ({ domainid: p.domainid }),
      mapper: mapToCanonicalDomainWhoisInfo,
    },
  ];

  for (const spec of specs) {
    registerExtendedRead(server, whmcs, logger, rl, spec);
  }
}
