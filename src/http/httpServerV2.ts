import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import {
  createMcpHandler,
  isLegacyRequest,
  type AuthInfo,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';
import { TRANSPORT_BOUND_PREFIX } from '../governance/consumers.js';
import type { ConsumerProfile } from '../governance/types.js';
import { buildModernServer, type ServerFactoryDeps } from '../mcp/serverFactory.js';

export interface ModernHttpAdapterDeps extends ServerFactoryDeps {
  readonly drainTimeoutMs?: number;
}

export interface ModernRequestAuth {
  readonly profile: ConsumerProfile;
  readonly scopes: readonly string[];
  readonly authMode: 'registry' | 'oauth';
}

export interface ModernHttpAdapter {
  /** Return true when the request belongs to the modern era and was answered. */
  handleIfModern(
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody: unknown,
    auth: ModernRequestAuth
  ): Promise<boolean>;
  /** Reject new modern exchanges, drain bounded in-flight work, then close. */
  close(): Promise<void>;
}

function oneHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function requestUrl(req: IncomingMessage): URL {
  const host = oneHeader(req.headers, 'host') ?? 'localhost';
  return new URL(req.url ?? '/', `http://${host}`);
}

function webRequest(req: IncomingMessage, parsedBody: unknown, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = req.method ?? 'GET';
  return new Request(requestUrl(req), {
    method,
    headers,
    signal,
    ...(method === 'GET' || method === 'HEAD' || parsedBody === undefined
      ? {}
      : { body: JSON.stringify(parsedBody) }),
  });
}

function authInfo(auth: ModernRequestAuth): AuthInfo {
  return Object.freeze({
    token: `${TRANSPORT_BOUND_PREFIX}${auth.profile.id}`,
    clientId: auth.profile.id,
    scopes: [...auth.scopes],
    extra: Object.freeze({ authMode: auth.authMode }),
  });
}

async function writeWebResponse(response: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  res.once('close', cancel);
  try {
    let finished = false;
    while (!finished) {
      const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
      finished = chunk.done;
      if (!chunk.done && chunk.value !== undefined && !res.write(Buffer.from(chunk.value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    if (!res.destroyed) res.end();
  } finally {
    res.off('close', cancel);
    reader.releaseLock();
  }
}

function boundedConsumerName(auth: ModernRequestAuth): string {
  return auth.profile.id.slice(0, 64);
}

function writeInternalError(res: ServerResponse): void {
  if (res.destroyed || res.writableEnded) return;
  if (!res.headersSent) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal error' },
        id: null,
      })
    );
    return;
  }
  res.end();
}

export function createModernHttpAdapter(deps: ModernHttpAdapterDeps): ModernHttpAdapter {
  const { logger } = deps;
  const handler: McpHttpHandler = createMcpHandler(
    async (sdkContext) => (await buildModernServer(deps, sdkContext)).server,
    {
      legacy: 'reject',
      responseMode: 'auto',
      onerror: (error) => {
        logger.error('Modern MCP handler error', { error_name: error.name });
      },
    }
  );
  let closing = false;
  let active = 0;
  const drainedWaiters = new Set<() => void>();

  function noteDrained(): void {
    if (active !== 0) return;
    for (const resolve of drainedWaiters) resolve();
    drainedWaiters.clear();
  }

  return {
    async handleIfModern(req, res, parsedBody, auth): Promise<boolean> {
      const requestAbort = new AbortController();
      const abortRequest = (): void => {
        requestAbort.abort();
      };
      const abortClosedResponse = (): void => {
        if (!res.writableFinished) requestAbort.abort();
      };
      req.once('aborted', abortRequest);
      res.once('close', abortClosedResponse);
      const detachAbortListeners = (): void => {
        req.off('aborted', abortRequest);
        res.off('close', abortClosedResponse);
      };
      const request = webRequest(req, parsedBody, requestAbort.signal);
      let legacyRequest: boolean;
      try {
        legacyRequest = await isLegacyRequest(request, parsedBody);
      } catch (error) {
        detachAbortListeners();
        logger.error('Modern MCP request classification failed', {
          error_name: error instanceof Error ? error.name : 'UnknownError',
        });
        writeInternalError(res);
        return true;
      }
      if (legacyRequest) {
        detachAbortListeners();
        return false;
      }

      if (closing) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Server draining' },
            id: null,
          })
        );
        logger.info('HTTP MCP request completed', {
          protocol_era: 'modern',
          transport: 'http',
          client_name: boundedConsumerName(auth),
          auth_mode: auth.authMode,
          outcome: 'draining',
          duration_ms: 0,
        });
        detachAbortListeners();
        return true;
      }

      active += 1;
      const startedAt = Date.now();
      let outcome = 'error';
      try {
        const response = await handler.fetch(request, {
          authInfo: authInfo(auth),
          parsedBody,
        });
        await writeWebResponse(response, res);
        outcome = response.ok ? 'success' : 'rejected';
      } catch (error) {
        logger.error('Modern MCP request failed', {
          error_name: error instanceof Error ? error.name : 'UnknownError',
        });
        writeInternalError(res);
      } finally {
        detachAbortListeners();
        logger.info('HTTP MCP request completed', {
          protocol_era: 'modern',
          transport: 'http',
          client_name: boundedConsumerName(auth),
          auth_mode: auth.authMode,
          outcome,
          duration_ms: Date.now() - startedAt,
        });
        active -= 1;
        noteDrained();
      }
      return true;
    },

    async close(): Promise<void> {
      closing = true;
      if (active > 0) {
        const timeoutMs = Math.max(1, deps.drainTimeoutMs ?? 10_000);
        await Promise.race([
          new Promise<void>((resolve) => drainedWaiters.add(resolve)),
          new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
      }
      await handler.close();
    },
  };
}
