/**
 * Configuration module for WHMCS MCP Server
 * Loads and validates all environment variables using Zod
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { PROD_NEVER_EXECUTABLE } from './write/types.js';

/**
 * Environment separation. `MCP_ENV` selects which env profile to layer on
 * top of the base `.env`:
 *   - local      → `.env.local`      (e.g. local dockerized WHMCS, http)
 *   - staging    → `.env.staging`
 *   - production  → `.env.production` (default; never weakens prod, e.g. SEC-005)
 *
 * Precedence (highest first): real process.env (explicit exports) >
 * `.env.<MCP_ENV>` > base `.env`. dotenv does not overwrite already-set
 * keys, so we load the env-specific file FIRST, then the base `.env`.
 */
const MCP_ENV = process.env.MCP_ENV ?? 'production';
loadEnv({ path: `.env.${MCP_ENV}`, quiet: true });
loadEnv({ quiet: true }); // base .env fallback

/**
 * MCP operation modes
 */
export type McpMode = 'read_only' | 'simulate' | 'full';

/** Block loopback, link-local metadata, and RFC1918 hosts (non-local MCP_ENV only). */
function isBlockedWhmcsHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const blocked = ['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254'];
  if (blocked.includes(host)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(host)) return true;
  return false;
}

function preprocessOptionalEnvString(val: unknown): string | undefined {
  if (val === undefined || val === '') return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return undefined;
}

function preprocessCommaSeparatedString(val: unknown): string {
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return '';
}

/**
 * Configuration schema with Zod validation
 */
const configSchema = z
  .object({
    // WHMCS API Configuration
    WHMCS_API_URL: z.string().min(1, 'WHMCS_API_URL is required'),
    WHMCS_IDENTIFIER: z.string().min(1, 'WHMCS_IDENTIFIER is required'),
    WHMCS_SECRET: z.string().min(1, 'WHMCS_SECRET is required'),
    WHMCS_ACCESS_KEY: z.preprocess(preprocessOptionalEnvString, z.string().optional()),
    // IP allowlist self-heal: on a 403 (caller IP missing from APIAllowedIPs,
    // typically after an ISP/proxy IP change) run scripts/whmcs-ip-updater
    // oneshot once and retry the call. Opt-in; the updater still needs its own
    // SSH env (WHMCS_SSH_HOST, WHMCS_SSH_USER, WHMCS_SSH_KEY,
    // WHMCS_SSH_KNOWN_HOSTS) and WHMCS_ROOT present in the environment.
    WHMCS_AUTO_IP_HEAL: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    WHMCS_IP_UPDATER_SCRIPT: z.preprocess(preprocessOptionalEnvString, z.string().optional()),
    WHMCS_IP_UPDATER_PYTHON: z.string().min(1).default('python3'),
    WHMCS_AUTO_IP_HEAL_COOLDOWN_MS: z.coerce.number().int().min(0).default(120000),
    WHMCS_AUTO_IP_HEAL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
    // SEC-005: allow http for WHMCS_API_URL only when explicitly opted in
    WHMCS_ALLOW_HTTP: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    MCP_AUTH_TOKEN: z.preprocess(preprocessOptionalEnvString, z.string().optional()),
    MCP_ACCESS_MODE: z.enum(['admin', 'client']).default('admin'),
    MCP_ALLOWED_CLIENT_IDS: z.preprocess((val) => {
      const raw = preprocessCommaSeparatedString(val);
      if (raw === '') return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    }, z.array(z.number().int().positive()).default([])),

    // MCP Server Configuration
    MCP_ENV: z.enum(['local', 'staging', 'production']).default('production'),
    MCP_MODE: z.enum(['read_only', 'simulate', 'full']).default('read_only'),
    MCP_RATE_LIMIT: z.coerce.number().int().positive().default(10),
    MCP_DEBUG: z.preprocess((val) => val === 'true' || val === '1', z.boolean().default(false)),
    MCP_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(500).default(100),
    MCP_TOOL_ALLOWLIST: z.preprocess((val) => {
      const raw = preprocessCommaSeparatedString(val);
      if (raw === '') return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }, z.array(z.string()).default([])),
    // ── F1: short-TTL in-memory READ cache (default OFF) ────────────────────
    // Caches ONLY idempotent reads for truly-static reference actions, to cut
    // repeated WHMCS API load. Default TTL 0 ⇒ cache DISABLED, so existing
    // behaviour/tests are byte-identical unless explicitly enabled. The cache
    // is per-WhmcsClient-instance and pure in-memory (no disk).
    MCP_READ_CACHE_TTL_MS: z.coerce.number().int().min(0).default(0),
    // Allowlist of WHMCS read actions eligible for caching (comma list). Only
    // actions in this set are cached, and only when MCP_READ_CACHE_TTL_MS > 0.
    // Default is a SMALL set of truly-static reference reads.
    MCP_READ_CACHE_ACTIONS: z.preprocess((val) => {
      const raw = preprocessCommaSeparatedString(val);
      if (raw === '') {
        return ['GetTLDPricing', 'GetRegistrars', 'GetSupportDepartments', 'GetProducts', 'GetCurrencies'];
      }
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }, z.array(z.string()).default(['GetTLDPricing', 'GetRegistrars', 'GetSupportDepartments', 'GetProducts', 'GetCurrencies'])),
    // Optional id:label map for client custom fields (e.g. "12:Tax ID,34:VAT Number").
    // Configured labels override WHMCS-provided field names when set.
    MCP_CLIENT_CUSTOM_FIELD_LABELS: z.preprocess(
      (val) => {
        const raw = preprocessCommaSeparatedString(val);
        if (raw === '') return {};
        return Object.fromEntries(
          raw
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean)
            .map((entry) => {
              const separatorIndex = entry.indexOf(':');
              if (separatorIndex === -1) return null;
              const id = Number.parseInt(entry.slice(0, separatorIndex).trim(), 10);
              const label = entry.slice(separatorIndex + 1).trim();
              if (!Number.isFinite(id) || id <= 0 || !label) return null;
              return [String(id), label] as const;
            })
            .filter((entry): entry is readonly [string, string] => entry !== null)
        );
      },
      z.record(z.string(), z.string()).default({})
    ),
    MCP_LARGE_REFUND_THRESHOLD: z.coerce.number().positive().default(1000),
    // Phase B governance: allow the deliberate anonymous llm_safe_summary
    // fallback for unknown/no-token callers. Never grants a privileged
    // profile; in production an `anonymous` registry entry is still required.
    MCP_ALLOW_ANON_LLM: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    // Phase B governance is OPT-IN and backward compatible. Off (default) =>
    // existing legacy tool output is preserved unchanged (no app/test breakage).
    // On => read tool/resource output is routed through the consumer-aware
    // projection boundary. Production stays read-only either way.
    MCP_GOVERNANCE_ENABLED: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    // ── Phase G+ controlled production write enablement ─────────────────────
    // ALL default to the SEALED posture: empty prod allowlist + zero caps +
    // kill switch off + empty durable paths (in-memory). With no env set,
    // production write behaviour is byte-identical to the legacy absolute deny.
    MCP_PROD_WRITE_AUTHORIZED: z.preprocess(
      (val) =>
        (typeof val === 'string' ? val : '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      z.array(z.string()).default([])
    ),
    // Non-prod runtime execution allowlist (dev/staging). Default [] ⇒ no
    // action authorized at runtime — sealed posture preserved. Mirrors the
    // MCP_PROD_WRITE_AUTHORIZED parser; consumed by writeFlow.runtimeAuthorizedActions().
    MCP_WRITE_EXECUTION_AUTHORIZED: z.preprocess(
      (val) =>
        (typeof val === 'string' ? val : '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      z.array(z.string()).default([])
    ),
    MCP_WRITE_KILL_SWITCH: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    // Tiered-friction safety lever. Default false ⇒ the per-environment write
    // allowlist is enforced for HIGH-RISK scopes only; low/medium scopes are
    // audit-gated and need no allowlist. Set true to restore strict
    // allowlist-for-ALL-tiers (legacy posture) for cautious deployments.
    MCP_WRITE_STRICT_ALLOWLIST: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(false)
    ),
    // Per-scope tightening (comma list). Scopes here ALWAYS require the write
    // allowlist even if low/medium risk. Default gates billing:invoice:create
    // (financial-document creation). Can only tighten, never loosen high-risk.
    // Set to empty to make every medium scope one-call.
    MCP_WRITE_STRICT_SCOPES: z.preprocess(
      (val) =>
        (typeof val === 'string' ? val : 'billing:invoice:create')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      z.array(z.string()).default(['billing:invoice:create'])
    ),
    // Separation-of-duties lever. Default TRUE ⇒ high-risk intents can never be
    // self-approved (drafter ≠ approver), and low/medium intents that carry an
    // approval record must also be distinctly approved. High-risk distinctness
    // is ALWAYS enforced by the gate regardless of this flag; this flag extends
    // the rule to low/medium approvals. Set false ONLY for single-operator dev
    // setups where a second consumer is impractical.
    MCP_WRITE_REQUIRE_DISTINCT_APPROVER: z.preprocess(
      (val) => val === 'true' || val === '1',
      z.boolean().default(true)
    ),
    // Empty ⇒ pure in-memory (legacy). A non-empty prod allowlist REQUIRES a
    // durable audit path (enforced below) so a production mutation is never
    // unauditable.
    MCP_WRITE_AUDIT_PATH: z.preprocess(
      (val) => (typeof val === 'string' ? val : ''),
      z.string().default('')
    ),
    MCP_WRITE_IDEMPOTENCY_PATH: z.preprocess(
      (val) => (typeof val === 'string' ? val : ''),
      z.string().default('')
    ),
    // Empty ⇒ pure in-memory (legacy — tally resets on restart). Operators
    // who set MCP_PROD_HIGH_RISK_DAILY_CAP SHOULD set this path so that a
    // restart does not reset the daily cap and allow cap-bypass via crash-loop.
    // Missing path is fail-safe: the cap still enforces per-run.
    MCP_WRITE_DAY_AMOUNTS_PATH: z.preprocess(
      (val) => (typeof val === 'string' ? val : ''),
      z.string().default('')
    ),
    // High-risk (money) caps. Default 0 ⇒ every high-risk action denied until
    // explicitly configured.
    MCP_PROD_HIGH_RISK_PER_ACTION_CAP: z.coerce.number().min(0).default(0),
    MCP_PROD_HIGH_RISK_DAILY_CAP: z.coerce.number().min(0).default(0),

    // ── MCP Adoption #10 — Streamable HTTP transport (OPT-IN) ───────────────
    // Transport selection. Default `stdio` ⇒ behaviour is byte-identical to the
    // pre-HTTP server (StdioServerTransport). `http` starts a node:http server
    // running the SDK StreamableHTTPServerTransport, with bearer-token auth
    // bridged to the EXISTING consumer registry (same tokens as stdio). Full
    // OAuth2.1/PRM is a documented follow-up (see docs/MCP_ADOPTION.md #9).
    MCP_TRANSPORT: z.enum(['stdio', 'http']).default('stdio'),
    // Bind address + port for the HTTP transport. Localhost by default so the
    // server is not exposed off-box unless explicitly reconfigured.
    MCP_HTTP_HOST: z.preprocess(
      (val) => (typeof val === 'string' && val.trim() !== '' ? val.trim() : '127.0.0.1'),
      z.string().default('127.0.0.1')
    ),
    MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    // Single MCP endpoint path (POST/GET/DELETE). Default `/mcp`.
    MCP_HTTP_PATH: z.preprocess(
      (val) => (typeof val === 'string' && val.trim() !== '' ? val.trim() : '/mcp'),
      z.string().default('/mcp')
    ),
    // DNS-rebinding guard (spec guidance). A comma list of permitted Origin
    // header values. Default EMPTY ⇒ no cross-origin requests are allowed: a
    // request whose Origin header is present must match an entry here, else 403.
    // (Requests with no Origin header — typical for native/CLI MCP clients —
    // are unaffected by this check.)
    MCP_HTTP_ALLOWED_ORIGINS: z.preprocess((val) => {
      const raw = preprocessCommaSeparatedString(val);
      if (raw === '') return [];
      return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }, z.array(z.string()).default([])),
    // HTTP session bounds (memory/DoS guard). Hard cap on concurrent sessions
    // (LRU-evicted) + idle TTL after which an unused session is swept/closed.
    MCP_HTTP_MAX_SESSIONS: z.coerce.number().int().min(1).max(100000).default(256),
    MCP_HTTP_SESSION_IDLE_MS: z.coerce.number().int().min(1000).default(300000),
    // ── OAuth 2.1 resource-server (HTTP only; default OFF ⇒ registry bearer) ──
    // When enabled, HTTP bearer tokens are validated as JWTs (jose) against the
    // configured issuer(s) with audience == MCP_OAUTH_RESOURCE (RFC 8707), and a
    // PRM document is served at /.well-known/oauth-protected-resource (RFC 9728).
    MCP_OAUTH_ENABLED: z.preprocess((val) => val === 'true' || val === '1', z.boolean().default(false)),
    MCP_OAUTH_RESOURCE: z.preprocess(preprocessOptionalEnvString, z.string().optional()),
    MCP_OAUTH_AUDIENCE: z.preprocess(preprocessOptionalEnvString, z.string().optional()),
    MCP_OAUTH_ISSUERS: z.preprocess((val) => {
      const raw = preprocessCommaSeparatedString(val);
      if (raw === '') return [];
      return raw.split(',').map((s) => s.trim()).filter(Boolean);
    }, z.array(z.string()).default([])),
  })
  .superRefine((val, ctx) => {
    // Phase G+ fail-fast misconfiguration guards.
    if (val.MCP_PROD_WRITE_AUTHORIZED.length > 0) {
      // No production execution without a durable audit trail (fail-closed).
      if (val.MCP_WRITE_AUDIT_PATH.trim() === '') {
        ctx.addIssue({
          code: 'custom',
          path: ['MCP_WRITE_AUDIT_PATH'],
          message:
            'MCP_WRITE_AUDIT_PATH is required when MCP_PROD_WRITE_AUTHORIZED is non-empty (production mutations must be durably auditable)',
        });
      }
      // A permanently-blocked action must never be allowlisted, even though the
      // gate would still refuse it — reject at config time (fail fast).
      const forbidden = val.MCP_PROD_WRITE_AUTHORIZED.filter((a) => PROD_NEVER_EXECUTABLE.has(a));
      if (forbidden.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['MCP_PROD_WRITE_AUTHORIZED'],
          message: `MCP_PROD_WRITE_AUTHORIZED must not contain permanently-blocked actions: ${forbidden.join(', ')}`,
        });
      }
    }
    // SEC-005: WHMCS_API_URL must be a valid URL; require https unless WHMCS_ALLOW_HTTP=true
    let parsedUrl: URL | undefined;
    try {
      parsedUrl = new URL(val.WHMCS_API_URL);
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['WHMCS_API_URL'],
        message: 'WHMCS_API_URL must be a valid absolute URL (e.g. https://billing.example.com)',
      });
    }
    if (parsedUrl) {
      const scheme = parsedUrl.protocol;
      const httpAllowed = scheme === 'http:' && val.WHMCS_ALLOW_HTTP;
      if (scheme !== 'https:' && !httpAllowed) {
        ctx.addIssue({
          code: 'custom',
          path: ['WHMCS_API_URL'],
          message:
            scheme === 'http:'
              ? 'WHMCS_API_URL uses http: credentials would be sent in clear. Use https, or set WHMCS_ALLOW_HTTP=true to override (not recommended).'
              : `WHMCS_API_URL must use the https scheme (got "${scheme}").`,
        });
      }
      if (val.MCP_ENV !== 'local' && isBlockedWhmcsHost(parsedUrl.hostname)) {
        ctx.addIssue({
          code: 'custom',
          path: ['WHMCS_API_URL'],
          message:
            'WHMCS_API_URL must not target localhost, private, or link-local addresses when MCP_ENV is not local (use MCP_ENV=local for dockerized dev).',
        });
      }
    }

    if (val.MCP_ACCESS_MODE === 'client' && val.MCP_ALLOWED_CLIENT_IDS.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['MCP_ALLOWED_CLIENT_IDS'],
        message: 'MCP_ALLOWED_CLIENT_IDS is required when MCP_ACCESS_MODE=client',
      });
    }
  });

/**
 * Validated application configuration type
 */
export type AppConfig = z.infer<typeof configSchema>;

/**
 * Parse and validate configuration from environment variables
 * Fails fast at startup if any required variable is missing or invalid
 */
function loadConfig(): AppConfig {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    // Write to stderr, not stdout (MCP stdio constraint)
    process.stderr.write(`\n❌ Configuration validation failed:\n${errors}\n\n`);
    process.stderr.write('Please check your .env file and environment variables.\n');
    process.exit(1);
  }

  return result.data;
}

// Export singleton config instance
export const config = loadConfig();

/**
 * Get the full WHMCS API endpoint URL
 */
export function getWhmcsApiEndpoint(): string {
  const baseUrl = config.WHMCS_API_URL.replace(/\/$/, ''); // Remove trailing slash
  return `${baseUrl}/includes/api.php`;
}

/**
 * Check if a tool is allowed based on the allowlist
 * If allowlist is empty, all tools are allowed
 */
export function isToolAllowed(toolName: string): boolean {
  if (config.MCP_TOOL_ALLOWLIST.length === 0) {
    return true;
  }
  return config.MCP_TOOL_ALLOWLIST.includes(toolName);
}

/**
 * Track C — legacy DIRECT-MUTATE write tools (create_ticket, reply_ticket,
 * create_invoice, mark_invoice_paid, add_credit, record_refund) DUPLICATE
 * governed write scopes but bypass the tiered governance model. RETIRED from the
 * default tool surface; the governed write-flow is the path. Read from
 * `process.env` at registration time so it's controllable per process and in
 * tests. Set `MCP_ENABLE_LEGACY_WRITE_TOOLS=true` to temporarily re-expose them.
 */
export function legacyWriteToolsEnabled(): boolean {
  const v = process.env.MCP_ENABLE_LEGACY_WRITE_TOOLS;
  return v === 'true' || v === '1';
}
