/**
 * Research Lab observability. Does not claim edge, Sharpe, or LIVE GO.
 */
import React, { useEffect, useState } from "react";
import AwaitingSignal from "./shared/AwaitingSignal";

export default function ResearchLabPanel() {
  const [status, setStatus] = useState<any>(null);
  const [promo, setPromo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  // Research Memory Platform Phase 1 (2026-09-11) - real, persisted pre-registered hypotheses and
  // the experiments testing them. Fetched independently of the VectorBT/promotion data above; a
  // failure here never blocks the rest of this panel.
  const [hypotheses, setHypotheses] = useState<any[] | null>(null);
  const [experiments, setExperiments] = useState<any[] | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/v2/research/vectorbt/status").then((r) => r.json()),
      fetch("/api/v2/research/comparison-matrix").then((r) => r.json()),
    ])
      .then(([s, p]) => {
        setStatus(s);
        setPromo(p);
      })
      .catch((e) => setError(e.message));

    Promise.all([
      fetch("/api/v2/research/hypotheses").then((r) => r.json()),
      fetch("/api/v2/research/experiments").then((r) => r.json()),
    ])
      .then(([h, e]) => {
        if (h.ok) setHypotheses(h.hypotheses);
        if (e.ok) setExperiments(e.experiments);
      })
      .catch(() => { /* additive section - Research Lab's own status/promotion data still renders */ });
  }, []);

  if (error) {
    return <AwaitingSignal label="Research Lab" reason={`Research API failed: ${error}`} />;
  }
  if (!status) {
    return <AwaitingSignal label="Research Lab" reason="Loading VectorBT capability (research-only)." />;
  }

  const v = status.vectorbt;
  const rustNote = v?.rustAccelerationUnavailable
    ? "RUST_ACCELERATION_UNAVAILABLE"
    : v?.rustBackend?.available
      ? "Rust backend present"
      : "Rust not installed — VectorBT fallback still valid";

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-white uppercase tracking-widest">Research Lab</h3>
        <span className="text-[10px] font-mono text-rose-400 uppercase tracking-widest">LIVE {status.live}</span>
      </div>
      <p className="text-[11px] text-slate-400 mb-4">
        VectorBT is a research engine. It cannot place orders. Installing it does not prove an edge.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <div className="border border-slate-800 rounded p-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">VectorBT</div>
          <div className="text-sm font-mono text-slate-200">{v?.state ?? "UNAVAILABLE"}</div>
        </div>
        <div className="border border-slate-800 rounded p-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">Version</div>
          <div className="text-sm font-mono text-slate-200">{v?.version ?? "UNAVAILABLE"}</div>
        </div>
        <div className="border border-slate-800 rounded p-2">
          <div className="text-[10px] font-mono text-slate-500 uppercase">Rust</div>
          <div className="text-sm font-mono text-slate-200">{rustNote}</div>
        </div>
      </div>
      <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">Strategy evidence (not P&amp;L)</div>
      {promo?.rows ? (
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] font-mono text-slate-300">
            <thead>
              <tr className="text-slate-500 uppercase">
                <th className="text-left py-1">Strategy</th>
                <th>Parity</th>
                <th>Data</th>
                <th>OOS</th>
                <th>WFO</th>
                <th>Paper</th>
                <th>Final</th>
              </tr>
            </thead>
            <tbody>
              {promo.rows.map((r: any) => (
                <tr key={r.strategy} className="border-t border-slate-800">
                  <td className="py-1">{r.strategy}</td>
                  <td>{r.featureParity}</td>
                  <td>{r.data}</td>
                  <td>{r.oos}</td>
                  <td>{r.wfo}</td>
                  <td>{r.paper}</td>
                  <td>{r.final}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <AwaitingSignal compact emptyResult reason="Comparison matrix not loaded." />
      )}
      <p className="text-[10px] font-mono text-slate-500 mt-4 uppercase tracking-widest">
        Dataset · Strategy · Backtest · Sweep · Walk-forward · Monte Carlo · Permutation · Sensitivity · Cost · Regime · Paper · Health
      </p>

      <div className="mt-6 pt-4 border-t border-slate-800">
        <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500 mb-2">
          Pre-Registered Hypotheses &amp; Experiments (Research Memory Platform)
        </div>
        <p className="text-[10px] text-slate-500 mb-3 max-w-2xl">
          A hypothesis is frozen here BEFORE its evidence is examined - never redefined after
          seeing a result. Empty is honest: nothing is backfilled from prior ad hoc analysis.
        </p>
        {!hypotheses ? (
          <AwaitingSignal compact reason="Loading hypotheses..." />
        ) : hypotheses.length === 0 ? (
          <AwaitingSignal compact emptyResult reason="No hypotheses pre-registered yet." />
        ) : (
          <div className="overflow-x-auto mb-4">
            <table className="w-full text-[10px] font-mono text-slate-300">
              <thead>
                <tr className="text-slate-500 uppercase">
                  <th className="text-left py-1">Statement</th>
                  <th className="text-left">Strategy</th>
                  <th>Preregistered</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {hypotheses.map((h: any) => (
                  <tr key={h.id} className="border-t border-slate-800">
                    <td className="py-1 text-left max-w-xs truncate" title={h.statement}>{h.statement}</td>
                    <td className="text-left">{h.strategyId ?? '—'}</td>
                    <td className="text-center">{h.preregisteredAt?.slice(0, 10) ?? '—'}</td>
                    <td className={`text-center ${h.resolvedStatus ? (h.resolvedStatus === 'CONFIRMED' ? 'text-emerald-400' : h.resolvedStatus === 'REJECTED' ? 'text-rose-400' : 'text-amber-400') : 'text-slate-500'}`}>
                      {h.resolvedStatus ?? 'PRE_REGISTERED'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!experiments ? (
          <AwaitingSignal compact reason="Loading experiments..." />
        ) : experiments.length === 0 ? (
          <AwaitingSignal compact emptyResult reason="No experiments recorded yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px] font-mono text-slate-300">
              <thead>
                <tr className="text-slate-500 uppercase">
                  <th className="text-left py-1">Label</th>
                  <th className="text-left">Strategy</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {experiments.map((exp: any) => (
                  <tr key={exp.id} className="border-t border-slate-800">
                    <td className="py-1 text-left">{exp.label}</td>
                    <td className="text-left">{exp.strategyId ?? '—'}</td>
                    <td className="text-center">{exp.status}</td>
                    <td className="text-center">{exp.createdAt?.slice(0, 10) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
