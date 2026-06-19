/**
 * Global test setup for WHMCS MCP Server
 *
 * IMPORTANT: This test suite is designed to run against a PRODUCTION WHMCS instance.
 * - Only READ operations are tested by default
 * - WRITE operations are SKIPPED unless MCP_TEST_WRITE_MODE=true
 * - Any created test data must be cleaned up automatically
 * - No modifications to existing accounts, domains, or services
 */

import 'dotenv/config';

export async function setup() {
  // Validate that required env vars are set for testing
  const required = ['WHMCS_API_URL', 'WHMCS_IDENTIFIER', 'WHMCS_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables for testing:');
    console.error(`   ${missing.join(', ')}`);
    console.error('');
    console.error('Please create a .env file with WHMCS API credentials.');
    process.exit(1);
  }

  console.log('');
  console.log('🧪 WHMCS MCP Server Test Suite');
  console.log('================================');
  console.log(`   API URL: ${process.env.WHMCS_API_URL}`);
  console.log(`   Mode: ${process.env.MCP_MODE || 'read_only (default)'}`);
  console.log(
    `   Write Tests: ${process.env.MCP_TEST_WRITE_MODE === 'true' ? 'ENABLED' : 'DISABLED (safe mode)'}`
  );
  console.log('');

  // Store test context
  globalThis.__TEST_CONTEXT__ = {
    createdClientIds: [],
    writeTestsEnabled: process.env.MCP_TEST_WRITE_MODE === 'true',
  };
}

export async function teardown() {
  const ctx = globalThis.__TEST_CONTEXT__;

  if (ctx?.createdClientIds?.length > 0) {
    console.log('');
    console.log('⚠️  CLEANUP REQUIRED:');
    console.log('   The following test clients were created and may need manual cleanup:');
    ctx.createdClientIds.forEach((id: number) => {
      console.log(`   - Client ID: ${id}`);
    });
    console.log('');
  }

  console.log('🧪 Test suite complete.');
}

// TypeScript declaration for global context
declare global {
  var __TEST_CONTEXT__: {
    createdClientIds: number[];
    writeTestsEnabled: boolean;
  };
}
