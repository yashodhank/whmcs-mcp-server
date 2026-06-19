"""Tests for Plan 006 Unit C: probe-and-correct on '403 Invalid IP <X>' after consensus update."""
from __future__ import annotations

import importlib.util
import json
import logging
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import MagicMock, call, patch

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

# ---------------------------------------------------------------------------
# Public test IPs (not RFC-5737/RFC-3849 documentation ranges — Python's
# ipaddress module marks 203.0.113.x and 2001:db8:: as non-global).
# ---------------------------------------------------------------------------
_PUBLIC_IPV4_A = "1.1.1.1"    # Cloudflare resolver — globally routable
_PUBLIC_IPV4_B = "8.8.8.8"    # Google DNS — globally routable
_PUBLIC_IPV4_DETECTED = "104.16.0.1"   # Cloudflare CDN — globally routable


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_cfg(tmp_path, **overrides):
    """Return a minimal AppConfig for tests."""
    import inspect
    fields = list(inspect.signature(_mod.AppConfig).parameters.keys())
    defaults = {
        "mode": "oneshot",
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
        "circuit_breaker_threshold": 5,
        "circuit_breaker_cooldown_seconds": 900,
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


def _fake_ssh_response(action="updated", checksum_after="abc123"):
    return {"ok": True, "data": {"action": action, "checksum_after": checksum_after}}


def _fake_verify_response():
    return {"ok": True, "data": {"version": "8.0", "checksum": "abc"}}


def _fake_read_response():
    return {"ok": True, "data": {"mac_ipv4": "1.2.3.4", "mac_ipv6": None, "checksum": "abc"}}


# ---------------------------------------------------------------------------
# (a) _extract_reported_ip helper
# ---------------------------------------------------------------------------

class TestExtractReportedIp:
    def test_extracts_ipv4(self):
        msg = f"WHMCS API returned failure: Invalid IP {_PUBLIC_IPV4_A}"
        assert _mod._extract_reported_ip(msg) == _PUBLIC_IPV4_A

    def test_extracts_ipv4_from_full_error(self):
        msg = f"WHMCS API returned failure: Invalid IP {_PUBLIC_IPV4_B}"
        assert _mod._extract_reported_ip(msg) == _PUBLIC_IPV4_B

    def test_case_insensitive(self):
        msg = f"INVALID IP {_PUBLIC_IPV4_A}"
        assert _mod._extract_reported_ip(msg) == _PUBLIC_IPV4_A

    def test_whitespace_variants(self):
        msg = f"invalid  ip  {_PUBLIC_IPV4_B}"
        assert _mod._extract_reported_ip(msg) == _PUBLIC_IPV4_B

    def test_returns_none_for_no_match(self):
        msg = "Some other error"
        assert _mod._extract_reported_ip(msg) is None

    def test_returns_none_for_private_ip(self):
        # Private IPs are not public; parse_ip returns None for them.
        msg = "Invalid IP 192.168.1.1"
        assert _mod._extract_reported_ip(msg) is None

    def test_returns_none_for_loopback(self):
        msg = "Invalid IP 127.0.0.1"
        assert _mod._extract_reported_ip(msg) is None


# ---------------------------------------------------------------------------
# (b) do_oneshot: probe-and-correct on 403 Invalid IP
# ---------------------------------------------------------------------------

class TestProbeAndCorrect:
    """Test the probe-and-correct logic in do_oneshot."""

    def _make_state_store(self, tmp_path):
        return _mod.StateStore(tmp_path / "state.json")

    def test_no_second_update_when_validation_passes(self, tmp_path):
        """When external validation succeeds first time, no corrective update is issued."""
        cfg = _make_cfg(tmp_path)
        logger = logging.getLogger("test_c")
        state_store = self._make_state_store(tmp_path)

        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            _fake_verify_response(),
            _fake_read_response(),
            _fake_ssh_response(),       # consensus update
            {"ok": True, "data": {}},   # test_api_local
        ]

        def fake_urlopen(req, timeout=None):
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.read.return_value = b'{"result": "success"}'
            return mock_resp

        with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4_DETECTED, "ipv6": None}):
            with patch("urllib.request.urlopen", fake_urlopen):
                result = _mod.do_oneshot(cfg, ssh_mock, logger, state_store)

        # Exactly one update call (the consensus update), no corrective update.
        update_calls = [c for c in ssh_mock.call.call_args_list if c[0][0] == "update"]
        assert len(update_calls) == 1, f"Expected 1 update call, got {len(update_calls)}"
        assert result.get("corrective_update") is None

    def test_corrective_update_on_invalid_ip_403(self, tmp_path):
        """When external validation fails with 'Invalid IP <X>', a single corrective update runs."""
        cfg = _make_cfg(tmp_path)
        logger = logging.getLogger("test_c")
        state_store = self._make_state_store(tmp_path)

        reported_ip = _PUBLIC_IPV4_B   # IP WHMCS says we should use.

        ssh_mock = MagicMock()
        # verify, read, update (consensus), test_api_local, update (corrective)
        ssh_mock.call.side_effect = [
            _fake_verify_response(),
            _fake_read_response(),
            _fake_ssh_response(),               # consensus update
            {"ok": True, "data": {}},           # test_api_local succeeds
            _fake_ssh_response(action="updated"),  # corrective update
        ]

        call_count = [0]

        def fake_urlopen(req, timeout=None):
            call_count[0] += 1
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            if call_count[0] == 1:
                # First external validation fails: WHMCS reports the authoritative IP.
                mock_resp.read.return_value = (
                    f'{{"result": "error", "message": "Invalid IP {reported_ip}"}}'.encode()
                )
            else:
                # Second external validation (after correction) succeeds.
                mock_resp.read.return_value = b'{"result": "success"}'
            return mock_resp

        with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4_DETECTED, "ipv6": None}):
            with patch("urllib.request.urlopen", fake_urlopen):
                result = _mod.do_oneshot(cfg, ssh_mock, logger, state_store)

        # Two update SSH calls: the consensus update and the corrective update.
        update_calls = [c for c in ssh_mock.call.call_args_list if c[0][0] == "update"]
        assert len(update_calls) == 2, f"Expected 2 update calls, got {len(update_calls)}"

        # The corrective update must target the reported IP.
        corrective_call_args = update_calls[1][0][1]  # second update's payload
        assert corrective_call_args.get("ipv4") == reported_ip, (
            f"Corrective update should target {reported_ip!r}, got {corrective_call_args!r}"
        )
        assert result.get("corrective_update") is not None

    def test_only_one_corrective_update_even_if_second_validation_fails(self, tmp_path):
        """Bounded to one correction: no further updates even if post-correction validation fails."""
        cfg = _make_cfg(tmp_path)
        logger = logging.getLogger("test_c")
        state_store = self._make_state_store(tmp_path)

        reported_ip = _PUBLIC_IPV4_B
        another_ip = _PUBLIC_IPV4_A   # Different IP returned on second validation — should NOT trigger another correction.

        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            _fake_verify_response(),
            _fake_read_response(),
            _fake_ssh_response(),               # consensus update
            {"ok": True, "data": {}},           # test_api_local succeeds
            _fake_ssh_response(action="updated"),  # corrective update
        ]

        call_count = [0]

        def fake_urlopen(req, timeout=None):
            call_count[0] += 1
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            ip = reported_ip if call_count[0] == 1 else another_ip
            # Both external API calls return "Invalid IP <X>" to test the one-correction bound.
            mock_resp.read.return_value = (
                f'{{"result": "error", "message": "Invalid IP {ip}"}}'.encode()
            )
            return mock_resp

        with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4_DETECTED, "ipv6": None}):
            with patch("urllib.request.urlopen", fake_urlopen):
                result = _mod.do_oneshot(cfg, ssh_mock, logger, state_store)

        # Still exactly two update calls: one consensus + one correction (no further loop).
        update_calls = [c for c in ssh_mock.call.call_args_list if c[0][0] == "update"]
        assert len(update_calls) == 2, (
            f"Expected exactly 2 update calls (no unbounded loop), got {len(update_calls)}"
        )

    def test_no_corrective_update_when_validation_disabled(self, tmp_path):
        """When validate_api_after_update is False, probe-and-correct is never triggered."""
        cfg = _make_cfg(tmp_path, validate_api_after_update=False)
        logger = logging.getLogger("test_c")
        state_store = self._make_state_store(tmp_path)

        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            _fake_verify_response(),
            _fake_read_response(),
            _fake_ssh_response(),  # consensus update only
        ]

        with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4_DETECTED, "ipv6": None}):
            result = _mod.do_oneshot(cfg, ssh_mock, logger, state_store)

        update_calls = [c for c in ssh_mock.call.call_args_list if c[0][0] == "update"]
        assert len(update_calls) == 1
        assert result.get("corrective_update") is None

    def test_no_corrective_update_when_no_api_creds(self, tmp_path):
        """Without API credentials, external validation is skipped so probe-and-correct never fires."""
        cfg = _make_cfg(
            tmp_path,
            whmcs_api_url=None,
            whmcs_api_identifier=None,
            whmcs_api_secret=None,
        )
        logger = logging.getLogger("test_c")
        state_store = self._make_state_store(tmp_path)

        ssh_mock = MagicMock()
        ssh_mock.call.side_effect = [
            _fake_verify_response(),
            _fake_read_response(),
            _fake_ssh_response(),          # consensus update
            {"ok": True, "data": {}},      # test_api_local
        ]

        with patch.object(_mod, "stability_detect", return_value={"ipv4": _PUBLIC_IPV4_DETECTED, "ipv6": None}):
            result = _mod.do_oneshot(cfg, ssh_mock, logger, state_store)

        update_calls = [c for c in ssh_mock.call.call_args_list if c[0][0] == "update"]
        assert len(update_calls) == 1
        assert result.get("corrective_update") is None
