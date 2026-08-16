/**
 * Research Lab observability. Does not claim edge, Sharpe, or LIVE GO.
 */
import React, { useEffect, useState } from "react";
import AwaitingSignal from "./shared/AwaitingSignal";

export default function ResearchLabPanel() {
  const [status, setStatus] = useState<any>(null);
  const [promo, setPromo] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

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
    </div>
  );
}
