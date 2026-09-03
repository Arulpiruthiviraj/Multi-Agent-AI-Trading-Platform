"""
Static architecture-boundary check for this whole service directory - the Python-side half of the
same safety boundary langGraphArchitectureBoundary.test.ts enforces on the Node side. Fails if any
file under langgraph-research/app/ ever mentions a broker/order/risk symbol, a broker credential
env var, or the real trading database path.
"""
import re
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent / "app"

FORBIDDEN_PATTERNS = [
    r"\bRiskEngine\b",
    r"\bOrderManagement\b",
    r"\bBrokerManager\b",
    r"\bChiefTraderAgent\b",
    r"\bplaceOrder\b",
    r"\bplace_order\b",
    r"argus\.db",
    r"ALPACA_API_KEY",
    r"ALPACA_SECRET_KEY",
    r"IBKR_",
    r"\bsqlite3\.connect\b",
]


def test_no_forbidden_symbols_anywhere_in_app():
    violations = []
    for path in APP_DIR.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_PATTERNS:
            if re.search(pattern, text):
                violations.append(f"{path.relative_to(APP_DIR.parent)}: matched forbidden pattern {pattern!r}")
    assert not violations, "Safety boundary violated:\n" + "\n".join(violations)


def test_only_two_http_endpoints_are_registered():
    server_text = (APP_DIR / "server.py").read_text(encoding="utf-8")
    # do_GET/do_POST each check self.path against exactly the documented routes - a crude but
    # effective guard against someone quietly adding a third endpoint (e.g. a generic /query or
    # /exec) without updating this test.
    assert '"/health"' in server_text
    assert '"/v1/strategy-graduation-recommendation"' in server_text
    get_paths = re.findall(r'self\.path (?:==|!=) "(/[a-zA-Z0-9/_-]+)"', server_text)
    assert set(get_paths) == {"/health", "/v1/strategy-graduation-recommendation"}


def test_argus_client_only_calls_the_one_documented_route():
    text = (APP_DIR / "argus_client.py").read_text(encoding="utf-8")
    assert "/api/v2/research/strategy-evidence/" in text
    # No other /api/ path should appear in this file - it must never grow into a general client.
    api_paths = re.findall(r"/api/v\d[a-zA-Z0-9/_-]*", text)
    assert set(api_paths) == {"/api/v2/research/strategy-evidence/"}
