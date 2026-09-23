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
#   2. Append WHMCS_HEAL_EXTRA_IPS (e.g. Grok Bot egress 104.30.180.111).
#   3. SMOKE the WHMCS API from here (GetCurrencies). If it succeeds -> healthy,
#      exit 0 (NO heal). This is what keeps the append-only healer from
#      accumulating a stale entry every 5 min — we only heal on an actual block.
#   4. On block, SSH root -> run the container healer for the detected IP(s).
#   5. Re-smoke; log result.
#
# Env: reads WHMCS creds + SSH target from whmcs-mcp-server/.env.production.
#
# Environment variables:
#   WHMCS_ENV_FILE              — path to .env.production (default: ~/Projects/whmcs-mcp-server/.env.production)
#   WHMCS_HEAL_SSH_TARGET       — SSH config alias or user@host (default: sat-de-prod01)
#   WHMCS_HEAL_SSH_KEY          — explicit SSH key path (preferred)
#   WHMCS_SSH_KEY               — fallback SSH key env (from MCP env)
#   WHMCS_HEAL_EXTRA_IPS        — comma-separated extra IPs to always include (e.g. 104.30.180.111 for Grok Bot)
#   WHMCS_HEAL_MODE             — set to "dokploy" to select this healer from the MCP ipAllowlistHeal module
set -uo pipefail

ENV_FILE="${WHMCS_ENV_FILE:-$HOME/Projects/whmcs-mcp-server/.env.production}"
SSH_TARGET="${WHMCS_HEAL_SSH_TARGET:-ded1-securiace-com}"   # ~/.ssh/config alias -> root@195.7.4.219
SERVER_RUNNER="/root/whmcs-healer/server-run-healer.sh"
LOG_TAG="[dokploy-ip-heal]"

log() { printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$LOG_TAG" "$*"; }

[ -f "$ENV_FILE" ] || { log "FATAL: env file not found: $ENV_FILE"; exit 2; }
set -a; . "$ENV_FILE"; set +a

BASE=$(printf '%s' "${WHMCS_API_URL:?}" | sed -E 's,/includes/api\.php/?$,,; s,/$,,')
API="$BASE/includes/api.php"

# ── SSH key resolution (prefer explicit, then MCP env, then common names) ────
resolve_ssh_key() {
  local candidates=(
    "${WHMCS_HEAL_SSH_KEY:-}"
    "${WHMCS_SSH_KEY:-}"
    "$HOME/.ssh/id_rsa_securiace"
    "$HOME/.ssh/id_ed25519"
    "$HOME/.ssh/id_rsa"
  )
  for key in "${candidates[@]}"; do
    [ -n "$key" ] && [ -f "$key" ] && { echo "$key"; return 0; }
  done
  return 1
}

SSH_KEY_ARGS=()
if SSH_KEY=$(resolve_ssh_key); then
  SSH_KEY_ARGS=(-i "$SSH_KEY")
  log "Using SSH key: $SSH_KEY"
fi

smoke() {
  local body
  body=$(curl -s --max-time 15 "$API" \
    --data-urlencode "identifier=${WHMCS_IDENTIFIER:?}" \
    --data-urlencode "secret=${WHMCS_SECRET:?}" \
    --data-urlencode "action=GetCurrencies" \
    --data-urlencode "responsetype=json" 2>/dev/null)
  printf '%s' "$body" | grep -q '"result":"success"'
}

# ── Detect current public IPs ────────────────────────────────────────────────
IPV4=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || true)
IPV6=$(curl -s --max-time 8 https://api6.ipify.org 2>/dev/null || true)
IPS=""
[ -n "$IPV4" ] && IPS="$IPV4"
[ -n "$IPV6" ] && IPS="${IPS:+$IPS,}$IPV6"

# ── Append WHMCS_HEAL_EXTRA_IPS (e.g. Grok Bot egress) ──────────────────────
EXTRA_IPS="${WHMCS_HEAL_EXTRA_IPS:-}"
if [ -n "$EXTRA_IPS" ]; then
  IPS="${IPS:+$IPS,}$EXTRA_IPS"
  log "Including extra IPs: $EXTRA_IPS"
fi

[ -n "$IPS" ] || { log "FATAL: could not detect public IP"; exit 2; }

if smoke; then
  log "healthy (IP $IPV4 already allowed) — no heal needed"
  exit 0
fi

log "API smoke FAILED — healing allowlist for: $IPS"
printf '%s\n%s\n' "${WHMCS_IDENTIFIER}" "${WHMCS_SECRET}" \
  | ssh -o ConnectTimeout=20 -o BatchMode=yes "${SSH_KEY_ARGS[@]}" "$SSH_TARGET" "$SERVER_RUNNER heal '$IPS'" 2>&1 \
  | sed "s/^/$(date -u +%FT%TZ) $LOG_TAG   /"

if smoke; then
  log "HEALED — API reachable for $IPV4"
  exit 0
else
  log "STILL FAILING after heal (check role ACL / WAF / IP churn)"
  exit 1
fi
