# Docs index — WHMCS MCP Server

Quick map of every document in this directory. For install, MCP config, and the
tool catalog, start with the root [README.md](../README.md). For contributor and
agent orientation, see [AGENTS.md](../AGENTS.md).

---

## Design

Architecture decisions, governance contracts, and phase-based design records.

| Document | Description |
|---|---|
| [design/architecture.md](design/architecture.md) | System architecture diagrams (D2–D4): write-flow lifecycle, workflow-tool orchestration, governance projection pipeline |
| [design/decisions.md](design/decisions.md) | Architectural decisions log — rationale for posture choices (sealed-by-default, tiered friction, etc.) |
| [design/governance.md](design/governance.md) | Phase B governance: consumer registry, data contracts, and field-class projection boundary |
| [design/controlled-writes-phase-f.md](design/controlled-writes-phase-f.md) | Phase F–G+ controlled-write engine design and implementation record (sealed by default) |
| [design/controlled-writes-phase-i.md](design/controlled-writes-phase-i.md) | Phase I recommendation: GO/NO-GO analysis for first production write ungating |
| [design/oauth.md](design/oauth.md) | OAuth 2.1 / PRM resource-server design (components 1–4) |
| [design/mcp-adoption.md](design/mcp-adoption.md) | MCP protocol adoption notes, open items, and HTTP-transport follow-ups |

---

## Runbooks

Step-by-step operational guides for setup, testing, and capability probing.

| Document | Description |
|---|---|
| [runbooks/ai-agent-local.md](runbooks/ai-agent-local.md) | Operator troubleshooting guide for AI agents running the server locally |
| [runbooks/capability-probe.md](runbooks/capability-probe.md) | How to run capability probes and promote verified read actions |
| [runbooks/write-capability-probe.md](runbooks/write-capability-probe.md) | Write-scope capability probe: pre-flight checks before ungating any write action |
| [runbooks/local-whmcs-testing.md](runbooks/local-whmcs-testing.md) | Bring up the dual WHMCS (8.13 + 9.x) local dev stack with Docker |
| [runbooks/production-test-program.md](runbooks/production-test-program.md) | L0–L6 reliability and RCA test program for production validation |
| [runbooks/testing-readonly.md](runbooks/testing-readonly.md) | Verifying read-only posture in Cursor and integration test harness |

---

## Reference

Stable reference material: environment context, consumer registry examples, prompt catalogs.

| Document | Description |
|---|---|
| [reference/agent-context.md](reference/agent-context.md) | Current server state, capability status, env snapshot — read first as an AI agent |
| [reference/consumer-registry.example.md](reference/consumer-registry.example.md) | `MCP_CONSUMER_REGISTRY` format reference with annotated example |
| [reference/consumer-registry.c2-example.json](reference/consumer-registry.c2-example.json) | Synthetic C2-track dev consumer JSON (placeholders only — do not use in prod) |
| [reference/cursor-skills.md](reference/cursor-skills.md) | Recommended Cursor skill bundles for this repo |
| [reference/whmcs-api-catalog-prompt.md](reference/whmcs-api-catalog-prompt.md) | Full WHMCS API action catalog in prompt form (used by AI agents for scope reasoning) |
| [reference/ai-handoff-prompt.md](reference/ai-handoff-prompt.md) | Structured AI handoff prompt: architecture context, extension seams, safety rules |
| [reference/whmcs9-credit-debit-notes.md](reference/whmcs9-credit-debit-notes.md) | WHMCS 9 invoice immutability and credit/debit note design notes |

---

## Archive

Historical point-in-time reports and earlier spec drafts. Content is accurate for
its era but may not reflect the current implementation.

| Document | Description |
|---|---|
| [archive/AGENT-v0.md](archive/AGENT-v0.md) | Original v0 full build specification (superseded by AGENTS.md + AGENT.md) |
| [archive/AGENT-v0.1.md](archive/AGENT-v0.1.md) | v0.1 spec draft (superseded) |
| [archive/phase-a-audit.md](archive/phase-a-audit.md) | Phase A audit report: baseline read-tool survey |
| [archive/getusers-investigation.md](archive/getusers-investigation.md) | Investigation into GetUsers degraded status across dev and production installs |
| [archive/mcp-domain-debug-report.md](archive/mcp-domain-debug-report.md) | Domain-tool debug report from MCP integration testing |
| [archive/rollout-validation-report.md](archive/rollout-validation-report.md) | Governance rollout validation: field-class projection behavior matrix |
| [archive/changelog-ai.md](archive/changelog-ai.md) | AI-authored changelog: per-session change log (newest first) |
