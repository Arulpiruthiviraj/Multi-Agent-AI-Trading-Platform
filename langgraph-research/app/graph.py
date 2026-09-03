"""
The real LangGraph StateGraph for the strategy-graduation-recommendation workflow - the ONE use
case selected in Phase 0 (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md's Phase 0 section has the
full reasoning for why this was chosen over the semantic-precedent-search alternative).

Topology:

    fetch_evidence --(ok)--> check_gates --(evaluated)--> assess_risk_factors --(ok)--> synthesize_recommendation --(ok)--> validate_output --(passed)--> finalize_success --> END
         |(fetch failed)                    |(not evaluated)          |(LLM failed)                |(LLM failed)                  |(violations found)
         v                                  v                         v                             v                              v
    finalize_error <------------------- insufficient_evidence -> finalize_success            finalize_error <----------------- finalize_error
         |                                                                                          ^
         +-------------------------------------------------------------------------------------------+ (all finalize_error paths converge)
         v
        END

Every branch above corresponds to a real, distinct outcome this workflow can genuinely reach - not
padding: a brand-new strategy id with zero evidence takes the insufficient_evidence shortcut and
never calls an LLM at all; a real Argus/LLM failure at any stage short-circuits straight to
finalize_error rather than continuing on invalid state; a validated recommendation that failed
Argus's own LIVE=NO-GO invariant check is treated as a validation failure, not silently passed
through.

No checkpointing: a single run completes in one bounded process lifetime (config.MAX_GRAPH_EXECUTION_S)
and is never resumed mid-graph across a restart - LangGraph's MemorySaver (in-process, per-run,
never written to disk) is used only so LangGraph's own machinery has a checkpointer to satisfy its
API, not because this workflow needs cross-restart resumability. See
docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md's persistence section for the full reasoning on
why this is NOT the same thing as the main Node process's own durable trading-database state.
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Dict

from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

from . import config
from .nodes import (
    assess_risk_factors_node,
    check_gates_node,
    fetch_evidence_node,
    finalize_error_node,
    finalize_success_node,
    insufficient_evidence_node,
    route_after_check_gates,
    route_after_fetch,
    route_after_risk_assessment,
    route_after_synthesis,
    route_after_validation,
    synthesize_recommendation_node,
    validate_output_node,
)
from .state import GraphState, new_state


def build_graph():
    graph = StateGraph(GraphState)

    graph.add_node("fetch_evidence", fetch_evidence_node)
    graph.add_node("check_gates", check_gates_node)
    graph.add_node("insufficient_evidence", insufficient_evidence_node)
    graph.add_node("assess_risk_factors", assess_risk_factors_node)
    graph.add_node("synthesize_recommendation", synthesize_recommendation_node)
    graph.add_node("validate_output", validate_output_node)
    graph.add_node("finalize_success", finalize_success_node)
    graph.add_node("finalize_error", finalize_error_node)

    graph.add_edge(START, "fetch_evidence")
    graph.add_conditional_edges("fetch_evidence", route_after_fetch, {"check_gates": "check_gates", "finalize_error": "finalize_error"})
    graph.add_conditional_edges("check_gates", route_after_check_gates, {"insufficient_evidence": "insufficient_evidence", "assess_risk_factors": "assess_risk_factors"})
    graph.add_edge("insufficient_evidence", "finalize_success")
    graph.add_conditional_edges("assess_risk_factors", route_after_risk_assessment, {"synthesize_recommendation": "synthesize_recommendation", "finalize_error": "finalize_error"})
    graph.add_conditional_edges("synthesize_recommendation", route_after_synthesis, {"validate_output": "validate_output", "finalize_error": "finalize_error"})
    graph.add_conditional_edges("validate_output", route_after_validation, {"finalize_success": "finalize_success", "finalize_error": "finalize_error"})
    graph.add_edge("finalize_success", END)
    graph.add_edge("finalize_error", END)

    # In-process-only checkpointer - never written to disk, never the Node process's own trading database. See this
    # file's own header for why cross-restart resumability is not needed for this workflow.
    checkpointer = MemorySaver()
    return graph.compile(checkpointer=checkpointer)


_COMPILED_GRAPH = None


def get_compiled_graph():
    global _COMPILED_GRAPH
    if _COMPILED_GRAPH is None:
        _COMPILED_GRAPH = build_graph()
    return _COMPILED_GRAPH


def run_strategy_graduation_graph(strategy_id: str, correlation_id: str) -> Dict[str, Any]:
    """Runs the graph to completion (bounded by config.MAX_GRAPH_EXECUTION_S at the HTTP-handler
    level, not here - see server.py) and returns the exact JSON-serializable envelope Node expects.
    Never raises - any exception escaping the graph itself is caught and turned into a FAILED
    envelope, matching every node's own internal never-raise contract applied one level up."""
    run_id = str(uuid.uuid4())
    started = time.monotonic()
    state = new_state(strategy_id, correlation_id, run_id, config.GRAPH_VERSION, started)

    try:
        app = get_compiled_graph()
        final_state: GraphState = app.invoke(state, config={"configurable": {"thread_id": run_id}})
    except Exception as e:  # noqa: BLE001 - a graph-level crash must still produce a clean envelope
        duration_ms = (time.monotonic() - started) * 1000
        return {
            "runId": run_id,
            "correlationId": correlation_id,
            "strategyId": strategy_id,
            "graphVersion": config.GRAPH_VERSION,
            "status": "FAILED",
            "result": None,
            "error": f"GRAPH_EXECUTION_ERROR: {e}",
            "durationMs": duration_ms,
            "nodesExecuted": state["metadata"]["nodes_executed"],
            "providerModel": None,
        }

    duration_ms = (time.monotonic() - started) * 1000
    if final_state["error"]["failed"]:
        return {
            "runId": run_id,
            "correlationId": correlation_id,
            "strategyId": strategy_id,
            "graphVersion": config.GRAPH_VERSION,
            "status": "FAILED",
            "result": None,
            "error": final_state["error"]["message"],
            "durationMs": duration_ms,
            "nodesExecuted": final_state["metadata"]["nodes_executed"],
            "providerModel": final_state["reasoning"]["provider_model"],
        }

    rec = final_state["recommendation"]
    assessment = final_state["assessment"]
    return {
        "runId": run_id,
        "correlationId": correlation_id,
        "strategyId": strategy_id,
        "graphVersion": config.GRAPH_VERSION,
        "status": "COMPLETED",
        "result": {
            "lifecycleStatusAtRequest": final_state["evidence"]["lifecycle_status"],
            "live": final_state["evidence"]["live"],
            "failedGatesAtRequest": final_state["evidence"]["failed_gates"],
            "recommendation": rec["recommendation"],
            "confidence": rec["confidence"],
            "rationale": rec["rationale"],
            "limitations": rec["limitations"],
            "evidenceUsed": rec["evidence_used"],
            "counterEvidence": rec["counter_evidence"],
            "missingEvidence": assessment["missing_evidence"],
            "evidenceStrength": assessment["evidence_strength"],
            "evidenceStrengthRationale": assessment["evidence_strength_rationale"],
            "humanReviewRequired": rec["human_review_required"],
            "provenance": {
                "source": "argus_strategy_evidence_endpoint",
                "strategyId": strategy_id,
                "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            "modelGeneratedNarrative": rec["model_generated_narrative"] or "",
        },
        "error": None,
        "durationMs": duration_ms,
        "nodesExecuted": final_state["metadata"]["nodes_executed"],
        "providerModel": final_state["reasoning"]["provider_model"],
    }
