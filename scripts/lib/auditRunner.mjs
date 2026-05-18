// PHASE H.1 — Track C: exposure-audit harness reliability ORCHESTRATION.
//
// Thin transport glue around the PURE reliability core
// (src/auditHarness/runnerCore.ts, run via tsx — same .ts-import pattern as
// the existing harness). Everything here is the side-effecting part:
//   - boot dist/index.js as a governed MCP client (read-only),
//   - hard per-phase timeouts (connect / call),
//   - safe+deterministic retry (transient kinds only),
//   - prefer the authoritative `__audit_trace` -> auditFromTrace path,
//     defensively feature-detected; else fall back to classification
//     inference and label classmap_source accordingly,
//   - ALWAYS resolve to exactly one structured object: a redacted audit
//     report OR a structured failure (no silent gaps).
//
// SAFETY: read-only governance; stdout never carries a raw value; raw
// values only ever go to the gitignored .audit-local/ (mode 3), written by
// the caller, never here.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import {
  auditExposure,
  redactedReport,
} from '../../src/audit/exposureAudit.ts';
import * as exposureAuditMod from '../../src/audit/exposureAudit.ts';
import {
  classifyFailure,
  shouldRetry,
  backoffMs,
  buildEnvelope,
  buildFailureReport,
  classmapSourceFor,
} from '../../src/auditHarness/runnerCore.ts';

// Feature-detect the authoritative trace adapter a parallel agent is
// adding. If absent at run time we still set __audit_trace_present so
// reliability metrics can report authoritative coverage.
const auditFromTrace =
  typeof exposureAuditMod.auditFromTrace === 'function'
    ? exposureAuditMod.auditFromTrace
    : null;

const DEFAULT_CONNECT_TIMEOUT_MS = Number(
  process.env.AUDIT_CONNECT_TIMEOUT_MS ?? 20000
);
const DEFAULT_CALL_TIMEOUT_MS = Number(
  process.env.AUDIT_CALL_TIMEOUT_MS ?? 45000
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Race a promise against a hard deadline. On deadline, reject with a
// timeout-flagged error so the pure classifier files it by phase.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label} timed out after ${ms}ms`);
      e.isTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const textOf = (r) => r?.content?.[0]?.text ?? '';

// Extract the structured payload + any authoritative __audit_trace. The
// Track-A producer puts __audit_trace in BOTH structuredContent and the
// JSON text payload; we accept either, preferring structuredContent.
function extractPayload(result) {
  const sc = result?.structuredContent;
  if (sc && typeof sc === 'object') {
    return { payload: sc, parseError: null };
  }
  const t = textOf(result);
  if (typeof t !== 'string' || t.length === 0) {
    return { payload: {}, parseError: null };
  }
  try {
    return { payload: JSON.parse(t), parseError: null };
  } catch (err) {
    return { payload: t, parseError: err };
  }
}

function projectionOf(payload) {
  if (payload && typeof payload === 'object') {
    if (payload.data !== undefined && payload.data !== null) {
      return payload.data;
    }
    if (Array.isArray(payload.items)) return { items: payload.items };
    return payload;
  }
  return { value: payload };
}

// One full attempt: spawn server, connect, call, parse, audit. Throws a
// phase-tagged error (err.__phase) on any failure so the caller can
// classify + decide retry. Always closes the client.
async function oneAttempt(opts) {
  const {
    consumerId,
    tool,
    toolArgs,
    rawToken,
    registry,
    env,
    classmapInference,
    contractPolicy,
    contract,
    showValues,
    connectTimeoutMs,
    callTimeoutMs,
  } = opts;

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      MCP_ENV: env,
      MCP_MODE: 'read_only',
      MCP_GOVERNANCE_ENABLED: 'true',
      MCP_ALLOW_ANON_LLM: 'false',
      MCP_CONSUMER_REGISTRY: registry,
      // Ask the governed server to emit the authoritative audit trace.
      MCP_AUDIT_TRACE: '1',
    },
    stderr: 'ignore',
  });
  const client = new Client(
    { name: 'exposure-audit', version: '1.1.0' },
    { capabilities: {} }
  );

  let closed = false;
  const safeClose = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch {
      /* server already gone — irrelevant for a read-only audit */
    }
  };

  try {
    try {
      await withTimeout(
        client.connect(transport),
        connectTimeoutMs,
        'mcp connect'
      );
    } catch (err) {
      err.__phase = 'connect';
      throw err;
    }

    let result;
    try {
      result = await withTimeout(
        client.callTool({
          name: tool,
          arguments: { ...toolArgs, auth_token: rawToken },
        }),
        callTimeoutMs,
        'mcp callTool'
      );
    } catch (err) {
      err.__phase = 'call';
      throw err;
    }

    if (result && result.isError === true) {
      const e = new Error(textOf(result) || 'governed tool returned isError');
      e.mcpToolError = true;
      e.__phase = 'call';
      throw e;
    }

    const { payload, parseError } = extractPayload(result);
    if (parseError) {
      parseError.__phase = 'parse';
      throw parseError;
    }

    const tracePresent =
      payload &&
      typeof payload === 'object' &&
      Array.isArray(payload.__audit_trace);

    let report;
    let fromTrace = false;
    try {
      if (tracePresent && auditFromTrace) {
        report = auditFromTrace(payload.__audit_trace, {
          consumer_id: consumerId,
          contract,
          tool,
          environment: env,
          localShowValues: showValues,
        });
        fromTrace = true;
      } else {
        const projected = projectionOf(payload);
        const safeProjected =
          projected && typeof projected === 'object' ? projected : {};
        let canonicalClasses;
        let toolClassmap = false;
        if (
          payload &&
          typeof payload === 'object' &&
          payload.__classmap &&
          typeof payload.__classmap === 'object'
        ) {
          canonicalClasses = payload.__classmap;
          toolClassmap = true;
        } else {
          canonicalClasses = classmapInference(safeProjected);
        }
        report = auditExposure({
          consumer_id: consumerId,
          contract,
          tool,
          canonicalClasses,
          projected: safeProjected,
          contractPolicy,
          localShowValues: showValues,
        });
        report.__toolClassmap = toolClassmap;
      }
    } catch (err) {
      err.__phase = 'audit';
      throw err;
    }

    const classmapSource = classmapSourceFor({
      tracePresent: Boolean(tracePresent),
      fromTrace,
      toolClassmap: report.__toolClassmap === true,
    });

    return {
      report,
      classmapSource,
      tracePresent: Boolean(tracePresent),
      usedTrace: fromTrace,
    };
  } finally {
    await safeClose();
  }
}

// Run a job with the full reliability contract: hard timeouts, safe retry
// for transient kinds only, and ALWAYS resolve to exactly one structured
// object — { ok:true, report:<redacted+annotated> } or a structured
// failure report. Never throws.
export async function runAuditJob(opts) {
  const startedAt = Date.now();
  const env = opts.environment;
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;

  const mkEnvelope = () =>
    buildEnvelope({
      consumer: opts.consumerId,
      tool: opts.tool,
      clientid: opts.clientid,
      environment: env,
      startedAt,
    });

  let attemptIndex = 0;
  let lastFailure = null;

  for (;;) {
    try {
      const { report, classmapSource, tracePresent, usedTrace } =
        await oneAttempt({ ...opts, env, connectTimeoutMs, callTimeoutMs });

      const envelope = mkEnvelope();
      const redacted = redactedReport(report);
      const annotated = {
        ok: true,
        ...redacted,
        classmap_source: classmapSource,
        __audit_trace_present: tracePresent,
        __audit_trace_used: usedTrace,
        environment: env,
        env,
        correlation_id: envelope.correlation_id,
        consumer: opts.consumerId,
        tool: opts.tool,
        clientid: opts.clientid,
        attempts: attemptIndex + 1,
        started_at: envelope.started_at,
        duration_ms: envelope.duration_ms,
      };
      return {
        ok: true,
        stdout: annotated,
        rawReport: report,
        classmapSource,
        tracePresent,
        usedTrace,
        outcome: {
          ok: true,
          tool: opts.tool,
          consumer: opts.consumerId,
          clientid: opts.clientid,
        },
      };
    } catch (err) {
      const phase = err && err.__phase ? err.__phase : 'call';
      const classified = classifyFailure(err, phase);
      lastFailure = classified;

      if (shouldRetry(classified.kind, attemptIndex)) {
        // eslint-disable-next-line no-await-in-loop
        await sleep(backoffMs(attemptIndex));
        attemptIndex += 1;
        continue;
      }

      const envelope = mkEnvelope();
      const failureReport = buildFailureReport(envelope, {
        kind: classified.kind,
        message: classified.message,
        attempts: attemptIndex + 1,
      });
      return {
        ok: false,
        stdout: failureReport,
        outcome: {
          ok: false,
          tool: opts.tool,
          consumer: opts.consumerId,
          clientid: opts.clientid,
          failure_kind: classified.kind,
        },
      };
    }
  }
}

// Write one JSON line to stdout and exit 0 ONLY after the write has been
// fully flushed to the (possibly piped) stdout. `process.exit()` does NOT
// wait for a pending pipe write to drain, so a naive write+exit truncates
// large (~50KB) reports mid-string at the first pipe-buffer boundary
// (8192 bytes) — this was the dominant silent/parse failure for the heavy
// aggregator + invoice tools. Always resolves (never hangs the process):
// a hard fallback timer forces exit even if the consumer never drains.
export function writeJsonLineAndExit(obj) {
  let exited = false;
  const done = () => {
    if (exited) return;
    exited = true;
    process.exit(0);
  };
  let line;
  try {
    line = JSON.stringify(obj, null, 2) + '\n';
  } catch {
    line = JSON.stringify({
      ok: false,
      failure: {
        kind: 'audit_error',
        message: 'report not serializable',
      },
    }) + '\n';
  }
  try {
    const flushed = process.stdout.write(line, () => done());
    if (flushed) {
      // Buffer was empty: the write callback still fires on next tick, but
      // guard with a short timer so we never wedge.
      setTimeout(done, 50).unref?.();
    } else {
      // Backpressure: wait for 'drain', plus a ceiling so a stuck reader
      // can't hang the job (the line is already buffered in the OS pipe).
      process.stdout.once('drain', done);
      setTimeout(done, 5000).unref?.();
    }
  } catch {
    done();
  }
}

// Process-level safety net: turn ANY uncaught crash/timeout into exactly
// one structured failure JSON line, then exit 0. Call once per single-shot
// process with the job's identity so a hung child still yields a report.
export function installSafetyNet(identity) {
  let fired = false;
  const emit = (kind, message) => {
    if (fired) return;
    fired = true;
    const envelope = buildEnvelope({
      consumer: identity.consumerId,
      tool: identity.tool,
      clientid: identity.clientid,
      environment: identity.environment,
      startedAt: identity.startedAt ?? Date.now(),
    });
    const failure = buildFailureReport(envelope, {
      kind,
      message,
      attempts: identity.attempts ?? 1,
    });
    // Flush before exit so even the safety-net failure line is never
    // truncated (it is small, but the same pipe race applies).
    writeJsonLineAndExit(failure);
  };

  process.on('uncaughtException', (e) =>
    emit('transport_error', e && e.message ? e.message : 'uncaughtException')
  );
  process.on('unhandledRejection', (e) =>
    emit(
      'transport_error',
      e && e.message ? e.message : 'unhandledRejection'
    )
  );
  // A hard ceiling so a wedged child can never hang the batch silently.
  const ceiling = Number(process.env.AUDIT_JOB_HARD_CEILING_MS ?? 120000);
  const t = setTimeout(
    () => emit('connect_timeout', `job hard ceiling ${ceiling}ms exceeded`),
    ceiling
  );
  if (typeof t.unref === 'function') t.unref();

  return { disarm: () => clearTimeout(t) };
}
