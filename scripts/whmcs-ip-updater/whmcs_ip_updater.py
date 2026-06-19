#!/usr/bin/env python3
"""Production-safe WHMCS API allowlist updater for MacIPv4/MacIPv6.

Architecture: Option B (restricted SSH user + remote forced-command wrapper).
"""

from __future__ import annotations

import argparse
import base64
import concurrent.futures
import fcntl
import ipaddress
import json
import logging
import os
import random
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

IPV4_PROVIDERS = (
    "https://api.ipify.org",
    "https://ipv4.icanhazip.com",
    "https://checkip.amazonaws.com",
    "https://ipecho.net/plain",
    "https://v4.ident.me",
    "https://myexternalip.com/raw",
    "https://ifconfig.me/ip",
)

IPV6_PROVIDERS = (
    "https://api6.ipify.org",
    "https://ipv6.icanhazip.com",
    "https://v6.ident.me",
    "https://v6.ipv6-test.com/api/myip.php",
    "https://ipv6.my-ip.io/ip",
)

VALID_MODES = (
    "doctor",
    "verify-remote",
    "read-remote",
    "dry-run",
    "oneshot",
    "daemon",
    "status",
    "test-api",
    "test-api-external",
    "rollback-last",
)

# Modes that require an SSH host and an explicit WHMCS root because they
# dispatch a remote action to the worker. `status` reads only the local state
# file; `test-api-external` calls the public WHMCS HTTP API and does not
# transit the forced-command worker.
REMOTE_MODES = frozenset({
    "doctor",
    "verify-remote",
    "read-remote",
    "dry-run",
    "oneshot",
    "daemon",
    "test-api",
    "rollback-last",
})

STOP_REQUESTED = False


@dataclass
class AppConfig:
    mode: str
    ssh_host: str
    ssh_user: str
    ssh_port: int
    ssh_key: Optional[str]
    ssh_known_hosts: Optional[str]
    ssh_timeout: int
    ssh_retries: int
    ssh_retry_backoff_seconds: float
    allow_root_production: bool
    whmcs_root: str
    ipv6_policy: str
    min_stability_seconds: int
    min_provider_agreement: int
    manual_ipv4: Optional[str]
    manual_ipv6: Optional[str]
    reason: str
    state_file: Path
    interval_seconds: int
    max_interval_seconds: int
    circuit_breaker_threshold: int
    circuit_breaker_cooldown_seconds: int
    whmcs_api_url: Optional[str]
    whmcs_api_identifier: Optional[str]
    whmcs_api_secret: Optional[str]
    test_api_timeout: int
    validate_api_after_update: bool
    json_output: bool
    provider_timeout: int
    no_stability_check: bool

    def __repr__(self) -> str:
        def mask(v: Optional[str]) -> str:
            return "***" if v else "None"
        return (
            f"AppConfig(mode={self.mode!r}, ssh_host={self.ssh_host!r}, "
            f"ssh_user={self.ssh_user!r}, whmcs_root={self.whmcs_root!r}, "
            f"ssh_key={mask(self.ssh_key)}, "
            f"whmcs_api_identifier={mask(self.whmcs_api_identifier)}, "
            f"whmcs_api_secret={mask(self.whmcs_api_secret)})"
        )


class StateStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def read(self) -> Dict[str, Any]:
        if not self.path.exists():
            return {
                "last_success_timestamp": None,
                "last_ipv4": None,
                "last_ipv6": None,
                "last_remote_checksum": None,
                "last_update_action": None,
                "failure_count": 0,
                "last_error_code": None,
            }
        with self.path.open("r", encoding="utf-8") as fh:
            try:
                return json.load(fh)
            except json.JSONDecodeError:
                return {
                    "last_success_timestamp": None,
                    "last_ipv4": None,
                    "last_ipv6": None,
                    "last_remote_checksum": None,
                    "last_update_action": None,
                    "failure_count": 0,
                    "last_error_code": "STATE_FILE_CORRUPT",
                }

    def write(self, state: Dict[str, Any]) -> None:
        tmp = self.path.with_suffix(self.path.suffix + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(state, fh, indent=2, sort_keys=True)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)  # atomic on POSIX


class ExecutionLock:
    def __init__(self, state_file: Path) -> None:
        self.lock_path = state_file.with_suffix(state_file.suffix + ".lock")
        self._fh: Optional[Any] = None

    def acquire(self) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RuntimeError(
                f"Another updater process holds lock: {self.lock_path}"
            ) from exc

    def release(self) -> None:
        if self._fh is None:
            return
        fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
        self._fh.close()
        self._fh = None


class RemoteError(RuntimeError):
    def __init__(self, message: str, code: str = "REMOTE_ERROR", payload: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.payload = payload or {}


class SshClient:
    def __init__(self, cfg: AppConfig, logger: logging.Logger) -> None:
        self.cfg = cfg
        self.logger = logger

    def call(self, action: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        payload_b64 = ""
        if payload is not None:
            payload_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
            payload_b64 = base64.urlsafe_b64encode(payload_json.encode("utf-8")).decode("ascii").rstrip("=")

        remote_command = action if not payload_b64 else f"{action} {payload_b64}"
        cmd = [
            "ssh",
            "-o",
            "BatchMode=yes",
            "-o",
            f"ConnectTimeout={self.cfg.ssh_timeout}",
            "-p",
            str(self.cfg.ssh_port),
        ]
        if self.cfg.ssh_key:
            cmd.extend(["-i", os.path.expanduser(self.cfg.ssh_key)])
        if self.cfg.ssh_known_hosts:
            cmd.extend([
                "-o",
                f"UserKnownHostsFile={os.path.expanduser(self.cfg.ssh_known_hosts)}",
                "-o",
                "StrictHostKeyChecking=yes",
            ])
        cmd.append(f"{self.cfg.ssh_user}@{self.cfg.ssh_host}")
        cmd.append(remote_command)

        last_error: Optional[RemoteError] = None
        for attempt in range(1, self.cfg.ssh_retries + 1):
            try:
                proc = subprocess.run(
                    cmd,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=self.cfg.ssh_timeout + 10,
                )
            except subprocess.TimeoutExpired as exc:
                last_error = RemoteError(f"SSH command timeout ({action})", code="SSH_TIMEOUT")
                emit_event(self.logger, "ssh_failed", action=action, attempt=attempt, code="SSH_TIMEOUT")
                if attempt < self.cfg.ssh_retries:
                    emit_event(self.logger, "retrying", scope="ssh", action=action, next_attempt=attempt + 1)
                    time.sleep(self.cfg.ssh_retry_backoff_seconds * attempt)
                    continue
                raise last_error from exc

            if proc.returncode != 0:
                stdout = (proc.stdout or "").strip()
                if stdout:
                    try:
                        parsed = json.loads(stdout)
                        if isinstance(parsed, dict) and not parsed.get("ok", True):
                            code = str(parsed.get("code", "REMOTE_FAILED"))
                            message = str(parsed.get("message", "Remote worker returned failure"))
                            raise RemoteError(message, code=code, payload=parsed)
                    except json.JSONDecodeError:
                        pass

                stderr = (proc.stderr or "").strip()
                last_error = RemoteError(
                    f"SSH command failed ({action}): {stderr or 'no stderr'}",
                    code="SSH_NON_ZERO_EXIT",
                    payload={"returncode": proc.returncode},
                )
                emit_event(
                    self.logger,
                    "ssh_failed",
                    action=action,
                    attempt=attempt,
                    code="SSH_NON_ZERO_EXIT",
                    returncode=proc.returncode,
                )
                if attempt < self.cfg.ssh_retries:
                    emit_event(self.logger, "retrying", scope="ssh", action=action, next_attempt=attempt + 1)
                    time.sleep(self.cfg.ssh_retry_backoff_seconds * attempt)
                    continue
                raise last_error

            output = (proc.stdout or "").strip()
            if not output:
                raise RemoteError(f"Remote response empty for action={action}", code="REMOTE_EMPTY_OUTPUT")
            try:
                response = json.loads(output)
            except json.JSONDecodeError as exc:
                raise RemoteError(
                    f"Remote response is not strict JSON for action={action}",
                    code="REMOTE_INVALID_JSON",
                    payload={"raw": output[:500]},
                ) from exc

            if not isinstance(response, dict):
                raise RemoteError(
                    f"Remote response has invalid shape for action={action}",
                    code="REMOTE_INVALID_SHAPE",
                )

            if not response.get("ok", False):
                code = str(response.get("code", "REMOTE_FAILED"))
                message = str(response.get("message", "Remote worker returned failure"))
                raise RemoteError(message, code=code, payload=response)
            return response

        if last_error:
            raise last_error
        raise RemoteError("SSH call failed with unknown error", code="SSH_UNKNOWN")


def configure_logger() -> logging.Logger:
    logger = logging.getLogger("whmcs-ip-updater")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    return logger


def emit_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    payload = {"event": event, **fields}
    logger.info(json.dumps(payload, sort_keys=True))


def parse_ip(value: str, version: int) -> Optional[str]:
    text = (value or "").strip()
    try:
        ip_obj = ipaddress.ip_address(text)
    except ValueError:
        return None
    if ip_obj.version != version:
        return None
    if not ip_obj.is_global:
        return None
    return text


def fetch_provider_ip(url: str, version: int, timeout: int = 5) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "whmcs-ip-updater/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read(200).decode("utf-8", errors="replace")
    ip_value = parse_ip(body, version)
    if not ip_value:
        raise ValueError(f"provider returned invalid {version} value")
    return ip_value


def detect_ip_with_consensus(
    version: int,
    logger: logging.Logger,
    min_agreement: int,
    provider_timeout: int = 5,
) -> Optional[str]:
    providers = IPV4_PROVIDERS if version == 4 else IPV6_PROVIDERS
    results: Dict[str, int] = {}
    quorum = max(1, min_agreement)

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(providers)) as executor:
        future_map = {
            executor.submit(fetch_provider_ip, provider, version, provider_timeout): provider
            for provider in providers
        }
        for future in concurrent.futures.as_completed(future_map):
            provider = future_map[future]
            try:
                value = future.result()
            except Exception as exc:  # noqa: BLE001
                emit_event(logger, "provider_failed", provider=provider, version=f"ipv{version}", error=str(exc))
                continue
            results[value] = results.get(value, 0) + 1
            emit_event(logger, "ip_detected", provider=provider, version=f"ipv{version}", value=value)
            # Early exit: cancel remaining once quorum is reached for any candidate.
            if results[value] >= quorum:
                for f in future_map:
                    f.cancel()
                break

    if not results:
        return None

    best_ip, best_count = sorted(results.items(), key=lambda item: (-item[1], item[0]))[0]
    if best_count < quorum:
        emit_event(
            logger,
            "retrying",
            scope="provider_consensus",
            version=f"ipv{version}",
            best_value=best_ip,
            best_count=best_count,
            required=quorum,
        )
        return None
    return best_ip


def _detect_parallel(cfg: AppConfig, logger: logging.Logger) -> Dict[str, Optional[str]]:
    """Detect IPv4 and IPv6 concurrently in a single round."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        futures: Dict[int, concurrent.futures.Future[Optional[str]]] = {}
        if not cfg.manual_ipv4:
            futures[4] = pool.submit(
                detect_ip_with_consensus, 4, logger, cfg.min_provider_agreement, cfg.provider_timeout
            )
        if not cfg.manual_ipv6:
            futures[6] = pool.submit(
                detect_ip_with_consensus, 6, logger, cfg.min_provider_agreement, cfg.provider_timeout
            )
        v4 = cfg.manual_ipv4 or (futures[4].result() if 4 in futures else None)
        v6 = cfg.manual_ipv6 or (futures[6].result() if 6 in futures else None)
    return {"ipv4": v4, "ipv6": v6}


def stability_detect(cfg: AppConfig, logger: logging.Logger) -> Dict[str, Optional[str]]:
    # Single-round fast path: used for agent/automation calls or when all IPs are manual.
    if cfg.no_stability_check or (cfg.manual_ipv4 and cfg.manual_ipv6):
        return _detect_parallel(cfg, logger)

    first = _detect_parallel(cfg, logger)

    if cfg.min_stability_seconds > 0:
        time.sleep(cfg.min_stability_seconds)

    second = _detect_parallel(cfg, logger)

    ipv4 = first["ipv4"] if first["ipv4"] and first["ipv4"] == second["ipv4"] else None
    ipv6 = first["ipv6"] if first["ipv6"] and first["ipv6"] == second["ipv6"] else None

    if first["ipv4"] and not ipv4:
        emit_event(logger, "retrying", scope="stability", version="ipv4", reason="unstable")
    if first["ipv6"] and not ipv6:
        emit_event(logger, "retrying", scope="stability", version="ipv6", reason="unstable")

    return {"ipv4": ipv4, "ipv6": ipv6}


def determine_targets(cfg: AppConfig, detection: Dict[str, Optional[str]]) -> Dict[str, str]:
    targets: Dict[str, str] = {}
    if detection.get("ipv4"):
        targets["ipv4"] = detection["ipv4"]  # type: ignore[index]

    if cfg.ipv6_policy == "disabled":
        return targets

    ipv6 = detection.get("ipv6")
    if cfg.ipv6_policy == "required":
        if not ipv6:
            raise RuntimeError("IPv6 policy is required but no stable IPv6 was detected")
        targets["ipv6"] = ipv6
        return targets

    if cfg.ipv6_policy == "only-if-detected" and ipv6:
        targets["ipv6"] = ipv6
    return targets


def ensure_user_guard(cfg: AppConfig) -> None:
    if cfg.ssh_user != "root":
        return
    if cfg.allow_root_production:
        return
    raise RuntimeError(
        "Refusing ssh_user=root by default. Use --allow-root-production only for explicit bootstrap/testing."
    )


def run_verify_remote(cfg: AppConfig, ssh: SshClient) -> Dict[str, Any]:
    return ssh.call("verify", {"whmcs_root": cfg.whmcs_root})


def run_read_remote(cfg: AppConfig, ssh: SshClient) -> Dict[str, Any]:
    return ssh.call("read", {"whmcs_root": cfg.whmcs_root})


def run_test_api(cfg: AppConfig, logger: logging.Logger) -> Dict[str, Any]:
    if not cfg.whmcs_api_url or not cfg.whmcs_api_identifier or not cfg.whmcs_api_secret:
        raise RuntimeError("test-api requires WHMCS API url/identifier/secret")

    if urllib.parse.urlparse(cfg.whmcs_api_url).scheme != "https":
        raise RuntimeError("WHMCS_API_URL must use https (refusing to send credentials over cleartext)")

    endpoint = cfg.whmcs_api_url.rstrip("/") + "/includes/api.php"
    payload = {
        "action": "WhmcsDetails",
        "identifier": cfg.whmcs_api_identifier,
        "secret": cfg.whmcs_api_secret,
        "responsetype": "json",
    }
    body = urllib.parse.urlencode(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "whmcs-ip-updater/1.0"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=cfg.test_api_timeout) as response:
            raw = response.read(4096).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        emit_event(logger, "remote_failed", scope="test_api", code="HTTP_ERROR", status=exc.code)
        raise RuntimeError(f"WHMCS API HTTP error: {exc.code}") from exc
    except urllib.error.URLError as exc:
        emit_event(logger, "remote_failed", scope="test_api", code="NETWORK_ERROR", error=str(exc))
        raise RuntimeError(f"WHMCS API network error: {exc}") from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError("WHMCS API returned non-JSON response") from exc
    if data.get("result") != "success":
        raise RuntimeError(f"WHMCS API returned failure: {data.get('message', 'unknown error')}")

    result = {
        "result": "success",
        "message": "WHMCS API validation succeeded",
    }
    return result


def run_test_api_local(cfg: AppConfig, ssh: SshClient) -> Dict[str, Any]:
    response = ssh.call("test_api_local", {"whmcs_root": cfg.whmcs_root})
    data = response.get("data", {})
    return {
        "result": "success",
        "mode": "local",
        "message": "WHMCS local API validation succeeded",
        "details": data,
    }


def do_dry_run(cfg: AppConfig, ssh: SshClient, logger: logging.Logger) -> Dict[str, Any]:
    ensure_user_guard(cfg)
    # IP detection is HTTP-only; run it concurrently with the first SSH call.
    # SSH calls remain sequential — the forced-command server does not support
    # concurrent connections from the same key.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        f_detect = pool.submit(stability_detect, cfg, logger)
        verify = run_verify_remote(cfg, ssh)
        read = run_read_remote(cfg, ssh)
        detection = f_detect.result()
    targets = determine_targets(cfg, detection)

    if not targets:
        raise RuntimeError("No target IPs available after policy evaluation")

    current = read.get("data", {})
    current_v4 = current.get("mac_ipv4")
    current_v6 = current.get("mac_ipv6")

    intended: Dict[str, Dict[str, str]] = {}
    if "ipv4" in targets and targets["ipv4"] != current_v4:
        intended["MacIPv4"] = {"from": str(current_v4), "to": targets["ipv4"]}
    if "ipv6" in targets and targets["ipv6"] != current_v6:
        intended["MacIPv6"] = {"from": str(current_v6), "to": targets["ipv6"]}

    return {
        "verify": verify.get("data", {}),
        "current": current,
        "detected": detection,
        "targets": targets,
        "intended_changes": intended,
        "no_change": len(intended) == 0,
    }


def do_oneshot(cfg: AppConfig, ssh: SshClient, logger: logging.Logger, state_store: StateStore) -> Dict[str, Any]:
    ensure_user_guard(cfg)

    state = state_store.read()
    try:
        # IP detection (HTTP) runs concurrently with the SSH verify+read calls.
        # SSH calls remain sequential — the forced-command server does not support
        # concurrent connections from the same key.
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            f_detect = pool.submit(stability_detect, cfg, logger)
            verify = run_verify_remote(cfg, ssh)
            read = run_read_remote(cfg, ssh)
            detection = f_detect.result()
        targets = determine_targets(cfg, detection)

        if not targets:
            raise RuntimeError("No valid stable IPv4/IPv6 targets available")

        update_payload = {
            "whmcs_root": cfg.whmcs_root,
            "reason": cfg.reason,
            **targets,
        }
        response = ssh.call("update", update_payload)

        action = response.get("data", {}).get("action", "updated")
        event_name = "no_change" if action == "no_change" else "update_applied"

        api_validation = None
        if cfg.validate_api_after_update and action != "no_change":
            try:
                local_result = run_test_api_local(cfg, ssh)
            except Exception as exc:  # noqa: BLE001
                emit_event(
                    logger,
                    "updated_but_api_validation_failed",
                    mode="local",
                    error=str(exc),
                )
                api_validation = {"result": "error", "mode": "local", "message": str(exc)}
            else:
                api_validation = {"local": local_result}
                if cfg.whmcs_api_url and cfg.whmcs_api_identifier and cfg.whmcs_api_secret:
                    try:
                        api_validation["external"] = run_test_api(cfg, logger)
                    except Exception as exc:  # noqa: BLE001
                        emit_event(
                            logger,
                            "updated_but_api_validation_failed",
                            mode="external",
                            error=str(exc),
                        )
                        api_validation["external"] = {"result": "error", "mode": "external", "message": str(exc)}

        state["last_success_timestamp"] = int(time.time())
        state["last_ipv4"] = targets.get("ipv4")
        state["last_ipv6"] = targets.get("ipv6")
        state["last_remote_checksum"] = response.get("data", {}).get("checksum_after") or read.get("data", {}).get("checksum")
        state["last_update_action"] = action
        state["failure_count"] = 0
        state["last_error_code"] = None
        state_store.write(state)

        emit_event(logger, event_name, action=action)
        return {
            "verify": verify.get("data", {}),
            "read": read.get("data", {}),
            "detected": detection,
            "targets": targets,
            "update": response.get("data", {}),
            "api_validation": api_validation,
        }

    except Exception as exc:  # noqa: BLE001
        code = exc.code if isinstance(exc, RemoteError) else "LOCAL_ERROR"
        state["failure_count"] = int(state.get("failure_count", 0)) + 1
        state["last_error_code"] = code
        state_store.write(state)
        emit_event(logger, "remote_failed", code=code, error=str(exc))
        raise


def do_rollback(cfg: AppConfig, ssh: SshClient, logger: logging.Logger, state_store: StateStore) -> Dict[str, Any]:
    ensure_user_guard(cfg)
    response = ssh.call("rollback", {"whmcs_root": cfg.whmcs_root, "reason": cfg.reason})
    state = state_store.read()
    state["last_success_timestamp"] = int(time.time())
    state["last_update_action"] = "rollback"
    state["last_error_code"] = None
    state_store.write(state)
    emit_event(logger, "rollback_applied", backup_id=response.get("data", {}).get("backup_id"))
    return response.get("data", {})


def daemon_loop(cfg: AppConfig, ssh: SshClient, logger: logging.Logger, state_store: StateStore) -> None:
    ensure_user_guard(cfg)
    interval = cfg.interval_seconds
    while not STOP_REQUESTED:
        state = state_store.read()
        failure_count = int(state.get("failure_count", 0))

        if failure_count >= cfg.circuit_breaker_threshold:
            emit_event(
                logger,
                "circuit_breaker_open",
                scope="circuit_breaker",
                failure_count=failure_count,
                cooldown_seconds=cfg.circuit_breaker_cooldown_seconds,
            )
            time.sleep(cfg.circuit_breaker_cooldown_seconds)
            if STOP_REQUESTED:
                break
            # Half-open probe: execute exactly one oneshot attempt. On success,
            # do_oneshot resets failure_count to 0 and the loop returns to the
            # normal interval cadence. On failure, do_oneshot increments
            # failure_count, the breaker stays open, and we sleep for another
            # cooldown on the next iteration instead of spinning.
            emit_event(
                logger,
                "circuit_breaker_half_open",
                scope="circuit_breaker",
                failure_count=failure_count,
            )
            try:
                do_oneshot(cfg, ssh, logger, state_store)
                interval = cfg.interval_seconds
                emit_event(logger, "circuit_breaker_closed", scope="circuit_breaker")
            except Exception as exc:  # noqa: BLE001
                emit_event(
                    logger,
                    "circuit_breaker_probe_failed",
                    scope="circuit_breaker",
                    error=str(exc),
                )
                # Do not sleep again here; the outer loop will re-evaluate
                # failure_count on its next iteration and apply cooldown.
                continue
        else:
            try:
                do_oneshot(cfg, ssh, logger, state_store)
                interval = cfg.interval_seconds
            except Exception as exc:  # noqa: BLE001
                failure_count = int(state_store.read().get("failure_count", 1))
                exponent = min(failure_count, 6)
                interval = min(cfg.max_interval_seconds, int(cfg.interval_seconds * (2 ** exponent)))
                emit_event(logger, "retrying", scope="daemon", wait_seconds=interval, error=str(exc))

        jitter = random.randint(0, max(1, int(interval * 0.1)))
        sleep_seconds = min(cfg.max_interval_seconds, interval + jitter)
        time.sleep(sleep_seconds)


def print_result(cfg: AppConfig, data: Dict[str, Any]) -> None:
    # All CLI output is JSON (operations consumers parse with jq, MCP, etc.).
    # The --json-output flag is retained for backwards compatibility with
    # existing cron/launchd invocations but is now a no-op; cfg.json_output
    # is intentionally unused here so removing the flag in the future is a
    # one-line change that does not also need to add an alternate renderer.
    del cfg
    print(json.dumps(data, indent=2, sort_keys=True))


def load_args(argv: Iterable[str]) -> AppConfig:
    parser = argparse.ArgumentParser(description="WHMCS API allowlist updater (MacIPv4/MacIPv6)")
    parser.add_argument("mode", choices=VALID_MODES)

    parser.add_argument("--ssh-host", required=False, default=os.getenv("WHMCS_SSH_HOST", ""))
    parser.add_argument("--ssh-user", required=False, default=os.getenv("WHMCS_SSH_USER", "whmcs-ip-updater"))
    parser.add_argument("--ssh-port", type=int, default=int(os.getenv("WHMCS_SSH_PORT", "22")))
    parser.add_argument("--ssh-key", default=os.getenv("WHMCS_SSH_KEY"))
    parser.add_argument(
        "--ssh-known-hosts",
        default=os.getenv("WHMCS_SSH_KNOWN_HOSTS"),
        help=(
            "Path to a known_hosts file for the remote host. When set, ssh uses "
            "it (UserKnownHostsFile) with StrictHostKeyChecking=yes — useful when "
            "the audited host key lives outside the default ~/.ssh/known_hosts. "
            "Defaults to the WHMCS_SSH_KNOWN_HOSTS environment variable."
        ),
    )
    parser.add_argument("--ssh-timeout", type=int, default=int(os.getenv("WHMCS_SSH_TIMEOUT", "15")))
    parser.add_argument("--ssh-retries", type=int, default=int(os.getenv("WHMCS_SSH_RETRIES", "3")))
    parser.add_argument("--ssh-retry-backoff-seconds", type=float, default=float(os.getenv("WHMCS_SSH_RETRY_BACKOFF", "1.5")))

    parser.add_argument("--allow-root-production", action="store_true")
    parser.add_argument(
        "--whmcs-root",
        default=os.getenv("WHMCS_ROOT", ""),
        help=(
            "Absolute path to the WHMCS installation root on the remote host "
            "(e.g. /var/www/whmcs/public). Required for every mode that talks "
            "to the remote worker. Defaults to the WHMCS_ROOT environment "
            "variable. No production path is hardcoded so the same CLI is safe "
            "to ship across customer environments."
        ),
    )

    parser.add_argument("--ipv6-policy", choices=("required", "only-if-detected", "disabled"), default=os.getenv("WHMCS_IPV6_POLICY", "only-if-detected"))
    parser.add_argument("--min-stability-seconds", type=int, default=int(os.getenv("WHMCS_MIN_STABILITY_SECONDS", "20")))
    parser.add_argument("--min-provider-agreement", type=int, default=int(os.getenv("WHMCS_MIN_PROVIDER_AGREEMENT", "2")))

    parser.add_argument("--ipv4", dest="manual_ipv4")
    parser.add_argument("--ipv6", dest="manual_ipv6")
    parser.add_argument("--reason", default=os.getenv("WHMCS_UPDATE_REASON", "Automated Mac IP refresh"))

    parser.add_argument(
        "--state-file",
        default=os.getenv("WHMCS_IP_UPDATER_STATE", str(Path.home() / ".local/state/whmcs-ip-updater/state.json")),
    )

    parser.add_argument("--interval-seconds", type=int, default=int(os.getenv("WHMCS_INTERVAL_SECONDS", "300")))
    parser.add_argument("--max-interval-seconds", type=int, default=int(os.getenv("WHMCS_MAX_INTERVAL_SECONDS", "1800")))
    parser.add_argument("--circuit-breaker-threshold", type=int, default=int(os.getenv("WHMCS_CIRCUIT_BREAKER_THRESHOLD", "5")))
    parser.add_argument("--circuit-breaker-cooldown-seconds", type=int, default=int(os.getenv("WHMCS_CIRCUIT_BREAKER_COOLDOWN_SECONDS", "900")))

    parser.add_argument("--whmcs-api-url", default=os.getenv("WHMCS_API_URL"))
    parser.add_argument("--whmcs-api-identifier", default=os.getenv("WHMCS_API_IDENTIFIER"))
    parser.add_argument("--whmcs-api-secret", default=os.getenv("WHMCS_API_SECRET"))
    parser.add_argument("--test-api-timeout", type=int, default=int(os.getenv("WHMCS_TEST_API_TIMEOUT", "15")))
    parser.add_argument("--validate-api-after-update", action=argparse.BooleanOptionalAction, default=True)

    parser.add_argument("--json-output", action="store_true")
    parser.add_argument(
        "--provider-timeout",
        type=int,
        default=int(os.getenv("WHMCS_PROVIDER_TIMEOUT", "5")),
        help="Per-provider HTTP timeout in seconds (default: 5). Lower values speed up consensus detection.",
    )
    parser.add_argument(
        "--no-stability-check",
        action="store_true",
        default=os.getenv("WHMCS_NO_STABILITY_CHECK", "").lower() in ("1", "true", "yes"),
        help=(
            "Skip the two-round stability check and 20-second sleep. "
            "Recommended for agent/automation callers — cuts typical oneshot time from ~25s to ~3s."
        ),
    )

    ns = parser.parse_args(list(argv))

    if ns.mode in REMOTE_MODES and not ns.ssh_host:
        parser.error("--ssh-host (or WHMCS_SSH_HOST) is required for this mode")

    # Every mode that talks to the remote worker passes whmcs_root in the
    # payload. Refuse to dispatch without an explicit absolute path so the CLI
    # never silently targets a wrong WHMCS install when the env var is unset.
    if ns.mode in REMOTE_MODES:
        if not ns.whmcs_root:
            parser.error("--whmcs-root (or WHMCS_ROOT) is required for this mode")
        if not ns.whmcs_root.startswith("/"):
            parser.error("--whmcs-root must be an absolute path")

    if ns.manual_ipv4 and not parse_ip(ns.manual_ipv4, 4):
        parser.error("--ipv4 must be a valid public IPv4 address")
    if ns.manual_ipv6 and not parse_ip(ns.manual_ipv6, 6):
        parser.error("--ipv6 must be a valid public IPv6 address")
    if ns.min_provider_agreement < 1:
        parser.error("--min-provider-agreement must be >= 1")

    return AppConfig(
        mode=ns.mode,
        ssh_host=ns.ssh_host,
        ssh_user=ns.ssh_user,
        ssh_port=ns.ssh_port,
        ssh_key=ns.ssh_key,
        ssh_known_hosts=ns.ssh_known_hosts,
        ssh_timeout=ns.ssh_timeout,
        ssh_retries=ns.ssh_retries,
        ssh_retry_backoff_seconds=ns.ssh_retry_backoff_seconds,
        allow_root_production=ns.allow_root_production,
        whmcs_root=ns.whmcs_root,
        ipv6_policy=ns.ipv6_policy,
        min_stability_seconds=ns.min_stability_seconds,
        min_provider_agreement=ns.min_provider_agreement,
        manual_ipv4=ns.manual_ipv4,
        manual_ipv6=ns.manual_ipv6,
        reason=ns.reason,
        state_file=Path(ns.state_file),
        interval_seconds=ns.interval_seconds,
        max_interval_seconds=ns.max_interval_seconds,
        circuit_breaker_threshold=ns.circuit_breaker_threshold,
        circuit_breaker_cooldown_seconds=ns.circuit_breaker_cooldown_seconds,
        whmcs_api_url=ns.whmcs_api_url,
        whmcs_api_identifier=ns.whmcs_api_identifier,
        whmcs_api_secret=ns.whmcs_api_secret,
        test_api_timeout=ns.test_api_timeout,
        validate_api_after_update=ns.validate_api_after_update,
        json_output=ns.json_output,
        provider_timeout=ns.provider_timeout,
        no_stability_check=ns.no_stability_check,
    )


def signal_handler(signum: int, frame: Any) -> None:
    del signum, frame
    global STOP_REQUESTED
    STOP_REQUESTED = True


def main(argv: Iterable[str]) -> int:
    logger = configure_logger()
    cfg = load_args(argv)
    state_store = StateStore(cfg.state_file)
    exec_lock = ExecutionLock(cfg.state_file)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    ssh = SshClient(cfg, logger)

    try:
        if cfg.mode not in ("status",):
            exec_lock.acquire()

        if cfg.mode in REMOTE_MODES:
            ensure_user_guard(cfg)

        if cfg.mode == "status":
            print_result(cfg, state_store.read())
            return 0

        if cfg.mode == "test-api":
            data = run_test_api_local(cfg, ssh)
            print_result(cfg, data)
            return 0

        if cfg.mode == "test-api-external":
            data = run_test_api(cfg, logger)
            print_result(cfg, data)
            return 0

        if cfg.mode == "verify-remote":
            data = run_verify_remote(cfg, ssh)
            print_result(cfg, data)
            return 0

        if cfg.mode == "read-remote":
            data = run_read_remote(cfg, ssh)
            print_result(cfg, data)
            return 0

        if cfg.mode == "dry-run":
            data = do_dry_run(cfg, ssh, logger)
            print_result(cfg, data)
            return 0

        if cfg.mode == "oneshot":
            data = do_oneshot(cfg, ssh, logger, state_store)
            print_result(cfg, data)
            return 0

        if cfg.mode == "rollback-last":
            data = do_rollback(cfg, ssh, logger, state_store)
            print_result(cfg, data)
            return 0

        if cfg.mode == "doctor":
            ensure_user_guard(cfg)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                f_detect = pool.submit(stability_detect, cfg, logger)
                remote_verify = run_verify_remote(cfg, ssh)
                remote_read = run_read_remote(cfg, ssh)
                detection = f_detect.result()
            doctor_data: Dict[str, Any] = {
                "remote_verify": remote_verify.get("data", {}),
                "remote_read": remote_read.get("data", {}),
                "detection": detection,
                "state": state_store.read(),
            }
            try:
                doctor_data["test_api_local"] = run_test_api_local(cfg, ssh)
            except Exception as exc:  # noqa: BLE001
                doctor_data["test_api_local"] = {"result": "error", "mode": "local", "message": str(exc)}
            if cfg.whmcs_api_url and cfg.whmcs_api_identifier and cfg.whmcs_api_secret:
                try:
                    doctor_data["test_api_external"] = run_test_api(cfg, logger)
                except Exception as exc:  # noqa: BLE001
                    doctor_data["test_api_external"] = {"result": "error", "mode": "external", "message": str(exc)}
            else:
                doctor_data["test_api_external"] = {
                    "result": "skipped",
                    "mode": "external",
                    "message": "WHMCS API credentials not configured",
                }
            print_result(cfg, doctor_data)
            return 0

        if cfg.mode == "daemon":
            daemon_loop(cfg, ssh, logger, state_store)
            return 0

        raise RuntimeError(f"Unhandled mode: {cfg.mode}")
    except Exception as exc:  # noqa: BLE001
        error_payload = {
            "ok": False,
            "code": exc.code if isinstance(exc, RemoteError) else "LOCAL_ERROR",
            "message": str(exc),
        }
        print(json.dumps(error_payload, indent=2, sort_keys=True))
        return 1
    finally:
        exec_lock.release()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
