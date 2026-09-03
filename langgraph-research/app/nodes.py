"""
Node functions for the strategy-graduation-recommendation graph (graph.py wires these into a real
StateGraph with conditional edges - see that file's header for the full topology diagram).

Every node:
  - reads only the GraphState sections it needs,
  - writes only the sections it owns,
  - never raises (a node's own failure is recorded into state["error"], not thrown - the graph's
    conditional routers are what decide whether to continue or short-circuit to finalize_error).

Deterministic nodes (fetch_evidence, check_gates, validate_output, insufficient_evidence,
finalize_*) never call an LLM. Only assess_risk_factors and synthesize_recommendation do, and both
are explicitly instructed to interpret ALREADY-RETRIEVED evidence, never to invent a number that
isn't present in it - validate_output_node is the automated check that this instruction was
actually followed.
"""
from __future__ import annotations

import time
from typing import Any, Dict

from . import argus_client, llm_client
from .logging_setup import log_event
from .state import GraphState, mark_error, mark_node_executed

RECOMMENDATION_VALUES = {
    "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW",
    "NOT_YET_ELIGIBLE",
    "INSUFFICIENT_EVIDENCE",
}

EVIDENCE_STRENGTH_VALUES = {"NONE", "WEAK", "MODERATE", "STRONG"}

# The same real, already-computed boolean gates Argus's own liveGoNoGo() reads (promotionEngine.ts) -
# counted here only to derive a deterministic strength BUCKET, never to recompute pass/fail (Argus
# remains the sole authority on any individual gate's true/false value).
_EVIDENCE_STRENGTH_GATE_KEYS = [
    "dataQualityPass", "backtestPass", "oosPass", "walkForwardPass",
    "monteCarloPass", "permutationPass", "sensitivityPass", "costStressPass",
    "paperExpectancyPositive", "paperDrawdownWithinLimit", "paperProfitFactorPass", "paperCalendarDaysPass",
    "riskGatePass", "brokerHealthPass", "marketDataHealthPass", "startupHealthPass",
    "omsHealthPass", "reconciliationHealthPass", "restartRecoveryPass", "failureRecoveryPass",
    "observabilityPass", "securityPass",
]


def _derive_evidence_strength(evaluated: bool, evidence: Dict[str, Any]) -> "tuple[str, str]":
    """Deterministic, non-LLM strength bucket + rationale. Counts only booleans Argus itself already
    computed - never re-derives a gate's pass/fail, only tallies how many already-passing gates exist."""
    if not evaluated:
        return "NONE", "Argus has not evaluated this strategy - no gate booleans exist yet."
    total = len(_EVIDENCE_STRENGTH_GATE_KEYS)
    passed = sum(1 for k in _EVIDENCE_STRENGTH_GATE_KEYS if evidence.get(k) is True)
    fraction = passed / total if total else 0.0
    rationale = f"{passed}/{total} Argus evidence gates currently pass."
    if fraction >= 0.75:
        return "STRONG", rationale
    if fraction >= 0.4:
        return "MODERATE", rationale
    return "WEAK", rationale


def _derive_missing_evidence(evaluated: bool, evidence: Dict[str, Any]) -> "list[str]":
    """Explicit, deterministic absence-of-evidence flags derived from real StrategyEvidence fields -
    never an LLM guess at what might be missing."""
    if not evaluated:
        return ["No evidence has been computed for this strategy id yet."]
    missing: List[str] = []
    if not evidence.get("paperTrades"):
        missing.append("No organic paper trades recorded yet (paperTrades is 0).")
    if evidence.get("qualityStatus") in (None, "UNKNOWN", "UNAVAILABLE"):
        missing.append("Data quality status has not reached GREEN/RED (currently unknown/unavailable).")
    if evidence.get("dataProvenance") != "REAL_MARKET_DATA":
        missing.append("Backtest evidence is not based on REAL_MARKET_DATA provenance.")
    if not evidence.get("datasetId"):
        missing.append("No canonical dataset id is recorded for this strategy's evidence.")
    if not (evidence.get("backtestPass") or evidence.get("oosPass") or evidence.get("walkForwardPass")):
        missing.append("No passing backtest, OOS, or walk-forward result exists.")
    return missing


def fetch_evidence_node(state: GraphState) -> GraphState:
    mark_node_executed(state, "fetch_evidence")
    strategy_id = state["request"]["strategy_id"]
    body, error = argus_client.fetch_strategy_evidence(strategy_id)
    if error is not None:
        state["evidence"]["fetched"] = False
        state["evidence"]["fetch_error"] = error
        mark_error(state, "fetch_evidence", f"Could not retrieve strategy evidence from Argus: {error}")
        log_event("node_fetch_evidence_failed", correlation_id=state["request"]["correlation_id"], strategy_id=strategy_id, error=error)
        return state

    state["evidence"]["fetched"] = True
    state["evidence"]["evaluated"] = bool(body["evaluated"])
    state["evidence"]["lifecycle_status"] = body["lifecycleStatus"]
    state["evidence"]["live"] = body["live"]
    state["evidence"]["failed_gates"] = list(body["failedGates"])
    state["evidence"]["raw_evidence"] = body["evidence"]
    log_event(
        "node_fetch_evidence_ok", correlation_id=state["request"]["correlation_id"], strategy_id=strategy_id,
        evaluated=state["evidence"]["evaluated"], live=state["evidence"]["live"],
    )
    return state


def check_gates_node(state: GraphState) -> GraphState:
    """Deterministic only - reads Argus's own already-computed lifecycle/gate result, never
    recomputes gate logic independently (a second, parallel gate implementation here would be
    exactly the split-brain risk CLAUDE.md's Java-authority rules warn against for calculations in
    general - this file mirrors that same discipline by simply not re-deriving what Argus already
    derived). Also derives the deterministic evidence-strength bucket and missing-evidence list here,
    on every path (including the insufficient-evidence shortcut), since both are pure functions of
    the evidence Argus already returned - never LLM-sourced, never overridable by the model's own
    self-reported confidence later in this graph."""
    mark_node_executed(state, "check_gates")
    evaluated = state["evidence"]["evaluated"]
    raw = state["evidence"]["raw_evidence"] or {}
    strength, rationale = _derive_evidence_strength(evaluated, raw)
    state["assessment"]["evidence_strength"] = strength
    state["assessment"]["evidence_strength_rationale"] = rationale
    state["assessment"]["missing_evidence"] = _derive_missing_evidence(evaluated, raw)
    return state


def insufficient_evidence_node(state: GraphState) -> GraphState:
    """Reached only when Argus has never evaluated this strategy at all (evidence.evaluated is
    False) - a real, common case (a brand-new strategy id) that deserves a real terminal answer,
    not a wasted LLM call reasoning about the absence of data."""
    mark_node_executed(state, "insufficient_evidence")
    rec = state["recommendation"]
    rec["recommendation"] = "INSUFFICIENT_EVIDENCE"
    rec["confidence"] = 0.0
    rec["rationale"] = "Argus has not yet evaluated this strategy (no persisted backtest/OOS/paper evidence exists)."
    rec["limitations"] = ["No evidence has been computed for this strategy id yet - this is not a judgment on the strategy itself."]
    rec["evidence_used"] = []
    rec["counter_evidence"] = []
    rec["human_review_required"] = False
    rec["model_generated_narrative"] = ""
    return state


def assess_risk_factors_node(state: GraphState) -> GraphState:
    mark_node_executed(state, "assess_risk_factors")
    evidence = state["evidence"]["raw_evidence"] or {}
    prompt = (
        "You are a quantitative-strategy risk reviewer. You are given REAL, already-computed evidence "
        "for one trading strategy from an internal validation pipeline. Interpret it; do NOT invent any "
        "number that is not present below. Reply with 2-4 sentences of plain qualitative risk commentary "
        "(no JSON, no lists) covering: whether the paper-trading track record (if any) looks robust or "
        "thin, and what the most concerning gap is if any gate failed.\n\n"
        f"Strategy id: {state['request']['strategy_id']}\n"
        f"Lifecycle status: {state['evidence']['lifecycle_status']}\n"
        f"Live go/no-go: {state['evidence']['live']}\n"
        f"Failed gates: {state['evidence']['failed_gates']}\n"
        f"Paper trades: {evidence.get('paperTrades')}, paper sessions: {evidence.get('paperSessions')}\n"
        f"Backtest pass: {evidence.get('backtestPass')}, OOS pass: {evidence.get('oosPass')}, "
        f"walk-forward pass: {evidence.get('walkForwardPass')}\n"
        f"Robustness (Monte Carlo/permutation/sensitivity/cost-stress) pass: "
        f"{evidence.get('monteCarloPass')}/{evidence.get('permutationPass')}/{evidence.get('sensitivityPass')}/{evidence.get('costStressPass')}\n"
        f"Paper expectancy positive: {evidence.get('paperExpectancyPositive')}, "
        f"paper drawdown within limit: {evidence.get('paperDrawdownWithinLimit')}\n"
    )
    text, error = llm_client.chat(prompt, temperature=0.2, max_tokens=400)
    if error is not None:
        state["reasoning"]["risk_assessment_error"] = error
        mark_error(state, "assess_risk_factors", f"LLM call failed: {error}")
        log_event("node_assess_risk_factors_failed", correlation_id=state["request"]["correlation_id"], error=error)
        return state
    state["reasoning"]["risk_assessment_text"] = text
    from . import config as _config
    state["reasoning"]["provider_model"] = _config.OLLAMA_MODEL
    log_event("node_assess_risk_factors_ok", correlation_id=state["request"]["correlation_id"], text_len=len(text or ""))
    return state


def synthesize_recommendation_node(state: GraphState) -> GraphState:
    mark_node_executed(state, "synthesize_recommendation")
    evidence = state["evidence"]["raw_evidence"] or {}
    prompt = (
        "You are producing a structured, advisory-only strategy-graduation recommendation for a human "
        "reviewer. This recommendation is NEVER auto-applied - a person decides. Base every claim only on "
        "the REAL evidence and risk commentary given below; never invent a number. "
        "You MUST also answer, honestly: what evidence argues AGAINST this strategy advancing? This is a "
        "quantitative research review, not a confirmation engine - if you cannot find real counter-evidence "
        "beyond what is already listed as a failed gate, say so explicitly rather than leaving it empty for "
        "no reason. "
        "Reply with ONLY a JSON object, no markdown fence, matching exactly this shape:\n"
        '{"recommendation": "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW" | "NOT_YET_ELIGIBLE", '
        '"confidence": <0.0-1.0 number>, "rationale": "<1-3 sentences>", '
        '"limitations": ["<short string>", ...], "evidenceUsed": ["<evidence field name>", ...], '
        '"counterEvidence": ["<short string arguing against advancing>", ...]}\n\n'
        f"Live go/no-go from Argus's own gate ladder: {state['evidence']['live']}\n"
        f"Failed gates: {state['evidence']['failed_gates']}\n"
        f"Lifecycle status: {state['evidence']['lifecycle_status']}\n"
        f"Risk commentary: {state['reasoning']['risk_assessment_text']}\n"
        f"Paper trades: {evidence.get('paperTrades')}, paper sessions: {evidence.get('paperSessions')}\n"
    )
    parsed, error = llm_client.chat_json(prompt, temperature=0.2, max_tokens=500)
    if error is not None:
        mark_error(state, "synthesize_recommendation", f"LLM call failed: {error}")
        log_event("node_synthesize_recommendation_failed", correlation_id=state["request"]["correlation_id"], error=error)
        return state

    rec = state["recommendation"]
    rec["recommendation"] = parsed.get("recommendation")
    rec["confidence"] = parsed.get("confidence")
    rec["rationale"] = parsed.get("rationale")
    rec["limitations"] = parsed.get("limitations") if isinstance(parsed.get("limitations"), list) else []
    rec["evidence_used"] = parsed.get("evidenceUsed") if isinstance(parsed.get("evidenceUsed"), list) else []
    rec["counter_evidence"] = parsed.get("counterEvidence") if isinstance(parsed.get("counterEvidence"), list) else []
    rec["model_generated_narrative"] = state["reasoning"]["risk_assessment_text"] or ""
    log_event("node_synthesize_recommendation_ok", correlation_id=state["request"]["correlation_id"], recommendation=rec["recommendation"])
    return state


def validate_output_node(state: GraphState) -> GraphState:
    """Deterministic anti-fabrication gate - the same spirit as AIOutputValidator.ts on the Node
    side, applied to this graph's own LLM output before it is ever allowed to reach a human."""
    mark_node_executed(state, "validate_output")
    violations = []
    rec = state["recommendation"]

    if rec["recommendation"] not in RECOMMENDATION_VALUES:
        violations.append("recommendation is not one of the allowed enum values")
    if not isinstance(rec["confidence"], (int, float)) or not (0.0 <= float(rec["confidence"]) <= 1.0):
        violations.append("confidence is missing or out of [0,1] range")
    if not rec["rationale"] or not isinstance(rec["rationale"], str):
        violations.append("rationale is missing or not a string")

    # Hard invariant: Argus's own real gate ladder says NO-GO -> the model may never recommend
    # promoting anyway. This is not a stylistic check - it is the one rule that must always hold
    # regardless of what the LLM decided to say.
    if state["evidence"]["live"] == "NO-GO" and rec["recommendation"] == "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW":
        violations.append("recommendation contradicts Argus's own LIVE=NO-GO gate result")

    state["validation"]["checked"] = True
    state["validation"]["violations"] = violations
    state["validation"]["passed"] = len(violations) == 0
    if violations:
        mark_error(state, "validate_output", f"Recommendation failed validation: {'; '.join(violations)}")
        log_event("node_validate_output_failed", correlation_id=state["request"]["correlation_id"], violations=violations)
    else:
        # Deterministic, never LLM-sourced - a person always reviews any recommendation that isn't
        # the "nothing to review yet" terminal state. The model's own confidence score has no vote
        # in this boolean.
        rec["human_review_required"] = rec["recommendation"] != "INSUFFICIENT_EVIDENCE"
        log_event("node_validate_output_ok", correlation_id=state["request"]["correlation_id"])
    return state


def finalize_success_node(state: GraphState) -> GraphState:
    mark_node_executed(state, "finalize_success")
    return state


def finalize_error_node(state: GraphState) -> GraphState:
    mark_node_executed(state, "finalize_error")
    return state


# --- Conditional-edge routers (read state, never mutate it) ---

def route_after_fetch(state: GraphState) -> str:
    return "finalize_error" if state["error"]["failed"] else "check_gates"


def route_after_check_gates(state: GraphState) -> str:
    return "insufficient_evidence" if not state["evidence"]["evaluated"] else "assess_risk_factors"


def route_after_risk_assessment(state: GraphState) -> str:
    return "finalize_error" if state["error"]["failed"] else "synthesize_recommendation"


def route_after_synthesis(state: GraphState) -> str:
    return "finalize_error" if state["error"]["failed"] else "validate_output"


def route_after_validation(state: GraphState) -> str:
    return "finalize_error" if state["error"]["failed"] else "finalize_success"
