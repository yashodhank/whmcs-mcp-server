#!/bin/bash
# dokploy_ip_heal.sh — REACTIVE WHMCS API-allowlist self-heal for the Dokploy
# deployment of my.securiace.com. Runs on the Mac (the MCP host), because only
# this box knows its own dynamic residential public IP — the IP that must be in
# WHMCS APIAllowedIPs for the local WHMCS MCP server to reach the API.
#
# Replaces the pre-Dokploy `whmcs_ip_updater.py` daemon, which SSHed to the now
# DELETED `whmcs-ip-updater@195.7.4.219` account (4040 failures / 40MB logs).
#
# Flow each run:
#   1. Detect current public IPv4 + IPv6.
#   2. SMOKE the WHMCS API from here (GetCurrencies). If it succeeds -> healthy,
#      exit 0 (NO heal). This is what keeps the append-only healer from
#      accumulating a stale entry every 5 min — we only heal on an actual block.
#   3. On block, SSH root -> run the container healer for the detected IP(s).
#   4. Re-smoke; log result.
#
# Env: reads WHMCS creds + SSH target from whmcs-mcp-server/.env.production.
set -uo pipefail

ENV_FILE="${WHMCS_ENV_FILE:-$HOME/Projects/whmcs-mcp-server/.env.production}"
SSH_TARGET="${WHMCS_HEAL_SSH_TARGET:-sat-de-prod01}"   # ~/.ssh/config alias -> root@195.7.4.219
SERVER_RUNNER="/root/whmcs-healer/server-run-healer.sh"
LOG_TAG="[dokploy-ip-heal]"

log() { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*"; }

[ -f "$ENV_FILE" ] || { log "FATAL: env file not found: $ENV_FILE"; exit 2; }
set -a; . "$ENV_FILE"; set +a

BASE=$(printf '%s' "${WHMCS_API_URL:?}" | sed -E 's,/includes/api\.php/?$,,; s,/$,,')
API="$BASE/includes/api.php"

smoke() {
  # Returns 0 if the API is reachable+authorized from this IP, else 1.
  local body
  body=$(curl -s --max-time 15 "$API" \
    --data-urlencode "identifier=${WHMCS_IDENTIFIER:?}" \
    --data-urlencode "secret=${WHMCS_SECRET:?}" \
    --data-urlencode "action=GetCurrencies" \
    --data-urlencode "responsetype=json" 2>/dev/null)
  printf '%s' "$body" | grep -q '"result":"success"'
}

IPV4=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || true)
IPV6=$(curl -s --max-time 8 https://api6.ipify.org 2>/dev/null || true)
IPS=""
[ -n "$IPV4" ] && IPS="$IPV4"
[ -n "$IPV6" ] && IPS="${IPS:+$IPS,}$IPV6"
[ -n "$IPS" ] || { log "FATAL: could not detect public IP"; exit 2; }

if smoke; then
  log "healthy (IP $IPV4 already allowed) — no heal needed"
  exit 0
fi

log "API smoke FAILED — healing allowlist for: $IPS"
printf '%s\n%s\n' "${WHMCS_IDENTIFIER}" "${WHMCS_SECRET}" \
  | ssh -o ConnectTimeout=20 -o BatchMode=yes "$SSH_TARGET" "$SERVER_RUNNER heal '$IPS'" 2>&1 \
  | sed "s/^/$(date -u +%FT%TZ) $LOG_TAG   /"

if smoke; then
  log "HEALED — API reachable for $IPV4"
  exit 0
else
  log "STILL FAILING after heal (check role ACL / WAF / IP churn)"
  exit 1
fi
