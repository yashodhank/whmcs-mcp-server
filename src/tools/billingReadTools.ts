/**
 * Billing read tools (read-only, governed, CLIENT-SCOPED):
 *
 *   - get_pay_methods ← WHMCS `GetPayMethods` (a client's stored pay methods).
 *   - get_credits     ← WHMCS `GetCredits`    (a client's credit ledger).
 *
 * SECURITY: `get_pay_methods` returns stored payment-instrument material. The
 * canonical mapper (src/canonical/payMethod.ts) classifies every card/bank/
 * token field `secret.credential`, which the projector DROPS for all non-local
 * contracts — raw PAN/expiry/CVV/account/routing/tokens can never reach an
 * LLM, client, or operator consumer. Only a WHMCS-provided masked last4 (a
 * `business.label`) and non-sensitive references survive projection.
 *
 * Both reads require `clientid` and, in client access mode, enforce that the
 * caller is scoped to that client (ensureClientAllowed). They follow the
 * standard governed-read pattern: AUTH_SHAPE, RateLimiter, governance
 * projection via the pipeline, capability-aware (the underlying actions are
 * `unverified`, but the tools still function — promotion is the capability
 * registry's job).
 */
import { z } from 'zod';
import {
  McpServer,
  type ToolCallback,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient, WhmcsBusinessError } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { isToolAllowed } from '../config.js';
import {
  ensureToolAuth,
  isClientMode,
  ensureClientAllowed,
  AUTH_SHAPE,
} from '../security.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import {
  applyGovernanceOrLegacy,
  governedToolResult,
  governanceEnabled,
  type GovernedToolResult,
} from '../governance/pipeline.js';
// Import directly from the module (not the barrel): the canonical barrel
// (index.ts) is owned by the main thread and adds these re-exports there.
import {
  mapToCanonicalPayMethods,
  mapToCanonicalCredits,
} from '../canonical/payMethod.js';

const TOOL_VERSION = 'v1';

/** Standard structured-error result for a recoverable read failure. */
function errorResult(message: string): GovernedToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ isError: true, error: message }),
      },
    ],
    isError: true,
  };
}

/** Shared client-scope guard: clientid required + scoped in client mode. */
function ensureClientScope(clientId: number): GovernedToolResult | null {
  if (isClientMode()) {
    const scopeErr = ensureClientAllowed(clientId);
    if (scopeErr) {
      // ensureClientAllowed returns the local McpToolResponse shape, which is
      // structurally the governed error shape; re-emit via errorResult is not
      // possible (it has structured fields), so pass it straight through.
      return scopeErr as unknown as GovernedToolResult;
    }
  }
  return null;
}

export function registerBillingReadTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  /* ───────────────────────────  get_pay_methods  ───────────────────────── */
  if (isToolAllowed('get_pay_methods')) {
    const schema = z.object({
      clientid: z
        .number()
        .int()
        .positive()
        .describe('WHMCS client id whose stored pay methods to read'),
      contract: z
        .string()
        .optional()
        .describe(
          'Requested data contract (honoured only if the resolved consumer permits it)'
        ),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (
      rawParams: Record<string, unknown>
    ) => {
      const params = rawParams as z.infer<typeof schema> & {
        auth_token?: string;
      };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        const scopeErr = ensureClientScope(params.clientid);
        if (scopeErr) return scopeErr;

        log.logToolCall('get_pay_methods', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const result = await whmcs.read<Record<string, unknown>>(
          'GetPayMethods',
          { clientid: params.clientid }
        );
        // Ensure the canonical clientId is anchored to the requested client
        // even if WHMCS omits it from the response body.
        const canonical = mapToCanonicalPayMethods({
          clientid: params.clientid,
          ...result,
        });

        log.logToolResult('get_pay_methods', true, Date.now() - t0);

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy: { entity: canonical.entity, data: canonical.data },
          govern: () =>
            governedToolResult({ canonical, authToken, requestedContract }),
        });
      } catch (e) {
        log.logToolResult(
          'get_pay_methods',
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
      'get_pay_methods',
      {
        description: `List a client's stored pay methods (read-only). Card/bank numbers, expiry, account/routing numbers and gateway tokens are classified secret and NEVER exposed to non-local consumers; only a masked last4 (if WHMCS provides one) and gateway/type references are returned. Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }

  /* ─────────────────────────────  get_credits  ─────────────────────────── */
  if (isToolAllowed('get_credits')) {
    const schema = z.object({
      clientid: z
        .number()
        .int()
        .positive()
        .describe('WHMCS client id whose credit ledger to read'),
      contract: z
        .string()
        .optional()
        .describe(
          'Requested data contract (honoured only if the resolved consumer permits it)'
        ),
    });

    const handler: ToolCallback<z.ZodRawShape> = (async (
      rawParams: Record<string, unknown>
    ) => {
      const params = rawParams as z.infer<typeof schema> & {
        auth_token?: string;
      };
      const log = logger.child();
      const t0 = Date.now();
      try {
        const authToken =
          typeof params.auth_token === 'string' ? params.auth_token : undefined;
        const requestedContract =
          typeof params.contract === 'string' ? params.contract : undefined;

        const authErr = ensureToolAuth(params as Record<string, unknown>);
        if (authErr) return authErr;

        const scopeErr = ensureClientScope(params.clientid);
        if (scopeErr) return scopeErr;

        log.logToolCall('get_credits', params, false);
        if (!rl.tryConsume()) throw new RateLimitError();

        const result = await whmcs.read<Record<string, unknown>>('GetCredits', {
          clientid: params.clientid,
        });
        const canonical = mapToCanonicalCredits({
          clientid: params.clientid,
          ...result,
        });

        log.logToolResult('get_credits', true, Date.now() - t0);

        return applyGovernanceOrLegacy({
          enabled: governanceEnabled(),
          legacy: { entity: canonical.entity, data: canonical.data },
          govern: () =>
            governedToolResult({ canonical, authToken, requestedContract }),
        });
      } catch (e) {
        log.logToolResult(
          'get_credits',
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
      'get_credits',
      {
        description: `List a client's credit ledger entries (read-only): id, date, description, amount and the related record id. Version: ${TOOL_VERSION}`,
        inputSchema: { ...schema.shape, ...AUTH_SHAPE },
        annotations: { ...READ_ONLY_ANNOTATIONS },
      },
      handler
    );
  }
}
