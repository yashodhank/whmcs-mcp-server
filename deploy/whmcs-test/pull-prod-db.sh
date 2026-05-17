#!/usr/bin/env bash
# Pull the PRODUCTION WHMCS DB + config for local dev seeding.
#
# READ-ONLY on prod: only `cat configuration.php` and a single
# `mysqldump --single-transaction` (no writes to prod, no locking writes).
# Output lands in deploy/whmcs-test/.prodseed/ which is GITIGNORED.
# The raw (unscrubbed) dump is deleted by seed-from-prod.sh right after
# scrubbing — it must never persist or be committed.
#
# Usage: deploy/whmcs-test/pull-prod-db.sh
# Override host/path via PROD_SSH / PROD_WHMCS_DIR env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PRODSEED="$REPO_ROOT/deploy/whmcs-test/.prodseed"
PROD_SSH="${PROD_SSH:-root@195.7.4.219}"
PROD_WHMCS_DIR="${PROD_WHMCS_DIR:-/var/www/my_securiace_usr/data/www/my.securiace.com}"
# A dump the operator prepared on prod (preferred — exact live DB). When
# present we just fetch it; no live mysqldump / config parsing needed.
PROD_DUMP_REMOTE_PATH="${PROD_DUMP_REMOTE_PATH:-~/my_securiace_db.sql}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -o StrictHostKeyChecking=accept-new)

mkdir -p "$PRODSEED"
chmod 700 "$PRODSEED"

echo "==> Verifying SSH to $PROD_SSH (read-only) ..."
if ! ssh "${SSH_OPTS[@]}" "$PROD_SSH" 'echo ok' >/dev/null 2>&1; then
  echo "ERROR: cannot SSH to $PROD_SSH non-interactively (BatchMode)." >&2
  echo "       Ensure key-based access works: ssh $PROD_SSH" >&2
  echo "       (If it needs a password, run the ssh-agent/key setup first.)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Mode A (preferred): operator-prepared dump file on prod. Just fetch it
# (gzip on the wire), then synthesize prod-config.env. The sensitive
# encrypted prod data (cards, gateway/SMTP secrets) is TRUNCATED/blanked by
# scrub-pii.sql, so a freshly generated local cc_encryption_hash is correct
# (nothing left to decrypt with prod's original hash).
# ---------------------------------------------------------------------------
umask 077
if ssh "${SSH_OPTS[@]}" "$PROD_SSH" "test -f $PROD_DUMP_REMOTE_PATH" 2>/dev/null; then
  echo "==> Found operator-prepared dump at $PROD_SSH:$PROD_DUMP_REMOTE_PATH — fetching (gzip on wire) ..."
  ssh "${SSH_OPTS[@]}" "$PROD_SSH" "gzip -c $PROD_DUMP_REMOTE_PATH" > "$PRODSEED/raw.sql.gz" 2>"$PRODSEED/.pull.err"
  if [[ $? -ne 0 || ! -s "$PRODSEED/raw.sql.gz" ]] || ! gunzip -t "$PRODSEED/raw.sql.gz" 2>/dev/null; then
    echo "ERROR: could not fetch $PROD_DUMP_REMOTE_PATH:" >&2
    sed 's/^/    /' "$PRODSEED/.pull.err" 2>/dev/null >&2 || true
    rm -f "$PRODSEED/raw.sql.gz" "$PRODSEED/.pull.err"; exit 1
  fi
  rm -f "$PRODSEED/.pull.err"
  GEN_CC_HASH="$(LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 32)"
  cat > "$PRODSEED/prod-config.env" <<EOF
PROD_CC_HASH='$GEN_CC_HASH'
PROD_LICENSE=''
PROD_DB_NAME=''
EOF
  chmod 600 "$PRODSEED/prod-config.env" "$PRODSEED/raw.sql.gz"
  ntables="$(gunzip -c "$PRODSEED/raw.sql.gz" | grep -c 'CREATE TABLE' || true)"
  echo "OK: prod dump staged ($(du -h "$PRODSEED/raw.sql.gz"|awk '{print $1}'), $ntables tables); local cc_encryption_hash generated. NOT committed."
  echo "    Next: seed-from-prod.sh will scrub it and DELETE the raw dump."
  exit 0
fi
echo "    (no operator dump at $PROD_DUMP_REMOTE_PATH — falling back to live mysqldump)"

# Credential parsing AND the dump run entirely on the prod side so DB
# credentials never transit to / get logged on the local machine. WHMCS
# configuration.php is authoritative. Prod's $db_host is a docker-network
# alias ('mariadb') but the real MySQL is prod-LOCAL (no docker) — so we
# try the configured host, then 127.0.0.1, then the localhost socket, and
# use the first that authenticates.
#
# Remote parser (shared by both calls): emits nothing secret to our logs.
read -r -d '' REMOTE_PARSE <<'RP' || true
CONF="$PROD_WHMCS_DIR/configuration.php"
[ -f "$CONF" ] || { echo "NO_CONFIG" >&2; exit 3; }
pv() { sed -nE "s/^\\\$$1[[:space:]]*=[[:space:]]*['\"]([^'\"]*)['\"].*/\\1/p" "$CONF" | head -1; }
DBH="$(pv db_host)"; DBPORT="$(pv db_port)"; DBU="$(pv db_username)"
DBP="$(pv db_password)"; DBN="$(pv db_name)"
[ -n "$DBPORT" ] || DBPORT=3306
case "$DBH" in mariadb|mysql|db|database|whmcs-db|mariadb8|mariadb9|"") DBH=127.0.0.1;; esac
CANDS="$DBH 127.0.0.1 localhost"
CLIENT="$(command -v mariadb || command -v mysql)"
DUMPER="$(command -v mariadb-dump || command -v mysqldump)"
PICKED=""
for h in $CANDS; do
  if MYSQL_PWD="$DBP" "$CLIENT" -h "$h" -P "$DBPORT" -u "$DBU" "$DBN" -e 'SELECT 1' >/dev/null 2>&1; then
    PICKED="$h"; break
  fi
done
RP

# --- Call A: fetch only what the local seeder needs (cc hash/license/db
#     name), base64'd, written to a 600 gitignored file, never printed. ---
echo "==> Reading prod WHMCS DB metadata (cc_encryption_hash/license/db) ..."
META_B64="$(ssh "${SSH_OPTS[@]}" "$PROD_SSH" \
  "PROD_WHMCS_DIR='$PROD_WHMCS_DIR' bash -s" <<RPA 2>/dev/null || true
$REMOTE_PARSE
CCH="\$(pv cc_encryption_hash)"; LIC="\$(pv license)"
printf 'PROD_CC_HASH=%s\nPROD_LICENSE=%s\nPROD_DB_NAME=%s\n' \
  "\$(printf %s "\$CCH" | base64 | tr -d '\n')" \
  "\$(printf %s "\$LIC" | base64 | tr -d '\n')" \
  "\$(printf %s "\$DBN" | base64 | tr -d '\n')" | base64 | tr -d '\n'
RPA
)"
if [[ -z "$META_B64" ]]; then
  echo "ERROR: could not read prod configuration.php metadata." >&2
  exit 1
fi
umask 077
{
  while IFS='=' read -r k v; do
    [[ -n "$k" ]] && printf "%s='%s'\n" "$k" "$(printf %s "$v" | base64 --decode)"
  done < <(printf %s "$META_B64" | base64 --decode)
} > "$PRODSEED/prod-config.env"
chmod 600 "$PRODSEED/prod-config.env"
echo "    metadata captured (values not printed; stored 600, gitignored)"

# --- Call B: host-fallback mysqldump, gzip on the wire, creds stay on prod ---
echo "==> mysqldump prod DB (single-transaction, read-only) → raw.sql.gz ..."
ssh "${SSH_OPTS[@]}" "$PROD_SSH" "PROD_WHMCS_DIR='$PROD_WHMCS_DIR' bash -s" <<RPB > "$PRODSEED/raw.sql.gz" 2>"$PRODSEED/.pull.err"
$REMOTE_PARSE
if [ -z "\$PICKED" ]; then echo "AUTH_FAIL: no working host in [\$CANDS] for user/db" >&2; exit 4; fi
echo "    picked prod DB host: \$PICKED" >&2
MYSQL_PWD="\$DBP" "\$DUMPER" --single-transaction --no-tablespaces --routines --triggers --quick --default-character-set=utf8mb4 -h "\$PICKED" -P "\$DBPORT" -u "\$DBU" "\$DBN" | gzip -c
RPB
rc=$?
grep -q 'picked prod DB host' "$PRODSEED/.pull.err" 2>/dev/null && grep 'picked prod DB host' "$PRODSEED/.pull.err"

if [[ $rc -ne 0 || ! -s "$PRODSEED/raw.sql.gz" ]] || ! gunzip -t "$PRODSEED/raw.sql.gz" 2>/dev/null; then
  echo "ERROR: prod dump failed:" >&2
  sed 's/^/    /' "$PRODSEED/.pull.err" >&2 2>/dev/null || true
  rm -f "$PRODSEED/raw.sql.gz" "$PRODSEED/.pull.err"
  exit 1
fi
rm -f "$PRODSEED/.pull.err"
chmod 600 "$PRODSEED/raw.sql.gz"
ntables="$(gunzip -c "$PRODSEED/raw.sql.gz" | grep -c 'CREATE TABLE' || true)"
echo "OK: prod dump staged at $PRODSEED/raw.sql.gz ($(du -h "$PRODSEED/raw.sql.gz"|awk '{print $1}'), $ntables tables). NOT committed (.gitignore)."
echo "    Next: seed-from-prod.sh will scrub it and DELETE the raw dump."
