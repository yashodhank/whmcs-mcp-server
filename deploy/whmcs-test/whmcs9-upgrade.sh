#!/usr/bin/env bash
# Run the WHMCS 8.x → 9.0 DB upgrade on the 9.0 leg (mcpw9).
#
# Precondition: seed-from-prod.sh has loaded the scrubbed 8.13.1 DB into
# the whmcs9 database and written source/9.0/configuration.php. The 9.0
# WHMCS source + bypass License.php + the install/ dir must be present
# (install/ drives the upgrade; post-install-fixup.sh removes it after).
#
# The UPGRADE path is far less brittle than fresh-install: no EULA, no
# DB-config form, no admin creation — it's "confirm backup → run schema
# migrations". We POST step=upgrade and poll tblconfiguration.Version.
#
# Usage: deploy/whmcs-test/whmcs9-upgrade.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/deploy/whmcs-test"
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
DC=(docker compose -f "$COMPOSE_FILE")
PORT="${WMCP_WHMCS_9_PORT:-8890}"
BASE="http://localhost:$PORT"
SRC9="$HERE/source/9.0"

mysql9() { "${DC[@]}" exec -T mcpw9-db mariadb -uroot -prootsecret_9 -N -B "$@" 2>/dev/null | tr -d '\r'; }
db_version() { mysql9 whmcs9 -e "SELECT value FROM tblconfiguration WHERE setting='Version' LIMIT 1;"; }

if ! "${DC[@]}" ps mcpw9 --status running --quiet >/dev/null 2>&1; then
  echo "ERROR: mcpw9 not running. Run: npm run whmcs:test:up" >&2
  exit 1
fi

before="$(db_version || true)"
echo "==> 9.0 leg current DB Version: ${before:-<unknown>}"
case "$before" in
  9.*) echo "    Already at 9.x — running post-install-fixup only."
       bash "$HERE/post-install-fixup.sh" mcpw9; exit 0 ;;
esac

# WHMCS upgrade needs install/ present. A prior post-install-fixup (e.g.
# from the clean-base bootstrap) removes it from the bind-mounted source.
# Self-heal: restore install/ (and the bypass License.php, which a source
# re-extract would also revert) from the staged bundle in ~/Downloads.
SRC9_HOST="$HERE/source/9.0"
BUNDLE9="${WMCP_WHMCS_9_BUNDLE:-$HOME/Downloads/whmcs_v901_full.zip}"
if ! "${DC[@]}" exec -T mcpw9 sh -lc 'test -d /var/www/html/install'; then
  echo "==> install/ missing on 9.0 leg — restoring from bundle ..."
  [[ -f "$BUNDLE9" ]] || { echo "ERROR: $BUNDLE9 not found; run npm run whmcs:test:source" >&2; exit 1; }
  tmp="$(mktemp -d)"
  # The whmcsfull bundle nests under a top dir (e.g. whmcs/). Extract just install/.
  unzip -q "$BUNDLE9" '*/install/*' -d "$tmp" 2>/dev/null || unzip -q "$BUNDLE9" 'install/*' -d "$tmp"
  ins="$(find "$tmp" -type d -name install -maxdepth 3 | head -1)"
  [[ -n "$ins" ]] || { echo "ERROR: install/ not found inside $BUNDLE9" >&2; rm -rf "$tmp"; exit 1; }
  rm -rf "$SRC9_HOST/install"
  cp -R "$ins" "$SRC9_HOST/install"
  rm -rf "$tmp"
  echo "    install/ restored at $SRC9_HOST/install"
  # Re-assert the bypass License.php in the container (bind-mount → host too).
  bash "$HERE/install-license.sh" mcpw9 >/dev/null 2>&1 || true
fi
"${DC[@]}" exec -T mcpw9 sh -lc 'test -d /var/www/html/install' \
  || { echo "ERROR: install/ still not visible in mcpw9 after restore." >&2; exit 1; }

JAR="$(mktemp)"; trap 'rm -f "$JAR" "$JAR".o' EXIT
echo "==> Driving WHMCS upgrade at $BASE/install/install.php ..."
# Prime a session, then POST the upgrade confirmation.
curl -sS --max-time 20 -c "$JAR" "$BASE/install/install.php" -o /dev/null || true
curl -sS --max-time 120 -b "$JAR" -c "$JAR" \
  --data 'confirmBackup=1&step=upgrade' \
  "$BASE/install/install.php?step=upgrade" -o "$JAR".o || true

# WHMCS 8→9 may run migrations across several auto-advancing steps; poll
# the DB Version (authoritative) for up to ~5 min, nudging the upgrade
# endpoint each cycle in case it advances per request.
ok=0
for i in $(seq 1 30); do
  v="$(db_version || true)"
  echo "    [$i] DB Version = ${v:-<none>}"
  case "$v" in 9.*) ok=1; break;; esac
  curl -sS --max-time 60 -b "$JAR" -c "$JAR" \
    --data 'confirmBackup=1&step=upgrade' \
    "$BASE/install/install.php?step=upgrade" -o /dev/null || true
  sleep 8
done

if [[ $ok -ne 1 ]]; then
  echo "ERROR: 9.0 leg did not reach Version 9.x after upgrade attempts." >&2
  echo "       Fallback: open $BASE/install/install.php in a browser and click" >&2
  echo "       through the upgrade once; WHMCS also auto-runs pending upgrades" >&2
  echo "       on first authenticated admin hit. Then: npm run whmcs:test:fixup" >&2
  echo "       Last installer response saved at: $JAR.o" >&2
  exit 1
fi

echo "==> Upgrade complete (Version $(db_version)). Running post-install-fixup ..."
bash "$HERE/post-install-fixup.sh" mcpw9
echo
echo "Done. 9.0 leg upgraded + fixed up. Snapshot it so resets skip the upgrade:"
echo "  npm run whmcs:test:snapshot"
