import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, isToolAllowed, resolveWhmcsApiEndpoint } from '../config.js';
import { buildCapabilityDiscovery } from '../catalog/discovery.js';
import type { OperationCatalog } from '../catalog/registry.js';
import { fingerprintCapabilityEvidenceTarget } from '../governance/capabilityEvidence.js';

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
      // Legacy resource registration has no request-bound consumer identity.
      // It therefore fails closed for consumer-filtered operations until the
      // protocol/catalog integration seam supplies that identity.
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
