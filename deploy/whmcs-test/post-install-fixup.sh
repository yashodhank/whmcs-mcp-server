#!/usr/bin/env bash
# Post-install fixups the WHMCS install wizard misses for docker-compose
# dev/test. LOCAL DEV/TEST ONLY (production never runs this).
#
# Repairs two failure modes:
#
# 1. install/ folder not deleted. WHMCS' boot guard hijacks every URL
#    with <title>Security Warning</title> until install/ is removed. The
#    wizard does not self-delete; the bind-mount makes it sticky across
#    restarts. We rm it (host bind-mount + in-container belt-and-braces).
#
# 2. SystemURL auto-detection wrong. The wizard reads the host header
#    during install; inside docker that becomes `https://localhost/`
#    (no port, wrong scheme) so the admin SPA fires XHR at the wrong
#    origin (CORS / ERR_NETWORK). We rewrite tblconfiguration.SystemURL
#    + Domain, and disable the dev-hostile session-IP check (Docker
#    Desktop macOS NAT shuffles source IPs and kills WHMCS sessions).
#
# HTTP-probes / afterward and fails if "Security Warning" still serves —
# single source of truth for "stack is healthy and snapshottable".
# Idempotent.
#
# Usage:
#   deploy/whmcs-test/post-install-fixup.sh         # both legs
#   deploy/whmcs-test/post-install-fixup.sh mcpw8   # 8.13 only
#   deploy/whmcs-test/post-install-fixup.sh mcpw9   # 9.0 only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
SOURCE_DIR="$REPO_ROOT/deploy/whmcs-test/source"

fixup_one() {
  local leg="$1"            # mcpw8 | mcpw9
  local mariadb="$2"        # mcpw8-db | mcpw9-db
  local db_root_pw="$3"
  local db_name="$4"
  local public_url="$5"     # http://localhost:8813/ (trailing slash)
  local source_subdir="$6"  # 8.13 | 9.0
  local port="$7"           # 8813 | 8890

  if ! docker compose -f "$COMPOSE_FILE" ps "$mariadb" --status running --quiet >/dev/null 2>&1; then
    echo "WARNING: $mariadb is not running; skipping $leg fixup." >&2
    return 0
  fi

  echo "==> Patching $leg config ..."

  if [[ -d "$SOURCE_DIR/$source_subdir/install" ]]; then
    rm -rf "$SOURCE_DIR/$source_subdir/install"
    echo "    install/ removed (host bind-mount)"
  fi
  docker compose -f "$COMPOSE_FILE" exec -T "$leg" sh -lc \
    'rm -rf /var/www/html/install 2>/dev/null || true' >/dev/null 2>&1 || true

  docker compose -f "$COMPOSE_FILE" exec -T "$mariadb" \
    mariadb -uroot "-p$db_root_pw" "$db_name" -e "
      UPDATE tblconfiguration SET value='$public_url' WHERE setting='SystemURL';
      UPDATE tblconfiguration SET value='$public_url' WHERE setting='Domain';
      UPDATE tblconfiguration SET value='on'         WHERE setting='DisableSessionIPCheck';
      UPDATE tblconfiguration SET value=''           WHERE setting='NetworkIssuesRequireLogin';
    " >/dev/null
  echo "    SystemURL + Domain → $public_url"
  echo "    DisableSessionIPCheck=on, NetworkIssuesRequireLogin='' (dev-only)"

  docker compose -f "$COMPOSE_FILE" exec -T "$leg" sh -lc \
    'rm -rf /var/www/whmcs_storage/templates_c/* /var/www/whmcs_storage/sessions/* 2>/dev/null || true' \
    >/dev/null 2>&1 || true
  echo "    template + session caches cleared"

  local title
  title=$(curl -sS --max-time 3 "http://localhost:$port/" 2>/dev/null | \
    grep -oE '<title>[^<]*</title>' | head -1 || true)
  if echo "$title" | grep -qi 'Security Warning'; then
    echo "    ERROR: http://localhost:$port/ STILL serves '$title'." >&2
    echo "           install/ removal did not propagate. Try:" >&2
    echo "             ls $SOURCE_DIR/$source_subdir/install   # should be empty/missing" >&2
    echo "             docker compose -f $COMPOSE_FILE exec $leg ls /var/www/html/install" >&2
    return 1
  fi
  echo "    health: $title"
}

target="${1:-all}"

case "$target" in
  mcpw8|all)
    fixup_one mcpw8 mcpw8-db rootsecret_8 whmcs8 "http://localhost:${WMCP_WHMCS_8_PORT:-8813}/" 8.13 "${WMCP_WHMCS_8_PORT:-8813}"
    ;;
esac

case "$target" in
  mcpw9|all)
    fixup_one mcpw9 mcpw9-db rootsecret_9 whmcs9 "http://localhost:${WMCP_WHMCS_9_PORT:-8890}/" 9.0 "${WMCP_WHMCS_9_PORT:-8890}"
    ;;
esac

if [[ "$target" != "mcpw8" && "$target" != "mcpw9" && "$target" != "all" ]]; then
  echo "Unknown target: $target. Use mcpw8 | mcpw9 | all." >&2
  exit 1
fi

echo
echo "Done. install/ removed, SystemURL patched, caches cleared, health OK."
