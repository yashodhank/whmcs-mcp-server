import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isToolAllowed } from '../config.js';
import type { OperationDefinition } from './types.js';

/** Register a catalog definition without changing the existing MCP contract. */
export function registerCatalogOperation(server: McpServer, definition: OperationDefinition): void {
  if (!isToolAllowed(definition.publicName)) return;
  if (definition.handler === undefined) {
    throw new Error(
      `Catalog operation '${definition.id}' is descriptor-only and cannot be registered`
    );
  }
  server.registerTool(
    definition.publicName,
    {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
      annotations: { ...definition.annotations },
    },
    definition.handler
  );
}
