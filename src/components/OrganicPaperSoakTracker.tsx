/**
 * Organic paper soak progress for Mission Control.
 * Reads GET /api/v2/research/organic-paper only — never invents P&L.
 * REPLAY / EXTERNAL_SYNC / DIAG are excluded server-side by isOrganicClosedPaper.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, AlertTriangle, Ban, CalendarDays, Target } from 'lucide-react';

type MarketBadge = 'MARKET_OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'WEEKEND_CLOSED' | 'CLOSED' | 'UNKNOWN';

interface OrganicPaperPayload {
  ok?: boolean;
  closedTradeCount?: number;
  sessionCount?: number;
  winRate?: number | null;
  expectancy?: number | null;
  profitFactor?: number | null;
  note?: string;
  soak?: { status?: string; legacyStatus?: string };
  marketSession?: MarketBadge;
  minPaperTrades?: number;
  minPaperSessions?: number;
  exclusions?: string[];
}

function ProgressBar({ value, max, tone }: { value: number; max: number; tone: 'emerald' | 'amber' }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  const bar = tone === 'emerald' ? 'bg-emerald-500' : 'bg-amber-500';
  return (
    <div className="h-2 w-full rounded bg-slate-800 overflow-hidden border border-slate-700">
      <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function sessionBadgeClass(s: MarketBadge): string {
  if (s === 'MARKET_OPEN') return 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40';
  if (s === 'PRE_MARKET' || s === 'AFTER_HOURS') return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  return 'bg-slate-700/40 text-slate-400 border-slate-600';
}

export default function OrganicPaperSoakTracker() {
  const [data, setData] = useState<OrganicPaperPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v2/research/organic-paper');
      const json = await res.json();
      if (!res.ok || json?.ok === false) {
        setError(json?.error || `HTTP ${res.status}`);
        setData(null);
        return;
      }
      setError(null);
      setData(json);
    } catch (e: any) {
      setError(e?.message || 'fetch failed');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const minTrades = data?.minPaperTrades ?? 30;
  const minSessions = data?.minPaperSessions ?? 10;
  const trades = data?.closedTradeCount ?? 0;
  const sessions = data?.sessionCount ?? 0;
  const market = data?.marketSession ?? 'UNKNOWN';
  const awaitingMetrics = trades < 5;

  return (
    <div className="mb-6 rounded-xl border border-slate-800 bg-[#111822] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <Target size={16} className="text-emerald-400" />
          <div>
            <h3 className="text-xs font-mono uppercase tracking-widest text-slate-200">Organic Paper Soak</h3>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Capital evidence tracker — not LIVE, not promotion auto-approve.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border ${sessionBadgeClass(market)}`}>
            NY {market}
          </span>
          <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border border-rose-500/40 bg-rose-500/10 text-rose-300 flex items-center gap-1">
            <Ban size={10} /> REPLAY / DIAGNOSTIC / EXTERNAL_SYNC excluded
          </span>
          {data?.soak?.status && (
            <span className="text-[9px] font-mono uppercase tracking-wider px-2 py-0.5 rounded border border-indigo-500/30 bg-indigo-500/10 text-indigo-300">
              {data.soak.status}
            </span>
          )}
        </div>
      </div>

      {loading && !data ? (
        <p className="text-[10px] text-slate-500 font-mono">Loading organic paper summary…</p>
      ) : error ? (
        <p className="text-[10px] text-rose-400 font-mono flex items-center gap-1">
          <AlertTriangle size={12} /> {error}
        </p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-slate-400">
              <span className="flex items-center gap-1"><Activity size={12} /> Paper trades</span>
              <span className="text-slate-200">{trades} / {minTrades}</span>
            </div>
            <ProgressBar value={trades} max={minTrades} tone={trades >= minTrades ? 'emerald' : 'amber'} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-wider text-slate-400">
              <span className="flex items-center gap-1"><CalendarDays size={12} /> Sessions</span>
              <span className="text-slate-200">{sessions} / {minSessions}</span>
            </div>
            <ProgressBar value={sessions} max={minSessions} tone={sessions >= minSessions ? 'emerald' : 'amber'} />
          </div>
          <div className="rounded border border-slate-800 bg-slate-950/50 p-3 space-y-1">
            <p className="text-[9px] font-mono uppercase tracking-widest text-slate-500">Expectancy & win rate</p>
            {awaitingMetrics ? (
              <p className="text-xs font-mono font-bold text-amber-300 tracking-wider">AWAITING_SAMPLE</p>
            ) : (
              <>
                <p className="text-[11px] font-mono text-slate-200">
                  Win rate:{' '}
                  {data?.winRate == null ? 'N/A' : `${(data.winRate * 100).toFixed(1)}%`}
                </p>
                <p className="text-[11px] font-mono text-slate-200">
                  Profit factor:{' '}
                  {data?.profitFactor == null ? 'N/A' : data.profitFactor.toFixed(3)}
                </p>
                <p className="text-[11px] font-mono text-slate-200">
                  Expectancy:{' '}
                  {data?.expectancy == null ? 'N/A' : data.expectancy.toFixed(4)}
                </p>
              </>
            )}
            <p className="text-[9px] text-slate-600 font-mono pt-1">
              Metrics shown only when closed organic trades ≥ 5.
            </p>
          </div>
        </div>
      )}

      {data?.note && (
        <p className="mt-3 text-[10px] text-slate-500 font-mono border-t border-slate-800 pt-2">{data.note}</p>
      )}
    </div>
  );
}
