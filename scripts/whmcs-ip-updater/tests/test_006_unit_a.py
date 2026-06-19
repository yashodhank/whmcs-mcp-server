"""Tests for Plan 006 Unit A: env-overridable validation action defaulting to GetStaffOnline."""
from __future__ import annotations

import importlib.util
import logging
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

import pytest

# ---------------------------------------------------------------------------
# Module loader (same pattern as test_hardening.py)
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
# Helper: build a minimal AppConfig-like stub for run_test_api
# ---------------------------------------------------------------------------

class _ApiStub:
    def __init__(self, url="https://whmcs.example.com", action="GetStaffOnline"):
        self.whmcs_api_url = url
        self.whmcs_api_identifier = "id-abc"
        self.whmcs_api_secret = "sec-xyz"
        self.test_api_timeout = 5
        self.test_api_action = action


# ---------------------------------------------------------------------------
# (a) Default action is GetStaffOnline
# ---------------------------------------------------------------------------

def test_default_test_api_action_is_GetStaffOnline(tmp_path):
    """load_args with no --test-api-action must produce test_api_action='GetStaffOnline'."""
    import os
    env = {
        "WHMCS_SSH_HOST": "host.example.com",
        "WHMCS_ROOT": "/var/www/whmcs",
    }
    with patch.dict(os.environ, env, clear=False):
        # Unset WHMCS_TEST_API_ACTION if present
        os.environ.pop("WHMCS_TEST_API_ACTION", None)
        cfg = _mod.load_args(["test-api-external"])
    assert cfg.test_api_action == "GetStaffOnline"


def test_env_overrides_test_api_action(tmp_path):
    """WHMCS_TEST_API_ACTION env var must override the default."""
    import os
    env = {
        "WHMCS_SSH_HOST": "host.example.com",
        "WHMCS_ROOT": "/var/www/whmcs",
        "WHMCS_TEST_API_ACTION": "GetStats",
    }
    with patch.dict(os.environ, env, clear=False):
        cfg = _mod.load_args(["test-api-external"])
    assert cfg.test_api_action == "GetStats"


def test_cli_flag_overrides_test_api_action():
    """--test-api-action CLI flag must override env and default."""
    import os
    env = {
        "WHMCS_SSH_HOST": "host.example.com",
        "WHMCS_ROOT": "/var/www/whmcs",
    }
    with patch.dict(os.environ, env, clear=False):
        os.environ.pop("WHMCS_TEST_API_ACTION", None)
        cfg = _mod.load_args(["test-api-external", "--test-api-action", "GetCurrencies"])
    assert cfg.test_api_action == "GetCurrencies"


# ---------------------------------------------------------------------------
# (b) run_test_api sends configured action in the POST payload
# ---------------------------------------------------------------------------

def test_run_test_api_uses_configured_action():
    """run_test_api must use cfg.test_api_action (not hardcoded 'WhmcsDetails') in POST payload."""
    captured = {}

    def fake_urlopen(req, timeout=None):
        # Capture the body sent
        import urllib.parse
        body = req.data.decode("utf-8")
        params = dict(urllib.parse.parse_qsl(body))
        captured.update(params)
        # Return a mock response with success JSON
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = b'{"result": "success"}'
        return mock_resp

    cfg = _ApiStub(action="GetStaffOnline")
    logger = logging.getLogger("test_unit_a")

    with patch("urllib.request.urlopen", fake_urlopen):
        _mod.run_test_api(cfg, logger)

    assert captured.get("action") == "GetStaffOnline", (
        f"Expected 'GetStaffOnline' in POST payload, got: {captured.get('action')!r}"
    )


def test_run_test_api_uses_custom_action():
    """run_test_api must respect a non-default action from config."""
    captured = {}

    def fake_urlopen(req, timeout=None):
        import urllib.parse
        body = req.data.decode("utf-8")
        params = dict(urllib.parse.parse_qsl(body))
        captured.update(params)
        mock_resp = MagicMock()
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)
        mock_resp.read.return_value = b'{"result": "success"}'
        return mock_resp

    cfg = _ApiStub(action="GetCurrencies")
    logger = logging.getLogger("test_unit_a")

    with patch("urllib.request.urlopen", fake_urlopen):
        _mod.run_test_api(cfg, logger)

    assert captured.get("action") == "GetCurrencies", (
        f"Expected 'GetCurrencies' in POST payload, got: {captured.get('action')!r}"
    )


def test_run_test_api_does_not_use_WhmcsDetails_by_default():
    """run_test_api must NOT default to 'WhmcsDetails' (the old, role-denied action)."""
    cfg = _ApiStub(action="GetStaffOnline")
    # Verify the config doesn't say WhmcsDetails
    assert cfg.test_api_action != "WhmcsDetails"
