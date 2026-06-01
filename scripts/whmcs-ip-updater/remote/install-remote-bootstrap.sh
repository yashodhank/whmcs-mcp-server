#!/usr/bin/env bash
set -euo pipefail

# Bootstrap script (run as root on WHMCS host) to install restricted forced-command setup.

RESTRICTED_USER="${1:-whmcs-ip-updater}"
PUBKEY_FILE="${2:-}"
WHMCS_ROOT="${3:-/var/www/my_securiace_usr/data/www/my.securiace.com}"
FORCED_COMMAND_PATH="/usr/local/sbin/whmcs-api-ip-updater"
WORKER_PATH="/usr/local/libexec/whmcs_api_ip_updater.php"
CONFIG_PATH="$WHMCS_ROOT/configuration.php"
SSHD_DROPIN="/etc/ssh/sshd_config.d/99-whmcs-ip-updater.conf"

if [[ -z "$PUBKEY_FILE" || ! -f "$PUBKEY_FILE" ]]; then
  echo "Usage: $0 <restricted-user> <public-key-file> [whmcs-root]" >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "WHMCS configuration.php not found at: $CONFIG_PATH" >&2
  exit 1
fi

if ! id "$RESTRICTED_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$RESTRICTED_USER"
else
  usermod -s /bin/bash "$RESTRICTED_USER"
fi
# Lock the password so the account can never be logged into interactively via
# console/su; SSH is the only access path, and SSH is itself gated by:
#   1. authorized_keys command="..." prefix (forced command)
#   2. sshd_config Match User block with ForceCommand and PermitTTY no
# The shell stays /bin/bash (not /usr/sbin/nologin) because sshd executes
# ForceCommand via `<user-shell> -c <cmd>` and nologin refuses to exec, which
# would break the entire updater path. Defense-in-depth is provided by the
# locked password, no sudo grant, no supplementary groups, and ACL-only file
# access elsewhere in this script.
usermod -L "$RESTRICTED_USER"

HOME_DIR="$(getent passwd "$RESTRICTED_USER" | cut -d: -f6)"
if [[ -z "$HOME_DIR" ]]; then
  echo "Unable to resolve home directory for $RESTRICTED_USER" >&2
  exit 1
fi

install -d -m 0755 /usr/local/libexec
install -m 0755 "$(dirname "$0")/whmcs-api-ip-updater" "$FORCED_COMMAND_PATH"
install -m 0644 "$(dirname "$0")/whmcs_api_ip_updater.php" "$WORKER_PATH"

install -d -m 0700 "$HOME_DIR/.ssh"
touch "$HOME_DIR/.ssh/authorized_keys"
chmod 0600 "$HOME_DIR/.ssh/authorized_keys"

PUBKEY_CONTENT="$(cat "$PUBKEY_FILE")"
# Extract the algorithm+base64 (drop trailing comment); used to match prior entries.
PUBKEY_CORE="$(awk '{print $1" "$2}' <"$PUBKEY_FILE")"
if [[ -z "$PUBKEY_CORE" ]]; then
  echo "Public key file is empty or malformed: $PUBKEY_FILE" >&2
  exit 1
fi
FORCED_PREFIX="command=\"$FORCED_COMMAND_PATH\",no-agent-forwarding,no-X11-forwarding,no-port-forwarding,no-pty"
ENTRY="$FORCED_PREFIX $PUBKEY_CONTENT"

TMP_AUTH_KEYS="$(mktemp)"
# Preserve any unrelated authorized_keys entries but drop every prior entry that
# references our public key, regardless of options/comment, before re-adding one
# canonical forced-command entry.
if [[ -s "$HOME_DIR/.ssh/authorized_keys" ]]; then
  PUBKEY_CORE="$PUBKEY_CORE" awk '
    {
      line = $0
      # Strip leading options up to first whitespace-separated token that looks like a key type.
      rest = line
      sub(/^[^ \t]+([ \t]+[^ \t]+)?[ \t]+/, "", rest)
      # Skip blank / comment-only lines (preserve them).
      if (line ~ /^[[:space:]]*$/ || line ~ /^[[:space:]]*#/) { print line; next }
      # Match "type base64" anywhere on the line; drop if it equals our PUBKEY_CORE.
      n = split(line, parts, /[ \t]+/)
      core = ""
      for (i = 1; i <= n - 1; i++) {
        if (parts[i] ~ /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))$/) {
          core = parts[i] " " parts[i+1]
          break
        }
      }
      if (core != ENVIRON["PUBKEY_CORE"]) {
        print line
      }
    }
  ' "$HOME_DIR/.ssh/authorized_keys" >"$TMP_AUTH_KEYS"
fi
printf '%s\n' "$ENTRY" >>"$TMP_AUTH_KEYS"
install -m 0600 "$TMP_AUTH_KEYS" "$HOME_DIR/.ssh/authorized_keys"
rm -f "$TMP_AUTH_KEYS"

install -d -m 0755 /etc/ssh/sshd_config.d
cat >"$SSHD_DROPIN" <<EOF
Match User $RESTRICTED_USER
    ForceCommand $FORCED_COMMAND_PATH
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PasswordAuthentication no
    PubkeyAuthentication yes
EOF
chmod 0644 "$SSHD_DROPIN"

if ! command -v setfacl >/dev/null 2>&1; then
  echo "setfacl is required for least-privilege file access; refusing insecure chmod fallback" >&2
  echo "Install the 'acl' package (e.g. 'apt-get install -y acl') and re-run this script." >&2
  exit 1
fi
setfacl -m "u:$RESTRICTED_USER:r" "$CONFIG_PATH"

# Resolve WHMCS templates_compiledir and grant the restricted user write access via ACL
# so localAPI() compilations can succeed without group-wide write permissions.
TEMPLATES_COMPILEDIR_RAW="$(php -r '
if (!isset($argv[1]) || !is_file($argv[1])) {
    fwrite(STDERR, "configuration.php path is invalid\n");
    exit(1);
}
require $argv[1];
if (isset($templates_compiledir) && is_string($templates_compiledir) && $templates_compiledir !== "") {
    echo rtrim($templates_compiledir, "/");
}
' "$CONFIG_PATH" 2>/dev/null || true)"

# Strip leading/trailing whitespace (WHMCS configuration.php sometimes emits a
# stray newline before our captured output) without disturbing internal spaces.
# sed without -z processes one line at a time so it cannot remove a leading
# newline; xargs collapses all surrounding whitespace, which is safe here
# because templates_compiledir is a filesystem path token, not free text.
TEMPLATES_COMPILEDIR="$(printf %s "$TEMPLATES_COMPILEDIR_RAW" | awk 'NF{sub(/^[[:space:]]+/,""); sub(/[[:space:]]+$/,""); print; exit}')"

if [[ -z "$TEMPLATES_COMPILEDIR" ]]; then
  # Fall back to the conventional Private/templates_c sibling of the WHMCS root.
  TEMPLATES_COMPILEDIR="$(dirname "$WHMCS_ROOT")/Private/templates_c"
fi

if [[ -d "$TEMPLATES_COMPILEDIR" ]]; then
  setfacl -R -m "u:$RESTRICTED_USER:rwx" "$TEMPLATES_COMPILEDIR"
  setfacl -d -m "u:$RESTRICTED_USER:rwx" "$TEMPLATES_COMPILEDIR"
else
  echo "Templates compile dir not found; localAPI() may fail until it exists: $TEMPLATES_COMPILEDIR" >&2
fi

# Strip any insecure supplementary group memberships (e.g. webserver group reads).
# The restricted user should only belong to its own primary group; if an operator
# explicitly wants supplementary groups they can re-add them after install.
CURRENT_SUPP_GROUPS="$(id -nG "$RESTRICTED_USER" | tr ' ' '\n' | grep -vxF "$RESTRICTED_USER" | tr '\n' ',' | sed 's/,$//' || true)"
if [[ -n "$CURRENT_SUPP_GROUPS" ]]; then
  # Verify ACL grants effective read access before removing group memberships,
  # otherwise we could lock the restricted user out of WHMCS files.
  if ! sudo -u "$RESTRICTED_USER" test -r "$CONFIG_PATH"; then
    echo "ACL verification failed: $RESTRICTED_USER cannot read $CONFIG_PATH after setfacl." >&2
    echo "Refusing to strip supplementary groups ($CURRENT_SUPP_GROUPS) to avoid lockout." >&2
    exit 1
  fi
  if [[ -d "$TEMPLATES_COMPILEDIR" ]] && ! sudo -u "$RESTRICTED_USER" test -w "$TEMPLATES_COMPILEDIR"; then
    echo "ACL verification failed: $RESTRICTED_USER cannot write $TEMPLATES_COMPILEDIR after setfacl." >&2
    echo "Refusing to strip supplementary groups ($CURRENT_SUPP_GROUPS) to avoid lockout." >&2
    exit 1
  fi
  echo "Removing supplementary groups from $RESTRICTED_USER (was: $CURRENT_SUPP_GROUPS) to enforce ACL-only access." >&2
  usermod -G "" "$RESTRICTED_USER"
fi

php -r '
// Disable mysqli implicit exception throwing so we can rely on return-value / errno
// checks for idempotent migration logic across PHP versions.
mysqli_report(MYSQLI_REPORT_OFF);
if (!isset($argv[1]) || !is_file($argv[1])) {
    fwrite(STDERR, "configuration.php path is invalid\n");
    exit(1);
}
require $argv[1];
foreach (["db_host", "db_username", "db_password", "db_name"] as $var) {
    if (!isset($$var) || !is_string($$var) || $$var === "") {
        fwrite(STDERR, "Missing WHMCS DB config value: {$var}\n");
        exit(1);
    }
}
$db = @new mysqli($db_host, $db_username, $db_password, $db_name);
if ($db->connect_errno) {
    fwrite(STDERR, "DB connect failed: {$db->connect_errno}\n");
    exit(1);
}
$db->set_charset("utf8mb4");
// The column list below MUST stay in lock-step with the $requiredColumns
// array in remote/whmcs_api_ip_updater.php::ensure_backup_table(). The worker
// fails closed with SCHEMA_MIGRATION_REQUIRED if any required column is
// missing, so dropping a column here without dropping it there will break
// every production action until bootstrap is re-run.
$create = "CREATE TABLE IF NOT EXISTS mod_api_ip_allowlist_backups (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, reason VARCHAR(255) NOT NULL, old_value LONGTEXT NOT NULL, new_value LONGTEXT NOT NULL, checksum_before CHAR(64) NOT NULL, checksum_after CHAR(64) NOT NULL, applied TINYINT(1) NOT NULL DEFAULT 0, applied_at DATETIME NULL, PRIMARY KEY (id), KEY idx_applied_created (applied, created_at), KEY idx_created_at (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
if (!$db->query($create)) {
    fwrite(STDERR, "Create backup table failed: {$db->error}\n");
    exit(1);
}
$columns = [];
$colResult = $db->query("SHOW COLUMNS FROM mod_api_ip_allowlist_backups");
if (!$colResult) {
    fwrite(STDERR, "Inspect backup table failed: {$db->error}\n");
    exit(1);
}
while ($row = $colResult->fetch_assoc()) {
    $columns[(string) $row["Field"]] = true;
}
$colResult->free();
if (!isset($columns["applied"])) {
    if (!$db->query("ALTER TABLE mod_api_ip_allowlist_backups ADD COLUMN applied TINYINT(1) NOT NULL DEFAULT 0")) {
        fwrite(STDERR, "Add applied column failed: {$db->error}\n");
        exit(1);
    }
}
if (!isset($columns["applied_at"])) {
    if (!$db->query("ALTER TABLE mod_api_ip_allowlist_backups ADD COLUMN applied_at DATETIME NULL")) {
        fwrite(STDERR, "Add applied_at column failed: {$db->error}\n");
        exit(1);
    }
}
// Idempotent index check via SHOW INDEX; only ALTER if the index is missing
// to avoid relying on errno 1061 across mysqli exception modes / PHP versions.
$haveIndex = false;
$idxResult = $db->query("SHOW INDEX FROM mod_api_ip_allowlist_backups WHERE Key_name = \"idx_applied_created\"");
if ($idxResult) {
    $haveIndex = $idxResult->num_rows > 0;
    $idxResult->free();
}
if (!$haveIndex) {
    if (!$db->query("ALTER TABLE mod_api_ip_allowlist_backups ADD KEY idx_applied_created (applied, created_at)")) {
        if ((int) $db->errno !== 1061) {
            fwrite(STDERR, "Add idx_applied_created failed: {$db->error}\n");
            exit(1);
        }
    }
}
$db->close();
' "$CONFIG_PATH"

chown -R "$RESTRICTED_USER:$RESTRICTED_USER" "$HOME_DIR/.ssh"

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload sshd >/dev/null 2>&1 || systemctl reload ssh >/dev/null 2>&1 || true
elif command -v service >/dev/null 2>&1; then
  service sshd reload >/dev/null 2>&1 || service ssh reload >/dev/null 2>&1 || true
fi

echo "Restricted user installed: $RESTRICTED_USER"
echo "Forced command: $FORCED_COMMAND_PATH"
echo "Worker script: $WORKER_PATH"
echo "WHMCS config ACL granted on: $CONFIG_PATH (u:$RESTRICTED_USER:r)"
echo "Templates compile dir ACL granted on: $TEMPLATES_COMPILEDIR (u:$RESTRICTED_USER:rwx)"
echo "sshd policy drop-in: $SSHD_DROPIN"
echo "Backup table schema verified: mod_api_ip_allowlist_backups"
