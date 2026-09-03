from unittest.mock import patch

from app.graph import run_strategy_graduation_graph

EVIDENCE_GO = {
    "ok": True, "strategyId": "MOMENTUM_BREAKOUT", "evaluated": True,
    "lifecycleStatus": "LIVE_CANDIDATE", "live": "GO", "failedGates": [],
    "evidence": {"paperTrades": 45, "paperSessions": 12, "backtestPass": True},
}

EVIDENCE_NOGO = {
    "ok": True, "strategyId": "MOMENTUM_BREAKOUT", "evaluated": True,
    "lifecycleStatus": "OOS_TESTING", "live": "NO-GO", "failedGates": ["WALK_FORWARD_PASS", "MIN_PAPER_TRADES"],
    "evidence": {"paperTrades": 3, "paperSessions": 1, "backtestPass": True, "oosPass": True},
}

EVIDENCE_NOT_EVALUATED = {
    "ok": True, "strategyId": "BRAND_NEW", "evaluated": False,
    "lifecycleStatus": "UNTESTED", "live": "NO-GO", "failedGates": ["BACKTEST_PASS"],
    "evidence": {"paperTrades": 0},
}


def _good_recommendation_json(recommendation="NOT_YET_ELIGIBLE", confidence=0.35, counter_evidence=None):
    return (
        {"recommendation": recommendation, "confidence": confidence, "rationale": "Reasoned from evidence.",
         "limitations": ["small sample"], "evidenceUsed": ["paperTrades"],
         "counterEvidence": counter_evidence if counter_evidence is not None else ["Sample size remains thin."]},
        None,
    )


def test_full_success_path_no_go():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_NOGO, None)), \
         patch("app.nodes.llm_client.chat", return_value=("Risk commentary text.", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=_good_recommendation_json("NOT_YET_ELIGIBLE", 0.3)):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-abc")

    assert envelope["status"] == "COMPLETED"
    assert envelope["result"]["recommendation"] == "NOT_YET_ELIGIBLE"
    assert envelope["result"]["live"] == "NO-GO"
    assert envelope["nodesExecuted"] == [
        "fetch_evidence", "check_gates", "assess_risk_factors", "synthesize_recommendation",
        "validate_output", "finalize_success",
    ]
    assert envelope["strategyId"] == "MOMENTUM_BREAKOUT"
    assert envelope["correlationId"] == "corr-abc"
    # Phase 3: deterministic assessment fields never come from the LLM
    assert envelope["result"]["counterEvidence"] == ["Sample size remains thin."]
    assert envelope["result"]["evidenceStrength"] in {"NONE", "WEAK", "MODERATE", "STRONG"}
    assert isinstance(envelope["result"]["evidenceStrengthRationale"], str) and envelope["result"]["evidenceStrengthRationale"]
    assert isinstance(envelope["result"]["missingEvidence"], list)
    assert envelope["result"]["humanReviewRequired"] is True


def test_full_success_path_go():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_GO, None)), \
         patch("app.nodes.llm_client.chat", return_value=("Looks robust across gates.", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=_good_recommendation_json("PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW", 0.65)):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-go")

    assert envelope["status"] == "COMPLETED"
    assert envelope["result"]["recommendation"] == "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW"
    assert envelope["result"]["humanReviewRequired"] is True
    # EVIDENCE_GO only sets a few real booleans True - strength should reflect that honestly, not
    # jump to STRONG just because the recommendation itself is favorable.
    assert envelope["result"]["evidenceStrength"] in {"WEAK", "MODERATE"}


def test_insufficient_evidence_path_skips_llm_entirely():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_NOT_EVALUATED, None)), \
         patch("app.nodes.llm_client.chat") as mock_chat, \
         patch("app.nodes.llm_client.chat_json") as mock_chat_json:
        envelope = run_strategy_graduation_graph("BRAND_NEW", "corr-new")

    mock_chat.assert_not_called()
    mock_chat_json.assert_not_called()
    assert envelope["status"] == "COMPLETED"
    assert envelope["result"]["recommendation"] == "INSUFFICIENT_EVIDENCE"
    assert envelope["nodesExecuted"] == ["fetch_evidence", "check_gates", "insufficient_evidence", "finalize_success"]
    assert envelope["result"]["evidenceStrength"] == "NONE"
    assert envelope["result"]["humanReviewRequired"] is False
    assert envelope["result"]["counterEvidence"] == []


def test_argus_fetch_failure_short_circuits():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(None, "ARGUS_UNREACHABLE: refused")):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-fail")

    assert envelope["status"] == "FAILED"
    assert "ARGUS_UNREACHABLE" in envelope["error"]
    assert envelope["nodesExecuted"] == ["fetch_evidence", "finalize_error"]
    assert envelope["result"] is None


def test_llm_provider_timeout_short_circuits():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_NOGO, None)), \
         patch("app.nodes.llm_client.chat", return_value=(None, "PROVIDER_TIMEOUT")):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-timeout")

    assert envelope["status"] == "FAILED"
    assert "PROVIDER_TIMEOUT" in envelope["error"]
    assert envelope["nodesExecuted"] == ["fetch_evidence", "check_gates", "assess_risk_factors", "finalize_error"]


def test_synthesis_failure_short_circuits():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_NOGO, None)), \
         patch("app.nodes.llm_client.chat", return_value=("commentary", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=(None, "PROVIDER_MALFORMED_RESPONSE")):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-malformed")

    assert envelope["status"] == "FAILED"
    assert "PROVIDER_MALFORMED_RESPONSE" in envelope["error"]


def test_conflicting_evidence_llm_promote_but_gate_says_nogo_is_rejected():
    """The model recommends promotion despite Argus's own gate ladder saying NO-GO - validate_output
    must catch this and the run must fail closed, never silently accept the LLM's more optimistic
    framing over the real evidence."""
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_NOGO, None)), \
         patch("app.nodes.llm_client.chat", return_value=("commentary", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=_good_recommendation_json("PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW", 0.9)):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-conflict")

    assert envelope["status"] == "FAILED"
    assert "NO-GO" in envelope["error"]
    assert envelope["nodesExecuted"][-1] == "finalize_error"


def test_final_state_never_includes_recommendation_on_failure():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(None, "ARGUS_UNREACHABLE: x")):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-x")
    assert envelope["result"] is None
    assert envelope["status"] == "FAILED"


def test_strong_evidence_yields_strong_strength_bucket_and_no_missing_evidence():
    """A strategy with every real gate boolean already True (a realistic LIVE_APPROVED-adjacent
    shape) should be bucketed STRONG deterministically, independent of what the LLM says."""
    from app import nodes as _nodes
    strong_evidence = {k: True for k in _nodes._EVIDENCE_STRENGTH_GATE_KEYS}
    strong_evidence.update({
        "paperTrades": 45, "paperSessions": 12, "qualityStatus": "GREEN",
        "dataProvenance": "REAL_MARKET_DATA", "datasetId": "ds-real-1",
    })
    body = {
        "ok": True, "strategyId": "MOMENTUM_BREAKOUT", "evaluated": True,
        "lifecycleStatus": "LIVE_CANDIDATE", "live": "NO-GO", "failedGates": ["MANUAL_APPROVAL"],
        "evidence": strong_evidence,
    }
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(body, None)), \
         patch("app.nodes.llm_client.chat", return_value=("Robust across every dimension checked.", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=_good_recommendation_json("NOT_YET_ELIGIBLE", 0.4)):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-strong")

    assert envelope["status"] == "COMPLETED"
    assert envelope["result"]["evidenceStrength"] == "STRONG"
    assert envelope["result"]["missingEvidence"] == []


def test_counter_evidence_from_model_is_never_silently_dropped():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(EVIDENCE_GO, None)), \
         patch("app.nodes.llm_client.chat", return_value=("Looks reasonable but thin.", None)), \
         patch("app.nodes.llm_client.chat_json", return_value=_good_recommendation_json(
             "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW", 0.6,
             counter_evidence=["Only 45 paper trades - below a full statistical sample.", "No walk-forward evidence was provided in this request."],
         )):
        envelope = run_strategy_graduation_graph("MOMENTUM_BREAKOUT", "corr-counter")

    assert envelope["result"]["counterEvidence"] == [
        "Only 45 paper trades - below a full statistical sample.",
        "No walk-forward evidence was provided in this request.",
    ]
