/**
 * Configuration module for WHMCS MCP Server
 * Loads and validates all environment variables using Zod
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

// Load .env file
loadEnv();

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
  MCP_CLIENT_CUSTOM_FIELD_LABELS: z.preprocess(
    (val) => {
      if (!val || val === '') return {};
      return Object.fromEntries(
        String(val)
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
}).superRefine((val, ctx) => {
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
