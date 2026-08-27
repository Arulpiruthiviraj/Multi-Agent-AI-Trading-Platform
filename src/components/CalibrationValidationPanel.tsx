/**
 * Phase 7D/7E (Calibration statistical validation) - shows the currently ACTIVE (raw)
 * agent_confidence_calibration value next to the cluster-corrected candidate this pass computes.
 * Read-only. Nothing here writes to, or is read by, the live consensus path - this exists purely
 * so an operator can see whether the live calibration value is well-supported by independent
 * evidence before ever considering wiring a promoted candidate into ChiefTraderAgent.
 */
import React, { useEffect, useRef, useState } from 'react';
import { FlaskConical, RefreshCw } from 'lucide-react';

interface CalibrationCandidate {
  agentName: string;
  bucketLow: number;
  bucketHigh: number;
  rawN: number;
  rawWinRate: number | null;
  effectiveN: number;
  effectiveWinRate: number | null;
  wilsonLower: number | null;
  wilsonUpper: number | null;
  inflationFactor: number | null;
  candidateCalibratedConfidence: number;
  currentActiveCalibratedConfidence: number | null;
  isStale: boolean;
  symbolConcentration: Array<{ symbol: string; count: number; sharePct: number }>;
}

export default function CalibrationValidationPanel() {
  const [candidates, setCandidates] = useState<CalibrationCandidate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/continuous-intelligence/learning/calibration/candidates', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setCandidates(d.candidates || []); setError(null); } else setError(d.error || 'unknown error'); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000);
    return () => { clearInterval(interval); abortRef.current?.abort(); };
  }, []);

  const sorted = [...candidates].sort((a, b) => b.rawN - a.rawN);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <FlaskConical size={14} className="text-cyan-400" /> Calibration validation (candidate vs. active)
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Cluster-corrected estimate shown for comparison only — never fed into live consensus
          </p>
        </div>
        <button onClick={fetchData} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load calibration candidates: {error}</p>}

      {sorted.length === 0 ? (
        <p className="text-[11px] text-slate-600">No calibration rows exist yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-slate-500 uppercase text-[9px] tracking-widest border-b border-slate-800">
                <th className="text-left py-1.5 pr-3">Agent</th>
                <th className="text-left py-1.5 pr-3">Bucket</th>
                <th className="text-left py-1.5 pr-3">Raw N</th>
                <th className="text-left py-1.5 pr-3">Effective N</th>
                <th className="text-left py-1.5 pr-3">Inflation</th>
                <th className="text-left py-1.5 pr-3">95% CI</th>
                <th className="text-left py-1.5 pr-3">Active</th>
                <th className="text-left py-1.5 pr-3">Candidate</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={`${c.agentName}-${c.bucketLow}`} className="border-b border-slate-900">
                  <td className="py-1.5 pr-3 font-bold text-slate-200">{c.agentName}</td>
                  <td className="py-1.5 pr-3 text-slate-400">{c.bucketLow.toFixed(1)}&ndash;{c.bucketHigh.toFixed(1)}</td>
                  <td className="py-1.5 pr-3 text-slate-400">{c.rawN}</td>
                  <td className="py-1.5 pr-3 text-slate-400">
                    {c.effectiveN}
                    {c.isStale && <span className="ml-1.5 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border text-amber-400 border-amber-500/30 bg-amber-500/10">stale</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-slate-500">{c.inflationFactor ? `${c.inflationFactor.toFixed(1)}x` : 'n/a'}</td>
                  <td className="py-1.5 pr-3 text-slate-500">
                    {c.wilsonLower != null && c.wilsonUpper != null ? `${(c.wilsonLower * 100).toFixed(0)}–${(c.wilsonUpper * 100).toFixed(0)}%` : 'n/a'}
                  </td>
                  <td className="py-1.5 pr-3 text-slate-300 font-mono">{c.currentActiveCalibratedConfidence?.toFixed(3) ?? 'n/a'}</td>
                  <td className="py-1.5 pr-3 font-mono" style={{ color: c.candidateCalibratedConfidence < (c.currentActiveCalibratedConfidence ?? 0) - 0.05 || c.candidateCalibratedConfidence > (c.currentActiveCalibratedConfidence ?? 0) + 0.05 ? '#e0a752' : '#7fcf8f' }}>
                    {c.candidateCalibratedConfidence.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
