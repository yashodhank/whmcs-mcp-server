/**
 * Tests for WHMCS MCP Prompts (reusable ops playbooks).
 *
 * Uses a fake McpServer capturing registerPrompt(name, config, cb) calls, then
 * invokes each callback to assert it returns the SDK GetPromptResult shape
 * ({ messages: [{ role:'user', content:{ type:'text', text } }] }) and that the
 * body references the real tool names each playbook is meant to drive.
 */
import { describe, it, expect } from 'vitest';
import { registerWhmcsPrompts } from '../../src/prompts/whmcsPrompts.js';

interface PromptConfig {
  title?: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
}
type PromptCb = (
  args: Record<string, string | undefined>,
  extra?: unknown,
) => { messages: { role: string; content: { type: string; text: string } }[] };

function makeServer() {
  const prompts: Record<string, { config: PromptConfig; cb: PromptCb }> = {};
  const server = {
    registerPrompt: (name: string, config: PromptConfig, cb: PromptCb) => {
      prompts[name] = { config, cb };
      return {} as unknown;
    },
  };
  return { server: server as never, prompts };
}

const ALL_PROMPTS = [
  'month_end_reconciliation',
  'phantom_tds_sweep',
  'suspend_for_nonpayment',
  'new_client_onboarding',
  'domain_renewal_review',
];

function firstText(res: ReturnType<PromptCb>): string {
  return res.messages[0].content.text;
}

describe('registerWhmcsPrompts', () => {
  it('registers exactly the five expected prompts', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    expect(Object.keys(prompts).sort()).toEqual([...ALL_PROMPTS].sort());
  });

  it('every prompt has a title, description and an argsSchema raw shape', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    for (const name of ALL_PROMPTS) {
      const { config } = prompts[name];
      expect(config.title, name).toBeTruthy();
      expect(config.description, name).toBeTruthy();
      expect(config.argsSchema, name).toBeTruthy();
      expect(config.argsSchema, name).toHaveProperty('clientid');
    }
  });

  it('every callback returns a single user-role text message', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    for (const name of ALL_PROMPTS) {
      const res = prompts[name].cb({ clientid: '42' });
      expect(res.messages, name).toHaveLength(1);
      expect(res.messages[0].role, name).toBe('user');
      expect(res.messages[0].content.type, name).toBe('text');
      expect(res.messages[0].content.text.length, name).toBeGreaterThan(50);
    }
  });

  it('month_end_reconciliation drives the reconciliation tools', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.month_end_reconciliation.cb({}));
    expect(text).toContain('get_reconciliation_snapshot');
    expect(text).toContain('get_accounts_receivable_aging');
    expect(text).toContain('list_invoices');
  });

  it('phantom_tds_sweep is bank-only and covers both directions', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.phantom_tds_sweep.cb({}));
    expect(text).toContain('get_reconciliation_snapshot');
    expect(text).toContain('list_client_transactions');
    expect(text.toLowerCase()).toContain('phantom');
    expect(text.toLowerCase()).toContain('inverse-phantom');
    expect(text.toLowerCase()).toContain('bank');
  });

  it('suspend_for_nonpayment routes through governed write flow, never direct', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.suspend_for_nonpayment.cb({ clientid: '7' }));
    expect(text).toContain('get_accounts_receivable_aging');
    expect(text).toContain('draft_write_intent');
    expect(text).toContain('service:suspend');
    expect(text).toContain('90+');
    // governance emphasis: must not instruct a direct suspend_service call
    expect(text).toContain('MUST NOT call `suspend_service` directly');
  });

  it('new_client_onboarding uses the 360 view + checklist', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.new_client_onboarding.cb({ clientid: '7' }));
    expect(text).toContain('get_account_360');
    expect(text.toLowerCase()).toContain('checklist');
  });

  it('domain_renewal_review surfaces <=30d expiries and renewal cost', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.domain_renewal_review.cb({}));
    expect(text).toContain('get_domain_portfolio_snapshot');
    expect(text).toContain('30');
    expect(text.toLowerCase()).toContain('renewal cost');
  });

  it('clientid arg flows into the rendered body when supplied', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.month_end_reconciliation.cb({ clientid: '999' }));
    expect(text).toContain('999');
  });

  it('optional-clientid prompts render a portfolio-wide hint when omitted', () => {
    const { server, prompts } = makeServer();
    registerWhmcsPrompts(server);
    const text = firstText(prompts.domain_renewal_review.cb({}));
    expect(text.toLowerCase()).toContain('all clients');
  });
});
