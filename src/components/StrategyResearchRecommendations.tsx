/**
 * ==========================================================
 * StrategyResearchRecommendations.tsx
 *
 * Phase 3 (docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md): read-only human-review surface for
 * LangGraph strategy-graduation recommendations. This panel is intentionally NOT a control panel -
 * there is no promote/enable/live-trading/risk-override/order button anywhere in this file. The one
 * write action it performs (POST .../strategy-graduation/:id) only ever triggers a new advisory
 * research run - identical in effect to the existing `argus-cli research-recommend` CLI command,
 * never a trading action. Every recommendation rendered here is explicitly labeled a RESEARCH
 * RECOMMENDATION, not a trading approval - both in this component's own JSX and already in the API
 * payload itself (disposition/notATradingApproval), so the two never drift apart.
 * ==========================================================
 */
import React, { useEffect, useState, useCallback } from "react";
import AwaitingSignal from "./shared/AwaitingSignal";

interface StrategyGraduationResult {
  lifecycleStatusAtRequest: string;
  live: "GO" | "NO-GO";
  failedGatesAtRequest: string[];
  recommendation: "PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW" | "NOT_YET_ELIGIBLE" | "INSUFFICIENT_EVIDENCE";
  confidence: number;
  rationale: string;
  limitations: string[];
  evidenceUsed: string[];
  counterEvidence: string[];
  missingEvidence: string[];
  evidenceStrength: "NONE" | "WEAK" | "MODERATE" | "STRONG";
  evidenceStrengthRationale: string;
  humanReviewRequired: boolean;
  provenance: { source: string; strategyId: string; fetchedAt: string };
  modelGeneratedNarrative: string;
}

interface RecommendationView {
  disposition: "RESEARCH_RECOMMENDATION";
  notATradingApproval: true;
  recommendationId: string;
  correlationId: string;
  strategyId: string | null;
  status: "PENDING" | "COMPLETED" | "FAILED" | "UNAVAILABLE";
  failureReason: string | null;
  graphVersion: string | null;
  providerModel: string | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  result: StrategyGraduationResult | null;
  stale: boolean | null;
  evidenceAgeMs: number | null;
}

const RECOMMENDATION_LABEL: Record<string, string> = {
  PROMOTE_ELIGIBLE_FOR_HUMAN_REVIEW: "READY FOR HUMAN REVIEW",
  NOT_YET_ELIGIBLE: "NOT YET ELIGIBLE",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT EVIDENCE",
};

const STRENGTH_COLOR: Record<string, string> = {
  NONE: "text-slate-500",
  WEAK: "text-rose-400",
  MODERATE: "text-amber-400",
  STRONG: "text-emerald-400",
};

function formatAge(ms: number | null): string {
  if (ms == null) return "unknown";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function StrategyResearchRecommendations() {
  const [strategyIds, setStrategyIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [recommendations, setRecommendations] = useState<RecommendationView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestNote, setRequestNote] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/v2/research/strategies")
      .then((r) => r.json())
      .then((body) => {
        const ids = [
          ...(body?.core ?? []).map((s: any) => s.strategyId),
          ...(body?.experimental ?? []).map((s: any) => s.strategyId),
          "GOLDEN_SMA",
        ];
        setStrategyIds(ids);
        if (ids.length > 0) setSelected(ids[0]);
      })
      .catch((e) => setError(e.message));
  }, []);

  const loadRecommendations = useCallback((strategyId: string) => {
    if (!strategyId) return;
    setError(null);
    fetch(`/api/v2/research/strategy-recommendations?strategyId=${encodeURIComponent(strategyId)}`)
      .then((r) => r.json())
      .then((body) => {
        if (body?.ok) setRecommendations(body.recommendations ?? []);
        else setError(body?.error || "Failed to load recommendations.");
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (selected) loadRecommendations(selected);
  }, [selected, loadRecommendations]);

  const requestNewRecommendation = () => {
    if (!selected || requesting) return;
    const strategyId = selected;
    setRequesting(true);
    setRequestNote(null);
    fetch(`/api/v2/research/strategy-graduation/${encodeURIComponent(strategyId)}`, { method: "POST" })
      .then((r) => r.json())
      .then((body) => {
        // A real LLM-backed run commonly takes 11-16s - the HTTP response can race the server's
        // own request-timeout watchdog and come back as a plain error body even though the run
        // itself completes and persists correctly a few seconds later (see
        // docs/architecture/LANGGRAPH_RESEARCH_SERVICE.md's known limitations). The delayed
        // re-fetches below pick up that real completion without requiring a manual refresh.
        setRequestNote(
          body?.status === "COMPLETED"
            ? "New research run completed."
            : body?.status
              ? `Research run finished with status: ${body.status}.`
              : "Run submitted - refreshing shortly to pick up the result once it completes."
        );
        loadRecommendations(strategyId);
      })
      .catch((e) => setRequestNote(`Request failed: ${e.message}`))
      .finally(() => {
        setRequesting(false);
        [5000, 12000, 20000].forEach((delayMs) => {
          setTimeout(() => loadRecommendations(strategyId), delayMs);
        });
      });
  };

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Strategy Research Recommendations</h3>
        <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest border border-amber-900/60 rounded px-2 py-0.5">
          Research Recommendation — Not A Trading Approval
        </span>
      </div>
      <p className="text-[11px] text-slate-400 mb-4">
        Advisory-only output from the isolated LangGraph research service. A recommendation here never promotes,
        enables, or trades a strategy — a human decides. Every claim is grounded in Argus's own already-computed
        evidence; the model's self-reported confidence is shown separately from deterministic evidence strength.
      </p>

      <div className="flex items-center gap-3 mb-4">
        <select
          className="bg-[#0F1420] border border-slate-800 rounded px-2 py-1 text-[11px] font-mono text-slate-200"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {strategyIds.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
        </select>
        <button
          onClick={requestNewRecommendation}
          disabled={requesting || !selected}
          className="text-[10px] font-mono uppercase tracking-widest border border-slate-700 rounded px-3 py-1 text-slate-200 hover:border-slate-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {requesting ? "Running…" : "Request New Recommendation"}
        </button>
        {requestNote && <span className="text-[10px] font-mono text-slate-500">{requestNote}</span>}
      </div>

      {error && <AwaitingSignal label="Strategy Research Recommendations" reason={`Failed: ${error}`} />}
      {!error && recommendations === null && (
        <AwaitingSignal compact reason="Loading recommendation history." />
      )}
      {!error && recommendations !== null && recommendations.length === 0 && (
        <AwaitingSignal compact emptyResult reason="No recommendation runs recorded yet for this strategy." />
      )}

      {!error && recommendations && recommendations.length > 0 && (
        <div className="flex flex-col gap-3">
          {recommendations.map((rec) => (
            <div key={rec.recommendationId} className="border border-slate-800 rounded p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <span className="text-[10px] font-mono text-slate-500">
                  {new Date(rec.createdAt).toLocaleString()} · run {rec.recommendationId.slice(0, 8)}
                </span>
                <div className="flex items-center gap-2">
                  {rec.stale && (
                    <span className="text-[10px] font-mono text-amber-400 uppercase border border-amber-900/60 rounded px-1.5 py-0.5">
                      Stale evidence ({formatAge(rec.evidenceAgeMs)})
                    </span>
                  )}
                  <span className="text-[10px] font-mono uppercase text-rose-400">LIVE {rec.result?.live ?? "NO-GO"}</span>
                </div>
              </div>

              {rec.status !== "COMPLETED" ? (
                <AwaitingSignal
                  compact
                  reason={`${rec.status}${rec.failureReason ? ` — ${rec.failureReason}` : ""}`}
                />
              ) : rec.result ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Recommendation</div>
                    <div className="text-slate-200 font-mono">{RECOMMENDATION_LABEL[rec.result.recommendation] ?? rec.result.recommendation}</div>
                    <div className="text-slate-500 text-[10px] mt-1">{rec.result.rationale}</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Lifecycle at request</div>
                    <div className="text-slate-200 font-mono">{rec.result.lifecycleStatusAtRequest}</div>
                    {rec.result.failedGatesAtRequest.length > 0 && (
                      <div className="text-slate-500 text-[10px] mt-1">Failed gates: {rec.result.failedGatesAtRequest.join(", ")}</div>
                    )}
                  </div>

                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Model confidence (self-reported)</div>
                    <div className="text-slate-200 font-mono">{Math.round(rec.result.confidence * 100)}%</div>
                    <div className="text-slate-600 text-[10px] mt-1">Not a statistical confidence. Not a validated win rate.</div>
                  </div>
                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Evidence strength (deterministic)</div>
                    <div className={`font-mono ${STRENGTH_COLOR[rec.result.evidenceStrength] ?? "text-slate-200"}`}>{rec.result.evidenceStrength}</div>
                    <div className="text-slate-600 text-[10px] mt-1">{rec.result.evidenceStrengthRationale}</div>
                  </div>

                  {rec.result.evidenceUsed.length > 0 && (
                    <div>
                      <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Supporting evidence</div>
                      <ul className="list-disc list-inside text-slate-300 text-[10px] space-y-0.5">
                        {rec.result.evidenceUsed.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                  <div>
                    <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Counter-evidence</div>
                    {rec.result.counterEvidence.length > 0 ? (
                      <ul className="list-disc list-inside text-rose-300 text-[10px] space-y-0.5">
                        {rec.result.counterEvidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    ) : (
                      <span className="text-slate-600 text-[10px]">None reported.</span>
                    )}
                  </div>

                  {rec.result.missingEvidence.length > 0 && (
                    <div className="md:col-span-2">
                      <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Missing evidence</div>
                      <ul className="list-disc list-inside text-amber-300 text-[10px] space-y-0.5">
                        {rec.result.missingEvidence.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}
                  {rec.result.limitations.length > 0 && (
                    <div className="md:col-span-2">
                      <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Limitations</div>
                      <ul className="list-disc list-inside text-slate-400 text-[10px] space-y-0.5">
                        {rec.result.limitations.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                    </div>
                  )}

                  <div className="md:col-span-2 flex flex-wrap items-center gap-3 pt-2 border-t border-slate-800 text-[10px] font-mono text-slate-600">
                    <span>Human review required: {rec.result.humanReviewRequired ? "YES" : "NO"}</span>
                    <span>Provider: {rec.providerModel ?? "n/a"}</span>
                    <span>Graph: {rec.graphVersion ?? "n/a"}</span>
                    <span>Evidence fetched: {new Date(rec.result.provenance.fetchedAt).toLocaleString()}</span>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
