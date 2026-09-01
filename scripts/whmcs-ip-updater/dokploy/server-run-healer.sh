#!/bin/bash
# server-run-healer.sh — runs the WHMCS allowlist healer INSIDE the Dokploy
# app container. Installed on the WHMCS host at /root/whmcs-healer/.
#
# Deployment note (2026-08): my.securiace.com migrated FastPanel -> Dokploy.
# WHMCS now runs in container $APP with DB in a sibling mariadb container.
# The old on-disk WHMCS_ROOT + dedicated `whmcs-ip-updater` SSH account are GONE
# (account deleted, box rebuilt as ded1.securiace.com). This runner reaches the
# install via `docker exec` as root instead.
#
# Usage:  server-run-healer.sh <dry|heal> "<ip1,ip2,...>"
# stdin:  line1 = WHMCS_IDENTIFIER, line2 = WHMCS_SECRET  (never in argv)
#
# Container gotcha: /tmp is a noexec tmpfs and `docker cp` writes UNDER the
# mount (invisible to the process). Stage the healer in /var/www/config
# (persistent ext4, not web-served) instead.
set -euo pipefail
MODE="${1:-dry}"
IPS="${2:?usage: server-run-healer.sh <dry|heal> \"ip1,ip2\"}"
APP="$(docker ps --format '{{.Names}}' | grep -E '^whmcs-production-.*-app-1$' | head -1)"
[ -n "$APP" ] || { echo "FATAL: WHMCS app container not found" >&2; exit 2; }
HEALER_SRC=/root/whmcs-healer/heal-whmcs-allowlist.php
HEALPATH=/var/www/config/.heal_tmp.php

read -r IDENT
read -r SECRET

docker cp "$HEALER_SRC" "$APP":"$HEALPATH" >/dev/null

ENABLE_FLAG=()
[ "$MODE" = "heal" ] && ENABLE_FLAG=(-e HEALER_ENABLED=1)

printf '%s\n%s\n' "$IDENT" "$SECRET" | docker exec -i \
  -e HEAL_KNOWN_IPS="$IPS" \
  -e WHMCS_ROOT=/var/www/html \
  -e WHMCS_API_URL="https://my.securiace.com/includes/api.php" \
  -e SNAPSHOT_DIR=/var/www/config/.heal-snapshots \
  "${ENABLE_FLAG[@]}" \
  "$APP" sh -c 'read -r I; read -r S; WHMCS_IDENTIFIER="$I" WHMCS_SECRET="$S" php "$0"; echo "HEALER_EXIT=$?"' "$HEALPATH"

docker exec "$APP" rm -f "$HEALPATH" 2>/dev/null || true
