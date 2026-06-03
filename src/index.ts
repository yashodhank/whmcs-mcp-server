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
import { RateLimiter } from './rateLimiter.js';
import { WhmcsClient } from './whmcs/WhmcsClient.js';

// Tool registrations
import { registerClientTools } from './tools/clients.js';
import { registerBillingTools } from './tools/billing.js';
import { registerOrderTools } from './tools/orders.js';
import { registerServiceTools } from './tools/services.js';
import { registerDomainTools } from './tools/domains.js';
import { registerSupportTools } from './tools/support.js';
import { registerListTools } from './tools/listTools.js';
import { registerReportingListTools } from './tools/reportingListTools.js';
import { registerInfraTools } from './tools/infraTools.js';
import { registerTicketThreadTool } from './tools/ticketThreadTool.js';
import { registerAggregatorTools } from './tools/aggregators.js';
import { registerCapabilityShellTools } from './tools/capabilityShellTools.js';
import { registerWriteFlowTools } from './tools/writeFlow.js';

// Resource registrations
import { registerResources } from './resources/index.js';
import { registerPlaybookResource } from './playbook/whmcsOpsPlaybook.js';
import { registerCompat9xResource } from './resources/compat9x.js';

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
    toolAllowlist: config.MCP_TOOL_ALLOWLIST.length > 0 
      ? config.MCP_TOOL_ALLOWLIST 
      : 'all tools enabled',
  });
  
  // Initialize rate limiter
  const rateLimiter = new RateLimiter(logger);
  rateLimiterInstance = rateLimiter; // Store for graceful shutdown
  
  // Initialize WHMCS client
  const whmcsClient = new WhmcsClient(config, logger);
  
  // Create MCP server
  const server = new McpServer({
    name: 'whmcs-mcp-server',
    version: '1.0.0',
  });
  
  // Register all tools
  logger.info('Registering MCP tools...');
  registerClientTools(server, whmcsClient, logger, rateLimiter);
  registerBillingTools(server, whmcsClient, logger, rateLimiter);
  registerOrderTools(server, whmcsClient, logger, rateLimiter);
  registerServiceTools(server, whmcsClient, logger, rateLimiter);
  registerDomainTools(server, whmcsClient, logger, rateLimiter);
  registerSupportTools(server, whmcsClient, logger, rateLimiter);
  registerListTools(server, whmcsClient, logger, rateLimiter);
  registerReportingListTools(server, whmcsClient, logger, rateLimiter);
  registerInfraTools(server, whmcsClient, logger, rateLimiter);
  registerTicketThreadTool(server, whmcsClient, logger, rateLimiter);
  registerAggregatorTools(server, whmcsClient, logger, rateLimiter);
  registerCapabilityShellTools(server, whmcsClient, logger, rateLimiter);
  registerWriteFlowTools(server, whmcsClient, logger, rateLimiter);

  // Register resources
  logger.info('Registering MCP resources...');
  registerResources(server, whmcsClient, logger, rateLimiter);
  registerPlaybookResource(server, logger);
  registerCompat9xResource(server, logger);
  
  // Connect with stdio transport
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

function gracefulShutdown(signal: string): void {
  process.stderr.write(`\n🛑 Received ${signal}, shutting down gracefully...\n`);
  if (rateLimiterInstance) {
    rateLimiterInstance.cleanup();
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
