import importlib.util
import pathlib
import sys

import pytest

_SRC = pathlib.Path(__file__).resolve().parents[1] / "whmcs_ip_updater.py"
_spec = importlib.util.spec_from_file_location("whmcs_ip_updater", _SRC)
mod = importlib.util.module_from_spec(_spec)
# Register in sys.modules before exec so that dataclass forward-references
# resolve correctly on Python 3.9 (Python 3.12 does not need this, but it is
# harmless there too).
sys.modules["whmcs_ip_updater"] = mod
_spec.loader.exec_module(mod)


@pytest.mark.parametrize("value,version,expected", [
    ("117.217.28.213", 4, "117.217.28.213"),   # valid global IPv4
    (" 117.217.28.213 ", 4, "117.217.28.213"), # trimmed
    ("10.0.0.1", 4, None),                       # private → rejected
    ("127.0.0.1", 4, None),                      # loopback → rejected
    ("::1", 6, None),                            # loopback v6 → rejected
    ("117.217.28.213", 6, None),                 # v4 given, v6 requested
    ("not-an-ip", 4, None),
    ("", 4, None),
])
def test_parse_ip(value, version, expected):
    assert mod.parse_ip(value, version) == expected
