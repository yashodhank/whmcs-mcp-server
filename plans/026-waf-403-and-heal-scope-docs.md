# Plan 026: Document the WAF/fingerprint-403 + the IP-heal's real scope & limits

> Written against commit `2b7f665`. Docs + agent-rules only — NO source changes.
> Companion to Plan 024 (code) and Plan 025 (tests).

## Why this matters
Two facts from the recent outage are NOT written down anywhere, and re-learning
them cost hours:
1. **A WHMCS API HTTP 403 is not always an IP-allowlist problem.** It can be an
   **edge/WAF/proxy block on the Node/axios request fingerprint** — `curl` from
   the *same IP* returns 200 while the MCP client gets 403. The IP-allowlist
   auto-heal **cannot** fix this (and correctly won't try).
2. **The IP-heal only acts on genuine WHMCS `"Invalid IP <X>"` 403s**, SSHes via
   a configured identity (`WHMCS_SSH_HOST/USER/KEY/KNOWN_HOSTS`, user defaults to
   `whmcs-ip-updater`), and is a **no-op if the IP is already allowlisted**.

## Steps

### Step 1 — Extend the connectivity runbook
Append to `docs/runbooks/api-connectivity-troubleshooting.md` a new section. Place it AFTER the existing "§1 URL shape" content (the file already documents the doubled-path cause). Add exactly:

````markdown
## 403 Forbidden — three distinct causes (don't assume IP)

A WHMCS API `403` is one of three things. Identify which BEFORE acting:

1. **Edge/WAF/proxy fingerprint block** — the request reaches the server but a
   security layer rejects the **client fingerprint** (TLS/JA3 or header order),
   not the IP. **Tell-tale:** `curl` from the *same IP* returns 200 while the
   Node/axios MCP client gets 403, and there is **no nginx/modsec entry and no
   WHMCS error body** for the request.
   ```bash
   # If this returns 200 but the MCP tool returns 403 → WAF/fingerprint block:
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "https://BASE/includes/api.php" \
     -d "identifier=$WHMCS_IDENTIFIER" -d "secret=$WHMCS_SECRET" \
     -d "responsetype=json" -d "action=GetAdminDetails"
   ```
   Fix is **server-side**: allow the client fingerprint in the WAF / security
   addon (e.g. the `twentyi_security` addon or the panel's bot-protection /
   JA3 rules). The IP auto-heal CANNOT fix this.

2. **IP not in the WHMCS API allowlist** — WHMCS returns 403 with a JSON body
   `{"message":"Invalid IP <X>"}`. This is the ONLY 403 the auto-heal handles.
   Confirm the caller's public IP is (not) in `tblconfiguration.APIAllowedIPs`.

3. **Permission/role ACL** — the credential's API role lacks the action; WHMCS
   returns 403 with a permissions message. Fix the API role, not the IP.

The client surfaces a classified hint for all three (see `WhmcsClient` 403
handling); if you only see a bare 403, the server build predates that change.

## IP-allowlist auto-heal — scope, limits, and why it may not fire

`WHMCS_AUTO_IP_HEAL=true` self-heals **only** cause #2 above. Mechanics:
- Triggers **only** when the 403 body matches `Invalid IP <X>` (a WAF/permission
  403 is deliberately skipped — no pointless SSH run).
- Spawns `scripts/whmcs-ip-updater/whmcs_ip_updater.py oneshot`, which SSHes to
  `WHMCS_SSH_HOST` as `WHMCS_SSH_USER` (default `whmcs-ip-updater`) with
  `WHMCS_SSH_KEY` / `WHMCS_SSH_KNOWN_HOSTS`, and compare-and-swaps the IP into
  `APIAllowedIPs`.
- Single-flight + cooldown (`WHMCS_AUTO_IP_HEAL_COOLDOWN_MS`) + hard timeout
  (`WHMCS_AUTO_IP_HEAL_TIMEOUT_MS`); any failure resolves to "not healed".

**Why it can look like it "didn't detect/apply":**
- The 403 was a WAF/permission 403 (not `Invalid IP`) → correctly skipped.
- The IP was **already** in the allowlist → heal is a no-op.
- `WHMCS_AUTO_IP_HEAL` is off, or the cooldown is active.
- The spawned updater could not SSH (key/identity not available to the MCP
  process — note the host key is keyed by IP and the key is a non-default name).
The reason is included in the surfaced 403 hint and logged to the server stderr.
````

**Verify:** `grep -q 'fingerprint block' docs/runbooks/api-connectivity-troubleshooting.md`.

### Step 2 — Agent rule in `AGENTS.md`
Under the existing WHMCS connectivity note (search for `An admin user is required`), add:

```markdown
### WHMCS API returns 403
A 403 is one of: (1) **edge/WAF fingerprint block** on the Node/axios client
(curl from the same IP works) — fix in the WAF, the IP auto-heal can't; (2) IP
not in `APIAllowedIPs` (the only case auto-heal fixes); (3) permission/role ACL.
Run the 403 triage in `docs/runbooks/api-connectivity-troubleshooting.md` before
assuming it's an IP problem.
```

**Verify:** `grep -q 'edge/WAF fingerprint block' AGENTS.md`.

### Step 3 — `.cursorrules` note
Append a one-liner pointing at the runbook's 403 triage and the fact that a WHMCS 403 is often a WAF fingerprint block, not an IP issue.

### Step 4 — Correct the audit ledger (operator knowledge base)
File: `~/.ai-audit/` — there is a ledger entry from this work. Append (do not rewrite) a short correction note recording: the post-URL-fix failure was a **WAF/fingerprint 403** (curl-200 / axios-403 from the same allowlisted IP), the auto-heal correctly did not apply (not an `Invalid IP` 403, and the IP was already listed), and the fix is server-side WAF allowlisting. Reference `docs/runbooks/api-connectivity-troubleshooting.md`. If `~/.ai-audit` is not present/writable in the executor's environment, SKIP this step and note it in the plan status.

## In scope
- `docs/runbooks/api-connectivity-troubleshooting.md` (append section)
- `AGENTS.md`, `.cursorrules` (append notes)
- `~/.ai-audit` ledger correction (if available)

## Out of scope
- Source code (Plans 024/025).
- `AGENT.md` (large generated doc) — don't hand-edit.

## Done criteria
- Runbook documents the 3 distinct 403 causes + the auto-heal's scope/limits/why-it-may-not-fire.
- `AGENTS.md` and `.cursorrules` route an agent to 403 triage before assuming IP.

## Maintenance note
Keep the runbook's "three 403 causes" in sync with the `WhmcsClient` 403 hint
(Plan 024) and `healthCheck.ts`'s `forbidden` classification.

## Escape hatch
If the runbook already has a "403" section (e.g. Plan 024/025 added one), merge
rather than duplicate. If the WAF/security layer turns out to be a specific named
product the maintainer identifies, prefer that concrete name over "WAF".
