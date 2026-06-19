"""Tests for Plan 004 hardening: atomic state write, https guard, secret masking."""
from __future__ import annotations

import importlib.util
import json
import logging
import sys
import tempfile
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Module loader (modeled on the inline verification snippets in the plan)
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
# (a) Atomic state write leaves no .tmp and round-trips JSON
# ---------------------------------------------------------------------------


def test_state_write_atomic_roundtrip(tmp_path):
    """write() must persist data atomically and leave no leftover .tmp file."""
    state_file = tmp_path / "state.json"
    store = _mod.StateStore(state_file)
    data = {"failure_count": 3, "last_ipv4": "203.0.113.1"}

    store.write(data)

    # The final file must exist and contain correct data.
    assert state_file.exists()
    on_disk = json.loads(state_file.read_text())
    assert on_disk["failure_count"] == 3
    assert on_disk["last_ipv4"] == "203.0.113.1"

    # The temp file must have been renamed away.
    tmp_file = state_file.with_suffix(state_file.suffix + ".tmp")
    assert not tmp_file.exists(), "temp file was not cleaned up"


# ---------------------------------------------------------------------------
# (b) run_test_api raises on http:// URL
# ---------------------------------------------------------------------------


class _StubConfig:
    """Minimal stub that satisfies the fields run_test_api reads before the guard."""

    def __init__(self, url):
        self.whmcs_api_url = url
        self.whmcs_api_identifier = "some-identifier"
        self.whmcs_api_secret = "some-secret"
        self.test_api_timeout = 5


def test_run_test_api_rejects_http():
    """run_test_api must raise RuntimeError when the URL uses http://."""
    cfg = _StubConfig("http://whmcs.example.com/api")
    with pytest.raises(RuntimeError, match="https"):
        _mod.run_test_api(cfg, logging.getLogger("test"))


def test_run_test_api_accepts_https_scheme_check():
    """run_test_api must NOT raise the https guard for https:// URLs.

    We do not make a real network call — we expect a different error (network
    or urllib) once the scheme guard passes.
    """
    cfg = _StubConfig("https://whmcs.example.invalid/api")
    try:
        _mod.run_test_api(cfg, logging.getLogger("test"))
    except RuntimeError as exc:
        assert "https" not in str(exc).lower() or "cleartext" not in str(exc), (
            f"https guard fired for a valid https:// URL: {exc}"
        )
    except Exception:
        # Any non-RuntimeError (URLError, socket, etc.) means the guard passed.
        pass


# ---------------------------------------------------------------------------
# (c) repr(AppConfig(...)) contains *** and none of the three secret values
# ---------------------------------------------------------------------------


def test_appconfig_repr_masks_secrets():
    """AppConfig.__repr__ must redact ssh_key, whmcs_api_identifier, whmcs_api_secret."""
    import inspect

    fields = list(inspect.signature(_mod.AppConfig).parameters.keys())
    # Pass "SECRETVALUE" for every field; dataclass construction will succeed
    # because Python 3.9 accepts string for any type annotation at runtime.
    kwargs = {f: "SECRETVALUE" for f in fields}
    cfg = _mod.AppConfig(**kwargs)
    r = repr(cfg)

    assert "***" in r, "repr should contain masked fields (***)"

    for field_name in ("ssh_key", "whmcs_api_identifier", "whmcs_api_secret"):
        assert f"{field_name}='SECRETVALUE'" not in r, (
            f"Secret field {field_name!r} leaked its value in repr"
        )
        assert f'{field_name}="SECRETVALUE"' not in r, (
            f"Secret field {field_name!r} leaked its value in repr"
        )
