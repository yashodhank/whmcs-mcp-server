/**
 * MCP Adoption #10 — Streamable HTTP transport (OPT-IN).
 *
 * Starts a raw `node:http` server (no express) that fronts the MCP
 * `StreamableHTTPServerTransport` on a single endpoint (default `/mcp`),
 * supporting:
 *   - POST   client→server JSON-RPC (initialize + subsequent requests)
 *   - GET    server→client SSE stream
 *   - DELETE  explicit session termination
 *
 * Session management follows the SDK's documented stateful pattern: an
 * `initialize` POST (no session id) creates a transport with a
 * `sessionIdGenerator`; the SDK assigns an `mcp-session-id`, which we capture in
 * `onsessioninitialized` and use to route every subsequent request to the same
 * transport (stored in a per-process map). DELETE / transport close evicts it.
 *
 * SECURITY: every request is run through the auth bridge (`authorizeHttpRequest`)
 * — Origin allowlist (403) then bearer-token resolution against the EXISTING
 * consumer registry (401, with `WWW-Authenticate: Bearer`, no body leak) —
 * BEFORE the body is handed to the transport. Tokens are never logged.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import type { Logger } from '../logging.js';
import { loadConsumerRegistry } from '../governance/consumers.js';
import type { ConsumerProfile } from '../governance/types.js';
import { authorizeHttpRequest } from './auth.js';

const SESSION_HEADER = 'mcp-session-id';
/** Cap on a single request body to avoid unbounded buffering. */
const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MiB

export interface HttpServerDeps {
  readonly logger: Logger;
  /** Factory that produces a fresh, fully-configured McpServer per session. */
  readonly buildServer: () => McpServer;
}

export interface HttpServerHandle {
  /** The bound port (useful for tests that pass port 0). */
  readonly port: number;
  /** Close listeners + all active transports. */
  close(): Promise<void>;
}

/** Write a minimal JSON-RPC-shaped error WITHOUT leaking internals. */
function writeJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  extraHeaders?: Record<string, string>
): void {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(extraHeaders ?? {}),
  });
  res.end(body);
}

/** Read + JSON-parse the request body, enforcing a size cap. Resolves
 *  `undefined` for an empty body (e.g. GET/DELETE). Throws on malformed JSON or
 *  oversize so the caller can map it to a proper JSON-RPC error (never a crash). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error('request body too large');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return undefined;
  return JSON.parse(raw) as unknown;
}

/**
 * Start the Streamable HTTP server. Resolves once the socket is listening.
 */
export async function startHttpServer(deps: HttpServerDeps): Promise<HttpServerHandle> {
  const { logger, buildServer } = deps;

  // Load the consumer registry ONCE at startup (same env-driven registry as
  // stdio). A malformed registry throws here and fails startup fast.
  const registry: ConsumerProfile[] = loadConsumerRegistry(process.env);
  const env = config.MCP_ENV;
  const endpointPath = config.MCP_HTTP_PATH;
  const allowedOrigins = config.MCP_HTTP_ALLOWED_ORIGINS;

  // Active sessions: sessionId → its transport. One McpServer is connected per
  // transport (created on the initialize request).
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    // Path match (ignore query string). Anything else → 404.
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];
    if (pathOnly !== endpointPath) {
      writeJsonRpcError(res, 404, -32600, 'Not found');
      return;
    }

    // ── Auth bridge: Origin (403) then bearer (401) BEFORE the transport. ──
    const decision = authorizeHttpRequest({
      authorizationHeader: req.headers.authorization,
      originHeader: req.headers.origin,
      env,
      registry,
      allowedOrigins,
    });
    if (!decision.ok) {
      const headers: Record<string, string> = {};
      if (decision.wwwAuthenticate) headers['WWW-Authenticate'] = 'Bearer';
      // Generic, non-leaking message; never echo token or internals.
      writeJsonRpcError(
        res,
        decision.status,
        decision.status === 401 ? -32001 : -32002,
        decision.publicMessage,
        headers
      );
      logger.warn('HTTP MCP request rejected', {
        status: decision.status,
        method,
        // NEVER log the token or Authorization header.
      });
      return;
    }

    const sessionId = req.headers[SESSION_HEADER];
    const sessionIdStr = Array.isArray(sessionId) ? sessionId[0] : sessionId;

    // Parse body for POST; GET/DELETE carry none. Malformed JSON → JSON-RPC
    // parse error (-32700), not a crash.
    let body: unknown;
    if (method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch {
        writeJsonRpcError(res, 400, -32700, 'Parse error');
        return;
      }
    }

    // Route to an existing session, or create one on an initialize POST.
    let transport: StreamableHTTPServerTransport | undefined =
      sessionIdStr !== undefined ? transports.get(sessionIdStr) : undefined;

    if (transport === undefined) {
      if (method === 'POST' && sessionIdStr === undefined && isInitializeRequest(body)) {
        // New session. The SDK generates the id; we capture it and store the
        // transport. A fresh McpServer is built and connected per session.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, newTransport);
            logger.info('HTTP MCP session initialized', { consumer: decision.profile.id });
          },
        });
        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid !== undefined) transports.delete(sid);
        };
        const server = buildServer();
        await server.connect(newTransport);
        transport = newTransport;
      } else {
        // Non-initialize request with a missing/unknown session id.
        writeJsonRpcError(
          res,
          400,
          -32000,
          'Bad Request: no valid session id for non-initialize request'
        );
        return;
      }
    }

    // Hand off to the SDK transport (handles POST/GET/DELETE + SSE + session
    // headers per the spec). Pass the pre-parsed body for POST.
    try {
      await transport.handleRequest(req, res, body);
    } catch (error) {
      logger.error('HTTP MCP transport error', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, 'Internal error');
      }
    }
  }

  const httpServer: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error('HTTP MCP request handler crashed', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        writeJsonRpcError(res, 500, -32603, 'Internal error');
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.MCP_HTTP_PORT, config.MCP_HTTP_HOST, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const boundPort = typeof addr === 'object' && addr !== null ? addr.port : config.MCP_HTTP_PORT;

  logger.info('MCP Server ready, listening via Streamable HTTP', {
    host: config.MCP_HTTP_HOST,
    port: boundPort,
    path: endpointPath,
    originAllowlist: allowedOrigins.length > 0 ? allowedOrigins : 'none (no cross-origin)',
  });

  return {
    port: boundPort,
    async close(): Promise<void> {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          // best-effort
        }
      }
      transports.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
