/**
 * ==========================================================
 * Module: TradeEfficiencyReport
 *
 * Phase 1A follow-up (Remediation Verification Pass, same house pattern as
 * MarketSentimentTrend.tsx/ExecutionQualityChart.tsx) - this used to render 5 hardcoded,
 * fictional "strategies" (Momentum/Mean Revert/News Arb/Order Flow/Macro - none of which are
 * real Argus agents or a real, separately-tracked strategy), re-jittered every 4s via
 * Date.now() % 1000 client-side noise, never backed by any real measurement.
 *
 * Now backed entirely by GET /api/v2/agents/efficiency: real win rate per real agent
 * (agent_performance_stats.winRate, the same source AgentEvaluationDashboard.tsx already uses -
 * only once ReflectionEngine has actually scored a real outcome, never a seeded placeholder) and
 * real average AI-call decision latency (agent_predictions.latencyMs). TechnicalAgent and
 * KronosForecastAgent never call an LLM, so their real latency is genuinely null - rendered as
 * "N/A", never 0 or a fabricated figure.
 * ==========================================================
 */

import React, { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, Legend, CartesianGrid } from 'recharts';
import { SafeResponsiveContainer } from './shared/SafeResponsiveContainer';
import { Zap, AlertTriangle } from 'lucide-react';
import AwaitingSignal from './shared/AwaitingSignal';

interface AgentEfficiencyPoint {
  agentName: string;
  winRate: number | null;
  totalPredictions: number;
  avgLatencyMs: number | null;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const point: AgentEfficiencyPoint = payload[0].payload;
    return (
      <div className="bg-[#111822] border border-slate-700 p-3 rounded shadow-lg">
        <p className="text-white font-mono text-xs font-bold mb-2">{label}</p>
        <p className="text-slate-400 font-mono text-[10px]">
          Win Rate: <span className="text-emerald-400">{point.winRate !== null ? `${point.winRate}%` : 'N/A'}</span>
          {point.totalPredictions > 0 && <span className="text-slate-600"> ({point.totalPredictions} evaluated)</span>}
        </p>
        <p className="text-slate-400 font-mono text-[10px] mt-1">
          Avg Decision Latency: <span className="text-indigo-400">{point.avgLatencyMs !== null ? `${point.avgLatencyMs}ms` : 'N/A (no AI call made)'}</span>
        </p>
      </div>
    );
  }
  return null;
};

export default function TradeEfficiencyReport() {
  const [data, setData] = useState<AgentEfficiencyPoint[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/agents/efficiency')
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
    };
    load();
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // recharts needs a numeric field even for "N/A" bars - render nulls as 0-height bars rather
  // than dropping the agent from the chart entirely, so a reader can still see which agents have
  // no real latency/win-rate data yet.
  const chartData = data?.map(d => ({ ...d, winRateChart: d.winRate ?? 0, latencyChart: d.avgLatencyMs ?? 0 })) ?? [];

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
          <Zap size={16} className="text-amber-400" />
          Agent Efficiency Report
        </h3>
        <div className="text-[10px] font-mono tracking-widest uppercase text-slate-500 bg-[#111822] px-2 py-1 rounded border border-slate-700">
          Win Rate vs Decision Latency
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
        Real win rate (ReflectionEngine's evaluated outcomes) against real average AI-call decision latency, per real Argus agent. TechnicalAgent and KronosForecastAgent compute signals locally with no LLM call, so their latency is honestly N/A rather than zero.
      </p>

      {available === false && (
        <div className="h-[300px] w-full bg-[#111822] rounded border border-slate-800 flex flex-col items-center justify-center gap-2">
          <AlertTriangle size={22} className="text-amber-500/70" />
          <AwaitingSignal reason={reason || 'No real agent performance stats or AI-call latency recorded yet.'} label="Agent Efficiency" />
        </div>
      )}

      {available === null && (
        <div className="h-[300px] w-full bg-[#111822] rounded border border-slate-800 flex items-center justify-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">
          Loading real agent efficiency data...
        </div>
      )}

      {available === true && (
        <div className="h-[300px] w-full bg-[#111822] rounded overflow-hidden border border-slate-800 p-4">
          <SafeResponsiveContainer>
            <BarChart
              data={chartData}
              margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
              <XAxis
                dataKey="agentName"
                stroke="#64748b"
                fontSize={9}
                fontFamily="monospace"
                tickLine={false}
                axisLine={false}
                dy={10}
              />
              <YAxis
                yAxisId="left"
                orientation="left"
                stroke="#64748b"
                fontSize={10}
                fontFamily="monospace"
                tickFormatter={(value) => `${value}%`}
                tickLine={false}
                axisLine={false}
                dx={-10}
                domain={[0, 100]}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#64748b"
                fontSize={10}
                fontFamily="monospace"
                tickFormatter={(value) => `${value}ms`}
                tickLine={false}
                axisLine={false}
                dx={10}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ fill: '#1e293b', opacity: 0.4 }} />
              <Legend
                wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', paddingTop: '20px' }}
                iconType="circle"
              />
              <Bar yAxisId="left" dataKey="winRateChart" name="Win Rate (%)" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
              <Bar yAxisId="right" dataKey="latencyChart" name="Avg Latency (ms)" fill="#818cf8" radius={[4, 4, 0, 0]} maxBarSize={40} />
            </BarChart>
          </SafeResponsiveContainer>
        </div>
      )}
    </div>
  );
}
