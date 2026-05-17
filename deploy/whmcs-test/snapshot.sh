#!/usr/bin/env bash
# Capture a "fresh-installed" snapshot of both WHMCS stacks so we can
# reset back without re-driving the install wizard.
#
# Captures per leg: full DB dump + configuration.php (installer-written).
# Does NOT capture: install/ (must be gone — fail-fast otherwise),
# whmcs_storage/ (runtime), vendor/ (from bind-mounted source).
#
# Snapshot files land at deploy/whmcs-test/snapshot/{mcpw8,mcpw9}/.
# This dir IS gitignored (DB dumps contain license keys + admin
# password hash).
#
# Usage:
#   deploy/whmcs-test/snapshot.sh         # both legs
#   deploy/whmcs-test/snapshot.sh mcpw8   # 8.13 only
#   deploy/whmcs-test/snapshot.sh mcpw9   # 9.0 only

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
SNAPSHOT_DIR="$REPO_ROOT/deploy/whmcs-test/snapshot"
SOURCE_DIR="$REPO_ROOT/deploy/whmcs-test/source"

mkdir -p "$SNAPSHOT_DIR"

snapshot_one() {
  local leg="$1"          # mcpw8 | mcpw9
  local mariadb="$2"      # mcpw8-db | mcpw9-db
  local db_user="$3"      # whmcs
  local db_password="$4"
  local db_name="$5"      # whmcs8 | whmcs9
  local source_subdir="$6" # 8.13 | 9.0

  local out_dir="$SNAPSHOT_DIR/$leg"
  mkdir -p "$out_dir"

  if ! docker compose -f "$COMPOSE_FILE" ps "$mariadb" --status running --quiet >/dev/null 2>&1; then
    echo "WARNING: $mariadb is not running; skipping $leg snapshot." >&2
    return 0
  fi

  if [[ -d "$SOURCE_DIR/$source_subdir/install" ]]; then
    echo "ERROR: $SOURCE_DIR/$source_subdir/install still exists for $leg." >&2
    echo "       WHMCS gates every URL with 'Security Warning' until it's removed." >&2
    echo "       Run:  npm run whmcs:test:fixup" >&2
    return 1
  fi

  echo "==> Snapshotting $leg ..."

  local dump_cmd
  dump_cmd=$(docker compose -f "$COMPOSE_FILE" exec -T "$mariadb" sh -lc \
    'command -v mariadb-dump || command -v mysqldump' 2>/dev/null | tr -d '\r')
  docker compose -f "$COMPOSE_FILE" exec -T "$mariadb" \
    "$dump_cmd" --no-tablespaces --single-transaction --routines --triggers \
    -u "$db_user" "-p$db_password" "$db_name" \
    > "$out_dir/$db_name.sql"
  echo "    DB dump: $(du -h "$out_dir/$db_name.sql" | awk '{print $1}')"

  if [[ -f "$SOURCE_DIR/$source_subdir/configuration.php" ]]; then
    cp "$SOURCE_DIR/$source_subdir/configuration.php" "$out_dir/configuration.php"
    chmod 0644 "$out_dir/configuration.php"
    echo "    configuration.php: captured"
  else
    echo "    WARNING: no configuration.php found at $SOURCE_DIR/$source_subdir/; skipping." >&2
  fi

  cat > "$out_dir/manifest.txt" <<EOF
WHMCS dev/test snapshot (whmcs-mcp-server)
captured_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
leg: $leg
mariadb_service: $mariadb
db_name: $db_name
db_user: $db_user
source_dir: deploy/whmcs-test/source/$source_subdir
EOF

  echo "    manifest written"
}

target="${1:-all}"

case "$target" in
  mcpw8|all)
    snapshot_one mcpw8 mcpw8-db whmcs whmcs_8_password whmcs8 8.13
    ;;
esac

case "$target" in
  mcpw9|all)
    snapshot_one mcpw9 mcpw9-db whmcs whmcs_9_password whmcs9 9.0
    ;;
esac

if [[ "$target" != "mcpw8" && "$target" != "mcpw9" && "$target" != "all" ]]; then
  echo "Unknown target: $target. Use mcpw8 | mcpw9 | all." >&2
  exit 1
fi

echo
echo "Done. Snapshot dir: $SNAPSHOT_DIR"
echo "To restore: npm run whmcs:test:reset"
