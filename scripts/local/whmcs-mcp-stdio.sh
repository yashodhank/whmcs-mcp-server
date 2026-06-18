#!/usr/bin/env bash
#
# Per-client *stdio* launcher for the WHMCS MCP server.
# Referenced by the `whmcs` MCP entry in Codex / Claude Code / Gemini configs,
# e.g.  command = "<repo>/scripts/local/whmcs-mcp-stdio.sh"
#
# Design (mirror of scripts/run-http-daemon.sh, inverted for stdio):
#   - Secrets/config come from the project env file (single source of truth),
#     loaded via `node --env-file` (no shell expansion; values containing `$`
#     are safe). Prefers .env.production (the documented local credential file),
#     falls back to .env. Both are gitignored.
#   - Transport is forced to stdio. `node --env-file` does NOT override variables
#     already present in the environment, so this export wins over the env file
#     — the SAME env file can be shared with the HTTP daemon (which forces http)
#     without either flipping the other's transport.
#   - No network listener in stdio mode.
set -euo pipefail

# scripts/local/ -> repo root is two levels up.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Pick the local env file: prefer .env.production, fall back to .env.
ENV_FILE=""
for candidate in "$HERE/.env.production" "$HERE/.env"; do
  if [ -f "$candidate" ]; then
    ENV_FILE="$candidate"
    break
  fi
done

# Ensure the build artifact exists. This package has no native dependencies, so
# a plain build is safe under any Node that satisfies the build toolchain.
if [ ! -f "$HERE/dist/index.js" ]; then
  echo "whmcs-mcp-stdio: dist/index.js missing; building once..." >&2
  if ! ( cd "$HERE" && npm run build >&2 ); then
    echo "whmcs-mcp-stdio: build failed — run 'npm install && npm run build' in $HERE" >&2
    exit 1
  fi
fi

# stdio is the server default; force it so a shared env file can never flip the
# stdio client into HTTP mode.
export MCP_TRANSPORT=stdio

if [ -n "$ENV_FILE" ]; then
  exec node --env-file="$ENV_FILE" "$HERE/dist/index.js"
fi

echo "whmcs-mcp-stdio: no .env.production or .env in $HERE; starting without an env file (WHMCS_* must already be exported)" >&2
exec node "$HERE/dist/index.js"
