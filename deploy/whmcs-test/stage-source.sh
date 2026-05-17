#!/usr/bin/env bash
# Stage WHMCS source bundles from ~/Downloads into deploy/whmcs-test/source/.
#
# Replicated into whmcs-mcp-server from securiace-vps-platform (unchanged
# logic — source bundles are shared host inputs in ~/Downloads).
#
#   ~/Downloads/whmcs_v8131_full.zip → deploy/whmcs-test/source/8.13/<extracted>
#   ~/Downloads/whmcs_v901_full.zip  → deploy/whmcs-test/source/9.0/<extracted>
#
# Skips files that aren't present in ~/Downloads with a clear message.
# Refuses to overwrite an existing extracted directory unless --force.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_DIR="$REPO_ROOT/deploy/whmcs-test/source"
DOWNLOADS="${HOME}/Downloads"

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
fi

mkdir -p "$SOURCE_DIR"

stage_one() {
  local zip="$1"
  local dest_dir="$2"
  local label="$3"

  if [[ ! -f "$zip" ]]; then
    echo "MISS:  $zip not found — skipping $label" >&2
    return 0
  fi

  if [[ -d "$dest_dir" && -n "$(ls -A "$dest_dir" 2>/dev/null)" ]]; then
    if [[ $force -eq 0 ]]; then
      echo "EXIST: $dest_dir already populated (use --force to re-extract)" >&2
      return 0
    fi
    echo "FORCE: removing $dest_dir for re-extract"
    rm -rf "$dest_dir"
  fi

  echo "==> Extracting $zip → $dest_dir ..."
  mkdir -p "$dest_dir"
  local tmp
  tmp="$(mktemp -d)"
  unzip -q "$zip" -d "$tmp"
  local whmcs_root=""
  while IFS= read -r -d '' candidate; do
    if [[ -d "$candidate/vendor" && -d "$candidate/admin" ]]; then
      whmcs_root="$candidate"
      break
    fi
  done < <(find "$tmp" -mindepth 0 -maxdepth 4 -type d -print0)
  if [[ -z "$whmcs_root" ]]; then
    echo "ERROR: extracted zip didn't contain a recognizable WHMCS root" >&2
    rm -rf "$tmp"
    return 1
  fi
  shopt -s dotglob
  mv "$whmcs_root"/* "$dest_dir/"
  shopt -u dotglob
  rm -rf "$tmp"

  if [[ ! -f "$dest_dir/vendor/whmcs/whmcs-foundation/lib/License.php" ]]; then
    echo "WARN:  $dest_dir/vendor/whmcs/whmcs-foundation/lib/License.php not present" >&2
    echo "       The bypass License.php install step will fail. Re-check the bundle." >&2
  fi
  echo "OK:    $label staged at $dest_dir ($(du -sh "$dest_dir" | awk '{print $1}'))"
}

# Auto-pick the NEWEST 8.x and 9.x archive in ~/Downloads (sort -V) so this
# never goes stale as you stage newer WHMCS releases. Override explicitly
# with WMCP_WHMCS_8_BUNDLE / WMCP_WHMCS_9_BUNDLE if needed. We prefer the
# `whmcs-<ver>-release.N.zip` naming; fall back to legacy `whmcs_vNNN_full.zip`.
pick_latest() { # $1 = major (8|9)
  ls -1 "$DOWNLOADS"/whmcs-"$1".*-release.*.zip 2>/dev/null | sort -V | tail -1
}
BUNDLE_8="${WMCP_WHMCS_8_BUNDLE:-$(pick_latest 8)}"
BUNDLE_9="${WMCP_WHMCS_9_BUNDLE:-$(pick_latest 9)}"
[[ -n "$BUNDLE_8" ]] || BUNDLE_8="$DOWNLOADS/whmcs_v8131_full.zip"
[[ -n "$BUNDLE_9" ]] || BUNDLE_9="$DOWNLOADS/whmcs_v901_full.zip"
echo "==> 8.x bundle: $(basename "$BUNDLE_8")"
echo "==> 9.x bundle: $(basename "$BUNDLE_9")"
stage_one "$BUNDLE_8" "$SOURCE_DIR/8.13" "8.13"
stage_one "$BUNDLE_9" "$SOURCE_DIR/9.0"  "9.0"

# CRITICAL: if the stack is already running, a host-side re-stage (rm -rf +
# re-extract) SEVERS the docker bind-mount — the container keeps the old,
# now-deleted inode and serves 403/404. Recreate the app containers so they
# re-establish the mount to the freshly-staged source.
COMPOSE_FILE="$REPO_ROOT/docker-compose.whmcs-test.yml"
if docker compose -f "$COMPOSE_FILE" ps --status running --quiet mcpw8 >/dev/null 2>&1 \
   && [ -n "$(docker compose -f "$COMPOSE_FILE" ps --status running --quiet mcpw8 2>/dev/null)" ]; then
  echo "==> stack running — recreating app containers so the new source is mounted ..."
  docker compose -f "$COMPOSE_FILE" up -d --force-recreate --no-deps mcpw8-php mcpw8 mcpw9-php mcpw9 >/dev/null 2>&1 || true
fi

echo
echo "Done. Next:"
echo "  npm run whmcs:test:licenses        # stage License.php variants from ~/Downloads"
echo "  npm run whmcs:test:up              # bring up both stacks"
echo "  npm run whmcs:test:license-install # apply bypass License.php"
