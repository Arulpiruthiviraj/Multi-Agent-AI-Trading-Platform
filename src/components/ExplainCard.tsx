/**
 * Expandable explanation card. Renders a DiagnosticMessage from the API — never a bare "Error".
 */
import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle, ChevronDown, ChevronUp } from 'lucide-react';

export default function ExplainCard({ d, compact }: { d: any; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  if (!d) return null;
  const tone = d.severity === 'CRITICAL' || d.severity === 'ERROR'
    ? 'border-rose-500/40 text-rose-300'
    : d.severity === 'WARNING' ? 'border-amber-500/40 text-amber-300'
    : 'border-emerald-500/30 text-emerald-300';
  const Icon = d.severity === 'CRITICAL' || d.severity === 'ERROR' ? XCircle
    : d.severity === 'WARNING' ? AlertTriangle
    : d.status === 'AVAILABLE' ? CheckCircle2 : Info;

  return (
    <div className={`bg-[#111822] border rounded-lg p-3 ${tone}`}>
      <button type="button" onClick={() => setOpen(!open)} className="w-full text-left flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <Icon size={14} className="mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[10px] font-mono tracking-widest uppercase">{d.component} · {d.status}</div>
            <div className="text-xs font-bold text-white mt-0.5">{d.title}</div>
            {compact && !open && <div className="text-[10px] text-slate-400 mt-1 line-clamp-2">{d.userMessage}</div>}
          </div>
        </div>
        {open ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
      </button>
      {open && (
        <div className="mt-3 space-y-2 text-[11px] font-mono text-slate-300 leading-relaxed">
          <p><span className="text-slate-500">Why: </span>{d.cause || d.userMessage}</p>
          <p><span className="text-slate-500">Impact: </span>{d.impact}</p>
          <p><span className="text-slate-500">Trading: </span>{d.tradingImpact}</p>
          <p><span className="text-slate-500">Can Argus continue: </span>{d.canContinueSafely ? 'Yes — this does not authorize bypassing RiskEngine' : 'No — operator action required'}</p>
          <p><span className="text-slate-500">Fix: </span>{d.recommendedFix}</p>
          {d.troubleshootingSteps?.length > 0 && (
            <ol className="list-decimal list-inside text-slate-400 space-y-0.5">
              {d.troubleshootingSteps.map((s: string, i: number) => <li key={i}>{s}</li>)}
            </ol>
          )}
          {d.documentationReference && <p className="text-slate-600">Docs: {d.documentationReference}</p>}
          <p className="text-[9px] text-slate-600">{d.code} · {d.timestamp}</p>
        </div>
      )}
    </div>
  );
}
