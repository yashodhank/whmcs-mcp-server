/**
 * Tests for the MCP logging bridge (src/mcpLogging.ts).
 *
 * We do NOT spin up a real SDK server/transport; we drive the bridge against a
 * minimal fake of the underlying SDK `Server` (getClientCapabilities +
 * sendLoggingMessage) so we can assert filtering, feature-detection, ordering,
 * and the never-throw contract deterministically.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  McpLoggingBridge,
  MCP_LOG_LEVELS,
  mcpLog,
  setMcpLogLevel,
  initMcpLogging,
  getActiveMcpLoggingBridge,
  type McpLogLevel,
} from '../src/mcpLogging.js';

interface SentMessage {
  level: McpLogLevel;
  logger?: string;
  data?: unknown;
}

/** Build a fake McpServer-shaped object exposing the bits the bridge uses. */
function makeFakeServer(opts: {
  clientLogging?: boolean; // whether client advertised logging capability
  clientCapsUndefined?: boolean; // simulate no getClientCapabilities at all
  throwOnSend?: boolean;
  rejectOnSend?: boolean;
}) {
  const sent: SentMessage[] = [];
  const sendLoggingMessage = vi.fn((params: SentMessage) => {
    if (opts.throwOnSend) {
      throw new Error('boom (sync)');
    }
    sent.push(params);
    if (opts.rejectOnSend) {
      return Promise.reject(new Error('boom (async)'));
    }
    return Promise.resolve();
  });

  const core: Record<string, unknown> = { sendLoggingMessage };
  if (!opts.clientCapsUndefined) {
    core.getClientCapabilities = () =>
      opts.clientLogging ? { logging: {} } : {};
  }

  return { server: { server: core }, sent, sendLoggingMessage };
}

describe('mcpLogging bridge', () => {
  describe('level ordering', () => {
    it('follows RFC-5424 order debug<info<notice<warning<error<critical<alert<emergency', () => {
      expect(MCP_LOG_LEVELS).toEqual([
        'debug',
        'info',
        'notice',
        'warning',
        'error',
        'critical',
        'alert',
        'emergency',
      ]);
    });
  });

  describe('feature detection (client capability)', () => {
    it('no-ops when client did NOT advertise logging', () => {
      const f = makeFakeServer({ clientLogging: false });
      const bridge = new McpLoggingBridge(f.server);
      bridge.mcpLog('error', 'should not send', { code: 'X' });
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
    });

    it('no-ops when getClientCapabilities is absent', () => {
      const f = makeFakeServer({ clientCapsUndefined: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.mcpLog('error', 'should not send');
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
    });

    it('no-ops when constructed without a server (default behaviour unchanged)', () => {
      const bridge = new McpLoggingBridge(undefined);
      // Should simply not throw and do nothing.
      expect(() => bridge.mcpLog('emergency', 'nobody home')).not.toThrow();
    });

    it('emits when client advertised logging', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.mcpLog('info', 'hello', { count: 3 });
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(1);
      expect(f.sent[0].level).toBe('info');
      expect(f.sent[0].logger).toBe('whmcs-mcp');
      expect(f.sent[0].data).toEqual({ message: 'hello', count: 3 });
    });
  });

  describe('threshold filtering (bridge min level)', () => {
    it('default min level is info: drops debug, emits info', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      expect(bridge.getMinLevel()).toBe('info');
      bridge.mcpLog('debug', 'noisy');
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
      bridge.mcpLog('info', 'kept');
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(1);
    });

    it('raising min level to warning drops info/notice but keeps warning+', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.setLevel('warning');
      expect(bridge.getMinLevel()).toBe('warning');
      bridge.mcpLog('info', 'drop');
      bridge.mcpLog('notice', 'drop');
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
      bridge.mcpLog('warning', 'keep');
      bridge.mcpLog('error', 'keep');
      bridge.mcpLog('emergency', 'keep');
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(3);
    });

    it('lowering min level to debug lets everything through', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.setLevel('debug');
      for (const lvl of MCP_LOG_LEVELS) {
        bridge.mcpLog(lvl, `msg-${lvl}`);
      }
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(MCP_LOG_LEVELS.length);
    });

    it('ignores an invalid setLevel without throwing or changing state', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.setLevel('bogus');
      expect(bridge.getMinLevel()).toBe('info');
    });

    it('ignores an unknown log level (no throw, no send)', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      expect(() =>
        bridge.mcpLog('verbose' as unknown as McpLogLevel, 'x')
      ).not.toThrow();
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
    });
  });

  describe('never throws', () => {
    it('swallows a synchronous throw from sendLoggingMessage', () => {
      const f = makeFakeServer({ clientLogging: true, throwOnSend: true });
      const bridge = new McpLoggingBridge(f.server);
      expect(() => bridge.mcpLog('error', 'boom')).not.toThrow();
    });

    it('swallows an async rejection from sendLoggingMessage', async () => {
      const f = makeFakeServer({ clientLogging: true, rejectOnSend: true });
      const bridge = new McpLoggingBridge(f.server);
      expect(() => bridge.mcpLog('error', 'boom')).not.toThrow();
      // give the rejected promise a tick to settle; must not become unhandled
      await Promise.resolve();
    });
  });

  describe('safe structured payload', () => {
    it('wraps message into data and merges structured fields only', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = new McpLoggingBridge(f.server);
      bridge.mcpLog('notice', 'capability_denied', {
        decision: 'deny',
        action: 'suspend_service',
        consumerId: 'c-123',
        count: 1,
      });
      expect(f.sent[0].data).toEqual({
        message: 'capability_denied',
        decision: 'deny',
        action: 'suspend_service',
        consumerId: 'c-123',
        count: 1,
      });
    });
  });

  describe('module-level singleton API', () => {
    beforeEach(() => {
      // reset to an inert bridge between tests
      initMcpLogging(undefined as never);
    });

    it('mcpLog is a safe no-op before initMcpLogging wires a real server', () => {
      expect(() => mcpLog('error', 'no server yet')).not.toThrow();
    });

    it('initMcpLogging wires the active bridge and routes mcpLog through it', () => {
      const f = makeFakeServer({ clientLogging: true });
      const bridge = initMcpLogging(f.server);
      expect(getActiveMcpLoggingBridge()).toBe(bridge);
      mcpLog('info', 'routed', { ok: true });
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(1);
      expect(f.sent[0].data).toEqual({ message: 'routed', ok: true });
    });

    it('setMcpLogLevel updates the active bridge threshold', () => {
      const f = makeFakeServer({ clientLogging: true });
      initMcpLogging(f.server);
      setMcpLogLevel('error');
      mcpLog('warning', 'drop');
      expect(f.sendLoggingMessage).not.toHaveBeenCalled();
      mcpLog('error', 'keep');
      expect(f.sendLoggingMessage).toHaveBeenCalledTimes(1);
    });
  });
});
