/**
 * mcp_doctor — read-only health of the 8.13.7 MCP + WHMCS install.
 *
 * Checks version family, OIDC discovery, API-role probes, OAuth RS config,
 * staff allow-list, and decorative allowedActions. Never logs secrets.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, getWhmcsApiEndpoint, isToolAllowed } from '../config.js';
import { AUTH_SHAPE, ensureToolAuth } from '../security.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import { getWhmcsVersionProfile } from '../whmcs/versionProfile.js';
import { getCapability } from '../governance/capabilities.js';
import { getConsumerRegistry } from '../governance/pipeline.js';
import { hasStdioDefaultToken } from '../auth/trustedStdioDefault.js';
import { parseStaffConsumerIds } from '../auth/audience.js';
import {
  collectForbiddenWhmcsIssuers,
  oauthIssuersIncludeWhmcs,
  originFromApiUrl,
} from '../auth/whmcsIssuer.js';

const DOCTOR_OUTPUT = z
  .object({
    ok: z.boolean().optional(),
    family: z.string().optional(),
    isError: z.boolean().optional(),
    error: z.string().optional(),
  })
  .catchall(z.unknown());

function whmcsOrigin(apiUrl: string): string {
  return originFromApiUrl(apiUrl);
}

async function fetchJson(
  url: string
): Promise<{ ok: boolean; status: number; body?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    const text = await res.text();
    let body: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = undefined;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

async function probeAction(
  whmcs: WhmcsClient,
  action: string,
  params: Record<string, unknown>
): Promise<{ action: string; ok: boolean; error?: string }> {
  try {
    await whmcs.read(action, params);
    return { action, ok: true };
  } catch (e) {
    return { action, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function registerMcpDoctorTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (!isToolAllowed('mcp_doctor')) return;

  const handler: ToolCallback<z.ZodRawShape> = (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      if (!rl.tryConsume()) throw new RateLimitError();
      log.logToolCall('mcp_doctor', {}, false);

      const origin = whmcsOrigin(config.WHMCS_API_URL);
      const profile = await getWhmcsVersionProfile(whmcs);
      const oidcPhp = await fetchJson(`${origin}/oauth/openid-configuration.php`);
      const oidcWellKnown = await fetchJson(`${origin}/.well-known/openid-configuration`);
      const jwksUri =
        typeof oidcPhp.body?.jwks_uri === 'string'
          ? oidcPhp.body.jwks_uri
          : `${origin}/oauth/certs.php`;
      const jwks = await fetchJson(jwksUri);
      const jwksKeys = Array.isArray(jwks.body?.keys) ? jwks.body.keys : [];

      const role = {
        WhmcsDetails: await probeAction(whmcs, 'WhmcsDetails', {}),
        GetAdminDetails: await probeAction(whmcs, 'GetAdminDetails', {}),
        GetConfigurationValue: await probeAction(whmcs, 'GetConfigurationValue', {
          setting: 'Version',
        }),
      };

      const usersCap = getCapability('GetUsers');
      const staffIds = [...parseStaffConsumerIds(config.MCP_STAFF_CONSUMER_IDS)];
      const staffOidcSubs = [...parseStaffConsumerIds(config.MCP_STAFF_OIDC_SUBS)];
      const forbiddenIssuers = collectForbiddenWhmcsIssuers({
        apiUrl: config.WHMCS_API_URL,
        oidcIssuer: config.MCP_WHMCS_OIDC_ISSUER,
      });
      const issuersIncludeWhmcs = oauthIssuersIncludeWhmcs(
        config.MCP_OAUTH_ISSUERS,
        forbiddenIssuers
      );
      const registry = getConsumerRegistry();
      const emptyAllowedActions = registry
        .filter((c) => !c.anonymous && c.allowedActions.length === 0)
        .map((c) => c.id);

      const warnings: string[] = [];
      if (profile.family !== '8.13' && profile.family !== 'unknown') {
        warnings.push(`version family is '${profile.family}', production baseline is 8.13`);
      }
      if (!oidcWellKnown.ok) {
        warnings.push(
          '/.well-known/openid-configuration is not available (expected 404 without rewrite)'
        );
      }
      if (jwksKeys.length === 0) {
        warnings.push(
          'OIDC JWKS keys[] is empty — ID token signature verification cannot succeed until keys are published'
        );
      }
      if (config.MCP_ENV === 'production' && hasStdioDefaultToken()) {
        warnings.push(
          'MCP_DEFAULT_CONSUMER_AUTH_TOKEN is set — local stdio escape hatch only, not production Grok identity'
        );
      }
      if (staffIds.length === 0 && staffOidcSubs.length === 0) {
        warnings.push(
          'MCP_STAFF_CONSUMER_IDS and MCP_STAFF_OIDC_SUBS are empty — no principal can run staff ops_ask jobs'
        );
      }
      if (issuersIncludeWhmcs) {
        warnings.push(
          'MCP_OAUTH_ISSUERS includes the WHMCS origin — WHMCS tokens are not MCP-audience tokens (ADR-0002). Use a federation AS.'
        );
      }
      if (emptyAllowedActions.length > 0) {
        warnings.push(
          `consumers with empty allowedActions (unrestricted legacy): ${emptyAllowedActions.join(', ')}`
        );
      }
      if (!config.MCP_CUSTOMER_USER_API_PROVEN) {
        warnings.push(
          'customer user-delegated API unproven — customer ops_ask jobs stay link/handoff'
        );
      }
      if (
        config.MCP_OAUTH_ENABLED &&
        (config.MCP_OAUTH_RESOURCE === undefined || config.MCP_OAUTH_ISSUERS.length === 0)
      ) {
        warnings.push('MCP_OAUTH_ENABLED is on but RESOURCE/ISSUERS are incomplete');
      }
      if (config.MCP_WRITE_INTENT_STORE_PATH.trim() === '') {
        warnings.push('MCP_WRITE_INTENT_STORE_PATH unset — write intents are process-local');
      }

      const payload = {
        ok: warnings.length === 0,
        endpoint: getWhmcsApiEndpoint(),
        origin,
        whmcs_version: {
          family: profile.family,
          version: profile.version,
          release: profile.release,
        },
        oidc: {
          discovery_php: {
            ok: oidcPhp.ok,
            status: oidcPhp.status,
            issuer: oidcPhp.body?.issuer,
            scopes_supported: oidcPhp.body?.scopes_supported,
            id_token_signing_alg_values_supported:
              oidcPhp.body?.id_token_signing_alg_values_supported,
            claims_supported: oidcPhp.body?.claims_supported,
          },
          well_known: { ok: oidcWellKnown.ok, status: oidcWellKnown.status },
          jwks: { ok: jwks.ok, status: jwks.status, key_count: jwksKeys.length },
        },
        api_role: role,
        get_users: { status: usersCap.status, capability: usersCap.capability },
        oauth_rs: {
          enabled: config.MCP_OAUTH_ENABLED,
          resource_configured: config.MCP_OAUTH_RESOURCE !== undefined,
          issuer_count: config.MCP_OAUTH_ISSUERS.length,
          federation: 'required',
          whmcs_issuer_rejected: true,
          issuers_include_whmcs_origin: issuersIncludeWhmcs,
          note: 'WHMCS ID token aud is the WHMCS OAuth client id, not MCP_OAUTH_RESOURCE. Federation is the chosen pattern (ADR-0002.3); RFC 8693 is the alternate. Raw WHMCS Bearer tokens are rejected.',
        },
        staff_consumer_ids: staffIds,
        staff_oidc_subs: staffOidcSubs,
        customer_user_api_proven: config.MCP_CUSTOMER_USER_API_PROVEN,
        stdio_default_token: hasStdioDefaultToken(),
        read_audit_configured:
          typeof config.MCP_READ_AUDIT_PATH === 'string' &&
          config.MCP_READ_AUDIT_PATH.trim() !== '',
        effect_ledger_configured:
          typeof config.MCP_EFFECT_LEDGER_PATH === 'string' &&
          config.MCP_EFFECT_LEDGER_PATH.trim() !== '',
        intent_store_configured: config.MCP_WRITE_INTENT_STORE_PATH.trim() !== '',
        empty_allowed_actions: emptyAllowedActions,
        warnings,
      };

      log.logToolResult('mcp_doctor', true, Date.now() - t0);
      return {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    } catch (e) {
      log.logToolResult(
        'mcp_doctor',
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ isError: true, error: e.message }) }],
          structuredContent: { isError: true, error: e.message },
          isError: true,
        };
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    'mcp_doctor',
    {
      description:
        'Read-only MCP + WHMCS 8.13.7 doctor: version family, OIDC discovery, API-role probes, OAuth RS config, staff consumer/OIDC allow-lists, allowedActions gaps.',
      inputSchema: { ...z.object({}).shape, ...AUTH_SHAPE },
      outputSchema: DOCTOR_OUTPUT,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handler
  );
}
