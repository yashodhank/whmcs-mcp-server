"""Tests for Plan 006 Unit D: best-effort failure notifier on circuit_breaker_open
and updated_but_api_validation_failed."""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Module loader
# ---------------------------------------------------------------------------

_SRC = Path(__file__).parent.parent / "whmcs_ip_updater.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("whmcs_ip_updater", _SRC)
    m = importlib.util.module_from_spec(spec)
    sys.modules["whmcs_ip_updater"] = m
    spec.loader.exec_module(m)
    return m


_mod = _load_module()

# Public IPs (see Unit C note — RFC-5737 docs ranges are not is_global).
_PUBLIC_IPV4 = "104.16.0.1"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cfg(tmp_path, **overrides):
    import inspect
    fields = list(inspect.signature(_mod.AppConfig).parameters.keys())
    defaults = {
        "mode": "daemon",
        "ssh_host": "host.example.com",
        "ssh_user": "whmcs-ip-updater",
        "ssh_port": 22,
        "ssh_key": None,
        "ssh_known_hosts": None,
        "ssh_timeout": 15,
        "ssh_retries": 1,
        "ssh_retry_backoff_seconds": 0.0,
        "allow_root_production": False,
        "whmcs_root": "/var/www/whmcs",
        "ipv6_policy": "only-if-detected",
        "min_stability_seconds": 0,
        "min_provider_agreement": 2,
        "manual_ipv4": None,
        "manual_ipv6": None,
        "reason": "test run",
        "state_file": tmp_path / "state.json",
        "interval_seconds": 300,
        "max_interval_seconds": 1800,
        "circuit_breaker_threshold": 1,   # low threshold so we can trigger it easily
        "circuit_breaker_cooldown_seconds": 0,
        "whmcs_api_url": "https://whmcs.example.com",
        "whmcs_api_identifier": "id-test",
        "whmcs_api_secret": "sec-test",
        "test_api_timeout": 5,
        "test_api_action": "GetStaffOnline",
        "validate_api_after_update": True,
        "json_output": False,
        "provider_timeout": 5,
        "no_stability_check": True,
    }
    defaults.update(overrides)
    kwargs = {f: defaults[f] for f in fields if f in defaults}
    return _mod.AppConfig(**kwargs)


# ---------------------------------------------------------------------------
# (a) notify_failure writes one JSON line to MCP_WRITE_AUDIT_PATH
# ---------------------------------------------------------------------------

class TestNotifyFailure:
    def test_writes_json_line_to_audit_path(self, tmp_path):
        """notify_failure must append a JSON line to MCP_WRITE_AUDIT_PATH when set."""
        audit_file = tmp_path / "audit.log"
        logger = logging.getLogger("test_d_notifier")

        with patch.dict(os.environ, {"MCP_WRITE_AUDIT_PATH": str(audit_file)}, clear=False):
            _mod.notify_failure(logger, "circuit_breaker_open", failure_count=5)

        assert audit_file.exists(), "audit file was not created"
        lines = audit_file.read_text().splitlines()
        assert len(lines) == 1, f"Expected 1 JSON line, got {len(lines)}"
        record = json.loads(lines[0])
        assert record["event"] == "circuit_breaker_open"
        assert record["failure_count"] == 5
        assert "ts" in record

    def test_writes_multiple_lines_on_repeated_calls(self, tmp_path):
        """Each notify_failure call must append a new line (not overwrite)."""
        audit_file = tmp_path / "audit.log"
        logger = logging.getLogger("test_d_notifier")

        with patch.dict(os.environ, {"MCP_WRITE_AUDIT_PATH": str(audit_file)}, clear=False):
            _mod.notify_failure(logger, "circuit_breaker_open", failure_count=5)
            _mod.notify_failure(logger, "updated_but_api_validation_failed", mode="external", error="x")

        lines = audit_file.read_text().splitlines()
        assert len(lines) == 2
        events = [json.loads(l)["event"] for l in lines]
        assert "circuit_breaker_open" in events
        assert "updated_but_api_validation_failed" in events

    def test_no_audit_write_when_env_unset(self, tmp_path):
        """notify_failure must silently do nothing when MCP_WRITE_AUDIT_PATH is not set."""
        logger = logging.getLogger("test_d_notifier")
        env_without_audit = {k: v for k, v in os.environ.items() if k != "MCP_WRITE_AUDIT_PATH"}
        with patch.dict(os.environ, {}, clear=True):
            os.environ.update(env_without_audit)
            _mod.notify_failure(logger, "circuit_breaker_open", failure_count=5)
        # No exception means the test passes.

    def test_notifier_exception_does_not_propagate(self, tmp_path):
        """A broken audit path must not raise — the notifier is best-effort."""
        logger = logging.getLogger("test_d_notifier")
        # Use a path that cannot be written (a directory as the audit path).
        non_writable = str(tmp_path)   # directory, not a file
        with patch.dict(os.environ, {"MCP_WRITE_AUDIT_PATH": non_writable}, clear=False):
            # Must not raise.
            _mod.notify_failure(logger, "circuit_breaker_open", failure_count=5)

    def test_notifier_webhook_exception_does_not_propagate(self, tmp_path):
        """A webhook POST failure must not raise."""
        logger = logging.getLogger("test_d_notifier")
        audit_file = tmp_path / "audit.log"

        def bad_urlopen(req, timeout=None):
            raise OSError("Connection refused")

        with patch.dict(os.environ, {
            "MCP_WRITE_AUDIT_PATH": str(audit_file),
            "WHMCS_IP_UPDATER_ALERT_WEBHOOK": "https://hook.example.com/alert",
        }, clear=False):
            with patch("urllib.request.urlopen", bad_urlopen):
                _mod.notify_failure(logger, "circuit_breaker_open", failure_count=5)

        # Audit file should still have been written before the webhook failed.
        assert audit_file.exists()


# ---------------------------------------------------------------------------
# (b) daemon_loop: notify_failure called on circuit_breaker_open and
#     updated_but_api_validation_failed; notifier errors do not propagate
# ---------------------------------------------------------------------------

class TestDaemonLoopNotifier:
    """Tests that daemon_loop integrates notify_failure correctly."""

    def test_notifier_called_on_circuit_breaker_open(self, tmp_path):
        """daemon_loop must call notify_failure when the circuit breaker opens."""
        cfg = _make_cfg(tmp_path, circuit_breaker_threshold=1, circuit_breaker_cooldown_seconds=0)
        logger = logging.getLogger("test_d_daemon")

        state_store = _mod.StateStore(tmp_path / "state.json")
        # Pre-seed failure_count at threshold to trigger breaker immediately.
        state_store.write({
            "failure_count": 1,
            "last_error_code": "TEST",
            "last_success_timestamp": None,
            "last_ipv4": None,
            "last_ipv6": None,
            "last_remote_checksum": None,
            "last_update_action": None,
        })

        notify_calls = []

        def mock_notify(log, event, **fields):
            notify_calls.append(event)

        # Make do_oneshot succeed so we can exit the loop after one breaker cycle.
        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            {"ok": True, "data": {"version": "8.0", "checksum": "abc"}},  # verify
            {"ok": True, "data": {"mac_ipv4": "1.2.3.4", "mac_ipv6": None, "checksum": "abc"}},  # read
            {"ok": True, "data": {"action": "updated", "checksum_after": "xyz"}},  # update
            {"ok": True, "data": {}},  # test_api_local
        ]

        # Patch STOP_REQUESTED to stop after one iteration.
        iteration = [0]
        original_stop = _mod.STOP_REQUESTED

        def stop_after_first_sleep(secs):
            _mod.STOP_REQUESTED = True

        with patch.object(_mod, "notify_failure", mock_notify):
            with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4, "ipv6": None}):
                with patch.object(_mod, "time") as mock_time:
                    mock_time.sleep.side_effect = stop_after_first_sleep
                    mock_time.time.return_value = 1000000
                    mock_time.randint.return_value = 0
                    try:
                        _mod.daemon_loop(cfg, ssh_mock, logger, state_store)
                    except Exception:
                        pass  # STOP_REQUESTED may interrupt; that is expected

        _mod.STOP_REQUESTED = False  # reset global state
        assert "circuit_breaker_open" in notify_calls, (
            f"notify_failure was not called with circuit_breaker_open; calls: {notify_calls}"
        )

    def test_notifier_error_does_not_propagate_out_of_daemon_loop(self, tmp_path):
        """A failing notifier must not cause daemon_loop to raise."""
        cfg = _make_cfg(tmp_path, circuit_breaker_threshold=1, circuit_breaker_cooldown_seconds=0)
        logger = logging.getLogger("test_d_daemon")

        state_store = _mod.StateStore(tmp_path / "state.json")
        state_store.write({
            "failure_count": 1,
            "last_error_code": "TEST",
            "last_success_timestamp": None,
            "last_ipv4": None,
            "last_ipv6": None,
            "last_remote_checksum": None,
            "last_update_action": None,
        })

        def exploding_notify(log, event, **fields):
            raise RuntimeError("notifier exploded!")

        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            {"ok": True, "data": {"version": "8.0"}},
            {"ok": True, "data": {"mac_ipv4": "1.2.3.4", "mac_ipv6": None, "checksum": "abc"}},
            {"ok": True, "data": {"action": "updated", "checksum_after": "xyz"}},
            {"ok": True, "data": {}},
        ]

        def stop_after_sleep(secs):
            _mod.STOP_REQUESTED = True

        # Must not raise even though notify_failure raises.
        # NOTE: exploding_notify raises in notify_failure which is called BEFORE
        # time.sleep(cooldown). The outer try/except in notify_failure catches it.
        with patch.object(_mod, "notify_failure", exploding_notify):
            with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4, "ipv6": None}):
                with patch.object(_mod, "time") as mock_time:
                    mock_time.sleep.side_effect = stop_after_sleep
                    mock_time.time.return_value = 1000000
                    mock_time.randint.return_value = 0
                    try:
                        _mod.daemon_loop(cfg, ssh_mock, logger, state_store)
                    except RuntimeError as exc:
                        if "notifier exploded" in str(exc):
                            pytest.fail(
                                f"notify_failure error propagated out of daemon_loop: {exc}"
                            )
                        raise  # unexpected error — re-raise

        _mod.STOP_REQUESTED = False  # reset global state
