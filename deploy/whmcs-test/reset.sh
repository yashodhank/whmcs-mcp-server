#!/usr/bin/env bash
# Restore both WHMCS stacks to the snapshotted "fresh-installed" state
# WITHOUT walking the install wizard again. Steps:
#   1. Drop + recreate each WHMCS DB, reload from dump.
#   2. Restore configuration.php into the bind-mounted source tree.
#   3. Optionally clear whmcs_storage (default: yes).
#   4. Defensively rm install/.
#   5. HTTP-probe / and fail if "Security Warning" still serves.
#
# Requires a previous successful `npm run whmcs:test:snapshot`.
#
# Usage:
#   deploy/whmcs-test/reset.sh                  # both legs, clear storage
#   deploy/whmcs-test/reset.sh --keep-storage   # don't wipe whmcs_storage
#   deploy/whmcs-test/reset.sh mcpw8            # 8.13 only
#   deploy/whmcs-test/reset.sh mcpw9            # 9.0 only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
SNAPSHOT_DIR="$REPO_ROOT/deploy/whmcs-test/snapshot"
SOURCE_DIR="$REPO_ROOT/deploy/whmcs-test/source"

clear_storage=1
target="all"
for arg in "$@"; do
  case "$arg" in
    --keep-storage)  clear_storage=0 ;;
    mcpw8|mcpw9|all) target="$arg" ;;
    *) echo "Unknown arg: $arg" >&2; exit 1 ;;
  esac
done

reset_one() {
  local leg="$1"
  local mariadb="$2"
  local db_root_pw="$3"
  local db_name="$4"
  local db_user="$5"
  local db_password="$6"
  local source_subdir="$7"
  local storage_volume="$8"
  local port="$9"

  local snapshot="$SNAPSHOT_DIR/$leg"
  local sql_file="$snapshot/$db_name.sql"
  local conf_file="$snapshot/configuration.php"

  if [[ ! -f "$sql_file" ]]; then
    echo "WARNING: no snapshot at $sql_file — skipping $leg." >&2
    echo "         Run 'npm run whmcs:test:snapshot' after a successful install first." >&2
    return 0
  fi

  echo "==> Resetting $leg ..."

  docker compose -f "$COMPOSE_FILE" exec -T "$mariadb" \
    mariadb -uroot "-p$db_root_pw" -e "
      DROP DATABASE IF EXISTS \`$db_name\`;
      CREATE DATABASE \`$db_name\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
      GRANT ALL ON \`$db_name\`.* TO '$db_user'@'%';
      FLUSH PRIVILEGES;
    " >/dev/null
  echo "    DB recreated"

  docker compose -f "$COMPOSE_FILE" exec -T "$mariadb" \
    mariadb -u "$db_user" "-p$db_password" "$db_name" < "$sql_file"
  echo "    DB reloaded from $(du -h "$sql_file" | awk '{print $1}') dump"

  if [[ -f "$conf_file" ]]; then
    cp "$conf_file" "$SOURCE_DIR/$source_subdir/configuration.php"
    chmod 0644 "$SOURCE_DIR/$source_subdir/configuration.php"
    echo "    configuration.php restored"
  fi

  if [[ $clear_storage -eq 1 ]]; then
    docker compose -f "$COMPOSE_FILE" exec -T "$leg" sh -lc \
      'rm -rf /var/www/whmcs_storage/templates_c/* /var/www/whmcs_storage/sessions/* 2>/dev/null || true' \
      >/dev/null 2>&1 || true
    echo "    storage caches cleared"
  fi

  if [[ -d "$SOURCE_DIR/$source_subdir/install" ]]; then
    rm -rf "$SOURCE_DIR/$source_subdir/install"
    echo "    install/ removed (host bind-mount)"
  fi
  docker compose -f "$COMPOSE_FILE" exec -T "$leg" sh -lc \
    'rm -rf /var/www/html/install 2>/dev/null || true' >/dev/null 2>&1 || true

  local title
  title=$(curl -sS --max-time 3 "http://localhost:$port/" 2>/dev/null | \
    grep -oE '<title>[^<]*</title>' | head -1 || true)
  if echo "$title" | grep -qi 'Security Warning'; then
    echo "    ERROR: http://localhost:$port/ still serves '$title' after reset." >&2
    echo "           Snapshot may have been captured with install/ present." >&2
    echo "           Investigate: ls $SOURCE_DIR/$source_subdir/install" >&2
    return 1
  fi
  echo "    health: $title"
}

case "$target" in
  mcpw8|all)
    reset_one mcpw8 mcpw8-db rootsecret_8 whmcs8 whmcs whmcs_8_password 8.13 mcpw8_storage "${WMCP_WHMCS_8_PORT:-8813}"
    ;;
esac

case "$target" in
  mcpw9|all)
    reset_one mcpw9 mcpw9-db rootsecret_9 whmcs9 whmcs whmcs_9_password 9.0 mcpw9_storage "${WMCP_WHMCS_9_PORT:-8890}"
    ;;
esac

echo
echo "Done. Stacks reset to the snapshotted state."
echo "Admin login: http://localhost:${WMCP_WHMCS_8_PORT:-8813}/admin/login.php  (8.13)"
echo "             http://localhost:${WMCP_WHMCS_9_PORT:-8890}/admin/login.php  (9.0)"
