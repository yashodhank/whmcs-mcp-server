# GetUsers / `list_users` Investigation (docs/research only)

> Read-only code & doc analysis. No live WHMCS probe was run as part of this
> investigation. No `src/`, `tests/`, or `scripts/` were modified.

## 1. Summary / verdict

**Verdict: (c) — `GetUsers` is a real, correctly-named WHMCS External API
action; it requires a specific WHMCS version + API-role permission. The
capability `list_users` must STAY `unverified` (and currently surfaces
`degraded` after a probe).** It must NOT be promoted on the strength of the
degraded probes. The degraded result is **not** evidence of a wrong action
name — it is most consistent with an API‑Role permission gap whose WHMCS
message wording is not matched by the probe classifier.

The task hypothesis ("`GetUsers` is the WRONG action name") is **not
supported** by the evidence — see §3 and §4.

## 2. WHMCS User vs Client distinction (verified from repo)

WHMCS 8.0 split the data model (documented in this repo: `AGENT.md` lines
388–394, and `src/tools/capabilityShellTools.ts:112`):

- **Client** = the billing entity that owns products/services and pays
  invoices. Listed via `GetClients`; detail via `GetClientsDetails`. These
  are already `supported` + allowlisted in this server
  (`src/governance/capabilities.ts` `SUPPORTED_READS`,
  `src/whmcs/actionPolicy.ts` `READ_ALLOWLIST`).
- **User** = the login/authentication identity. One User can manage many
  Clients (`owner_user_id` links a Client to an existing User). Users are a
  separate object class from Clients and are **not** returned by
  `GetClients`.

So "list users" is a genuinely distinct capability from `list_clients`;
`GetClients` cannot satisfy it.

## 3. Candidate actions evaluated

| Candidate | Exists in WHMCS External API? | Lists Users? | Fit |
|---|---|---|---|
| `GetUsers` | **Yes** — added in WHMCS **8.0** as part of the User/Client split (the External API gained `GetUsers`/`GetUserPermissions`/`AddUser`/`UpdateUser`). ASSUMPTION (version of introduction) — requires confirmation against the target install's WHMCS version. | Yes (the User identity records). | **Correct action.** Already the seeded mapping `['GetUsers','list_users']`. |
| `GetClients` | Yes (already `supported` here). | No — lists **Clients**, not Users. | Wrong object class. Do not substitute. |
| `GetClientsDetails` | Yes (already `supported` here). | No — one Client's billing detail. | Wrong object class. |
| Internal/Admin (local) API only | N/A | — | Not applicable: `GetUsers` IS exposed on the External (identifier/secret) API in 8.x+, which is the only transport this server uses (`AGENT.md:62`). No internal-API fallback is needed or wanted in a read-only External-API server. |

Conclusion: the action name `GetUsers` is **correct**, not a typo. No
better/alternative External API action exists for enumerating Users.

## 4. Why the probes returned `degraded` (hypothesis)

The operator probe (`scripts/mcp-capability-probe.mjs`) bypasses the read
allowlist and calls `WhmcsClient.call('GetUsers',{limitnum:1},{isMutating:false})`,
then classifies via `src/governance/capabilityProbeReport.ts`
(mirrors `src/governance/capabilities.ts` `classifyFailure`). Precedence:

1. message contains access-denied/permission text → `not_authorized`
   (patterns: `access denied`, `permission`, `not permitted`, `unauthor`,
   `authentication failed`, `invalid permission`)
2. message contains unknown-action text → `unsupported`
   (patterns incl. `action could not be found`, `requested api action`,
   `invalid action`, `unknown action`)
3. anything else (incl. thrown transport error) → **`degraded`**

Key inference: if WHMCS genuinely did **not** recognise the action, it
returns *"The requested API Action could not be found."*, which **matches**
the `unsupported` patterns (`requested api action` / `action could not be
found`). The probes returned `degraded`, **not** `unsupported` — so WHMCS
did **not** report an unknown action. This is strong evidence the action
name is right and the request reached a WHMCS handler.

Most likely cause of `degraded` (ASSUMPTION — requires confirmation):

- **API-Role permission gap.** In WHMCS 8/9, every External API action must
  be explicitly enabled for the API credential's API Role
  (Setup → Staff Management → API Roles). `GetUsers` is a newer action and
  is commonly NOT in a role that predates it. WHMCS's wording for this case
  (e.g. *"This API Action is not enabled / authorized for this API
  credential"*-style text, exact string version-dependent) does **not**
  reliably contain the literal substrings `access denied` / `permission` /
  `unauthor`, so the classifier drops it into `degraded` rather than
  `not_authorized`. Same credential class, same role → consistent
  `degraded` on Dev 8, Dev 9, and prod, exactly as observed.
- Less likely: a transport/HTTP-shape edge for this action. Consistency
  across three independent installs makes a pure network fault unlikely.

The repo itself hints at the role mechanism: `src/errors.ts:40` maps
`access denied` → "Check WHMCS Setup → Staff Management → API Roles."

ASSUMPTION (cannot be proven without a fresh probe that captures the raw
WHMCS message): the degraded classification masks an API-Role/permission
or version-availability message. Confirming this requires §6.

## 5. Recommended capability disposition for `list_users`

**Keep `list_users` permanently gated as `unverified` (degraded after
probe). Do NOT promote. Do NOT add `GetUsers` to `READ_ALLOWLIST`. Do NOT
move it to `SUPPORTED_READS`.**

Exact reason: promotion criteria (`docs/capability-probe-runbook.md` §5)
require a real `supported` probe result on the target install. We have the
opposite — a consistent `degraded` everywhere — and `degraded` is explicitly
non-promotable. Substituting `GetClients` would be **faking support for a
different object class** (Clients ≠ Users) and is forbidden by the project's
no-fake-data rule (`src/tools/capabilityShellTools.ts` header,
`docs/PHASE_B_GOVERNANCE.md` §6). The `list_users` capability shell already
returns the correct honest payload (`capability_unavailable`,
`status:"unverified"`, `retriable:true`) and must continue to.

No code change is recommended by this investigation.

## 6. Evidence / next step required to ever change this (separate authorized task)

This is a **separate, explicitly-authorized** task — out of scope here. To
move `list_users` off `unverified`, an operator would need, in order:

1. **Confirm WHMCS version** on the target install (≥ 8.0 expected) — a
   `supported` version source, not assumed.
2. **Capture the raw `GetUsers` error** in a controlled, authorized probe
   (the current classifier hides the message). If the message is an
   API-Role/permission error → status is really `not_authorized`
   (terminal for this build until an operator adjusts the API Role; **not**
   a code change). If the message is genuinely unknown-action → `unsupported`
   (terminal). Only a clean `result:"success"` justifies promotion.
3. **If (and only if) a real `supported` probe is obtained:** perform the
   deliberate, reviewed TDD promotion in `docs/capability-probe-runbook.md`
   §5 — add `GetUsers` to `READ_ALLOWLIST` (single action, `WRITE_DENY_*`
   guards still hold), move the pair to `SUPPORTED_READS`, add tests,
   record the probe `verifiedAt` evidence in the PR.

Until that authorized sequence yields a `supported` result, `list_users`
stays `unverified`/`degraded` by design. No live re-probe was performed in
this investigation; doing so is its own authorized step.
