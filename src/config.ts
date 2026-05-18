/**
 * Configuration module for WHMCS MCP Server
 * Loads and validates all environment variables using Zod
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

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

/**
 * Configuration schema with Zod validation
 */
const configSchema = z.object({
  // WHMCS API Configuration
  WHMCS_API_URL: z.string().min(1, 'WHMCS_API_URL is required'),
  WHMCS_IDENTIFIER: z.string().min(1, 'WHMCS_IDENTIFIER is required'),
  WHMCS_SECRET: z.string().min(1, 'WHMCS_SECRET is required'),
  WHMCS_ACCESS_KEY: z.preprocess(
    (val) => (val === undefined || val === '' ? undefined : String(val)),
    z.string().optional()
  ),
  // SEC-005: allow http for WHMCS_API_URL only when explicitly opted in
  WHMCS_ALLOW_HTTP: z.preprocess(
    (val) => val === 'true' || val === '1',
    z.boolean().default(false)
  ),
  MCP_AUTH_TOKEN: z.preprocess(
    (val) => (val === undefined || val === '' ? undefined : String(val)),
    z.string().optional()
  ),
  MCP_ACCESS_MODE: z.enum(['admin', 'client']).default('admin'),
  MCP_ALLOWED_CLIENT_IDS: z.preprocess(
    (val) => {
      if (!val || val === '') return [];
      return String(val)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
    },
    z.array(z.number().int().positive()).default([])
  ),
  
  // MCP Server Configuration
  MCP_ENV: z.enum(['local', 'staging', 'production']).default('production'),
  MCP_MODE: z.enum(['read_only', 'simulate', 'full']).default('read_only'),
  MCP_RATE_LIMIT: z.coerce.number().int().positive().default(10),
  MCP_DEBUG: z.preprocess(
    (val) => val === 'true' || val === '1',
    z.boolean().default(false)
  ),
  MCP_MAX_PAGE_SIZE: z.coerce.number().int().positive().max(500).default(100),
  MCP_TOOL_ALLOWLIST: z.preprocess(
    (val) => {
      if (!val || val === '') return [];
      return String(val).split(',').map((s) => s.trim()).filter(Boolean);
    },
    z.array(z.string()).default([])
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
}).superRefine((val, ctx) => {
  // SEC-005: WHMCS_API_URL must be a valid URL; require https unless WHMCS_ALLOW_HTTP=true
  let parsedUrl: URL | undefined;
  try {
    parsedUrl = new URL(val.WHMCS_API_URL);
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['WHMCS_API_URL'],
      message: 'WHMCS_API_URL must be a valid absolute URL (e.g. https://billing.example.com)',
    });
  }
  if (parsedUrl) {
    const scheme = parsedUrl.protocol;
    const httpAllowed = scheme === 'http:' && val.WHMCS_ALLOW_HTTP;
    if (scheme !== 'https:' && !httpAllowed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['WHMCS_API_URL'],
        message:
          scheme === 'http:'
            ? 'WHMCS_API_URL uses http: credentials would be sent in clear. Use https, or set WHMCS_ALLOW_HTTP=true to override (not recommended).'
            : `WHMCS_API_URL must use the https scheme (got "${scheme}").`,
      });
    }
  }

  if (val.MCP_ACCESS_MODE === 'client' && val.MCP_ALLOWED_CLIENT_IDS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
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
