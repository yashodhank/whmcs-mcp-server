import { readFileSync, statSync } from 'node:fs';

export const LIVE_AUTHORIZATION_FILE_ENV = 'MCP_PROD_WRITE_AUTHORIZED_FILE';

export class LiveAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveAuthorizationError';
  }
}

/**
 * Read the production execution allowlist from a protected JSON file.
 *
 * The file is deliberately read on every authorization check: changing the
 * approved scopes takes effect on the next write attempt without restarting
 * the MCP process. Any missing, lax, malformed, or schema-invalid file fails
 * closed instead of falling back to a previously accepted grant.
 */
export function loadLiveProductionAuthorization(filePath: string): readonly string[] {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    throw new LiveAuthorizationError(
      LIVE_AUTHORIZATION_FILE_ENV + " points to a path that cannot be stat'd: " + filePath
    );
  }
  if (!stat.isFile()) {
    throw new LiveAuthorizationError(
      LIVE_AUTHORIZATION_FILE_ENV + ' is not a regular file: ' + filePath
    );
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new LiveAuthorizationError(
      LIVE_AUTHORIZATION_FILE_ENV +
        ' (' +
        filePath +
        ') is group/other-accessible; restrict it to owner-only (chmod 600).'
    );
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new LiveAuthorizationError(
      LIVE_AUTHORIZATION_FILE_ENV + ' could not be read: ' + filePath
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LiveAuthorizationError(LIVE_AUTHORIZATION_FILE_ENV + ' contains invalid JSON.');
  }

  const objectValue =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as { authorized?: unknown })
      : undefined;
  const actions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(objectValue?.authorized)
      ? objectValue.authorized
      : undefined;

  if (!actions?.every((value): value is string => typeof value === 'string')) {
    throw new LiveAuthorizationError(
      LIVE_AUTHORIZATION_FILE_ENV + ' must contain a JSON array of strings or {"authorized":[...]}'
    );
  }

  return actions.map((action) => action.trim()).filter(Boolean);
}
