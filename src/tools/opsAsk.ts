/**
 * ops_ask — small job surface for Grok / staff ops on WHMCS 8.13.7.
 *
 * Audience comes from MCP_STAFF_CONSUMER_IDS + the authenticated consumer.
 * A caller-supplied `audience` argument is ignored.
 */

import { z } from 'zod';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WhmcsClient } from '../whmcs/WhmcsClient.js';
import { Logger } from '../logging.js';
import { RateLimiter, RateLimitError } from '../rateLimiter.js';
import { config, isToolAllowed } from '../config.js';
import { AUTH_SHAPE, ensureToolAuth } from '../security.js';
import { READ_ONLY_ANNOTATIONS } from './listTools.js';
import { getConsumerRegistry, governanceEnabled } from '../governance/pipeline.js';
import { resolveStdioDefaultToken } from '../auth/trustedStdioDefault.js';
import { resolveConsumer } from '../governance/consumers.js';
import { audienceForConsumer, parseStaffConsumerIds } from '../auth/audience.js';
import { actionDeniedMessage, isActionAllowed } from '../governance/allowedActions.js';
import { ALL_JOBS, jobAllowedForAudience, jobDeniedMessage, isOpsJob } from '../jobs/catalog.js';
import { customerDoorResult, runStaffJob } from '../jobs/opsAsk.js';
import { getReadAuditLog } from '../audit/readAudit.js';
import { listWriteIntentsForConsumer } from './writeFlow.js';

const OPS_ASK_OUTPUT = z
  .object({
    job: z.string().optional(),
    audience: z.string().optional(),
    status: z.string().optional(),
    isError: z.boolean().optional(),
    error: z.string().optional(),
  })
  .catchall(z.unknown());

function effectiveToken(params: Record<string, unknown>): string | undefined {
  const caller = typeof params.auth_token === 'string' ? params.auth_token : undefined;
  if (caller !== undefined && caller.length > 0) return caller;
  return resolveStdioDefaultToken(config.MCP_TRANSPORT, caller);
}

export function registerOpsAskTools(
  server: McpServer,
  whmcs: WhmcsClient,
  logger: Logger,
  rl: RateLimiter
): void {
  if (!isToolAllowed('ops_ask')) return;

  const schema = z.object({
    job: z.enum(ALL_JOBS),
    clientid: z.number().int().positive().optional(),
    email: z.string().email().optional(),
    contract: z.string().optional(),
  });

  const handler: ToolCallback<z.ZodRawShape> = (async (params: Record<string, unknown>) => {
    const log = logger.child();
    const t0 = Date.now();
    try {
      const authErr = ensureToolAuth(params);
      if (authErr) return authErr;
      if (!rl.tryConsume()) throw new RateLimitError();

      const jobRaw = typeof params.job === 'string' ? params.job : '';
      if (!isOpsJob(jobRaw)) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ isError: true, error: 'unknown job' }) },
          ],
          structuredContent: { isError: true, error: 'unknown job' },
          isError: true,
        };
      }

      const token = effectiveToken(params);
      const resolution = resolveConsumer(token, config.MCP_ENV, getConsumerRegistry(), {
        allowAnon: config.MCP_ALLOW_ANON_LLM,
      });
      if (!resolution.ok) {
        const payload = { isError: true, error: `consumer denied: ${resolution.reason}` };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }

      const staffIds = parseStaffConsumerIds(config.MCP_STAFF_CONSUMER_IDS);
      const audience = audienceForConsumer(resolution.profile.id, staffIds);
      if (governanceEnabled() && !isActionAllowed(resolution.profile, 'ops_ask')) {
        const payload = {
          isError: true,
          status: 'action_denied',
          error: actionDeniedMessage('ops_ask', resolution.profile.id),
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }

      if (!jobAllowedForAudience(jobRaw, audience)) {
        const payload = {
          isError: true,
          status: 'job_denied',
          error: jobDeniedMessage(jobRaw, audience),
          audience,
          job: jobRaw,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: true,
        };
      }

      log.logToolCall(
        'ops_ask',
        {
          job: jobRaw,
          clientid: params.clientid,
        },
        false
      );

      const clientid = typeof params.clientid === 'number' ? params.clientid : undefined;
      getReadAuditLog(config.MCP_READ_AUDIT_PATH).append({
        at: new Date().toISOString(),
        consumer_id: resolution.profile.id,
        job: jobRaw,
        ...(clientid === undefined ? {} : { clientid }),
      });

      const payload =
        audience === 'customer'
          ? customerDoorResult(jobRaw)
          : await runStaffJob({
              job: jobRaw,
              whmcs,
              clientid,
              email: typeof params.email === 'string' ? params.email : undefined,
              listDrafts: () => listWriteIntentsForConsumer(resolution.profile.id),
            });

      const result = {
        consumer: resolution.profile.id,
        audience,
        ...payload,
      };
      log.logToolResult('ops_ask', true, Date.now() - t0);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (e) {
      log.logToolResult(
        'ops_ask',
        false,
        Date.now() - t0,
        e instanceof Error ? e.message : String(e)
      );
      if (e instanceof RateLimitError) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ isError: true, error: e.message }) }],
          structuredContent: { isError: true, error: e.message },
          isError: true,
        };
      }
      throw e;
    }
  }) as unknown as ToolCallback<z.ZodRawShape>;

  server.registerTool(
    'ops_ask',
    {
      description:
        'Staff-first WHMCS 8.13.7 jobs (morning digest, overdue, ticket inbox, billing card, GDPR export). Audience comes from the consumer allow-list, not the prompt. Customer door is link/handoff until a user-delegated API is proven.',
      inputSchema: { ...schema.shape, ...AUTH_SHAPE },
      outputSchema: OPS_ASK_OUTPUT,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    handler
  );
}
