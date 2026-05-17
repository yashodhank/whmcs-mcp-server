#!/usr/bin/env bash
# Copy bypass License.php into running WHMCS containers (LOCAL DEV/TEST ONLY).
#
# Usage:
#   deploy/whmcs-test/install-license.sh          # both containers
#   deploy/whmcs-test/install-license.sh mcpw8    # 8.13 only
#   deploy/whmcs-test/install-license.sh mcpw9    # 9.x only
#
# Requires deploy/whmcs-test/licenses/License-{8.13,9}.php to exist
# (run `npm run whmcs:test:licenses` to stage them from ~/Downloads).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
LICENSES_DIR="$REPO_ROOT/deploy/whmcs-test/licenses"

# Both 8.13 and 9.0 source trees place License.php at the same
# vendor-relative path. Override WMCP_WHMCS_LICENSE_PATH if a future
# WHMCS version moves it.
TARGET_IN_CONTAINER="${WMCP_WHMCS_LICENSE_PATH:-/var/www/html/vendor/whmcs/whmcs-foundation/lib/License.php}"

install_for() {
  local service="$1"        # mcpw8 | mcpw9
  local license_file="$2"   # absolute path on host

  if [[ ! -f "$license_file" ]]; then
    echo "ERROR: $license_file is missing." >&2
    echo "       Run 'npm run whmcs:test:licenses' to copy from ~/Downloads," >&2
    echo "       or place the file there manually." >&2
    return 1
  fi

  if ! docker compose -f "$COMPOSE_FILE" ps "$service" \
       --status running --quiet >/dev/null 2>&1; then
    echo "WARNING: container '$service' is not running; skipping." >&2
    return 0
  fi

  echo "==> Installing License.php into $service ..."
  docker compose -f "$COMPOSE_FILE" cp \
    "$license_file" "$service:$TARGET_IN_CONTAINER"
  echo "    OK"
}

target="${1:-all}"

case "$target" in
  mcpw8|all)
    install_for mcpw8 "$LICENSES_DIR/License-8.13.php"
    ;;
esac

case "$target" in
  mcpw9|all)
    install_for mcpw9 "$LICENSES_DIR/License-9.php"
    ;;
esac

if [[ "$target" != "mcpw8" && "$target" != "mcpw9" && "$target" != "all" ]]; then
  echo "Unknown target: $target. Use mcpw8 | mcpw9 | all." >&2
  exit 1
fi

echo
echo "Done. Verify by hitting each WHMCS root:"
echo "  curl -s http://localhost:${WMCP_WHMCS_8_PORT:-8813}/   # WHMCS 8.13"
echo "  curl -s http://localhost:${WMCP_WHMCS_9_PORT:-8890}/   # WHMCS 9.0"
