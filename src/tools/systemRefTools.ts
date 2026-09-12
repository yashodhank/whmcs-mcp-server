/**
 * Track A — system reference read tools (read-only, governed).
 *
 *  - get_currencies        ← WHMCS `GetCurrencies`     (install currency table)
 *  - list_payment_methods  ← WHMCS `GetPaymentMethods` (active gateway labels)
 *  - get_whmcs_details     ← WHMCS `WhmcsDetails`       (version/release info)
 *                            Fallback: `GetAdminDetails` → whmcs.version +
 *                            `GetConfigurationValue(Version)` when the API
 *                            credential role denies `WhmcsDetails`.
 *
 * All three are GLOBAL/admin reads (not client-scoped) carrying no per-customer
 * PII — currency tables, payment-gateway module labels, and the WHMCS version
 * string are install-level reference/system data. They take no clientid and are
 * not gated by client-mode scope. Each returns a SINGLE-entity governed result
 * (governedToolResult), mirroring get_tld_pricing in infraTools.ts: READ_ONLY
 * annotations, AUTH_SHAPE, RateLimiter, governance projection via the pipeline.
 * Capability status is `unverified` (informational — the tools still function).
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError, WhmcsTransportError } from '../whmcs/WhmcsClient.js';
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
  mapToCanonicalCurrencies,
  mapToCanonicalPaymentMethods,
  mapToCanonicalWhmcsDetails,
} from '../canonical/systemRefs.js';
import type { Canonical } from '../governance/types.js';
import { asRecord, str } from '../canonical/_shared.js';

const TOOL_VERSION = 'v1';

/** Standard structured-error result for a recoverable read failure. */
function errorResult(message: string): GovernedToolResult {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ isError: true, error: message }) }],
    isError: true,
  };
}

/**
 * Register a single-entity governed read tool that calls one WHMCS action with
 * no parameters and maps the response through `mapper`. Factors out the shared
 * auth → rate-limit → read → map → project boundary so all three tools stay
 * byte-identical in behaviour.
 */
function registerSimpleRead(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter,
  spec: {
    tool: string;
    action: string;
    description: string;
    mapper: (raw: unknown) => Canonical<unknown>;
  }
): void {
  if (!isToolAllowed(spec.tool)) {
    return;
  }

  const schema = z.object({
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
  });

  const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
    const params = rawParams as z.infer<typeof schema> & { auth_token?: string };
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authToken = typeof params.auth_token === 'string' ? params.auth_token : undefined;
      const requestedContract = typeof params.contract === 'string' ? params.contract : undefined;

      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;

      log.logToolCall(spec.tool, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      const result = await whmcs.read<Record<string, unknown>>(spec.action, {});
      const canonical = spec.mapper(result);

      log.logToolResult(spec.tool, true, Date.now() - t0);

      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy: { entity: canonical.entity, data: canonical.data },
        govern: () =>
          governedToolResult({
            canonical,
            authToken,
            requestedContract,
          }),
      });
    } catch (e) {
      log.logToolResult(
        spec.tool,
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
        return errorResult((e as Error).message);
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    spec.tool,
    {
      description: `${spec.description} Version: ${TOOL_VERSION}`,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}

export function registerSystemRefTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  registerSimpleRead(server, whmcs, logger, rl, {
    tool: 'get_currencies',
    action: 'GetCurrencies',
    description:
      'Get the WHMCS install currency table (read-only, reference data): per currency id/code, prefix/suffix/format display affixes, conversion rate, and the default flag.',
    mapper: mapToCanonicalCurrencies,
  });

  registerSimpleRead(server, whmcs, logger, rl, {
    tool: 'list_payment_methods',
    action: 'GetPaymentMethods',
    description:
      'List active WHMCS payment gateway methods (read-only, reference data): gateway module name and display label.',
    mapper: mapToCanonicalPaymentMethods,
  });

  registerWhmcsDetailsWithFallback(server, whmcs, logger, rl);
}

/**
 * Detect if an error is a WHMCS "Invalid Permissions" 403 for a specific action.
 * This happens when the API credential's allowed-actions role does not include
 * the action (e.g. WhmcsDetails is often disabled).
 */
function isPermissionDenied(e: unknown): boolean {
  if (e instanceof WhmcsBusinessError) {
    return /invalid\s+permissions/i.test(e.message);
  }
  if (e instanceof WhmcsTransportError && e.statusCode === 403) {
    return /invalid\s+permissions/i.test(e.message);
  }
  return false;
}

/**
 * Fallback version probe: extract version from GetAdminDetails.whmcs or
 * GetConfigurationValue(Version). Same idea as `src/whmcs/versionProfile.ts`
 * but returns a Canonical suitable for the tool's governed output.
 */
async function probeVersionFallback(
  whmcs: WhmcsClient,
  logger: Logger
): Promise<Canonical<unknown>> {
  try {
    const admin = await whmcs.read<Record<string, unknown>>('GetAdminDetails', {});
    const src = asRecord(admin);
    const whmcsBlock = 'whmcs' in src ? asRecord(src.whmcs) : undefined;
    if (whmcsBlock) {
      const version = str(whmcsBlock, 'version') ?? null;
      const release = str(whmcsBlock, 'canonicalversion') ?? str(whmcsBlock, 'release') ?? null;
      if (version) {
        logger.info(
          'get_whmcs_details: used GetAdminDetails fallback (WhmcsDetails permission denied)'
        );
        return mapToCanonicalWhmcsDetails({ whmcs: { version, canonicalversion: release } });
      }
    }
  } catch {
    /* GetAdminDetails also denied — try GetConfigurationValue */
  }

  try {
    const cfg = await whmcs.read<Record<string, unknown>>('GetConfigurationValue', {
      setting: 'Version',
    });
    const value = str(asRecord(cfg), 'value');
    if (value && value.trim() !== '') {
      const release = value.trim();
      const version = release.replace(/-release.*$/i, '') || release;
      logger.info(
        'get_whmcs_details: used GetConfigurationValue fallback (WhmcsDetails permission denied)'
      );
      return mapToCanonicalWhmcsDetails({ whmcs: { version, canonicalversion: release } });
    }
  } catch {
    /* Both fallbacks failed */
  }

  logger.warn('get_whmcs_details: all fallbacks failed — returning null version');
  return mapToCanonicalWhmcsDetails({});
}

/**
 * Register `get_whmcs_details` with automatic fallback to GetAdminDetails /
 * GetConfigurationValue when the API credential role denies WhmcsDetails.
 */
function registerWhmcsDetailsWithFallback(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  const toolName = 'get_whmcs_details';
  if (!isToolAllowed(toolName)) return;

  const schema = z.object({
    contract: z
      .string()
      .optional()
      .describe('Requested data contract (honoured only if the resolved consumer permits it)'),
  });

  const handler: ToolCallback<z.ZodRawShape> = (async (rawParams: Record<string, unknown>) => {
    const params = rawParams as z.infer<typeof schema> & { auth_token?: string };
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authToken = typeof params.auth_token === 'string' ? params.auth_token : undefined;
      const requestedContract = typeof params.contract === 'string' ? params.contract : undefined;

      const authErr = ensureToolAuth(params as Record<string, unknown>);
      if (authErr) return authErr;

      log.logToolCall(toolName, params, false);
      if (!rl.tryConsume()) throw new RateLimitError();

      let canonical: Canonical<unknown>;
      try {
        const result = await whmcs.read<Record<string, unknown>>('WhmcsDetails', {});
        canonical = mapToCanonicalWhmcsDetails(result);
      } catch (e) {
        if (isPermissionDenied(e)) {
          canonical = await probeVersionFallback(whmcs, logger);
        } else {
          throw e;
        }
      }

      log.logToolResult(toolName, true, Date.now() - t0);

      return applyGovernanceOrLegacy({
        enabled: governanceEnabled(),
        legacy: { entity: canonical.entity, data: canonical.data },
        govern: () =>
          governedToolResult({
            canonical,
            authToken,
            requestedContract,
          }),
      });
    } catch (e) {
      log.logToolResult(
        toolName,
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError || e instanceof WhmcsBusinessError) {
        return errorResult((e as Error).message);
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    toolName,
    {
      description:
        'Get WHMCS system details (read-only): installed version and release string. ' +
        'Falls back to GetAdminDetails/GetConfigurationValue when WhmcsDetails is not allowed ' +
        'by the API credential role. System info only; no secrets. Version: ' +
        TOOL_VERSION,
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      annotations: { ...READ_ONLY_ANNOTATIONS },
    },
    handler
  );
}
