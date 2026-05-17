#!/usr/bin/env bash
# SECONDARY / fallback: seed a CLEAN fresh-install base (no prod data) by
# reusing securiace-vps-platform's proven post-install snapshot.
#
# Use this when prod SSH is unavailable, or for a pristine reset. The
# primary path is seed-from-prod.sh (realistic scrubbed prod data).
#
# READ-ONLY w.r.t. securiace-vps-platform: copies files OUT only; never
# modifies that repo. Patches $db_host (their mariadb8/9 → our mcpw{8,9}-db)
# then delegates to reset.sh (the proven non-wizard restore).
#
# Usage: deploy/whmcs-test/bootstrap-from-source-snapshot.sh [mcpw8|mcpw9|all]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/whmcs-test"
SRC_SNAP="${WMCP_SRC_SNAPSHOT:-/Users/kritananda/Projects/securiace-vps-platform/deploy/whmcs-test/snapshot}"
target="${1:-all}"

[[ -d "$SRC_SNAP" ]] || { echo "ERROR: source snapshot not found at $SRC_SNAP" >&2; exit 1; }

copy_one() {
  local srcleg="$1" dstleg="$2" dbname="$3" oldhost="$4" newhost="$5"
  local s="$SRC_SNAP/$srcleg" d="$HERE/snapshot/$dstleg"
  if [[ ! -f "$s/$dbname.sql" || ! -f "$s/configuration.php" ]]; then
    echo "WARNING: incomplete source snapshot at $s — skipping $dstleg" >&2
    return 0
  fi
  mkdir -p "$d"
  cp "$s/$dbname.sql" "$d/$dbname.sql"
  # Patch their docker db host → ours. Their default db creds already
  # match ours (whmcs / whmcs_{8,9}_password / whmcs{8,9}).
  sed "s/\$db_host = '$oldhost';/\$db_host = '$newhost';/" \
    "$s/configuration.php" > "$d/configuration.php"
  chmod 644 "$d/configuration.php"
  cat > "$d/manifest.txt" <<EOF
whmcs-mcp-server bootstrap snapshot (from securiace-vps-platform clean install)
captured_from: $s
db_name: $dbname
db_host_patched: $oldhost -> $newhost
EOF
  echo "OK: $dstleg base snapshot prepared ($(du -h "$d/$dbname.sql"|awk '{print $1}'))"
}

case "$target" in
  mcpw8|all) copy_one whmcs8 mcpw8 whmcs8 mariadb8 mcpw8-db ;;
esac
case "$target" in
  mcpw9|all) copy_one whmcs9 mcpw9 whmcs9 mariadb9 mcpw9-db ;;
esac
[[ "$target" =~ ^(mcpw8|mcpw9|all)$ ]] || { echo "Unknown target: $target" >&2; exit 1; }

echo
echo "==> Restoring via reset.sh (proven non-wizard path) ..."
bash "$HERE/reset.sh" "$target"
echo
echo "Done. CLEAN WHMCS base restored (no prod data)."
echo "For realistic scrubbed prod data instead: npm run whmcs:test:seed-prod"
