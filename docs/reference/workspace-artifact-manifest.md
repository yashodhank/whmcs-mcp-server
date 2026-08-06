# Workspace artifact manifest

Status: reconciled 2026-08-06

This manifest records previously untracked, user-owned artifacts found in the
repository workspace. The originals remain on disk and are ignored by exact
path. They are not canonical source, active plans, or public operational
instructions.

The tracked source code, merged PR history, [`plans/README.md`](../../plans/README.md),
and [`docs/OPERATIONS-HANDOFF.md`](../OPERATIONS-HANDOFF.md) remain authoritative.
Do not delete, stage with `git add -f`, or execute an artifact below without a
fresh evidence review and operator approval.

## Disposition rules

- **Local configuration:** retain locally; expose only a portable example.
- **Private operations:** retain in the private audit/operator store; publish
  only a host-neutral, secret-free runbook.
- **Historical plan:** preserve the hash and outcome, then rely on current code,
  tests, docs, and merged PRs rather than stale execution instructions.
- **Provenance gap:** behavior appears in the current tree, but the old plan
  index says its worktree commit was not pushed; verify exact ancestry before
  attributing a merge commit.

## Local and operational artifacts

| Artifact | SHA-256 | Classification | Decision |
|---|---|---|---|
| `.claude/CLAUDE.md` | `0128bda65de64770c3b6f227badeb534322a3017ab235a12754936f8f748bff6` | Generated local agent context | Keep local. It was indexed at an old commit; durable rules belong in `AGENTS.md`. |
| `.mcp.json` | `7b06c82ef9e58bf82be3471a3790e622977fa40891ca025649c392afc2d3604d` | Machine-local MCP config | Keep local. Use [`.mcp.example.json`](../../.mcp.example.json) as the portable template. |
| `docs/runbooks/operator-production-reconciliation-writes.md` | `273ea760b8d3249be5bfc623e8c44c11ceb13a34048503737f18d67d82137a23` | Private production procedure | Keep private. Extract a sanitized, host-neutral governed-write runbook; do not publish provider/customer specifics. |

## Reconciled plans

The statuses below are grounded in the tracked `plans/README.md`. “Historical”
means the plan must not be executed again without a new drift review.

| Plan artifact | SHA-256 | Evidence/status | Disposition |
|---|---|---|---|
| `001-ci-verification-baseline.md` | `c1ff751e58383f4cb4ef2d0ab7356b1cf6a2605bb036cbcf5369014eb0b3e728` | DONE; CI now contains the Python/PHP gate | Historical; current workflow is canonical |
| `002-validate-whmcs-root-path.md` | `e472de41f8df2ffc034cf87fb215b54e69587df4b2f2b56d6f700f978abe8a69` | DONE; PR #50 | Historical; PR and current worker are canonical |
| `003-wrap-update-in-transaction.md` | `b887247ad3cf73d0c0d8645896bb933229d7d88a29016b16333b8f4b9fb8dacf` | DONE; PR #50 | Historical; PR and current worker are canonical |
| `004-updater-hardening-bundle.md` | `a3c4d94b14c05bc071561f18d0829565be144ea54b2e7ae376c37272ee10cc40` | DONE; PR #49 | Historical; PR and current updater are canonical |
| `005-DESIGN-authoritative-ip.md` | `693cc4dd7f122e497e283ff45eab5cb84e27f09ad4d79913020814fdb4f48b4c` | Design output for plan 005 | Preserve hash; current updater docs/code supersede it |
| `005-authoritative-ip-spike.md` | `cdf9965638681dc7168d1cc879053a52e6f92c14493375da939adf0ae830556e` | DONE spike | Historical design input; do not treat as implementation instructions |
| `006-implement-authoritative-ip.md` | `fccc172580ffbe19e14355c60b3fae3b124e7b93ebb4744f86c142ab67b73593` | DONE; PR #51 | Historical; current updater and runbook are canonical |
| `008-normalizer-coverage-tripwire.md` | `0253e2a53d748efa024e0690ce7d0f7fe4dc6471b41bbfdc604c2d839ed73f39` | DONE; PR #57 | Historical; current test is canonical |
| `009-phase-f-doc-reconcile.md` | `39ceca9692853f9beccb3188997197b11b07c0806ae570267a1e1f466d1aa375` | DONE; old index says worktree commit not pushed | Historical with provenance gap; current controlled-write docs are canonical |
| `010-write-posture-doc-rules-sync.md` | `d58ec0e52c088cbf431a9bb5eecdaa9c823dc1d9c46681dc3c79b9c163e3db61` | DONE; old index says worktree commit not pushed | Historical with provenance gap; current docs/rules are canonical |
| `011-approval-separation-of-duties.md` | `d49d848b3d2e9014d141b38f16469302319d177e8dc524bbc79e1a563bf3eb21` | DONE; distinct-approver behavior exists | Historical with provenance gap; current code/tests are canonical |
| `012-idempotency-result-durability.md` | `dc48b02aeef3127fdb82029841896ba2496f566ab1542b8e70fc116416cd78f9` | DONE; durable redacted replay behavior exists | Historical with provenance gap; current code/tests are canonical |
| `013-execute-time-scope-recheck.md` | `dbab59e9cf6969440c00c3bbc3363b26bf152de2c91921dd8af140ff0a1e92a6` | DONE; execution-time scope behavior exists | Historical with provenance gap; current code/tests are canonical |
| `014-power-user-workflows-brainstorm.md` | `3268a364dc08360958c77a73b6074be7f56130b6155d864a8884549f0cbc179d` | DONE design reference | Preserve rejected alternatives in tracked decision history when still useful |
| `015-dunning-sweep-prompt.md` | `b876ac69e2d139aa56ff19954c250d8809676d97e05ea34e52696b37c9692b92` | DONE; prompt exists | Historical with provenance gap; current prompt/tests are canonical |
| `016-renewal-risk-triage-prompt.md` | `406931649b5f5837da9b2a9a8f4a2ad6ceeadc06fcfdbf5d5b933c22ea3c1251` | DONE; prompt exists | Historical with provenance gap; current prompt/tests are canonical |
| `017-ticket-triage-to-resolution-prompt.md` | `47f8d93e43311ed2c98496bf08d932a37e630a8ba7035841f5869097f8b08db3` | DONE; prompt exists | Historical with provenance gap; current prompt/tests are canonical |
| `018-month-end-close-prompt.md` | `f2207e4c9abdf661388650de85c5d007d256ee9958e2002569cbb4892684c346` | DONE; prompt exists | Historical with provenance gap; current prompt/tests are canonical |
| `019-executable-workflow-tools.md` | `98472cb7730a235dbbeb4f26198cb8d481c34287d5a82f33ca39fde1d86876ee` | MERGED; PR #63 | Historical; current tools/tests are canonical |
| `020-docs-revamp.md` | `37f5e733db03739db52c4955b869120a869b8115f44d142f34511837388224bf` | MERGED; PR #64 | Historical; current documentation tree is canonical |
| `021-code-comment-deep-pass.md` | `e6e4cb82c9a451c06452a44e9c94e9ee8119d67c6ee062f4ad79701e64654a53` | MERGED; PR #65 | Historical; current source comments are canonical |

## Re-verification procedure

Before promoting any ignored artifact:

1. recompute its SHA-256 and compare it with this manifest;
2. scan for secrets, customer PII, production hosts, and absolute paths;
3. compare every claimed status with `main`, tests, and the referenced PR;
4. extract only durable facts into the proper tracked document;
5. update this manifest and `docs/OPERATIONS-HANDOFF.md` in the same PR; and
6. retain sensitive or customer-specific details only in the private audit
   ledger/operator store.
