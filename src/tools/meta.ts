/**
 * Shared `_meta` derivation for tool results (MCP spec 2025-11-25).
 *
 * `_meta` is the protocol's reserved, namespaced metadata channel on a
 * CallToolResult — distinct from `structuredContent` (the typed payload the
 * client consumes as data). We use it to surface governance HINTS a client can
 * read generically without parsing the body: the risk tier of a write intent,
 * its scope/stage, approval requirements, and whether anything executed.
 *
 * These are HINTS ONLY. They never gate or change behavior; the authoritative
 * governance decision is always in the structured payload. Keys are reverse-DNS
 * prefixed per the spec's `_meta` key convention so they never collide with the
 * SDK's own reserved keys.
 */

export const META_PREFIX = 'io.whmcs.mcp';

/**
 * Build the `_meta` hint object for a tool-result payload, or `undefined` when
 * the payload carries no hint-worthy fields (so the result is byte-identical to
 * before for payloads that have nothing to advertise). Purely derived from the
 * payload already returned — adds no new computation or data.
 */
export function deriveToolMeta(
  payload: Record<string, unknown>
): Record<string, unknown> | undefined {
  const meta: Record<string, unknown> = {};
  const intent = payload.intent as { risk?: unknown; scope?: unknown } | undefined;

  // Risk tier — the headline hint for single-intent write-flow results.
  const risk =
    intent && typeof intent.risk === 'string'
      ? intent.risk
      : Array.isArray(payload.risk_flags) && typeof payload.risk_flags[0] === 'string'
        ? payload.risk_flags[0]
        : undefined;
  if (risk !== undefined) meta[`${META_PREFIX}/risk_tier`] = risk;

  const scope =
    intent && typeof intent.scope === 'string'
      ? intent.scope
      : typeof payload.scope === 'string'
        ? payload.scope
        : undefined;
  if (scope !== undefined) meta[`${META_PREFIX}/scope`] = scope;

  if (typeof payload.stage === 'string') meta[`${META_PREFIX}/stage`] = payload.stage;
  if (typeof payload.required_approvals === 'number')
    meta[`${META_PREFIX}/required_approvals`] = payload.required_approvals;
  if (typeof payload.executed === 'boolean') meta[`${META_PREFIX}/executed`] = payload.executed;

  // Composite workflow results — advertise the workflow + draft/skip counts.
  if (typeof payload.workflow === 'string') {
    meta[`${META_PREFIX}/workflow`] = payload.workflow;
    if (Array.isArray(payload.drafted_intent_ids))
      meta[`${META_PREFIX}/drafted_count`] = payload.drafted_intent_ids.length;
    if (Array.isArray(payload.skipped))
      meta[`${META_PREFIX}/skipped_count`] = payload.skipped.length;
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}
