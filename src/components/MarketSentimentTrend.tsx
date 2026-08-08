/**
 * ==========================================================
 * Module:
 * MarketSentimentTrend.tsx
 *
 * Purpose:
 * Core implementation and logic for the MarketSentimentTrend.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for MarketSentimentTrendx
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import React, { useState } from 'react';
import { AreaChart, Area, ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid, ReferenceLine } from 'recharts';
import { Activity, TrendingUp } from 'lucide-react';

/* === COMPONENT: MarketSentimentTrend === */
/*
  Plots the aggregated sentiment score from the SentimentAgent over the last 7 days, 
  overlaying it with the benchmark index price to identify divergences.
*/
const MockSentimentData = [
  { date: '15 Sep', sentiment: 42, index: 4430, divergence: false },
  { date: '16 Sep', sentiment: 35, index: 4400, divergence: false },
  { date: '17 Sep', sentiment: 28, index: 4385, divergence: false },
  { date: '18 Sep', sentiment: 45, index: 4390, divergence: true },
  { date: '19 Sep', sentiment: 68, index: 4380, divergence: true }, // Bullish divergence
  { date: '20 Sep', sentiment: 75, index: 4420, divergence: false },
  { date: '21 Sep', sentiment: 82, index: 4450, divergence: false },
  { date: '22 Sep', sentiment: 88, index: 4480, divergence: false },
];

export default function MarketSentimentTrend() {
  const [data] = useState(MockSentimentData);

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

      {/* Stats/Metrics Row */}
      <div className="grid grid-cols-3 gap-2 sm:gap-3 z-10 mb-5">
        <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
            <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">Curr Sentiment</span>
            <span className="text-lg sm:text-xl font-mono text-emerald-400 font-bold mt-1">88<span className="text-[10px] text-emerald-400/50">/100</span></span>
        </div>
        <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
            <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">Divergences (7D)</span>
            <span className="text-lg sm:text-xl font-mono text-amber-400 font-bold mt-1">2</span>
        </div>
        <div className="bg-[#111822] rounded border border-slate-800 p-2 sm:p-3 flex flex-col justify-between">
            <span className="text-[9px] sm:text-[10px] font-mono text-slate-500 uppercase tracking-widest">SPY Base</span>
            <span className="text-lg sm:text-xl font-mono text-white font-bold mt-1">4,480<span className="text-[10px] text-slate-500">.00</span></span>
        </div>
      </div>

      <div className="flex-1 w-full min-h-[200px] sm:min-h-[250px] z-10">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 10, right: 0, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="sentimentArea" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#818CF8" stopOpacity={0.25}/>
                <stop offset="95%" stopColor="#818CF8" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} opacity={0.3} />
            <XAxis dataKey="date" stroke="#64748B" fontSize={10} tickLine={false} axisLine={false} tickMargin={10} />
            <YAxis yAxisId="left" stroke="#818CF8" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}`} domain={[0, 100]} />
            <YAxis yAxisId="right" orientation="right" stroke="#CBD5E1" fontSize={10} tickLine={false} axisLine={false} domain={['dataMin - 20', 'dataMax + 20']} tickFormatter={(v) => `$${v}`} />
            
            <Tooltip 
              contentStyle={{ backgroundColor: '#0F172A', borderColor: '#334155', borderRadius: '8px', fontSize: '11px', fontFamily: 'monospace' }}
              itemStyle={{ color: '#E2E8F0' }}
            />
            
            <Legend wrapperStyle={{ fontSize: '10px', paddingTop: '10px', fontFamily: 'monospace' }} />
            
            <Area yAxisId="left" type="monotone" dataKey="sentiment" name="Sentiment Score" stroke="#818CF8" strokeWidth={2} fillOpacity={1} fill="url(#sentimentArea)" />
            <Line yAxisId="right" type="monotone" dataKey="index" name="SPY Benchmark" stroke="#CBD5E1" strokeWidth={2} dot={{ r: 3, fill: '#CBD5E1', stroke: '#0F172A', strokeWidth: 2 }} activeDot={{ r: 5 }} />
            
            <ReferenceLine y={50} yAxisId="left" stroke="#64748B" strokeDasharray="3 3" label={{ position: 'insideTopLeft', value: 'NEUTRAL (50)', fill: '#64748B', fontSize: 9 }} opacity={0.5} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center z-10">
          <p className="text-[10px] text-slate-500 font-mono flex items-center gap-1.5"><TrendingUp size={12} className="text-emerald-400"/> Sentiment Agent leading SPY benchmark correlation.</p>
      </div>
    </div>
  );
}
