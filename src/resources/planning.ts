import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const GUIDANCE = {
  schema_version: 1,
  planir_version: '1.0',
  executable: false,
  boundary: {
    host: 'brainstorms alternatives and produces structured candidates',
    server: 'validates catalog facts, evidence, policy, risk, cost, DAG, TTL and hash',
    writes: 'draft_operation_plan may only create existing governed draft intents',
    excluded: ['server-side model calls', 'approval', 'execution', 'generic database reads'],
  },
  modes: {
    analyse: 'pure catalog/planning operations only',
    read_only: 'pure and explicitly bounded safe reads',
    draft_only: 'analysis/reads plus governed draft-intent creation; never approval/execution',
  },
  clients: {
    basic: ['inspect_operation_catalog', 'compile_operation_plan'],
    prompt_aware: ['plan_whmcs_operation', 'compile_operation_plan'],
    modern:
      'discover/cache/MRTR may improve UX only when supported; cancellation remains non-executable',
    offline:
      'compile from an exported snapshot only as stale/non-executable until online recompilation',
    future_tasks: 'requires a separately approved durable encrypted store',
  },
} as const;

export function registerPlanningResource(server: McpServer): void {
  server.resource('planir-guidance-v1', 'whmcs://planning/planir/v1', (uri) => ({
    contents: [
      {
        uri: uri.toString(),
        mimeType: 'application/json',
        text: JSON.stringify(GUIDANCE),
      },
    ],
  }));
}
