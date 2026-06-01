# Cursor Skills for WHMCS MCP Server

Recommended [antigravity-awesome-skills](https://github.com/sickn33/antigravity-awesome-skills) for this project. Install with `npx antigravity-awesome-skills --cursor`; then use `@skill-name` in Cursor chat.

Repo-specific agent guidance lives in [AGENTS.md](../AGENTS.md) and [.cursor/rules/whmcs-mcp-server.mdc](../.cursor/rules/whmcs-mcp-server.mdc).

## MCP and agent design

| Skill | Rationale |
|-------|-----------|
| `mcp-builder` | Creating high-quality MCP servers and tools; aligns with adding or refining tools in `src/tools/`. |
| `agent-tool-builder` | Designing tools agents can use reliably; relevant for tool schemas and descriptions. |
| `ai-agents-architect` | Tool use, memory, planning; useful when thinking about how Cursor (or other agents) will use this server. |

## Security (billing/API/auth)

| Skill | Rationale |
|-------|-----------|
| `api-security-best-practices` | Secure API design; WHMCS API usage and exposure via MCP. |
| `backend-security-coder` | Secure backend practices; matches Node/TypeScript server code. |
| `auth-implementation-patterns` | JWT, OAuth2, session/auth patterns; aligns with `MCP_AUTH_TOKEN` and access modes. |
| `cc-skill-security-review` | Security checklist for features; for new tools or modes. |
| `security-auditor` | Broader security audits; complements existing security report and tests. |

## TypeScript and Node backend

| Skill | Rationale |
|-------|-----------|
| `typescript-expert` | Types, performance, strictness; matches current TS codebase. |
| `typescript-pro` | Advanced types and enterprise patterns. |
| `nodejs-backend-patterns` | Node backends with Express/Fastify-style patterns; applicable to MCP server structure. |
| `backend-dev-guidelines` | Node.js + Express + TypeScript microservices; layered architecture, error handling. |
| `api-patterns` | REST/API design, versioning, pagination; relevant for how tools wrap WHMCS API. |
| `api-design-principles` | REST/GraphQL API design; for tool input/output and resource shapes. |

## Testing and quality

| Skill | Rationale |
|-------|-----------|
| `javascript-testing-patterns` | Jest/Vitest, unit/integration, mocking; matches `tests/` setup. |
| `test-driven-development` | TDD workflow; for new tools or security checks. |
| `test-fixing` | Fixing failing tests systematically. |
| `code-review-excellence` | Code review and PR feedback. |

## General workflow (Essentials)

| Skill | Rationale |
|-------|-----------|
| `concise-planning` | Clear, actionable plans for coding tasks. |
| `lint-and-validate` | Keep code lint-clean (fits existing ESLint/Prettier). |
| `systematic-debugging` | Debugging and root-cause analysis. |
| `error-handling-patterns` | Resilient error handling across the server. |

## Optional (documentation and ops)

| Skill | Rationale |
|-------|-----------|
| `architecture-decision-records` | Document significant technical decisions. |
| `documentation-templates` | README, API docs, AI-friendly docs; for tool/resource docs. |

## Bundles

For a ready-made set, use the **Security Developer** and **Agent Architect** bundles from the repo’s [docs/BUNDLES.md](https://github.com/sickn33/antigravity-awesome-skills/blob/main/docs/BUNDLES.md).
