# Plan 023: API-connectivity troubleshooting runbook + agent "check-first" rules

> Written against commit `1275532`. Companion to Plan 022 (the code fix). This
> plan is docs + agent-rules only — no source code changes.

## Why this matters

On 2026-06-19 a total WHMCS API outage (`"An admin user is required"` on every
call) took hours to diagnose because the team chased the credential, admin
account, admin roles, and IP allowlist before discovering the real cause: a
**doubled `/includes/api.php` path** from a full-URL `WHMCS_API_URL` (see Plan
022). None of that diagnostic ladder was written down, and no agent rule said
"check the URL shape first." This plan captures the ladder so the next
occurrence is a 2-minute fix, and adds a check-first rule to the repo's agent
instructions.

## Repo conventions to follow
- Runbooks live in `docs/runbooks/*.md` (existing: `capability-probe.md`,
  `local-whmcs-testing.md`, `write-capability-probe.md`, etc.). Match their tone:
  short, command-first, copy-pasteable.
- Agent rules live in `AGENTS.md` (and a mirror in `.cursorrules`). Keep additions
  brief and imperative.

## Steps

### Step 1 — Create the runbook

Create `docs/runbooks/api-connectivity-troubleshooting.md` with exactly this content:

````markdown
# Runbook: WHMCS API connectivity / "An admin user is required"

Symptom: API calls (via the MCP tools or curl) return
`{"result":"error","message":"An admin user is required"}` — often for **every**
action, reads and writes alike.

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

# Direct test against the CORRECT single-path endpoint (replace base):
curl -s -X POST "https://BASE/includes/api.php" \
  -d "identifier=$WHMCS_IDENTIFIER" -d "secret=$WHMCS_SECRET" \
  -d "responsetype=json" -d "action=GetAdminDetails"
# success here + failure via the MCP  ==>  it's the URL doubling. Fix WHMCS_API_URL to the base origin.
```
Confirm from the web access log on the server (doubled path is visible):
```bash
grep 'includes/api.php' .../logs/<domain>-backend.access.log | tail
# A line like  POST /includes/api.php/includes/api.php  is the smoking gun.
```
Fix: set `WHMCS_API_URL=https://BASE` (no path) and restart the MCP server.
(Plan 022 hardens the code so this can't double anymore — but the runbook check
still applies to older deployments.)

### 2. Tell credential failure apart from URL failure
- **No credentials** in the request → WHMCS returns `"Authentication Failed"`.
- **Bad credentials** (wrong identifier/secret) → also `"Authentication Failed"`.
- `"An admin user is required"` means the request reached an admin-context path
  WITHOUT a resolved admin — i.e. the credential path wasn't even taken. With
  valid creds this almost always means the **URL is doubled** (check #1), not a
  credential problem.

### 3. Is the credential actually being validated?
WHMCS API credentials live in `tbldeviceauth` (NOT `tblapi_credentials`, which
does not exist, NOR the empty `tbloauthserver_clients`). `last_access` is stamped
on successful validation. If it is NOT moving while you make calls, WHMCS is
rejecting before credential lookup → re-check #1.

```sql
SELECT id, user_id, is_admin, role_ids, last_access, deleted_at
FROM tbldeviceauth WHERE identifier = '<the identifier>';
```

### 4. IP allowlist
WHMCS `tblconfiguration.APIAllowedIPs` restricts API source IPs. Confirm the
caller's public IP is present (the project's auto-IP-heal addon, PR #46, manages
this on 403s). A clean HTTP 200 with a business error means IP is NOT the
blocker.

### 5. Admin account + role
The credential's `user_id` must be an **active** admin (`tbladmins.disabled=0`)
whose Administrator Role grants the needed permissions. WHMCS effectively
intersects the credential's API roles (`tblapi_roles`) with the linked admin's
role permissions (`tbladminperms`). An under-permissioned admin role can break
API calls — but it does NOT produce the doubled-path `"An admin user is
required"` (that one is pre-credential; see #1).

## Production server access (for DB-level diagnosis)
- Host: `sat-de-prod01.hn1.nl` / `195.7.4.219`. SSH host key is keyed by **IP**
  (connect via the IP), and the key is `~/.ssh/id_rsa_securiace` (NOT a default
  name — pass it with `-i`; it is not auto-loaded):
  ```bash
  ssh -i ~/.ssh/id_rsa_securiace root@195.7.4.219
  ```
- WHMCS docroot: `/var/www/my_securiace_usr/data/www/my.securiace.com/`.
- Read DB creds safely from `configuration.php` inside PHP (avoids shell mangling
  of special chars) rather than exporting them to the shell:
  ```bash
  ssh -i ~/.ssh/id_rsa_securiace root@195.7.4.219 php <<'PHP'
  <?php ob_start(); include "/var/www/my_securiace_usr/data/www/my.securiace.com/configuration.php"; ob_end_clean();
  $p=new PDO("mysql:host=$db_host;dbname=$db_name;charset=utf8mb4",$db_username,$db_password);
  echo $p->query("SELECT NOW()")->fetchColumn(),"\n";
  PHP
  ```
- All such access is READ-ONLY for diagnosis. Never echo secrets; reference
  `file:line` + type only.
````

**Verify:** `test -f docs/runbooks/api-connectivity-troubleshooting.md` and the file renders (no unclosed code fences).

### Step 2 — Add a check-first rule to `AGENTS.md`

Find the section in `AGENTS.md` covering WHMCS connectivity / configuration (search for `WHMCS_API_URL` or "Troubleshooting"; if none, add a new `## Troubleshooting` section near the configuration docs). Add:

```markdown
### WHMCS API returns "An admin user is required"
This is almost always a **doubled API path**, NOT a credential/permission issue.
`WHMCS_API_URL` must be the base origin (`https://host`) — the client appends
`/includes/api.php`. Before touching credentials, admins, roles, or the IP
allowlist, run the URL-shape check in
`docs/runbooks/api-connectivity-troubleshooting.md` (§1). It's a 2-minute fix.
```

**Verify:** `grep -n "An admin user is required" AGENTS.md` returns the new entry.

### Step 3 — Mirror the rule into `.cursorrules`

`.cursorrules` mirrors agent guidance for Cursor. Add the same short note (one or two lines pointing at the runbook) in its WHMCS/troubleshooting area. If `.cursorrules` has no natural section, append under a `# Troubleshooting` heading.

**Verify:** `grep -n "doubled API path\|api-connectivity-troubleshooting" .cursorrules` returns a match.

### Step 4 — Cross-link from the runbook index (if one exists)
If `docs/runbooks/` has an index or `README.md`, add a line linking the new runbook. If not, skip (do not create one).

## In scope
- `docs/runbooks/api-connectivity-troubleshooting.md` (new)
- `AGENTS.md` (append a subsection)
- `.cursorrules` (append a short note)
- a runbook index line IF one already exists

## Out of scope
- `AGENT.md` (the large generated agent doc) — do not hand-edit; if it is generated, note that it should be regenerated, don't edit by hand.
- Any source code (that's Plan 022).
- Global/user-level `~/.claude/CLAUDE.md` — out of repo scope; recommended separately to the maintainer.

## Done criteria
- The runbook exists and documents, in order: URL-shape check, auth-vs-url error distinction, credential validation via `tbldeviceauth.last_access`, IP allowlist, admin/role.
- `AGENTS.md` and `.cursorrules` both point an agent to the URL-shape check first.

## Maintenance note
If Plan 022 lands (endpoint normalization), keep the runbook's §1 — it still
applies to deployments running older builds and to manual curl debugging. Update
the SSH/host details if the production host or docroot changes.

## Escape hatch
If `AGENTS.md` already contains an "An admin user is required" / doubled-path
note, only add what's missing. If the production host details in the runbook
contradict current infra (host moved), STOP and confirm the new values before
writing them.
