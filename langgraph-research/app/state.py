"""
Strongly structured LangGraph state for the strategy-graduation-recommendation graph. Deliberately
split into separate sections rather than one flat bag of fields, per
docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md's state-model rule:

    request        - what was asked (immutable once set)
    evidence       - what was actually retrieved from Argus (read-only fact, not interpretation)
    reasoning      - intermediate, LLM-generated interpretation of that evidence
    validation     - the deterministic anti-fabrication check on the LLM's output
    recommendation - the final structured advisory result
    error          - explicit failure state (never silently swallowed into a fabricated success)
    metadata       - correlation/run bookkeeping only, never a place for secrets or free-form data

Nothing here is Argus's source of truth - this state exists only for the lifetime of one graph
run (in-memory, per LANGGRAPH_CHECKPOINTING.md's "no checkpointing needed for a single bounded
run" decision, see graph.py's header) and is never itself persisted; only the final envelope Node
receives and writes into research_agent_runs is durable, and that write happens on the Node side.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, TypedDict


class RequestState(TypedDict):
    strategy_id: str
    correlation_id: str
    run_id: str


class EvidenceState(TypedDict):
    fetched: bool
    evaluated: bool
    lifecycle_status: Optional[str]
    live: Optional[str]  # "GO" | "NO-GO"
    failed_gates: List[str]
    raw_evidence: Optional[Dict[str, Any]]  # the StrategyEvidence dict, exactly as Argus returned it
    fetch_error: Optional[str]


class ReasoningState(TypedDict):
    risk_assessment_text: Optional[str]
    risk_assessment_error: Optional[str]
    provider_model: Optional[str]


class ValidationState(TypedDict):
    checked: bool
    passed: bool
    violations: List[str]


class AssessmentState(TypedDict):
    """Deterministic, non-LLM assessment of the real evidence Argus returned - computed once in
    check_gates_node from raw_evidence/failed_gates, the same real numbers every path already has.
    Kept entirely separate from the LLM's own self-reported confidence (RecommendationState.confidence)
    so a human reviewer can tell "how much real evidence exists" apart from "how confident the model
    felt about its own narrative" - the two are never allowed to collapse into one number."""
    evidence_strength: Optional[str]  # "NONE" | "WEAK" | "MODERATE" | "STRONG"
    evidence_strength_rationale: Optional[str]
    missing_evidence: List[str]


class RecommendationState(TypedDict):
    recommendation: Optional[str]  # RecommendationValue
    confidence: Optional[float]  # model self-reported only - see AssessmentState for deterministic evidence strength
    rationale: Optional[str]
    limitations: List[str]
    evidence_used: List[str]
    counter_evidence: List[str]  # evidence arguing AGAINST advancing - explicitly prompted for, never left implicit
    human_review_required: Optional[bool]  # deterministic, never LLM-sourced - see validate_output_node
    model_generated_narrative: Optional[str]


class ErrorState(TypedDict):
    failed: bool
    message: Optional[str]
    node: Optional[str]


class RunMetadata(TypedDict):
    graph_version: str
    nodes_executed: List[str]
    started_at_monotonic: float


class GraphState(TypedDict):
    request: RequestState
    evidence: EvidenceState
    reasoning: ReasoningState
    validation: ValidationState
    assessment: AssessmentState
    recommendation: RecommendationState
    error: ErrorState
    metadata: RunMetadata


def new_state(strategy_id: str, correlation_id: str, run_id: str, graph_version: str, started_at_monotonic: float) -> GraphState:
    return GraphState(
        request=RequestState(strategy_id=strategy_id, correlation_id=correlation_id, run_id=run_id),
        evidence=EvidenceState(
            fetched=False, evaluated=False, lifecycle_status=None, live=None,
            failed_gates=[], raw_evidence=None, fetch_error=None,
        ),
        reasoning=ReasoningState(risk_assessment_text=None, risk_assessment_error=None, provider_model=None),
        validation=ValidationState(checked=False, passed=False, violations=[]),
        assessment=AssessmentState(evidence_strength=None, evidence_strength_rationale=None, missing_evidence=[]),
        recommendation=RecommendationState(
            recommendation=None, confidence=None, rationale=None,
            limitations=[], evidence_used=[], counter_evidence=[], human_review_required=None,
            model_generated_narrative=None,
        ),
        error=ErrorState(failed=False, message=None, node=None),
        metadata=RunMetadata(graph_version=graph_version, nodes_executed=[], started_at_monotonic=started_at_monotonic),
    )


def mark_node_executed(state: GraphState, node_name: str) -> None:
    state["metadata"]["nodes_executed"].append(node_name)


def mark_error(state: GraphState, node_name: str, message: str) -> None:
    state["error"]["failed"] = True
    state["error"]["message"] = message
    state["error"]["node"] = node_name
