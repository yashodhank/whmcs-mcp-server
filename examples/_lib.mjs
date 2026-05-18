// Shared helper for the runnable examples (dev/test only).
//
// READ-ONLY. SYNTHETIC ONLY. NOT production code and NOT test infra.
//
// Every example builds a *tiny inline single-consumer registry* — exactly the
// pattern used by scripts/mcp-governed-smoke.mjs — and spawns the built MCP
// server (`node dist/index.js`) over stdio with governance ON. The synthetic
// bearer token is the sha256 of `EXAMPLE-<id>-SYNTHETIC-DO-NOT-USE-IN-PROD`;
// it resolves to a single governed consumer mapped to one data contract.
//
// Apps consume tool output in one of two ways:
//   * GOVERNED (governance ON): read `result.structuredContent`, an object
//     `{ entity, consumer, contract, data }` (or a structured failure
//     `{ isError, error, status }`). This is the contract-projected,
//     machine-readable shape an app should render.
//   * LEGACY (governance OFF): parse `result.content[0].text` as JSON (the
//     raw aggregate). Governed mode also mirrors the same JSON into
//     content[0].text for backward compatibility.
//
// These scripts demonstrate the GOVERNED path.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/** Synthetic raw bearer token for a consumer id. Clearly NOT for prod. */
export const RAW = (id) => `EXAMPLE-${id}-SYNTHETIC-DO-NOT-USE-IN-PROD`;

/** One synthetic registry entry: read-only, single contract, no writes. */
const entry = (id, contract) => ({
  id,
  token_sha256: sha(RAW(id)),
  allowedScopes: ['read'],
  defaultContract: contract,
  allowedContracts: [contract],
  allowedActions: [],
  writeCapability: 'false',
  envRestrictions: [],
  anonymous: false,
});

/**
 * Connect to a freshly spawned governed server with a single synthetic
 * consumer in the registry. Returns { client, call, token, close }.
 */
export async function connectAs(consumerId, contract) {
  const REGISTRY = JSON.stringify([entry(consumerId, contract)]);
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      MCP_ENV: 'local',
      MCP_MODE: 'read_only',
      MCP_GOVERNANCE_ENABLED: 'true',
      MCP_ALLOW_ANON_LLM: 'false',
      MCP_RATE_LIMIT: '1000',
      MCP_CONSUMER_REGISTRY: REGISTRY,
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: `example-${consumerId}`, version: '1.0.0' },
    { capabilities: {} }
  );
  await client.connect(transport);

  const auth = { auth_token: RAW(consumerId) };
  const call = (name, args = {}) =>
    client.callTool({ name, arguments: { ...args, ...auth } });

  return { client, call, close: () => client.close() };
}

/**
 * Pull the app-usable governed envelope out of a tool result.
 * Prefers `structuredContent` (what an app reads); falls back to parsing
 * content[0].text (legacy mirror). Throws on a tool/governance error so
 * the example exits non-zero.
 */
export function structured(result, label) {
  if (result?.structuredContent) {
    const sc = result.structuredContent;
    if (sc.isError) {
      throw new Error(
        `${label}: governed error status=${sc.status} ${sc.error ?? ''}`
      );
    }
    return sc;
  }
  // Legacy fallback (governance OFF) — parse the text mirror.
  const txt = result?.content?.[0]?.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(txt);
  } catch {
    parsed = txt;
  }
  if (result?.isError || parsed?.isError) {
    throw new Error(`${label}: tool error → ${txt.slice(0, 160)}`);
  }
  return parsed;
}

/** Compact preview of a value (truncates long arrays/strings). */
export function preview(v, max = 3) {
  if (Array.isArray(v)) {
    const head = v.slice(0, max);
    return v.length > max ? [...head, `…(+${v.length - max} more)`] : head;
  }
  return v;
}

const banner = (title) =>
  console.log(`\n=== ${title} (READ-ONLY · SYNTHETIC consumer) ===`);

export { banner };
