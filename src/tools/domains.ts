/**
 * Domain Tools for WHMCS MCP Server
 *
 * Tools: check_domain_availability, register_domain, renew_domain, transfer_domain, sync_domain
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import { ensureToolAuth, clientModeDenied, isClientMode, AUTH_SHAPE } from '../security.js';

const TOOL_VERSION = 'v1';

/**
 * Check domain availability input schema
 */
const checkDomainSchema = z.object({
  domain: z.string().min(4, 'Domain must be at least 4 characters (e.g., a.cc)'),
});

/**
 * Validate domain format with IDN (Internationalized Domain Name) support
 *
 * Supports:
 * - Standard ASCII domains: example.com
 * - Punycode (ACE) domains: xn--nxasmq5b.xn--wgbh1c (مثال.مصر)
 * - Unicode/IDN domains: пример.рф, 例え.jp
 * - New gTLDs and ccTLDs of any length
 */
function isValidDomainFormat(domain: string): boolean {
  // Check for empty or too long
  if (!domain || domain.length > 253) {
    return false;
  }

  // Split into labels
  const labels = domain.split('.');

  // Must have at least 2 labels (name + TLD)
  if (labels.length < 2) {
    return false;
  }

  // Validate each label
  for (const label of labels) {
    // Each label must be 1-63 characters
    if (!label || label.length > 63) {
      return false;
    }

    // Punycode label (ACE prefix)
    if (label.toLowerCase().startsWith('xn--')) {
      // Punycode: xn-- followed by alphanumeric and hyphens
      const punyRegex = /^xn--[a-zA-Z0-9-]+$/;
      if (!punyRegex.test(label)) {
        return false;
      }
    } else {
      // Standard or IDN label
      // Allow Unicode letters, digits, and hyphens
      // Cannot start or end with hyphen
      if (label.startsWith('-') || label.endsWith('-')) {
        return false;
      }

      // Unicode-aware check: letters (any script), digits, hyphens
      // Using Unicode property escapes for broad internationalization
      const idnLabelRegex = /^[\p{L}\p{N}][\p{L}\p{N}-]*[\p{L}\p{N}]$|^[\p{L}\p{N}]$/u;
      if (!idnLabelRegex.test(label)) {
        return false;
      }
    }
  }

  // TLD validation: last label must have at least 2 chars
  const tld = labels[labels.length - 1];
  if (tld.length < 2) {
    return false;
  }

  return true;
}

/**
 * Sanitize and normalize domain input
 * Note: Does NOT convert IDN to Punycode - WHMCS handles that internally
 */
function normalizeDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

/**
 * Helper: require a domain identifier (domainid or domain)
 */
function getDomainIdentifier(
  domainid?: number,
  domain?: string
): { domainid?: number; domain?: string } | null {
  if (!domainid && !domain) {
    return null;
  }
  return { domainid, domain };
}

/**
 * Register domain tools
 */
export function registerDomainTools(
  server: McpServer,
  whmcsClient: WhmcsClient,
  logger: Logger,
  rateLimiter: RateLimiter
): void {
  // ============================================
  // Tool: check_domain_availability
  // ============================================
  if (isToolAllowed('check_domain_availability')) {
    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof checkDomainSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        toolLogger.logToolCall('check_domain_availability', params, false);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        // Normalize and validate domain format
        const domain = normalizeDomain(params.domain);

        if (!isValidDomainFormat(domain)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: `Invalid domain format: '${domain}'. Expected format: 'example.com' or 'sub.example.com'`,
                  suggestion:
                    'Domain must contain only letters, numbers, hyphens, and a valid TLD (e.g., .com, .net, .org)',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await whmcsClient.read<{
          result: string;
          status?: string;
          whois?: string;
        }>('DomainWhois', {
          domain,
        });

        let status: 'available' | 'unavailable' | 'unknown' = 'unknown';
        let reason: string | undefined;

        // Parse WHMCS response
        if (result.status === 'available') {
          status = 'available';
        } else if (result.status === 'unavailable' || result.status === 'registered') {
          status = 'unavailable';
        } else if (result.result === 'error') {
          status = 'unknown';
          reason =
            'WHOIS lookup failed. The TLD may not be configured or the registrar is unavailable.';
        }

        toolLogger.logToolResult('check_domain_availability', true, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                domain: params.domain,
                status,
                raw_status: result.status || result.result,
                reason,
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'check_domain_availability',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'check_domain_availability',
      `Check if a domain is available for registration. Version: ${TOOL_VERSION}`,
      { ...checkDomainSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: register_domain
  // ============================================
  if (isToolAllowed('register_domain')) {
    const registerDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive').optional(),
      domain: z.string().optional(),
      idn_language: z
        .string()
        .optional()
        .describe('IDN language code to override stored domain language'),
      nameserver1: z.string().optional(),
      nameserver2: z.string().optional(),
      nameserver3: z.string().optional(),
      nameserver4: z.string().optional(),
      nameserver5: z.string().optional(),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof registerDomainSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('register_domain');
        }

        toolLogger.logToolCall('register_domain', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const identifier = getDomainIdentifier(params.domainid, params.domain);
        if (!identifier) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Either domainid or domain is required',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          message?: string;
          domainid?: number;
        }>('DomainRegister', {
          ...identifier,
          idnlanguage: params.idn_language,
        });

        toolLogger.logToolResult(
          'register_domain',
          result.result === 'success',
          Date.now() - startTime
        );

        // Optionally update nameservers after registration if provided
        const hasNameservers = !!(
          params.nameserver1 ||
          params.nameserver2 ||
          params.nameserver3 ||
          params.nameserver4 ||
          params.nameserver5
        );
        if (hasNameservers && result.result === 'success') {
          // DomainUpdateNameservers requires ns1 and ns2 at minimum
          if (!params.nameserver1 || !params.nameserver2) {
            toolLogger.warn('Nameserver update skipped: ns1 and ns2 are required', {
              domainid: params.domainid,
              domain: params.domain,
            });
          } else {
            await whmcsClient.mutate('DomainUpdateNameservers', {
              ...identifier,
              ns1: params.nameserver1,
              ns2: params.nameserver2,
              ns3: params.nameserver3,
              ns4: params.nameserver4,
              ns5: params.nameserver5,
            });
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                domainid: result.domainid ?? params.domainid,
                domain: params.domain,
                success: result.result === 'success',
                message:
                  result.message ||
                  (result.result === 'success'
                    ? 'Domain registered successfully'
                    : 'Registration failed'),
                nameservers_updated:
                  hasNameservers && result.result === 'success'
                    ? !!(params.nameserver1 && params.nameserver2)
                    : false,
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'register_domain',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'register_domain',
      `Register a domain with the registrar. Requires domain to be in Pending status. Version: ${TOOL_VERSION}`,
      { ...registerDomainSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: renew_domain
  // ============================================
  if (isToolAllowed('renew_domain')) {
    const renewDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive').optional(),
      domain: z.string().optional(),
      regperiod: z.number().int().min(1).max(10).optional().describe('Renewal term in years'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof renewDomainSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('renew_domain');
        }

        toolLogger.logToolCall('renew_domain', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const identifier = getDomainIdentifier(params.domainid, params.domain);
        if (!identifier) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Either domainid or domain is required',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          message?: string;
        }>('DomainRenew', {
          ...identifier,
          regperiod: params.regperiod,
        });

        toolLogger.logToolResult(
          'renew_domain',
          result.result === 'success',
          Date.now() - startTime
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                domain: params.domain,
                success: result.result === 'success',
                message:
                  result.message ||
                  (result.result === 'success' ? 'Domain renewed successfully' : 'Renewal failed'),
                regperiod: params.regperiod,
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'renew_domain',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'renew_domain',
      `Renew a domain with the registrar. The domain must be active and eligible for renewal. Version: ${TOOL_VERSION}`,
      { ...renewDomainSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: transfer_domain
  // ============================================
  if (isToolAllowed('transfer_domain')) {
    const transferDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive').optional(),
      domain: z.string().optional(),
      eppcode: z.string().optional().describe('EPP/Authorization code for transfer'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof transferDomainSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('transfer_domain');
        }

        toolLogger.logToolCall('transfer_domain', params, true);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        if (whmcsClient.isReadOnly()) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Tool not available in read_only mode',
                }),
              },
            ],
            isError: true,
          };
        }

        const identifier = getDomainIdentifier(params.domainid, params.domain);
        if (!identifier) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  isError: true,
                  error: 'Either domainid or domain is required',
                }),
              },
            ],
            isError: true,
          };
        }

        const result = await whmcsClient.mutate<{
          result: string;
          message?: string;
        }>('DomainTransfer', {
          ...identifier,
          eppcode: params.eppcode,
        });

        toolLogger.logToolResult(
          'transfer_domain',
          result.result === 'success',
          Date.now() - startTime
        );

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                domainid: params.domainid,
                domain: params.domain,
                success: result.result === 'success',
                message:
                  result.message ||
                  (result.result === 'success' ? 'Transfer initiated' : 'Transfer failed'),
                warning:
                  'Domain transfers may take several days to complete depending on registrar policies.',
              }),
            },
          ],
        };
      } catch (error) {
        toolLogger.logToolResult(
          'transfer_domain',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'transfer_domain',
      `Initiate a domain transfer from another registrar. Requires valid EPP code for most TLDs. Version: ${TOOL_VERSION}`,
      { ...transferDomainSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }

  // ============================================
  // Tool: sync_domain
  // ============================================
  if (isToolAllowed('sync_domain')) {
    const syncDomainSchema = z.object({
      domainid: z.number().int().positive('Domain ID must be positive'),
    });

    // Boundary cast: SDK v1.29 `ToolCallback` declares a return shape with an
    // open `[x: string]: unknown` index signature; our shared `ensure*`/result
    // helpers return the local closed `McpToolResponse`, which is structurally
    // a subtype but not assignable through the inferred overload. Lift the
    // handler and cast once at the boundary — pure type-only refactor.
    const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
      const params = rawParams as z.infer<typeof syncDomainSchema> & { auth_token?: string };

      const toolLogger = logger.child();
      const startTime = Date.now();

      try {
        const authError = ensureToolAuth(params as Record<string, unknown>);
        if (authError) return authError;

        if (isClientMode()) {
          return clientModeDenied('sync_domain');
        }

        toolLogger.logToolCall('sync_domain', params, false);

        if (!rateLimiter.tryConsume()) {
          throw new RateLimitError();
        }

        toolLogger.logToolResult('sync_domain', false, Date.now() - startTime);

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                isError: true,
                error:
                  'Domain sync is performed by WHMCS cron/registrar module and is not available via the External API.',
                suggestion: 'Use the WHMCS domain sync cron or registrar module sync function.',
              }),
            },
          ],
          isError: true,
        };
      } catch (error) {
        toolLogger.logToolResult(
          'sync_domain',
          false,
          Date.now() - startTime,
          error instanceof Error ? error.message : String(error)
        );

        if (error instanceof RateLimitError || error instanceof WhmcsBusinessError) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ isError: true, error: error.message }),
              },
            ],
            isError: true,
          };
        }

        throw error;
      }
    }) as unknown as ToolCallback<z.ZodRawShape>;

    server.tool(
      'sync_domain',
      `Sync domain status and expiry date with the registrar. NOTE: WHMCS performs domain sync via cron; there is no external API endpoint. Version: ${TOOL_VERSION}`,
      { ...syncDomainSchema.shape, ...AUTH_SHAPE },
      handler
    );
  }
}
