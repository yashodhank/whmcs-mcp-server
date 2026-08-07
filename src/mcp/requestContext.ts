import { randomUUID } from 'node:crypto';
import type {
  AuthInfo,
  McpRequestContext as SdkRequestContext,
} from '@modelcontextprotocol/server';

export type McpProtocolEra = 'legacy' | 'modern';

export interface TransportIdentity {
  readonly consumerId: string;
  readonly scopes: readonly string[];
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

function freezeIdentity(authInfo: AuthInfo | undefined): TransportIdentity {
  if (authInfo === undefined) {
    return Object.freeze({
      consumerId: 'stdio-process',
      scopes: Object.freeze([]),
      authMode: 'stdio',
    });
  }
  const extra = authInfo.extra;
  const authMode =
    extra?.authMode === 'oauth' || extra?.authMode === 'stdio' ? extra.authMode : 'registry';
  return Object.freeze({
    consumerId: authInfo.clientId,
    scopes: Object.freeze([...authInfo.scopes]),
    authMode,
  });
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
