#!/usr/bin/env bash
# run-oneshot.sh — launchd entry-point for whmcs-ip-updater.
#
# Sources .env.production so the updater receives WHMCS API credentials,
# then bridges the MCP-style key names to the updater's expected names.
# Execs the updater (no sub-shell overhead, clean signal delivery).
#
# OPERATOR NOTES:
#   • chmod 700 this file after copying it to the production machine.
#   • Set ENV_FILE to the location of your .env.production if it differs
#     from the default path below (or set WHMCS_ENV_FILE before launchctl
#     bootstraps the agent).
#   • This file must NOT contain credentials — it only sources them.
#   • After installing/changing this file, reload the LaunchAgent:
#       launchctl bootout  gui/$(id -u) ~/Library/LaunchAgents/com.securiace.whmcs-ip-updater.plist
#       launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.securiace.whmcs-ip-updater.plist
set -euo pipefail

ENV_FILE="${WHMCS_ENV_FILE:-$HOME/Projects/whmcs-mcp-server/.env.production}"

# Source the env file with all-export mode so every var becomes available
# to child processes without an explicit `export` in the file itself.
set -a
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

# Bridge MCP key names → updater key names (see Design 005, Q4).
# Prefer the _API_ names if already set; fall back to the short MCP names.
export WHMCS_API_IDENTIFIER="${WHMCS_API_IDENTIFIER:-${WHMCS_IDENTIFIER:-}}"
export WHMCS_API_SECRET="${WHMCS_API_SECRET:-${WHMCS_SECRET:-}}"

# Exec the updater, inheriting all env vars and forwarding any CLI args
# passed by launchd ProgramArguments.
exec /usr/bin/python3 "$(dirname "$0")/../whmcs_ip_updater.py" "$@"
