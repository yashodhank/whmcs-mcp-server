#!/usr/bin/env tsx
/**
 * Debug script: call WHMCS DomainWhois API and print full response.
 * Use to diagnose HTTP 500 or other API issues with domain availability checks.
 *
 * Usage: npm run debug:domain-whois [domain1] [domain2] ...
 * Default domains: dsri-marks.com (not registered), securiace.com (registered)
 *
 * Requires .env with WHMCS_API_URL, WHMCS_IDENTIFIER, WHMCS_SECRET.
 */

import axios from 'axios';
import { config, getWhmcsApiEndpoint } from '../src/config.js';

const DEFAULT_DOMAINS = ['dsri-marks.com', 'securiace.com'];

async function main(): Promise<void> {
  const domains = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DOMAINS;

  console.error('=== WHMCS DomainWhois debug ===\n');

  const endpoint = getWhmcsApiEndpoint();
  console.error(`Endpoint: ${endpoint}`);
  console.error(`Domains:  ${domains.join(', ')}\n`);

  for (const domain of domains) {
    console.error(`--- Domain: ${domain} ---`);
    const body = new URLSearchParams({
      action: 'DomainWhois',
      identifier: config.WHMCS_IDENTIFIER,
      secret: config.WHMCS_SECRET,
      responsetype: 'json',
      domain,
    } as Record<string, string>);

    try {
      const response = await axios.post(endpoint, body, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validateStatus: () => true, // accept any status to capture body
      });

      console.error(`HTTP status: ${response.status} ${response.statusText}`);
      console.error('Response body:');
      if (typeof response.data === 'object') {
        console.log(JSON.stringify(response.data, null, 2));
      } else {
        console.log(response.data);
      }
      console.error('');
    } catch (err) {
      if (axios.isAxiosError(err)) {
        console.error(`Request error: ${err.message}`);
        if (err.response) {
          console.error(`HTTP ${err.response.status}`);
          console.log(
            typeof err.response.data === 'object'
              ? JSON.stringify(err.response.data, null, 2)
              : err.response.data
          );
        }
      } else {
        console.error(String(err));
      }
      console.error('');
    }
  }

  console.error('=== end ===');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
