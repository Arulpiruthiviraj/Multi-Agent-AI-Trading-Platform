/**
 * ==========================================================
 * Module: MarketSentimentTrend
 *
 * Phase 1A (Remediation Verification Pass, FINAL_ANALYSIS.md Section 25.3's follow-up) - this
 * used to render a hardcoded `MockSentimentData` array with fixed dates/values regardless of any
 * real state. Now backed entirely by GET /api/v2/market/sentiment-trend: real daily-averaged
 * NewsScoringEngine sentiment scores and real SPY closes. Renders an explicit
 * "SENTIMENT DATA UNAVAILABLE" state - not a chart with a fabricated shape - when the backend
 * reports no real scored news in the window, per this pass's own house rule: no numbers on the
 * dashboard may be synthetic.
 * ==========================================================
 */

import React, { useEffect, useState } from 'react';
import { AreaChart, Area, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, ReferenceLine } from 'recharts';
import { Activity, TrendingUp, AlertTriangle } from 'lucide-react';

interface SentimentPoint {
  date: string;
  sentiment: number;
  articleCount: number;
  index: number | null;
}

export default function MarketSentimentTrend() {
  const [data, setData] = useState<SentimentPoint[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v2/market/sentiment-trend')
      .then(r => r.json())
      .then(json => {
        if (cancelled) return;
        if (json.ok) {
          setAvailable(json.available);
          setData(json.data || []);
          setReason(json.reason || null);
        } else {
          setAvailable(false);
          setReason(json.error || 'Request failed.');
        }
      })
      .catch(e => {
        if (cancelled) return;
        setAvailable(false);
        setReason(e.message);
      });
    return () => { cancelled = true; };
  }, []);

  const latest = data && data.length > 0 ? data[data.length - 1] : null;
  const divergenceCount = data ? data.filter(d => d.index !== null).length > 1
    ? data.reduce((count, d, i) => {
        if (i === 0 || d.index === null || data[i - 1].index === null) return count;
        const sentDelta = d.sentiment - data[i - 1].sentiment;
        const idxDelta = (d.index as number) - (data[i - 1].index as number);
        return (sentDelta > 0 && idxDelta < 0) || (sentDelta < 0 && idxDelta > 0) ? count + 1 : count;
      }, 0)
    : 0 : 0;

  return (
    <div className="bg-[#1A1F2B] rounded-lg border border-slate-800 flex flex-col p-4 w-full shadow-[0_4px_24px_rgba(0,0,0,0.4)] overflow-hidden relative">
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl transform translate-x-20 -translate-y-20 pointer-events-none"></div>

      <div className="flex items-center justify-between z-10 mb-5">
        <h3 className="text-xs sm:text-sm font-mono tracking-widest uppercase text-white flex items-center gap-2 font-black">
          <Activity size={16} className="text-indigo-400" />
          Market Sentiment Trend
        </h3>
        <span className="text-[9px] sm:text-[10px] font-mono uppercase bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded border border-indigo-500/20">
          Last 7 Days
        </span>
      </div>

      {available === false && (
        <div className="z-10 flex flex-col items-center justify-center py-12 text-center gap-2 flex-1">
          <AlertTriangle size={22} className="text-amber-500/70" />
          <p className="text-xs font-mono uppercase tracking-widest text-amber-400/90">Sentiment Data Unavailable</p>
          <p className="text-[10px] text-slate-500 max-w-sm">{reason || 'No real scored news articles in the last 7 days.'}</p>
        </div>
      )}

      {available === null && (
        <div className="z-10 flex items-center justify-center py-12 text-[10px] font-mono text-slate-500 uppercase tracking-widest flex-1">
          Loading real sentiment data...
        </div>
      )}

      {available === true && data && (
        <>
          {/* Stats/Metrics Row - every value here is derived from `data`, real per the fetch above */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 z-10 mb-5">
            <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
              <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">Curr Sentiment</span>
              {/* Real scale is -1 (bearish) to +1 (bullish), per NewsScoringEngine's own AI prompt
                  schema - not 0-100 (the fabricated mock's assumed scale). Sign-colored, not
                  hardcoded green, since a negative real value is a real bearish signal. */}
              <span className={`text-lg sm:text-xl font-mono font-bold mt-1 ${latest && latest.sentiment < 0 ? 'text-rose-400' : 'text-emerald-400'}`}>
                {latest ? (latest.sentiment >= 0 ? '+' : '') + latest.sentiment.toFixed(2) : '--'}
              </span>
            </div>
            <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
              <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">Divergences (7D)</span>
              <span className="text-lg sm:text-xl font-mono text-amber-400 font-bold mt-1">{divergenceCount}</span>
            </div>
            <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
              <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">SPY Base</span>
              <span className="text-lg sm:text-xl font-mono text-white font-bold mt-1">
                {latest && latest.index !== null ? latest.index.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '--'}
              </span>
            </div>
          </div>

          <div className="flex-1 w-full min-h-[200px] sm:min-h-[250px] z-10">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="sentimentArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#818CF8" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#818CF8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} opacity={0.3} />
                <XAxis dataKey="date" stroke="#64748B" fontSize={10} tickLine={false} axisLine={false} tickMargin={10} />
                <YAxis yAxisId="left" stroke="#818CF8" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => v.toFixed(1)} domain={[-1, 1]} />
                <YAxis yAxisId="right" orientation="right" stroke="#CBD5E1" fontSize={10} tickLine={false} axisLine={false} domain={['dataMin - 20', 'dataMax + 20']} tickFormatter={(v) => `$${v}`} />

                <Tooltip
                  contentStyle={{ backgroundColor: '#0F172A', borderColor: '#334155', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}
                  itemStyle={{ color: '#E2E8F0' }}
                />

                <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px', fontFamily: 'monospace' }} />

                <Area yAxisId="left" type="monotone" dataKey="sentiment" name="Sentiment Score" stroke="#818CF8" strokeWidth={2} fillOpacity={1} fill="url(#sentimentArea)" connectNulls />
                <Line yAxisId="right" type="monotone" dataKey="index" name="SPY Benchmark" stroke="#CBD5E1" strokeWidth={2} dot={{ r: 3, fill: '#CBD5E1', stroke: '#0F172A', strokeWidth: 2 }} activeDot={{ r: 5 }} connectNulls />

                <ReferenceLine y={0} yAxisId="left" stroke="#64748B" strokeDasharray="3 3" label={{ position: 'insideTopLeft', value: 'NEUTRAL (0)', fill: '#64748B', fontSize: 9 }} opacity={0.5} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center z-10">
            <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1.5">
              <TrendingUp size={12} className="text-emerald-400" /> Real daily-averaged sentiment from NewsScoringEngine, real SPY closes.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
