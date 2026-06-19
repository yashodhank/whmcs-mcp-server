/**
 * IP allowlist self-heal
 *
 * WHMCS rejects API calls from a source IP that is not present in the
 * `APIAllowedIPs` configuration with HTTP 403. This is common after an
 * ISP/proxy IP change. When auto-heal is enabled, a 403 triggers a single
 * `oneshot` run of the existing IP updater
 * (`scripts/whmcs-ip-updater/whmcs_ip_updater.py`), which detects the current
 * WHMCS-reported source IP and compare-and-swaps it into `APIAllowedIPs`. The
 * caller then retries the original request once.
 *
 * Safety properties:
 * - Opt-in via WHMCS_AUTO_IP_HEAL (default off).
 * - Single-flight: concurrent 403s coalesce onto one updater run.
 * - Cooldown: refuses to re-run within WHMCS_AUTO_IP_HEAL_COOLDOWN_MS, so a
 *   persistently-failing whitelist cannot spawn the updater in a tight loop.
 * - Hard timeout: the updater is killed after WHMCS_AUTO_IP_HEAL_TIMEOUT_MS.
 * - Fail-soft: any error resolves to `false`; the original 403 is then surfaced.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logging.js';

/** Shared promise so concurrent 403s trigger at most one updater run. */
let inFlight: Promise<boolean> | null = null;
/** Epoch ms when the last heal finished, for cooldown enforcement. */
let lastHealEndMs = 0;

/** Reset module state. Test-only. */
export function _resetIpHealStateForTests(): void {
  inFlight = null;
  lastHealEndMs = 0;
}

/**
 * Resolve the updater script path. Prefers the explicit config value; otherwise
 * walks up from this module to find scripts/whmcs-ip-updater/whmcs_ip_updater.py
 * (works whether running from src/ or a bundled dist/).
 */
function resolveUpdaterScript(config: AppConfig): string | null {
  if (config.WHMCS_IP_UPDATER_SCRIPT) {
    return existsSync(config.WHMCS_IP_UPDATER_SCRIPT) ? config.WHMCS_IP_UPDATER_SCRIPT : null;
  }
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const up of ['.', '..', '../..', '../../..']) {
      const candidate = path.resolve(here, up, 'scripts/whmcs-ip-updater/whmcs_ip_updater.py');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    /* import.meta unavailable / fs error — fall through */
  }
  return null;
}

/**
 * Attempt to self-heal the WHMCS API IP allowlist. Returns true only if the
 * updater completed successfully (exit code 0 — IP updated or already correct).
 */
/**
 * @param reportedIp Optional source IP WHMCS reported in the "Invalid IP" 403.
 *   When provided (and well-formed), the updater is told to use it directly
 *   (--ipv4/--ipv6) instead of detecting via public-IP providers — authoritative
 *   (no proxy/NAT skew) and faster.
 */
export async function attemptIpAllowlistHeal(
  config: AppConfig,
  logger: Logger,
  reportedIp?: string
): Promise<boolean> {
  if (!config.WHMCS_AUTO_IP_HEAL) {
    return false;
  }
  if (inFlight) {
    logger.info('IP allowlist heal already in progress; awaiting shared run');
    return inFlight;
  }
  const sinceMs = Date.now() - lastHealEndMs;
  if (lastHealEndMs > 0 && sinceMs < config.WHMCS_AUTO_IP_HEAL_COOLDOWN_MS) {
    logger.warn('IP allowlist heal skipped (cooldown active)', {
      sinceMs,
      cooldownMs: config.WHMCS_AUTO_IP_HEAL_COOLDOWN_MS,
    });
    return false;
  }
  inFlight = runUpdaterOnce(config, logger, reportedIp).finally(() => {
    inFlight = null;
    lastHealEndMs = Date.now();
  });
  return inFlight;
}

/** Accept only a well-formed IPv4/IPv6 literal before handing it to the updater. */
function isIpLiteral(ip: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/.test(ip);
}

function runUpdaterOnce(config: AppConfig, logger: Logger, reportedIp?: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const script = resolveUpdaterScript(config);
    if (!script) {
      logger.warn(
        'IP allowlist heal aborted: updater script not found (set WHMCS_IP_UPDATER_SCRIPT to scripts/whmcs-ip-updater/whmcs_ip_updater.py)'
      );
      resolve(false); return;
    }

    // The updater reads its own SSH/WHMCS_ROOT env (WHMCS_SSH_HOST, WHMCS_SSH_USER,
    // WHMCS_SSH_KEY, WHMCS_SSH_KNOWN_HOSTS, WHMCS_ROOT). Inherit process env and
    // map the MCP credential names to the updater's expected names so its
    // post-update API validation can run.
    const childEnv = {
      ...process.env,
      WHMCS_API_URL: config.WHMCS_API_URL,
      WHMCS_API_IDENTIFIER: config.WHMCS_IDENTIFIER,
      WHMCS_API_SECRET: config.WHMCS_SECRET,
    };

    // Build args. If WHMCS reported a well-formed source IP, target it directly
    // (--ipv4/--ipv6) so the updater skips provider detection and can't be
    // fooled by proxy/NAT skew between our public IP and the WHMCS-facing one.
    const args = [script, 'oneshot', '--no-stability-check'];
    if (reportedIp && isIpLiteral(reportedIp)) {
      args.push(reportedIp.includes(':') ? '--ipv6' : '--ipv4', reportedIp);
    }

    logger.warn('WHMCS 403: attempting IP allowlist self-heal (oneshot)', { script, reportedIp });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const child = spawn(config.WHMCS_IP_UPDATER_PYTHON, args, {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      logger.warn('IP allowlist heal timed out; killing updater', {
        timeoutMs: config.WHMCS_AUTO_IP_HEAL_TIMEOUT_MS,
      });
      child.kill('SIGKILL');
      finish(false);
    }, config.WHMCS_AUTO_IP_HEAL_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      logger.warn('IP allowlist heal failed to spawn updater', { error: String(e) });
      finish(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ok = code === 0;
      let action: string | undefined;
      try {
        const parsed = JSON.parse(stdout) as { action?: string; data?: { action?: string } };
        action = parsed.data?.action ?? parsed.action;
      } catch {
        /* updater output was not JSON (e.g. an early error) */
      }
      logger[ok ? 'info' : 'warn']('IP allowlist heal finished', {
        exitCode: code,
        ok,
        action,
        stderr: stderr.slice(0, 500),
      });
      finish(ok);
    });
  });
}
