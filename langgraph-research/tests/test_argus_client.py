from unittest.mock import Mock, patch

import requests

from app import argus_client


def _resp(status_code=200, json_body=None, raise_json=False):
    r = Mock()
    r.status_code = status_code
    r.ok = 200 <= status_code < 300
    if raise_json:
        r.json = Mock(side_effect=ValueError("not json"))
    else:
        r.json = Mock(return_value=json_body if json_body is not None else {})
    return r


def test_success_returns_body():
    good = {
        "ok": True, "strategyId": "GOLDEN_SMA", "evaluated": True,
        "lifecycleStatus": "UNTESTED", "live": "NO-GO", "failedGates": ["BACKTEST_PASS"],
        "evidence": {"paperTrades": 0},
    }
    with patch("app.argus_client.requests.get", return_value=_resp(200, good)):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert error is None
    assert body["strategyId"] == "GOLDEN_SMA"


def test_unknown_strategy_id_404():
    with patch("app.argus_client.requests.get", return_value=_resp(404)):
        body, error = argus_client.fetch_strategy_evidence("NOT_A_REAL_STRATEGY")
    assert body is None
    assert error == "UNKNOWN_STRATEGY_ID"


def test_other_http_error():
    with patch("app.argus_client.requests.get", return_value=_resp(500)):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error == "ARGUS_HTTP_500"


def test_timeout():
    with patch("app.argus_client.requests.get", side_effect=requests.exceptions.Timeout()):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error == "ARGUS_REQUEST_TIMEOUT"


def test_connection_error():
    with patch("app.argus_client.requests.get", side_effect=requests.exceptions.ConnectionError("refused")):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error is not None and error.startswith("ARGUS_UNREACHABLE")


def test_response_not_json():
    with patch("app.argus_client.requests.get", return_value=_resp(200, raise_json=True)):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error == "ARGUS_RESPONSE_NOT_JSON"


def test_response_missing_ok_true():
    with patch("app.argus_client.requests.get", return_value=_resp(200, {"ok": False})):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error == "ARGUS_RESPONSE_MALFORMED"


def test_response_missing_required_field():
    incomplete = {"ok": True, "strategyId": "GOLDEN_SMA"}  # missing evaluated/lifecycleStatus/etc.
    with patch("app.argus_client.requests.get", return_value=_resp(200, incomplete)):
        body, error = argus_client.fetch_strategy_evidence("GOLDEN_SMA")
    assert body is None
    assert error == "ARGUS_RESPONSE_MISSING_FIELDS"
