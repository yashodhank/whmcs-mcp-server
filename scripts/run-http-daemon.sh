#!/usr/bin/env bash
#
# Launches the WHMCS MCP server as a long-running Streamable HTTP daemon.
#
# Design:
#   - Secrets/config come from the project .env (single source of truth). The
#     same .env is consumed by the per-client *stdio* MCP configs, so we MUST
#     override the transport here rather than in .env — otherwise stdio clients
#     would also try to start an HTTP listener.
#   - Bind is localhost-only by default; the server is never exposed off-box
#     unless MCP_HTTP_HOST is deliberately changed.
#   - Intended to be supervised by a launchd LaunchAgent (KeepAlive=true), which
#     restarts the process on crash and at login/boot.
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load project env (creds + mode) as the single source of truth.
set -a
# shellcheck disable=SC1090,SC1091
[ -f "$HERE/.env" ] && . "$HERE/.env"
set +a

# Transport/bind overrides — keep stdio clients (which read the same .env) on stdio.
export MCP_TRANSPORT=http
export MCP_HTTP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
export MCP_HTTP_PORT="${MCP_HTTP_PORT:-8765}"

exec node "$HERE/dist/index.js"
