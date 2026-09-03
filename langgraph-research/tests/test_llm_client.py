from unittest.mock import Mock, patch

import requests

from app import llm_client


def _resp(status_code=200, content=None):
    r = Mock()
    r.status_code = status_code
    r.ok = 200 <= status_code < 300
    r.json = Mock(return_value={"choices": [{"message": {"content": content}}]} if content is not None else {})
    return r


def test_chat_success():
    with patch("app.llm_client.requests.post", return_value=_resp(200, "Hello there")):
        text, error = llm_client.chat("prompt")
    assert error is None
    assert text == "Hello there"


def test_chat_timeout_retries_then_fails():
    with patch("app.llm_client.requests.post", side_effect=requests.exceptions.Timeout()) as mock_post, \
         patch("app.llm_client.time.sleep"):
        text, error = llm_client.chat("prompt")
    assert text is None
    assert error == "PROVIDER_TIMEOUT"
    # config.OLLAMA_MAX_RETRIES default is 1 -> 2 total attempts
    assert mock_post.call_count == 2


def test_chat_rate_limited_no_retry():
    with patch("app.llm_client.requests.post", return_value=_resp(429)) as mock_post:
        text, error = llm_client.chat("prompt")
    assert text is None
    assert error == "PROVIDER_RATE_LIMITED"
    assert mock_post.call_count == 1  # non-transient - must not retry


def test_chat_auth_failed():
    with patch("app.llm_client.requests.post", return_value=_resp(401)):
        text, error = llm_client.chat("prompt")
    assert text is None
    assert error == "PROVIDER_AUTH_FAILED"


def test_chat_empty_content_is_error():
    with patch("app.llm_client.requests.post", return_value=_resp(200, "   ")):
        text, error = llm_client.chat("prompt")
    assert text is None
    assert error == "PROVIDER_EMPTY_RESPONSE"


def test_chat_malformed_body():
    r = Mock()
    r.status_code = 200
    r.ok = True
    r.json = Mock(return_value={"unexpected": "shape"})
    with patch("app.llm_client.requests.post", return_value=r):
        text, error = llm_client.chat("prompt")
    assert text is None
    assert error == "PROVIDER_MALFORMED_RESPONSE"


def test_chat_json_parses_fenced_json():
    fenced = '```json\n{"recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.4}\n```'
    with patch("app.llm_client.requests.post", return_value=_resp(200, fenced)):
        parsed, error = llm_client.chat_json("prompt")
    assert error is None
    assert parsed["recommendation"] == "NOT_YET_ELIGIBLE"
    assert parsed["confidence"] == 0.4


def test_chat_json_rejects_non_json_text():
    with patch("app.llm_client.requests.post", return_value=_resp(200, "I cannot answer that.")):
        parsed, error = llm_client.chat_json("prompt")
    assert parsed is None
    assert error == "PROVIDER_MALFORMED_RESPONSE"


def test_chat_json_extracts_prose_wrapped_json():
    prose = 'Sure, here it is:\n{"recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.3}\nHope that helps.'
    with patch("app.llm_client.requests.post", return_value=_resp(200, prose)):
        parsed, error = llm_client.chat_json("prompt")
    assert error is None
    assert parsed["recommendation"] == "NOT_YET_ELIGIBLE"
