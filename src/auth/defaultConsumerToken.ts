import { readFileSync, statSync } from 'node:fs';

import { config } from '../config.js';

interface TokenSource {
  readonly token?: string;
  readonly tokenFile?: string;
}

function trimIfString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readTokenFromFile(filePath: string): string | undefined {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    return undefined;
  }

  if (!stat.isFile()) {
    return undefined;
  }

  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return undefined;
  }

  try {
    return trimIfString(readFileSync(filePath, 'utf8'));
  } catch {
    return undefined;
  }
}

function resolveToken(source: TokenSource): string | undefined {
  if (source.tokenFile !== undefined && source.tokenFile.trim() !== '') {
    const token = readTokenFromFile(source.tokenFile);
    if (token !== undefined) return token;
  }
  return trimIfString(source.token);
}

export function resolveDefaultConsumerAuthToken(): string | undefined {
  return resolveToken({
    tokenFile: config.MCP_DEFAULT_CONSUMER_AUTH_TOKEN_FILE,
    token: config.MCP_DEFAULT_CONSUMER_AUTH_TOKEN,
  });
}

export function resolveApproverConsumerAuthToken(): string | undefined {
  return (
    resolveToken({
      tokenFile: config.MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN_FILE,
      token: config.MCP_DEFAULT_APPROVER_CONSUMER_AUTH_TOKEN,
    }) ?? resolveDefaultConsumerAuthToken()
  );
}

export function resolveWriteConsumerAuthToken(role: 'approver' | 'executor'): string | undefined {
  if (role === 'approver') {
    return resolveApproverConsumerAuthToken();
  }
  return resolveDefaultConsumerAuthToken();
}

