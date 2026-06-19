# WHMCS IP Updater (Option B)

Production-safe updater that changes only `MacIPv4` and `MacIPv6` entries inside serialized `tblconfiguration.setting='APIAllowedIPs'`.

## Safety Contract
- Production SSH must use restricted user + forced command wrapper.
- Local root SSH is refused by default unless `--allow-root-production` is explicitly passed.
- Write scope is limited to:
  1. `tblconfiguration` row where `setting='APIAllowedIPs'`
  2. backup rows in `mod_api_ip_allowlist_backups`
- Duplicate target notes fail closed (`DUPLICATE_TARGET_NOTE`).
- Missing target notes fail closed (`TARGET_NOTE_MISSING`).
- Compare-and-swap update prevents stale overwrites.
- Backup is written before each write attempt.
- Rollback requires checksum chain guard.
- Local execution uses a lock file beside state file to prevent concurrent updater runs.

## Files
- `whmcs_ip_updater.py` - local automation CLI
- `remote/whmcs-api-ip-updater` - forced-command wrapper
- `remote/whmcs_api_ip_updater.php` - remote JSON worker
- `remote/install-remote-bootstrap.sh` - bootstrap installer (root)
- `launchd/com.securiace.whmcs-ip-updater.plist.template` - 5-minute LaunchAgent template

## Bootstrap (root, one-time)
1. Copy `remote/*` to server.
2. Run on server as root:

```bash
./install-remote-bootstrap.sh whmcs-ip-updater /path/to/updater.pub /var/www/my_securiace_usr/data/www/my.securiace.com
```

Installer behavior:
- forces restricted user shell to `/bin/bash` (forced-command still restricts execution)
- requires `setfacl` and grants the restricted user read access to `configuration.php` via per-user ACL only
- grants the restricted user write access to the configured `templates_compiledir` so WHMCS local API bootstrap can run in CLI mode
- normalizes existing `authorized_keys` entries so the updater key is always forced-command restricted
- performs backup-table schema migration (`mod_api_ip_allowlist_backups`) during bootstrap

3. Validate forced command manually:

```bash
ssh -i /path/to/private_key whmcs-ip-updater@195.7.4.219 verify
```

## Host key verification

All remote modes use `ssh` with `StrictHostKeyChecking`. If the audited host key
lives outside the default `~/.ssh/known_hosts`, pass `--ssh-known-hosts <file>`
(or set `WHMCS_SSH_KNOWN_HOSTS`); the path may use `~`. This avoids per-machine
`~/.ssh/config` edits and makes the auto-heal portable across machines.

## Local Commands

```bash
# Doctor: remote checks + local detection + optional API validation
python3 whmcs_ip_updater.py doctor --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# Read current target values
python3 whmcs_ip_updater.py read-remote --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# Dry-run: detect + compare, no mutation
python3 whmcs_ip_updater.py dry-run --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# One update cycle
python3 whmcs_ip_updater.py oneshot --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# Rollback latest guarded backup
python3 whmcs_ip_updater.py rollback-last --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# API validation only
python3 whmcs_ip_updater.py test-api --ssh-host 195.7.4.219 --ssh-user whmcs-ip-updater --ssh-key /path/to/key

# Optional external API validation (requires credentials)
python3 whmcs_ip_updater.py test-api-external --whmcs-api-url https://my.securiace.com --whmcs-api-identifier <id> --whmcs-api-secret <secret>
```

## IPv6 Policy
- `required` - fail if no stable IPv6
- `only-if-detected` (default) - keep IPv4 healthy updates if IPv6 unavailable
- `disabled` - IPv6 ignored

## Provider/Route Mismatch Caveat
Public IP providers may see an address that differs from WHMCS-facing egress. Mitigation order:
1. Post-update `test-api` validation
2. Provider detection
3. Manual override `--ipv4` and/or `--ipv6`

## launchd Scheduling
Use `launchd` for production scheduling (every 5 minutes):
- Copy plist template to `~/Library/LaunchAgents/`
- Replace placeholder paths and user values
- Run one manual verification cycle (`doctor`, then `oneshot`) before loading the agent
- Load with `launchctl load ~/Library/LaunchAgents/com.securiace.whmcs-ip-updater.plist`
