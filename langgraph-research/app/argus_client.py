"""
The ONLY way this service reads Argus data: one narrow, read-only HTTP GET against Argus's own
GET /api/v2/research/strategy-evidence/:strategyId route
(src/server/routes/researchRoutes.ts). No SQLite access, no broad "database query" endpoint, no
credential of any kind - this call needs none, the route is unauthenticated-by-design for a
loopback-only advisory reader (same threat model as quant-core-java's own advisory HTTP server:
127.0.0.1 only, nothing sensitive reachable off this host).

Never invents evidence. A non-200 response, a connection failure, or a response that doesn't match
the expected shape all surface as an explicit fetch_error - the graph's fetch_evidence node treats
that as a real, distinct failure state, never a substitute value.
"""
from __future__ import annotations

from typing import Any, Dict, Optional, Tuple

import requests

from . import config


def fetch_strategy_evidence(strategy_id: str) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Returns (evidence_dict, None) on success, or (None, error_message) on any failure. Never raises."""
    url = f"{config.ARGUS_BASE_URL}/api/v2/research/strategy-evidence/{requests.utils.quote(strategy_id, safe='')}"
    try:
        res = requests.get(url, timeout=config.ARGUS_REQUEST_TIMEOUT_S)
    except requests.exceptions.Timeout:
        return None, "ARGUS_REQUEST_TIMEOUT"
    except requests.exceptions.RequestException as e:
        return None, f"ARGUS_UNREACHABLE: {e}"

    if res.status_code == 404:
        return None, "UNKNOWN_STRATEGY_ID"
    if not res.ok:
        return None, f"ARGUS_HTTP_{res.status_code}"

    try:
        body = res.json()
    except ValueError:
        return None, "ARGUS_RESPONSE_NOT_JSON"

    if not isinstance(body, dict) or body.get("ok") is not True:
        return None, "ARGUS_RESPONSE_MALFORMED"

    required = ("strategyId", "evaluated", "lifecycleStatus", "live", "failedGates", "evidence")
    if any(k not in body for k in required):
        return None, "ARGUS_RESPONSE_MISSING_FIELDS"

    return body, None
