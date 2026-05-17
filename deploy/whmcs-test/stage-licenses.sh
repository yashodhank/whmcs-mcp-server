#!/usr/bin/env bash
# Stage bypass License.php files from ~/Downloads into
# deploy/whmcs-test/licenses/. LOCAL DEV/TEST ONLY — never production.
#
#   ~/Downloads/License8.13.0.php → deploy/whmcs-test/licenses/License-8.13.php
#   ~/Downloads/License9.php      → deploy/whmcs-test/licenses/License-9.php
#
# Skips files that aren't present in ~/Downloads with a clear message.
# Refuses to overwrite an existing staged file unless --force is passed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LICENSES_DIR="$REPO_ROOT/deploy/whmcs-test/licenses"
DOWNLOADS="${HOME}/Downloads"

force=0
if [[ "${1:-}" == "--force" ]]; then
  force=1
fi

mkdir -p "$LICENSES_DIR"

stage_one() {
  local src="$1"
  local dest="$2"
  if [[ ! -f "$src" ]]; then
    echo "MISS:  $src not found — skipping" >&2
    return 0
  fi
  if [[ -f "$dest" && $force -eq 0 ]]; then
    echo "EXIST: $dest already staged (use --force to overwrite)"
    return 0
  fi
  cp "$src" "$dest"
  chmod 0644 "$dest"
  echo "OK:    $src → $dest"
}

stage_one "$DOWNLOADS/License8.13.0.php" "$LICENSES_DIR/License-8.13.php"
stage_one "$DOWNLOADS/License9.php"       "$LICENSES_DIR/License-9.php"
