"""
HTTP contract tests against a real (ephemeral, loopback, random-port) instance of this service's
own ThreadingHTTPServer - not a mock of the transport layer, only of the graph/LLM/Argus calls
underneath it, so these tests exercise the actual wire format Node's LangGraphResearchService.ts
client depends on.
"""
import json
import threading
import time
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import pytest

from app.server import Handler

EVIDENCE_NOGO = {
    "ok": True, "strategyId": "MOMENTUM_BREAKOUT", "evaluated": True,
    "lifecycleStatus": "OOS_TESTING", "live": "NO-GO", "failedGates": ["MIN_PAPER_TRADES"],
    "evidence": {"paperTrades": 3},
}


@pytest.fixture()
def server():
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    httpd.daemon_threads = True
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    port = httpd.server_address[1]
    yield port
    httpd.shutdown()
    thread.join(timeout=5)


def _request(port, method, path, body=None, headers=None):
    conn = HTTPConnection("127.0.0.1", port, timeout=10)
    payload = json.dumps(body).encode() if body is not None else None
    conn.request(method, path, body=payload, headers=headers or {"Content-Type": "application/json"})
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    return res.status, raw


def test_health_endpoint(server):
    status, raw = _request(server, "GET", "/health")
    assert status == 200
    body = json.loads(raw)
    assert body["status"] == "ok"
    assert body["service"] == "langgraph-research"


def test_unknown_get_path_404(server):
    status, _ = _request(server, "GET", "/nope")
    assert status == 404


def test_valid_request_valid_response(server):
    with patch("app.server.run_strategy_graduation_graph") as mock_run:
        mock_run.return_value = {
            "runId": "r1", "correlationId": "corr-1", "strategyId": "MOMENTUM_BREAKOUT",
            "graphVersion": "test-v1", "status": "COMPLETED",
            "result": {
                "lifecycleStatusAtRequest": "OOS_TESTING", "live": "NO-GO", "failedGatesAtRequest": ["MIN_PAPER_TRADES"],
                "recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.3, "rationale": "x",
                "limitations": [], "evidenceUsed": [], "counterEvidence": [], "missingEvidence": [],
                "evidenceStrength": "WEAK", "evidenceStrengthRationale": "1/22 Argus evidence gates currently pass.",
                "humanReviewRequired": True,
                "provenance": {"source": "argus_strategy_evidence_endpoint", "strategyId": "MOMENTUM_BREAKOUT", "fetchedAt": "2026-01-01T00:00:00Z"},
                "modelGeneratedNarrative": "y",
            },
            "error": None, "durationMs": 12.3, "nodesExecuted": ["fetch_evidence"], "providerModel": "llama3.2:latest",
        }
        status, raw = _request(server, "POST", "/v1/strategy-graduation-recommendation", {"strategyId": "MOMENTUM_BREAKOUT", "correlationId": "corr-1"})
    assert status == 200
    body = json.loads(raw)
    assert body["status"] == "COMPLETED"
    assert body["result"]["recommendation"] == "NOT_YET_ELIGIBLE"
    assert body["correlationId"] == "corr-1"  # correlation id propagated through


def test_invalid_request_missing_field(server):
    status, raw = _request(server, "POST", "/v1/strategy-graduation-recommendation", {"strategyId": "X"})  # missing correlationId
    assert status == 400
    body = json.loads(raw)
    assert body["error"] == "INVALID_REQUEST"


def test_malformed_json_body(server):
    conn = HTTPConnection("127.0.0.1", server, timeout=10)
    conn.request("POST", "/v1/strategy-graduation-recommendation", body=b"{not json", headers={"Content-Type": "application/json"})
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    assert res.status == 400
    assert json.loads(raw)["error"] == "MALFORMED_JSON"


def test_oversized_payload_rejected(server):
    conn = HTTPConnection("127.0.0.1", server, timeout=10)
    big_body = json.dumps({"strategyId": "X" * 20000, "correlationId": "c"}).encode()
    conn.request("POST", "/v1/strategy-graduation-recommendation", body=big_body, headers={"Content-Type": "application/json"})
    res = conn.getresponse()
    raw = res.read()
    conn.close()
    assert res.status == 413
    assert json.loads(raw)["error"] == "PAYLOAD_TOO_LARGE"


def test_unknown_post_path_404(server):
    status, _ = _request(server, "POST", "/v1/does-not-exist", {"a": 1})
    assert status == 404


def test_graph_timeout_returns_clean_failed_envelope(server):
    """Simulates a graph run that never returns within the bounded execution window - the HTTP
    response must still come back promptly with a FAILED envelope, never hang."""
    def _never_returns(strategy_id, correlation_id):
        time.sleep(999)
        return {}

    with patch("app.server.config.MAX_GRAPH_EXECUTION_S", 0.2), \
         patch("app.server.run_strategy_graduation_graph", side_effect=_never_returns):
        status, raw = _request(server, "POST", "/v1/strategy-graduation-recommendation", {"strategyId": "X", "correlationId": "corr-timeout"})
    assert status == 200  # the HTTP layer itself succeeds - the envelope reports the failure
    body = json.loads(raw)
    assert body["status"] == "FAILED"
    assert body["error"] == "GRAPH_EXECUTION_TIMEOUT"
    assert body["correlationId"] == "corr-timeout"


def test_concurrent_independent_requests_do_not_cross_contaminate(server):
    """Two simultaneous requests for two different strategies must each get back their own
    strategyId/correlationId, never the other's."""
    results = {}

    def _echo(strategy_id, correlation_id):
        time.sleep(0.05)
        return {
            "runId": f"run-{strategy_id}", "correlationId": correlation_id, "strategyId": strategy_id,
            "graphVersion": "test-v1", "status": "COMPLETED", "result": None, "error": None,
            "durationMs": 1.0, "nodesExecuted": [], "providerModel": None,
        }

    def _call(strategy_id, correlation_id):
        status, raw = _request(server, "POST", "/v1/strategy-graduation-recommendation", {"strategyId": strategy_id, "correlationId": correlation_id})
        results[strategy_id] = (status, json.loads(raw))

    with patch("app.server.run_strategy_graduation_graph", side_effect=_echo):
        t1 = threading.Thread(target=_call, args=("STRAT_A", "corr-a"))
        t2 = threading.Thread(target=_call, args=("STRAT_B", "corr-b"))
        t1.start(); t2.start()
        t1.join(timeout=5); t2.join(timeout=5)

    assert results["STRAT_A"][1]["strategyId"] == "STRAT_A"
    assert results["STRAT_A"][1]["correlationId"] == "corr-a"
    assert results["STRAT_B"][1]["strategyId"] == "STRAT_B"
    assert results["STRAT_B"][1]["correlationId"] == "corr-b"
