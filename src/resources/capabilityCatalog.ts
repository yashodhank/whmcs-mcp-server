import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, isToolAllowed, resolveWhmcsApiEndpoint } from '../config.js';
import { buildCapabilityDiscovery } from '../catalog/discovery.js';
import type { OperationCatalog } from '../catalog/registry.js';
import { fingerprintCapabilityEvidenceTarget } from '../governance/capabilityEvidence.js';
import { CAPABILITY_REGISTRY } from '../governance/capabilities.js';
import { getCurrentRequestContext } from '../mcp/requestContext.js';

function currentCapabilityGrants(): ReadonlySet<string> | undefined {
  const context = getCurrentRequestContext();
  if (context === undefined || context.identity.authMode === 'stdio') return undefined;
  const grants = new Set(context.identity.capabilityActionGrants);
  return new Set(
    Object.values(CAPABILITY_REGISTRY)
      .filter((capability) => grants.has(capability.action) || grants.has(capability.capability))
      .map((capability) => capability.capability)
  );
}

export function registerCapabilityCatalogResource(
  server: McpServer,
  catalog: OperationCatalog
): void {
  const evidenceTarget = fingerprintCapabilityEvidenceTarget({
    installationIdentity: resolveWhmcsApiEndpoint(config.WHMCS_API_URL),
    configuration: {
      identifier: config.WHMCS_IDENTIFIER,
      accessMode: config.MCP_ACCESS_MODE,
      governanceEnabled: config.MCP_GOVERNANCE_ENABLED,
      toolAllowlist: [...config.MCP_TOOL_ALLOWLIST].sort(),
    },
    catalogVersion: catalog.version,
  });

  server.resource('capability-catalog-v2', 'whmcs://capabilities/v2', (uri) => {
    const payload = buildCapabilityDiscovery(catalog, {
      operationAllowed: isToolAllowed,
      // Modern HTTP grants come only from its authenticated ConsumerProfile.
      // Legacy and stdio resource reads have no authenticated profile and
      // therefore continue to fail closed for consumer-filtered operations.
      allowedCapabilityIds: currentCapabilityGrants(),
      evidenceTarget,
      availableProtocolFeatures: ['resources', 'tools'],
    });
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: 'application/json',
          text: JSON.stringify(payload),
        },
      ],
    };
  });
}
