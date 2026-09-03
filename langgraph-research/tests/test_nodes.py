from unittest.mock import patch

from app import nodes
from app.state import new_state


def _state():
    return new_state("GOLDEN_SMA", "corr-1", "run-1", "test-v1", 0.0)


def test_fetch_evidence_node_success():
    good_body = {
        "ok": True, "strategyId": "GOLDEN_SMA", "evaluated": True,
        "lifecycleStatus": "UNTESTED", "live": "NO-GO", "failedGates": ["BACKTEST_PASS"],
        "evidence": {"paperTrades": 0},
    }
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(good_body, None)):
        s = nodes.fetch_evidence_node(_state())
    assert s["evidence"]["fetched"] is True
    assert s["evidence"]["evaluated"] is True
    assert s["evidence"]["live"] == "NO-GO"
    assert s["error"]["failed"] is False
    assert "fetch_evidence" in s["metadata"]["nodes_executed"]


def test_fetch_evidence_node_failure_sets_error_state():
    with patch("app.nodes.argus_client.fetch_strategy_evidence", return_value=(None, "ARGUS_UNREACHABLE: refused")):
        s = nodes.fetch_evidence_node(_state())
    assert s["evidence"]["fetched"] is False
    assert s["error"]["failed"] is True
    assert s["error"]["node"] == "fetch_evidence"


def test_check_gates_node_never_mutates_evidence_itself():
    s = _state()
    before = dict(s["evidence"])
    s = nodes.check_gates_node(s)
    assert s["evidence"] == before


def test_check_gates_node_derives_none_strength_when_not_evaluated():
    s = _state()
    s["evidence"]["evaluated"] = False
    s["evidence"]["raw_evidence"] = None
    s = nodes.check_gates_node(s)
    assert s["assessment"]["evidence_strength"] == "NONE"
    assert s["assessment"]["missing_evidence"] != []


def test_check_gates_node_derives_strong_evidence_strength_from_real_gate_booleans():
    s = _state()
    s["evidence"]["evaluated"] = True
    s["evidence"]["raw_evidence"] = {k: True for k in nodes._EVIDENCE_STRENGTH_GATE_KEYS}
    s["evidence"]["raw_evidence"]["paperTrades"] = 45
    s["evidence"]["raw_evidence"]["qualityStatus"] = "GREEN"
    s["evidence"]["raw_evidence"]["dataProvenance"] = "REAL_MARKET_DATA"
    s["evidence"]["raw_evidence"]["datasetId"] = "ds-1"
    s = nodes.check_gates_node(s)
    assert s["assessment"]["evidence_strength"] == "STRONG"
    assert s["assessment"]["missing_evidence"] == []


def test_check_gates_node_derives_weak_evidence_strength_when_nothing_passes():
    s = _state()
    s["evidence"]["evaluated"] = True
    s["evidence"]["raw_evidence"] = {}
    s = nodes.check_gates_node(s)
    assert s["assessment"]["evidence_strength"] == "WEAK"
    # Real absence-of-evidence flags, not fabricated ones
    assert any("paper trades" in m.lower() for m in s["assessment"]["missing_evidence"])


def test_insufficient_evidence_node_never_calls_llm():
    s = _state()
    s["evidence"]["evaluated"] = False
    with patch("app.nodes.llm_client.chat") as mock_chat:
        s = nodes.insufficient_evidence_node(s)
    mock_chat.assert_not_called()
    assert s["recommendation"]["recommendation"] == "INSUFFICIENT_EVIDENCE"
    assert s["recommendation"]["confidence"] == 0.0
    assert s["recommendation"]["counter_evidence"] == []
    assert s["recommendation"]["human_review_required"] is False


def test_assess_risk_factors_node_success():
    s = _state()
    s["evidence"]["raw_evidence"] = {"paperTrades": 12}
    with patch("app.nodes.llm_client.chat", return_value=("Thin sample, moderate risk.", None)):
        s = nodes.assess_risk_factors_node(s)
    assert s["reasoning"]["risk_assessment_text"] == "Thin sample, moderate risk."
    assert s["error"]["failed"] is False


def test_assess_risk_factors_node_llm_failure():
    s = _state()
    s["evidence"]["raw_evidence"] = {}
    with patch("app.nodes.llm_client.chat", return_value=(None, "PROVIDER_TIMEOUT")):
        s = nodes.assess_risk_factors_node(s)
    assert s["error"]["failed"] is True
    assert s["reasoning"]["risk_assessment_error"] == "PROVIDER_TIMEOUT"


def test_synthesize_recommendation_node_success():
    s = _state()
    s["evidence"]["raw_evidence"] = {}
    s["evidence"]["live"] = "GO"
    s["evidence"]["failed_gates"] = []
    parsed = {
        "recommendation": "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW", "confidence": 0.7,
        "rationale": "All gates pass.", "limitations": ["small sample"], "evidenceUsed": ["backtestPass"],
        "counterEvidence": ["Sample size is still small relative to a full market cycle."],
    }
    with patch("app.nodes.llm_client.chat_json", return_value=(parsed, None)):
        s = nodes.synthesize_recommendation_node(s)
    assert s["recommendation"]["recommendation"] == "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW"
    assert s["recommendation"]["confidence"] == 0.7
    assert s["recommendation"]["counter_evidence"] == ["Sample size is still small relative to a full market cycle."]


def test_synthesize_recommendation_node_coerces_missing_counter_evidence_to_empty_list():
    """A model response that omits counterEvidence entirely must not fail the run - it's coerced to
    an empty list like limitations/evidenceUsed already are, never fabricated."""
    s = _state()
    s["evidence"]["raw_evidence"] = {}
    parsed = {"recommendation": "NOT_YET_ELIGIBLE", "confidence": 0.3, "rationale": "x"}
    with patch("app.nodes.llm_client.chat_json", return_value=(parsed, None)):
        s = nodes.synthesize_recommendation_node(s)
    assert s["recommendation"]["counter_evidence"] == []


def test_synthesize_recommendation_node_llm_failure():
    s = _state()
    s["evidence"]["raw_evidence"] = {}
    with patch("app.nodes.llm_client.chat_json", return_value=(None, "PROVIDER_MALFORMED_RESPONSE")):
        s = nodes.synthesize_recommendation_node(s)
    assert s["error"]["failed"] is True


def test_validate_output_node_passes_good_recommendation():
    s = _state()
    s["evidence"]["live"] = "GO"
    s["recommendation"]["recommendation"] = "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW"
    s["recommendation"]["confidence"] = 0.6
    s["recommendation"]["rationale"] = "Looks solid."
    s = nodes.validate_output_node(s)
    assert s["validation"]["passed"] is True
    assert s["error"]["failed"] is False
    assert s["recommendation"]["human_review_required"] is True


def test_validate_output_node_sets_human_review_false_only_for_insufficient_evidence():
    s = _state()
    s["evidence"]["live"] = "NO-GO"
    s["recommendation"]["recommendation"] = "INSUFFICIENT_EVIDENCE"
    s["recommendation"]["confidence"] = 0.0
    s["recommendation"]["rationale"] = "No evidence yet."
    s = nodes.validate_output_node(s)
    assert s["validation"]["passed"] is True
    assert s["recommendation"]["human_review_required"] is False


def test_validate_output_node_does_not_set_human_review_when_validation_fails():
    """A failed validation short-circuits to finalize_error - human_review_required must stay
    unset (None) rather than being computed from a recommendation the run is about to discard."""
    s = _state()
    s["evidence"]["live"] = "NO-GO"
    s["recommendation"]["recommendation"] = "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW"
    s["recommendation"]["confidence"] = 0.9
    s["recommendation"]["rationale"] = "x"
    s = nodes.validate_output_node(s)
    assert s["validation"]["passed"] is False
    assert s["recommendation"]["human_review_required"] is None


def test_validate_output_node_rejects_confidence_out_of_range():
    s = _state()
    s["evidence"]["live"] = "NO-GO"
    s["recommendation"]["recommendation"] = "NOT_YET_ELIGIBLE"
    s["recommendation"]["confidence"] = 1.7
    s["recommendation"]["rationale"] = "x"
    s = nodes.validate_output_node(s)
    assert s["validation"]["passed"] is False
    assert s["error"]["failed"] is True


def test_validate_output_node_rejects_promote_when_live_is_nogo():
    """The one hard invariant: a model may never recommend promotion when Argus's own gate ladder
    says NO-GO, no matter how confident the LLM sounds - this is the anti-fabrication check that
    matters most for this workflow."""
    s = _state()
    s["evidence"]["live"] = "NO-GO"
    s["recommendation"]["recommendation"] = "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW"
    s["recommendation"]["confidence"] = 0.9
    s["recommendation"]["rationale"] = "Looks great!"
    s = nodes.validate_output_node(s)
    assert s["validation"]["passed"] is False
    assert any("NO-GO" in v for v in s["validation"]["violations"])


def test_routers():
    ok_state = _state()
    assert nodes.route_after_fetch(ok_state) == "check_gates"
    ok_state["error"]["failed"] = True
    assert nodes.route_after_fetch(ok_state) == "finalize_error"

    gate_state = _state()
    gate_state["evidence"]["evaluated"] = False
    assert nodes.route_after_check_gates(gate_state) == "insufficient_evidence"
    gate_state["evidence"]["evaluated"] = True
    assert nodes.route_after_check_gates(gate_state) == "assess_risk_factors"

    risk_state = _state()
    assert nodes.route_after_risk_assessment(risk_state) == "synthesize_recommendation"
    risk_state["error"]["failed"] = True
    assert nodes.route_after_risk_assessment(risk_state) == "finalize_error"

    synth_state = _state()
    assert nodes.route_after_synthesis(synth_state) == "validate_output"
    synth_state["error"]["failed"] = True
    assert nodes.route_after_synthesis(synth_state) == "finalize_error"

    val_state = _state()
    assert nodes.route_after_validation(val_state) == "finalize_success"
    val_state["error"]["failed"] = True
    assert nodes.route_after_validation(val_state) == "finalize_error"
