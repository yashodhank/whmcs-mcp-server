# Runbook: WHMCS API connectivity / "An admin user is required"

Symptom: API calls (via the MCP tools or curl) return
`{"result":"error","message":"An admin user is required"}` — often for **every**
action, reads and writes alike.

> TL;DR: this is **almost always a doubled API path**, not a credential or
> permission problem. Check §1 first — it's a 2-minute fix.

## Check these IN ORDER (fastest, highest-yield first)

### 1. URL shape — the #1 cause (2-minute check)
`WHMCS_API_URL` must be the **base origin** (`https://billing.example.com`), NOT
the full endpoint. The client appends `/includes/api.php` itself. If the env var
already includes that path, requests double to
`/includes/api.php/includes/api.php`, which WHMCS serves with **HTTP 200** but
routes to an admin-session handler → `"An admin user is required"` *before the
credential is ever validated*.

```bash
# What is configured?
grep '^WHMCS_API_URL=' .env.production        # must NOT end in /includes/api.php

# Direct test against the CORRECT single-path endpoint (replace BASE):
curl -s -X POST "https://BASE/includes/api.php" \
  -d "identifier=$WHMCS_IDENTIFIER" -d "secret=$WHMCS_SECRET" \
  -d "responsetype=json" -d "action=GetAdminDetails"
# success here + failure via the MCP  ==>  it's URL doubling. Set WHMCS_API_URL to the base origin.
```

Confirm from the web access log on the server (the doubled path is visible):

```bash
grep 'includes/api.php' .../logs/<domain>-backend.access.log | tail
# A line like   POST /includes/api.php/includes/api.php   is the smoking gun.
```

Fix: set `WHMCS_API_URL=https://BASE` (no path) and restart the MCP server.

> Code guard: `resolveWhmcsApiEndpoint()` in `src/config.ts` now normalizes both
> forms so a full-URL value can no longer double, and config load warns when the
> env contains the path. This runbook still applies to older deployments and to
> manual curl debugging.

### 2. Tell credential failure apart from URL failure
- **No credentials** in the request → WHMCS returns `"Authentication Failed"`.
- **Bad credentials** (wrong identifier/secret) → also `"Authentication Failed"`.
- `"An admin user is required"` means the request reached an admin-context path
  WITHOUT a resolved admin — i.e. the credential path wasn't even taken. With
  valid creds this almost always means the **URL is doubled** (check §1), not a
  credential problem.

### 3. Is the credential actually being validated?
WHMCS API credentials live in `tbldeviceauth` (NOT `tblapi_credentials`, which
does not exist, NOR the empty `tbloauthserver_clients`). `last_access` is stamped
on successful validation. If it is NOT moving while you make calls, WHMCS is
rejecting before credential lookup → re-check §1.

```sql
SELECT id, user_id, is_admin, role_ids, last_access, deleted_at
FROM tbldeviceauth WHERE identifier = '<the identifier>';
```

### 4. IP allowlist
WHMCS `tblconfiguration.APIAllowedIPs` restricts API source IPs. Confirm the
caller's public IP is present (the project's auto-IP-heal addon, PR #46, manages
this on HTTP 403s). A clean HTTP 200 with a business error means IP is NOT the
blocker.

### 5. Admin account + role
The credential's `user_id` must be an **active** admin (`tbladmins.disabled=0`)
whose Administrator Role grants the needed permissions. WHMCS effectively
intersects the credential's API roles (`tblapi_roles`) with the linked admin's
role permissions (`tbladminperms`). An under-permissioned admin role can break
API calls — but it does NOT produce the doubled-path `"An admin user is
required"` (that one is pre-credential; see §1).

## Production server access (read-only DB diagnosis)
- Host: `sat-de-prod01.hn1.nl` / `195.7.4.219`. The SSH host key is keyed by
  **IP** (connect via the IP), and the key is `~/.ssh/id_rsa_securiace` — a
  non-default name, so pass it with `-i` (it is not auto-loaded by the agent):
  ```bash
  ssh -i ~/.ssh/id_rsa_securiace root@195.7.4.219
  ```
- WHMCS docroot: `/var/www/my_securiace_usr/data/www/my.securiace.com/`.
- Read DB creds *inside PHP* from `configuration.php` (avoids shell mangling of
  special chars and never echoes the secret to the shell):
  ```bash
  ssh -i ~/.ssh/id_rsa_securiace root@195.7.4.219 php <<'PHP'
  <?php ob_start(); include "/var/www/my_securiace_usr/data/www/my.securiace.com/configuration.php"; ob_end_clean();
  $p = new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4", $db_username, $db_password);
  echo $p->query("SELECT NOW()")->fetchColumn(), "\n";
  PHP
  ```
- All such access is READ-ONLY for diagnosis. Never echo secrets; reference
  `file:line` + credential type only.

## History
First diagnosed 2026-06-19: a total API outage where the env value had been set
to the full `https://my.securiace.com/includes/api.php`. Hours were spent on the
credential, admin account, admin roles, and IP allowlist (all fine) before the
doubled path was found in the access log. This runbook + the `resolveWhmcsApiEndpoint`
guard exist so it never costs that again.
