#!/usr/bin/env tsx
/**
 * Quick test script to verify WHMCS API connectivity
 */

import { config } from './src/config.js';
import { Logger } from './src/logging.js';
import { WhmcsClient } from './src/whmcs/WhmcsClient.js';

async function testConnection() {
  console.error('🔧 Testing WHMCS MCP Server Configuration...\n');
  
  console.error('📋 Configuration:');
  console.error(`   API URL: ${config.WHMCS_API_URL}`);
  console.error(`   Mode: ${config.MCP_MODE}`);
  console.error(`   Access Mode: ${config.MCP_ACCESS_MODE}`);
  console.error(`   Allowed Clients: ${config.MCP_ALLOWED_CLIENT_IDS.length > 0 ? config.MCP_ALLOWED_CLIENT_IDS.join(',') : 'none'}`);
  console.error(`   Auth Token Enabled: ${config.MCP_AUTH_TOKEN ? 'yes' : 'no'}`);
  console.error(`   Rate Limit: ${config.MCP_RATE_LIMIT}/sec`);
  console.error(`   Debug: ${config.MCP_DEBUG}\n`);
  
  const logger = Logger.create();
  const client = new WhmcsClient(config, logger);
  
  console.error('🔌 Testing API connection...\n');
  
  try {
    // Test with a simple API call - GetHealthCheck or GetAdminDetails
    const result = await client.read<{
      result: string;
      totalresults?: number;
    }>('GetClients', {
      limitnum: 1,
    });
    
    console.error('✅ API connection successful!');
    console.error(`   Response result: ${result.result}`);
    if (result.totalresults !== undefined) {
      console.error(`   Total clients in WHMCS: ${result.totalresults}`);
    }
    console.error('\n🎉 WHMCS MCP Server is ready to use!\n');
    
  } catch (error) {
    console.error('❌ API connection failed!');
    console.error(`   Error: ${error instanceof Error ? error.message : String(error)}`);
    console.error('\n⚠️  Please check your credentials and API URL.\n');
    process.exit(1);
  }
}

testConnection();
