/**
 * Phase 3F - Risk Center. Real 24-gate breakdown per recent risk assessment
 * (GET /api/v2/runtime/risk/recent-assessments) — every gate as actually recorded by
 * RiskEngine.ts, including gates recorded after the first failure. Read-only: no frontend
 * override, no "force approve", no bypass control exists here or anywhere in the UI.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ShieldCheck, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';

interface GateResult {
  gateName: string;
  sequence: number;
  passed: boolean;
  detail: string | null;
}

interface RiskAssessment {
  traceId: string;
  symbol: string;
  side: string;
  approved: boolean;
  rejectionGate: string | null;
  accountEquity: number | null;
  createdAt: string;
  gates: GateResult[];
}

export default function RiskGateHistoryPanel() {
  const [assessments, setAssessments] = useState<RiskAssessment[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAssessments = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    fetch('/api/v2/runtime/risk/recent-assessments?limit=20', { signal: controller.signal })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setAssessments(d.assessments || []); else setError(d.error || 'unknown error'); })
      .catch((e) => { if (e?.name !== 'AbortError') setError(e.message); });
  };

  useEffect(() => {
    fetchAssessments();
    const interval = setInterval(fetchAssessments, 20000);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, []);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
      <div className="flex justify-between items-center mb-4">
        <div>
          <h3 className="text-xs font-bold text-slate-100 uppercase tracking-widest flex items-center gap-2">
            <ShieldCheck size={14} className="text-emerald-400" /> Risk gate history
          </h3>
          <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">
            Read-only — every gate as actually recorded, no override control exists
          </p>
        </div>
        <button onClick={fetchAssessments} className="flex items-center gap-2 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-emerald-400 text-[10px] uppercase tracking-widest font-bold rounded">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {error && <p className="text-[11px] text-rose-400 mb-3">Could not load risk assessments: {error}</p>}

      {assessments.length === 0 ? (
        <p className="text-[11px] text-slate-600">No risk assessments recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {assessments.map((a) => {
            const isOpen = expanded === a.traceId;
            return (
              <div key={a.traceId} className="border border-slate-800 rounded bg-[#111822]">
                <button
                  className="w-full flex items-center justify-between px-3 py-2.5 text-left"
                  onClick={() => setExpanded(isOpen ? null : a.traceId)}
                >
                  <div className="flex items-center gap-3 text-[11px]">
                    <span className={`font-bold uppercase tracking-widest px-2 py-0.5 rounded border text-[10px] ${a.approved ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' : 'text-rose-400 border-rose-500/30 bg-rose-500/10'}`}>
                      {a.approved ? 'Approved' : 'Rejected'}
                    </span>
                    <span className="font-bold text-slate-200">{a.symbol}</span>
                    <span className="text-slate-500">{a.side}</span>
                    {a.rejectionGate && <span className="text-slate-600">— {a.rejectionGate}</span>}
                    <span className="text-slate-600">{new Date(a.createdAt).toLocaleTimeString()}</span>
                  </div>
                  {isOpen ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                </button>
                {isOpen && (
                  <div className="px-3 pb-3 flex flex-wrap gap-1.5">
                    {a.gates.map((g) => (
                      <span
                        key={`${a.traceId}-${g.sequence}-${g.gateName}`}
                        title={g.detail ?? undefined}
                        className={`text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${g.passed ? 'border-emerald-500/30 text-emerald-400' : 'border-rose-500/30 text-rose-400'}`}
                      >
                        {g.sequence}. {g.gateName}
                      </span>
                    ))}
                    {a.gates.length === 0 && <span className="text-[10px] text-slate-600">No gate rows recorded for this assessment.</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
