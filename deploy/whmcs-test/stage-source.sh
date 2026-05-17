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

stage_one "$DOWNLOADS/whmcs_v8131_full.zip" "$SOURCE_DIR/8.13" "8.13"
stage_one "$DOWNLOADS/whmcs_v901_full.zip"  "$SOURCE_DIR/9.0"  "9.0"

echo
echo "Done. Next:"
echo "  npm run whmcs:test:licenses        # stage License.php variants from ~/Downloads"
echo "  npm run whmcs:test:up              # bring up both stacks"
echo "  npm run whmcs:test:license-install # apply bypass License.php"
