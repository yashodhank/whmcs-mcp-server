const SAFE_HOST_KEYS = [
  'PATH',
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
];

/**
 * Compatibility-significant catalog inputs. These values match the saved v1
 * fixture and override both a hostile parent shell and any local env files.
 */
export const CONTRACT_CATALOG_ENV = Object.freeze({
  MCP_ACCESS_MODE: 'admin',
  MCP_ALLOWED_CLIENT_IDS: '',
  MCP_ENABLE_LEGACY_WRITE_TOOLS: 'false',
  MCP_MAX_PAGE_SIZE: '100',
  MCP_TOOL_ALLOWLIST: '',
});

/** Build the minimal, inert environment used by MCP contract subprocesses. */
export function createMcpTestEnvironment(parentEnvironment, temporaryHome) {
  if (!temporaryHome) throw new Error('temporaryHome is required for an isolated MCP test child');

  const environment = {};
  for (const key of SAFE_HOST_KEYS) {
    const value = parentEnvironment[key];
    if (value !== undefined) environment[key] = value;
  }

  return Object.freeze({
    ...environment,
    HOME: temporaryHome,
    TMPDIR: temporaryHome,
    TEMP: temporaryHome,
    TMP: temporaryHome,
    CI: '1',
    NO_COLOR: '1',
    NODE_ENV: 'test',
    TZ: 'UTC',
    WHMCS_API_URL: 'https://whmcs.invalid',
    WHMCS_IDENTIFIER: 'mcp-contract-placeholder',
    WHMCS_SECRET: 'mcp-contract-placeholder',
    WHMCS_ACCESS_KEY: '',
    WHMCS_AUTO_IP_HEAL: 'false',
    MCP_ENV: 'production',
    MCP_MODE: 'read_only',
    MCP_STARTUP_HEALTHCHECK: 'off',
    MCP_TRANSPORT: 'stdio',
    MCP_GOVERNANCE_ENABLED: 'false',
    MCP_OAUTH_ENABLED: 'false',
    MCP_INTEGRATION_SKIP: '1',
    MCP_TEST_DISABLE_ENV_FILES: '1',
    ...CONTRACT_CATALOG_ENV,
  });
}
