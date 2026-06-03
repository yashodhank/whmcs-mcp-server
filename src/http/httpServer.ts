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
import {
  loadConsumerRegistry,
  resolveConsumer,
  enableTransportConsumerBinding,
  TRANSPORT_BOUND_PREFIX,
} from '../governance/consumers.js';
import type { ConsumerProfile } from '../governance/types.js';
import { extractBearerToken, isOriginAllowed } from './auth.js';
import {
  PRM_PATH,
  buildProtectedResourceMetadata,
  wwwAuthenticateValue,
} from '../auth/protectedResourceMetadata.js';
import { createTokenVerifier, type TokenVerifier } from '../auth/tokenVerifier.js';
import { consumerFromClaims, consumerScopes } from '../auth/consumerBridge.js';
import {
  requiredScopeForRead,
  requiredScopeForWriteScope,
  hasRequiredScope,
} from '../auth/scopes.js';

/** Write-flow tool names whose required scope is a write tier (not read). */
const WRITE_FLOW_TOOLS = new Set([
  'write',
  'draft_write_intent',
  'validate_write_intent',
  'approve_write_intent',
  'execute_write_intent',
]);

/** Compute the OAuth scope a tools/call requires (coarse boundary gate; the
 *  in-house authorizer still does fine-grained per-scope/tier enforcement). */
function requiredScopeForCall(body: unknown): string {
  const b = body as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
  if (b.method !== 'tools/call') return requiredScopeForRead();
  const name = b.params?.name;
  if (typeof name !== 'string' || !WRITE_FLOW_TOOLS.has(name)) return requiredScopeForRead();
  const scope = b.params?.arguments?.scope;
  return typeof scope === 'string' ? requiredScopeForWriteScope(scope) : 'whmcs:write:low';
}

/** Bind the transport-authenticated consumer to the tool layer: overwrite the
 *  tools/call `auth_token` arg with the trusted marker (strips any client value)
 *  so tools resolve the AUTHENTICATED consumer, not a client-supplied token. */
function bindConsumerIdentity(body: unknown, consumerId: string): void {
  const b = body as { method?: string; params?: { arguments?: Record<string, unknown> } } | null;
  if (b?.method === 'tools/call' && b.params) {
    const args = (b.params.arguments ??= {});
    args.auth_token = `${TRANSPORT_BOUND_PREFIX}${consumerId}`;
  }
}

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

  // OAuth 2.1 resource-server (opt-in). When enabled, HTTP bearers are JWTs
  // validated against the issuer(s) with aud == resource (RFC 8707); a PRM
  // document (RFC 9728) is served for discovery. Else: registry bearer tokens.
  const oauthEnabled = config.MCP_OAUTH_ENABLED;
  let verifier: TokenVerifier | undefined;
  let prmUrl = '';
  let prmConfig: { resource: string; authorizationServers: string[]; scopesSupported: string[] } | undefined;
  if (oauthEnabled) {
    const resource = config.MCP_OAUTH_RESOURCE;
    const audience = config.MCP_OAUTH_AUDIENCE ?? resource;
    const issuers = config.MCP_OAUTH_ISSUERS;
    if (resource === undefined || audience === undefined || issuers.length === 0) {
      throw new Error(
        'MCP_OAUTH_ENABLED requires MCP_OAUTH_RESOURCE, MCP_OAUTH_AUDIENCE (or RESOURCE), and MCP_OAUTH_ISSUERS'
      );
    }
    verifier = createTokenVerifier({ issuers, audience });
    prmUrl = `${resource.replace(/\/+$/, '')}${PRM_PATH}`;
    prmConfig = {
      resource,
      authorizationServers: issuers,
      scopesSupported: ['whmcs:read', 'whmcs:write:low', 'whmcs:write:medium', 'whmcs:write:high'],
    };
  }
  // Enable transport→tool identity binding for THIS (HTTP) process, so the
  // server-injected consumer marker is trusted by resolveConsumer (stdio never
  // sets this, so the marker can't be used to impersonate there).
  enableTransportConsumerBinding(true);

  // Active sessions: sessionId → its transport. One McpServer is connected per
  // transport (created on the initialize request).
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Last-activity per session, for idle eviction + LRU cap (memory/DoS guard:
  // a client that initializes then drops without DELETE must not leak forever).
  const lastSeen = new Map<string, number>();
  const maxSessions = config.MCP_HTTP_MAX_SESSIONS;
  const idleMs = config.MCP_HTTP_SESSION_IDLE_MS;
  const closeSession = (sid: string): void => {
    const t = transports.get(sid);
    transports.delete(sid);
    lastSeen.delete(sid);
    if (t) {
      try {
        void t.close();
      } catch {
        /* best-effort */
      }
    }
  };
  // Sweep idle sessions periodically (capped at 60s cadence).
  const sweeper = setInterval(
    () => {
      const cutoff = Date.now() - idleMs;
      for (const [sid, seen] of lastSeen) if (seen < cutoff) closeSession(sid);
    },
    Math.min(idleMs, 60_000)
  );
  if (typeof sweeper.unref === 'function') sweeper.unref();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    const pathOnly = url.split('?')[0];

    // PRM discovery (RFC 9728) — UNAUTHENTICATED GET, so clients can find the
    // authorization server before they hold a token. OAuth mode only.
    if (oauthEnabled && method === 'GET' && pathOnly === PRM_PATH && prmConfig !== undefined) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildProtectedResourceMetadata(prmConfig)));
      return;
    }

    // Path match (ignore query string). Anything else → 404.
    if (pathOnly !== endpointPath) {
      writeJsonRpcError(res, 404, -32600, 'Not found');
      return;
    }

    // ── Origin gate (403) BEFORE auth — no token-probing oracle. ──
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
      writeJsonRpcError(res, 403, -32002, 'Forbidden origin');
      logger.warn('HTTP MCP request rejected', { status: 403, method });
      return;
    }

    // ── Bearer → ConsumerProfile (OAuth JWT or registry token). 401 leaks nothing. ──
    const token = extractBearerToken(req.headers.authorization);
    let profile: ConsumerProfile;
    let grantedScopes: string[] = [];
    if (oauthEnabled) {
      if (token === undefined) {
        writeJsonRpcError(res, 401, -32001, 'Unauthorized', {
          'WWW-Authenticate': wwwAuthenticateValue(prmUrl),
        });
        return;
      }
      if (verifier === undefined) {
        writeJsonRpcError(res, 503, -32603, 'Service unavailable');
        return;
      }
      const vr = await verifier.verify(token);
      if (!vr.ok) {
        writeJsonRpcError(res, 401, -32001, 'Unauthorized', {
          'WWW-Authenticate': wwwAuthenticateValue(prmUrl, 'invalid_token'),
        });
        logger.warn('HTTP MCP OAuth token rejected', { method, reason: vr.reason });
        return;
      }
      const mapped = consumerFromClaims(vr.claims, registry);
      if (mapped === null) {
        writeJsonRpcError(res, 403, -32002, 'No mapped consumer for token');
        return;
      }
      profile = mapped;
      grantedScopes = consumerScopes(vr.claims);
    } else {
      const decision = resolveConsumer(token, env, registry, { allowAnon: false });
      if (!decision.ok) {
        writeJsonRpcError(res, 401, -32001, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
        logger.warn('HTTP MCP request rejected', { status: 401, method, reason: decision.reason });
        return;
      }
      profile = decision.profile;
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

    // OAuth boundary scope gate (coarse — the in-house authorizer still does
    // fine-grained per-scope/tier enforcement once the consumer is bound).
    if (
      oauthEnabled &&
      body !== undefined &&
      (body as { method?: string }).method === 'tools/call' &&
      !hasRequiredScope(grantedScopes, requiredScopeForCall(body))
    ) {
      writeJsonRpcError(res, 403, -32003, 'Insufficient scope');
      return;
    }
    // IDENTITY BINDING: overwrite the tools/call auth_token with the trusted
    // marker for the TRANSPORT-authenticated consumer (strips any client value),
    // so the tool layer is governed by who the bearer authenticated as.
    if (body !== undefined) bindConsumerIdentity(body, profile.id);

    // Route to an existing session, or create one on an initialize POST.
    let transport: StreamableHTTPServerTransport | undefined =
      sessionIdStr !== undefined ? transports.get(sessionIdStr) : undefined;
    if (transport !== undefined && sessionIdStr !== undefined) {
      lastSeen.set(sessionIdStr, Date.now()); // mark activity
    }

    if (transport === undefined) {
      if (method === 'POST' && sessionIdStr === undefined && isInitializeRequest(body)) {
        // Hard cap: evict the least-recently-used session before adding a new one.
        if (transports.size >= maxSessions) {
          let oldest: string | undefined;
          let oldestSeen = Infinity;
          for (const [sid, seen] of lastSeen) {
            if (seen < oldestSeen) {
              oldestSeen = seen;
              oldest = sid;
            }
          }
          if (oldest !== undefined) closeSession(oldest);
        }
        // New session. The SDK generates the id; we capture it and store the
        // transport. A fresh McpServer is built and connected per session.
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, newTransport);
            lastSeen.set(sid, Date.now());
            logger.info('HTTP MCP session initialized', { consumer: profile.id });
          },
        });
        newTransport.onclose = () => {
          const sid = newTransport.sessionId;
          if (sid !== undefined) {
            transports.delete(sid);
            lastSeen.delete(sid);
          }
        };
        // Init-failure cleanup: if connect throws before a session id is
        // assigned, the transport/server would leak — close it explicitly.
        try {
          const server = buildServer();
          await server.connect(newTransport);
        } catch (e) {
          try {
            await newTransport.close();
          } catch {
            /* best-effort */
          }
          logger.error('HTTP MCP session init failed', {
            error: e instanceof Error ? e.message : String(e),
          });
          if (!res.headersSent) writeJsonRpcError(res, 503, -32603, 'Service unavailable');
          return;
        }
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
      clearInterval(sweeper);
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          // best-effort
        }
      }
      transports.clear();
      lastSeen.clear();
      await new Promise<void>((resolve) => {
        httpServer.close(() => { resolve(); });
      });
    },
  };
}
