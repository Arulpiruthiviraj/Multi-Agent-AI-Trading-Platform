/**
 * Decision Trace view. SQLite is source of truth (GET /api/v2/traces/:traceId).
 * Does not fabricate organic paper/LIVE evidence.
 */
import React, { useCallback, useState } from 'react';
import { Search, Download, Activity, ShieldAlert } from 'lucide-react';

interface TimelineStep {
  step: number;
  time: string;
  stage: string;
  source?: string;
  details?: unknown;
}

interface TracePayload {
  ok: boolean;
  traceId: string;
  decisionId?: string;
  symbol: string | null;
  status: string;
  terminalReason: string | null;
  consensusScore: number | null;
  consensusThreshold: number | null;
  contributingAgents: unknown;
  orderId: string | null;
  totalLatencyMs?: number;
  timeline: TimelineStep[];
  riskGates?: Array<{ gateName: string; sequence: number; passed: boolean }>;
  error?: string;
}

function agentsLabel(raw: unknown): string {
  if (Array.isArray(raw)) return raw.map(String).join(', ') || '—';
  if (typeof raw === 'string') {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.join(', ') : raw;
    } catch {
      return raw;
    }
  }
  return '—';
}

export default function DecisionTracePanel({ initialTraceId = '' }: { initialTraceId?: string }) {
  const [traceId, setTraceId] = useState(initialTraceId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<TracePayload | null>(null);

  const load = useCallback(async (id: string) => {
    const trimmed = id.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v2/traces/${encodeURIComponent(trimmed)}`);
      const json = await res.json();
      if (!json.ok && json.error) {
        setError(json.error);
        setTrace(null);
      } else {
        setTrace(json);
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load decision trace');
      setTrace(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const exportJson = useCallback(() => {
    const id = (trace?.traceId || traceId).trim();
    if (!id) return;
    window.open(`/api/v2/traces/${encodeURIComponent(id)}/export`, '_blank');
  }, [trace, traceId]);

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5" id="decision-trace-view">
      <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4 mb-4">
        <div>
          <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2 uppercase tracking-wide">
            <Activity size={16} className="text-cyan-400" />
            Decision Trace
          </h3>
          <p className="text-[11px] text-slate-400 max-w-3xl leading-relaxed font-mono">
            DB-backed reconstruction of one decision (traceId = decisionId). LIVE remains NO-GO. Replay/diagnostic rows are not organic paper.
          </p>
        </div>
      </div>

      <form
        className="flex flex-col sm:flex-row gap-2 mb-4"
        onSubmit={(e) => { e.preventDefault(); void load(traceId); }}
      >
        <input
          value={traceId}
          onChange={(e) => setTraceId(e.target.value)}
          placeholder="trace_AAPL_…"
          className="flex-1 bg-[#111822] border border-slate-700 rounded px-3 py-2 text-[11px] font-mono text-slate-200"
        />
        <button
          type="submit"
          className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/10 flex items-center gap-1.5"
        >
          <Search size={12} /> Load
        </button>
        <button
          type="button"
          onClick={exportJson}
          disabled={!trace?.traceId}
          className="px-3 py-2 text-[10px] font-bold uppercase tracking-widest rounded border border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-40 flex items-center gap-1.5"
        >
          <Download size={12} /> Export JSON
        </button>
      </form>

      {loading && <div className="py-6 text-center text-slate-500 text-xs font-mono">Loading from SQLite…</div>}
      {error && (
        <div className="py-3 text-[11px] font-mono text-rose-400 flex items-center gap-2">
          <ShieldAlert size={14} /> {error}
        </div>
      )}

      {trace && !loading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px] font-mono">
            <div className="bg-[#111822] border border-slate-800 rounded p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Symbol</div>
              <div className="text-white">{trace.symbol || '—'}</div>
            </div>
            <div className="bg-[#111822] border border-slate-800 rounded p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Status</div>
              <div className="text-cyan-300">{trace.status}</div>
            </div>
            <div className="bg-[#111822] border border-slate-800 rounded p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Order</div>
              <div className="text-slate-200 truncate">{trace.orderId || '—'}</div>
            </div>
            <div className="bg-[#111822] border border-slate-800 rounded p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-1">Latency</div>
              <div className="text-slate-200">{typeof trace.totalLatencyMs === 'number' ? `${trace.totalLatencyMs} ms` : '—'}</div>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 font-mono">
            Agents: {agentsLabel(trace.contributingAgents)}
            {trace.terminalReason ? ` — ${trace.terminalReason}` : ''}
          </p>

          {trace.riskGates && trace.riskGates.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {trace.riskGates.map((g) => (
                <span
                  key={`${g.sequence}-${g.gateName}`}
                  className={`text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${
                    g.passed ? 'border-emerald-500/30 text-emerald-400' : 'border-rose-500/30 text-rose-400'
                  }`}
                >
                  {g.gateName}
                </span>
              ))}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                  <th className="pb-2 pl-2 font-medium">#</th>
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Stage</th>
                  <th className="pb-2 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {(trace.timeline || []).map((row) => (
                  <tr key={row.step} className="border-b border-slate-800/50">
                    <td className="py-2 pl-2 font-mono text-[10px] text-slate-500">{row.step}</td>
                    <td className="py-2 font-mono text-[10px] text-slate-400">{row.time}</td>
                    <td className="py-2 font-mono text-[11px] text-white">{row.stage}</td>
                    <td className="py-2 font-mono text-[10px] text-slate-500">{row.source || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(!trace.timeline || trace.timeline.length === 0) && (
              <p className="py-6 text-center text-slate-500 text-xs font-mono">
                No persisted events for this traceId yet.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
