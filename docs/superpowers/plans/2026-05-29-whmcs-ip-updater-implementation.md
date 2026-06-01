# 2026-05-29 WHMCS IP Updater Implementation Decisions

This document locks brainstorming gates required by the source plan (`1780014784668-misty-harbor.md`) before coding.

## Gate 1: Execution Model (Option B)
- Locked: production uses restricted SSH user + forced command wrapper.
- Forced command path: `/usr/local/sbin/whmcs-api-ip-updater`.
- Forced command executes PHP worker only and emits JSON-only output.
- Root SSH is allowed for bootstrap and setup testing only.
- Bootstrap must ensure the restricted user can read WHMCS `configuration.php`
  via filesystem ACL (`setfacl -m u:<user>:r`) only — group-read fallbacks are
  refused fail-closed because they grant the same access to every other member
  of the WHMCS service group. The installer aborts if `setfacl` is missing and
  instructs the operator to install the `acl` package first.
- Bootstrap must also grant the restricted user `rwx` ACL on the WHMCS
  `templates_compiledir` (default ACL included) so `localAPI()` Smarty
  compilations succeed without group-wide write permissions on the WHMCS
  install directory.
- Before stripping any prior supplementary group memberships from the
  restricted user, the installer must verify that the ACL grants are
  effective (`sudo -u <user> test -r/-w`) so a misconfigured ACL cannot lock
  the worker out.
- The restricted user's login shell stays `/bin/bash` (not `nologin`) because
  `sshd_config` `ForceCommand` invokes `<user-shell> -c <cmd>` and `nologin`
  refuses to exec, which would break the entire updater path. Defense in
  depth is provided by `usermod -L`, no sudo grant, no supplementary groups,
  ACL-only file access, and the `sshd_config` `Match User` block enforcing
  `ForceCommand`, `PermitTTY no`, and `PubkeyAuthentication yes`.

## Gate 2: Safety
- Locked default IPv6 policy: `only-if-detected`.
- Partial update allowed only when policy permits (IPv4 can proceed if IPv6 missing under `only-if-detected`).
- If both IPv4 and IPv6 targets are unavailable/invalid, no write.
- Duplicate target notes (`MacIPv4`/`MacIPv6`) fail closed; no auto-fix.
- Production profile refuses `ssh_user=root` unless explicit override flag is supplied.

## Gate 3: Data Integrity
- Locked compare-and-swap update on `tblconfiguration(setting='APIAllowedIPs')` using pre-image match.
- On zero affected rows, re-read once and retry CAS one time.
- Semantic preservation check compares non-target entries before/after and hard-fails on any semantic drift.

## Gate 4: Backup and Rollback
- Locked backup table: `mod_api_ip_allowlist_backups`.
- Backup captured before each attempted write with checksums (`before`/`after`) and serialized payload snapshots.
- Rollback allowed only if current checksum == backup `checksum_after`.
- On checksum mismatch, rollback fails closed.

## Gate 5: Validation (`test-api`)
- Locked: `test-api` performs harmless WHMCS API action (`WhmcsDetails`) using configured API identifier/secret.
- `oneshot` can optionally run post-update API validation.
- If update succeeds but API validation fails, local event is `updated_but_api_validation_failed`.

## Gate 6: Operations
- Preferred scheduler: LaunchAgent runs `oneshot` every 5 minutes.
- Daemon mode is optional for manual long-running operation.
- LaunchAgent template documents root refusal and explicit override switch.

## Implementation Scope
- Write scope restricted to:
  1. `tblconfiguration.setting='APIAllowedIPs'`
  2. Backup table rows in `mod_api_ip_allowlist_backups`
- No mutation of any other WHMCS tables/settings.
