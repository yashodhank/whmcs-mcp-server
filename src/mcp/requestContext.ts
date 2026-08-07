import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  AuthInfo,
  McpRequestContext as SdkRequestContext,
} from '@modelcontextprotocol/server';

export type McpProtocolEra = 'legacy' | 'modern';

export interface TransportIdentity {
  readonly consumerId: string;
  readonly scopes: readonly string[];
  /** Transport-authenticated capability or WHMCS-action grants. */
  readonly capabilityActionGrants: readonly string[];
  readonly authMode: 'registry' | 'oauth' | 'stdio';
}

export interface RequestContext {
  readonly era: McpProtocolEra;
  readonly clientName: string;
  readonly identity: TransportIdentity;
  readonly requestId: string;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

const MAX_GRANTS = 256;
const MAX_GRANT_LENGTH = 128;
const requestContextStorage = new AsyncLocalStorage<RequestContext>();

function boundedGrants(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const grants = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const grant = candidate.trim();
    if (grant.length === 0 || grant.length > MAX_GRANT_LENGTH) continue;
    grants.add(grant);
    if (grants.size === MAX_GRANTS) break;
  }
  return Object.freeze([...grants].sort());
}

function freezeIdentity(authInfo: AuthInfo | undefined): TransportIdentity {
  if (authInfo === undefined) {
    return Object.freeze({
      consumerId: 'stdio-process',
      scopes: Object.freeze([]),
      capabilityActionGrants: Object.freeze([]),
      authMode: 'stdio',
    });
  }
  const extra = authInfo.extra;
  const authMode =
    extra?.authMode === 'oauth' || extra?.authMode === 'stdio' ? extra.authMode : 'registry';
  return Object.freeze({
    consumerId: authInfo.clientId,
    scopes: Object.freeze([...authInfo.scopes]),
    capabilityActionGrants: boundedGrants(extra?.capabilityActionGrants),
    authMode,
  });
}

/** Run an async request chain with immutable request-local MCP context. */
export function runWithRequestContext<T>(context: RequestContext, callback: () => T): T {
  return requestContextStorage.run(context, callback);
}

/** Return the current request context, or undefined for legacy/local callers. */
export function getCurrentRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * Build the immutable request context that crosses the protocol/control-plane
 * boundary. Identity is transport-derived only; request bodies never supply it.
 */
export function createRequestContext(
  sdk: SdkRequestContext,
  options: { readonly timeoutMs?: number; readonly requestId?: string } = {}
): RequestContext {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 60_000);
  const requestId = options.requestId ?? randomUUID();
  const clientName = (sdk.requestInfo?.headers.get('mcp-name')?.trim() || 'unknown').slice(0, 64);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    sdk.requestInfo === undefined
      ? timeoutSignal
      : AbortSignal.any([sdk.requestInfo.signal, timeoutSignal]);

  return Object.freeze({
    era: sdk.era,
    clientName,
    identity: freezeIdentity(sdk.authInfo),
    requestId,
    deadline: Date.now() + timeoutMs,
    signal,
  });
}
