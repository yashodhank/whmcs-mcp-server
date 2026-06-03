/**
 * WHMCS MCP Server Entry Point
 * 
 * A production-ready Model Context Protocol (MCP) server for WHMCS administration.
 * Supports AI agents (via Cursor or other MCP hosts) to manage WHMCS installations.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from './config.js';
import { Logger } from './logging.js';
import { startHttpServer } from './http/httpServer.js';
import { initMcpLogging } from './mcpLogging.js';
import { RateLimiter } from './rateLimiter.js';
import { WhmcsClient } from './whmcs/WhmcsClient.js';

// Tool registrations
import { registerClientTools } from './tools/clients.js';
import { registerBillingTools } from './tools/billing.js';
import { registerOrderTools } from './tools/orders.js';
import { registerDomainTools } from './tools/domains.js';
import { registerSupportTools } from './tools/support.js';
import { registerListTools } from './tools/listTools.js';
import { registerReportingListTools } from './tools/reportingListTools.js';
import { registerInfraTools } from './tools/infraTools.js';
import { registerContactsTools } from './tools/contactsTools.js';
import { registerBillingReadTools } from './tools/billingReadTools.js';
import { registerTicketMetaTools } from './tools/ticketMetaTools.js';
import { registerQuoteTools } from './tools/quoteTools.js';
import { registerSystemRefTools } from './tools/systemRefTools.js';
import { registerWhmcsPrompts } from './prompts/whmcsPrompts.js';
import { registerTicketThreadTool } from './tools/ticketThreadTool.js';
import { registerAggregatorTools } from './tools/aggregators.js';
import { registerCapabilityShellTools } from './tools/capabilityShellTools.js';
import { registerWriteFlowTools } from './tools/writeFlow.js';

// Resource registrations
import { registerResources } from './resources/index.js';
import { registerPlaybookResource } from './playbook/whmcsOpsPlaybook.js';
import { registerCompat9xResource } from './resources/compat9x.js';

/**
 * Build a fully-configured McpServer (capabilities + all tools/resources/
 * prompts registered). Extracted as a factory so BOTH the stdio path and the
 * Streamable HTTP transport (which builds one server instance per session) get
 * a byte-identical server surface from the same code. Pure construction — it
 * does not connect any transport.
 */
export function buildServer(deps: {
  whmcsClient: WhmcsClient;
  logger: Logger;
  rateLimiter: RateLimiter;
}): McpServer {
  const { whmcsClient, logger, rateLimiter } = deps;

  // Create MCP server.
  // Declare the `logging` capability (spec 2025-11-25 logging utility). This is
  // what makes the SDK auto-install its `logging/setLevel` request handler and
  // enables the `notifications/message` emit path. The McpLoggingBridge below
  // rides on top of server.server.sendLoggingMessage.
  const server = new McpServer(
    {
      name: 'whmcs-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: { logging: {} },
    }
  );

  // Initialize the MCP logging bridge (server->client structured logs). No-op
  // until a logging-capable client connects; default behaviour unchanged.
  initMcpLogging(server);

  // Register all tools
  logger.info('Registering MCP tools...');
  registerClientTools(server, whmcsClient, logger, rateLimiter);
  registerBillingTools(server, whmcsClient, logger, rateLimiter);
  registerOrderTools(server, whmcsClient, logger, rateLimiter);
  // Track C: legacy direct-mutate suspend/unsuspend/terminate_service tools
  // RETIRED — service lifecycle now flows through the governed tiered model
  // (write scopes service:suspend/unsuspend/terminate via the write-flow).
  registerDomainTools(server, whmcsClient, logger, rateLimiter);
  registerSupportTools(server, whmcsClient, logger, rateLimiter);
  registerListTools(server, whmcsClient, logger, rateLimiter);
  registerReportingListTools(server, whmcsClient, logger, rateLimiter);
  registerInfraTools(server, whmcsClient, logger, rateLimiter);
  registerContactsTools(server, whmcsClient, logger, rateLimiter);
  registerBillingReadTools(server, whmcsClient, logger, rateLimiter);
  registerTicketMetaTools(server, whmcsClient, logger, rateLimiter);
  registerQuoteTools(server, whmcsClient, logger, rateLimiter);
  registerSystemRefTools(server, whmcsClient, logger, rateLimiter);
  registerTicketThreadTool(server, whmcsClient, logger, rateLimiter);
  registerAggregatorTools(server, whmcsClient, logger, rateLimiter);
  registerCapabilityShellTools(server, whmcsClient, logger, rateLimiter);
  registerWriteFlowTools(server, whmcsClient, logger, rateLimiter);

  // Register resources
  logger.info('Registering MCP resources...');
  registerResources(server, whmcsClient, logger, rateLimiter);
  registerPlaybookResource(server, logger);
  registerCompat9xResource(server, logger);

  // Register MCP prompts (reusable WHMCS ops playbooks)
  logger.info('Registering MCP prompts...');
  registerWhmcsPrompts(server);

  return server;
}

/**
 * Main server initialization
 */
async function main(): Promise<void> {
  // Initialize logger (writes to stderr only)
  const logger = Logger.create();

  logger.info('Starting WHMCS MCP Server', {
    mode: config.MCP_MODE,
    debug: config.MCP_DEBUG,
    rateLimit: config.MCP_RATE_LIMIT,
    maxPageSize: config.MCP_MAX_PAGE_SIZE,
    accessMode: config.MCP_ACCESS_MODE,
    allowedClientIds: config.MCP_ALLOWED_CLIENT_IDS.length > 0 ? config.MCP_ALLOWED_CLIENT_IDS : 'not set',
    authEnabled: !!config.MCP_AUTH_TOKEN,
    transport: config.MCP_TRANSPORT,
    toolAllowlist: config.MCP_TOOL_ALLOWLIST.length > 0
      ? config.MCP_TOOL_ALLOWLIST
      : 'all tools enabled',
  });

  // Initialize rate limiter
  const rateLimiter = new RateLimiter(logger);
  rateLimiterInstance = rateLimiter; // Store for graceful shutdown

  // Initialize WHMCS client
  const whmcsClient = new WhmcsClient(config, logger);

  // ── Transport selection (MCP Adoption #10) ───────────────────────────────
  // Default `stdio` is byte-identical to the pre-HTTP server. `http` opts into
  // the Streamable HTTP transport with bearer auth bridged to the consumer
  // registry. The HTTP server builds one McpServer per session via buildServer.
  if (config.MCP_TRANSPORT === 'http') {
    httpServerHandle = await startHttpServer({
      logger,
      buildServer: () => buildServer({ whmcsClient, logger, rateLimiter }),
    });
    return;
  }

  // Default: stdio. Build the single server and connect StdioServerTransport.
  const server = buildServer({ whmcsClient, logger, rateLimiter });
  const transport = new StdioServerTransport();

  logger.info('MCP Server ready, connecting via stdio...');

  try {
    await server.connect(transport);
  } catch (error) {
    logger.error('Failed to connect MCP server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  process.stderr.write(`\n❌ Uncaught exception: ${error.message}\n${error.stack}\n`);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const detail = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(`\n❌ Unhandled rejection: ${detail}\n`);
  process.exit(1);
});

// Graceful shutdown handlers
let rateLimiterInstance: RateLimiter | null = null;
let httpServerHandle: { close: () => Promise<void> } | null = null;

function gracefulShutdown(signal: string): void {
  process.stderr.write(`\n🛑 Received ${signal}, shutting down gracefully...\n`);
  if (rateLimiterInstance) {
    rateLimiterInstance.cleanup();
  }
  if (httpServerHandle) {
    // Best-effort: close listeners + active transports, then exit.
    void httpServerHandle.close().finally(() => { process.exit(0); });
    return;
  }
  process.exit(0);
}

process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });

// Start the server
main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n❌ Failed to start server: ${detail}\n`);
  process.exit(1);
});
