## What

<!-- Describe the change and the user/operator outcome. -->

## Why

<!-- State the problem, review finding, or approved scope. -->

## Verification

<!-- List exact commands and results. Include any environmental limitation. -->

## Migration / deployment

<!-- State "None" or give the safe rollout, rollback, and data steps. -->

## Handoff and audit checklist

Complete every explicit field below; do not rely on the checkboxes as a
substitute for a `yes`, `no`, path, or `PENDING` answer.

```text
Handoff updated: yes/no
Operational docs changed: <paths or none>
Owner/deployment/release facts changed: yes/no
Secrets or customer PII added to repository: no
Audit ledger entry required: yes/no
```

- [ ] `docs/OPERATIONS-HANDOFF.md` reviewed and updated if applicable.
- [ ] Technical context/runbook/docs updated if behavior or operations changed.
- [ ] No secrets, tokens, customer PII, production IDs, or raw WHMCS payloads added.
- [ ] Private audit-ledger entry created when this involves operations, production, a client, credentials, or an agent handoff.
- [ ] New ownership/deployment/release facts are verified, or explicitly marked `PENDING` with an evidence owner.
