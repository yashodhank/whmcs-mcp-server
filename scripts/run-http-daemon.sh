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

# Transport/bind overrides exported in the shell. node --env-file then loads the
# project .env WITHOUT shell expansion (values containing `$` are safe) and does
# NOT override variables already present in the environment — so these win, and
# stdio clients (which read the same .env, but without these) stay on stdio.
export MCP_TRANSPORT=http
export MCP_HTTP_HOST="${MCP_HTTP_HOST:-127.0.0.1}"
export MCP_HTTP_PORT="${MCP_HTTP_PORT:-8765}"

exec node --env-file="$HERE/.env" "$HERE/dist/index.js"
