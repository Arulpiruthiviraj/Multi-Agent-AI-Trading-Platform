import React from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts';
import { ArrowUpRight, ArrowDownRight, ShieldCheck, Zap, AlertTriangle, Scale } from 'lucide-react';

export default function ShadowPortfolioBenchmark({ autoBotConfig }: { autoBotConfig: any }) {
  const equityHistory = autoBotConfig?.equityHistory || [];
  const bypassedTrades = autoBotConfig?.bypassedTrades || [];

  // Calculate current valuations
  const latestSovereign = equityHistory.length > 0 ? equityHistory[equityHistory.length - 1].sovereign : 100000;
  const latestShadow = equityHistory.length > 0 ? equityHistory[equityHistory.length - 1].shadow : 100000;
  const initialEquity = 100000;

  const sovereignRoi = ((latestSovereign - initialEquity) / initialEquity) * 100;
  const shadowRoi = ((latestShadow - initialEquity) / initialEquity) * 100;

  // The "Alpha" or Value Add represents the outperformance of the risk-gated portfolio
  const riskAlpha = sovereignRoi - shadowRoi;

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col gap-6">
      
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Scale size={16} className="text-indigo-400" />
            SHADOW PORTFOLIO BENCHMARKING ENGINE
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Compare the performance of the risk-gated **Sovereign Portfolio** against an unconstrained, parallel **Shadow Portfolio** that executes all Proposer decisions directly (bypassing the Risk Manager and 1.5x ATR dynamic safeguards).
          </p>
        </div>
        
        {/* Value Add Widget */}
        <div className="bg-[#111822] border border-slate-800 rounded px-4 py-2 flex items-center gap-3 shrink-0">
          <ShieldCheck size={18} className="text-emerald-400" />
          <div>
            <span className="text-[9px] uppercase font-mono tracking-widest text-slate-500 block">Risk Manager Value-Add</span>
            <span className={`text-sm font-bold font-mono ${riskAlpha >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {riskAlpha >= 0 ? '+' : ''}{riskAlpha.toFixed(2)}% Alpha
            </span>
          </div>
        </div>
      </div>

      {/* Grid Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* Sovereign Card */}
        <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500"></div>
          <div>
            <span className="text-[10px] text-emerald-400 uppercase tracking-widest font-mono block mb-1">Sovereign Portfolio (Risk-Gated)</span>
            <div className="text-2xl font-bold font-mono text-white">${latestSovereign.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div className="flex items-center gap-1.5 mt-3 text-xs">
            {sovereignRoi >= 0 ? (
              <span className="text-emerald-400 flex items-center font-bold"><ArrowUpRight size={14} /> +{sovereignRoi.toFixed(2)}% ROI</span>
            ) : (
              <span className="text-rose-400 flex items-center font-bold"><ArrowDownRight size={14} /> {sovereignRoi.toFixed(2)}% ROI</span>
            )}
            <span className="text-slate-500 font-mono text-[10px] uppercase">Gated ATR Protection</span>
          </div>
        </div>

        {/* Shadow Card */}
        <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-rose-500"></div>
          <div>
            <span className="text-[10px] text-rose-400 uppercase tracking-widest font-mono block mb-1">Shadow Portfolio (Unconstrained)</span>
            <div className="text-2xl font-bold font-mono text-white">${latestShadow.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          </div>
          <div className="flex items-center gap-1.5 mt-3 text-xs">
            {shadowRoi >= 0 ? (
              <span className="text-emerald-400 flex items-center font-bold"><ArrowUpRight size={14} /> +{shadowRoi.toFixed(2)}% ROI</span>
            ) : (
              <span className="text-rose-400 flex items-center font-bold"><ArrowDownRight size={14} /> {shadowRoi.toFixed(2)}% ROI</span>
            )}
            <span className="text-slate-500 font-mono text-[10px] uppercase">Zero Risk Filtering</span>
          </div>
        </div>

        {/* Protection Efficiency */}
        <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col justify-between">
          <div>
            <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-mono block mb-1">Protection Efficiency</span>
            <div className="text-2xl font-bold font-mono text-white">
              {bypassedTrades.length} <span className="text-xs text-slate-500">Vetos Logged</span>
            </div>
          </div>
          <div className="flex items-center gap-1.5 mt-3 text-xs text-slate-400">
            <Zap size={13} className="text-amber-400" />
            <span className="font-mono text-[10px] uppercase">Prevents Overbought / Correlated Traps</span>
          </div>
        </div>

      </div>

      {/* Equity Curve Comparison Chart */}
      <div className="bg-[#0A0F16] rounded-lg border border-slate-800 p-4">
        <h4 className="text-[10px] font-mono tracking-widest uppercase text-slate-400 mb-4 flex items-center gap-2">
          <Scale size={14} className="text-indigo-400" />
          Live Benchmarking Equity Comparison Curve
        </h4>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={equityHistory} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
              <XAxis dataKey="time" stroke="#475569" fontSize={9} tickLine={false} axisLine={false} />
              <YAxis 
                stroke="#475569" 
                fontSize={9} 
                tickLine={false} 
                axisLine={false} 
                domain={['auto', 'auto']}
                tickFormatter={(val) => `$${(val / 1000).toFixed(0)}k`} 
              />
              <Tooltip 
                contentStyle={{ backgroundColor: '#111822', borderColor: '#1e293b', fontSize: '11px', color: '#f8fafc' }}
                itemStyle={{ fontSize: '11px' }}
                labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                formatter={(val: any) => [`$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, '']}
              />
              <Legend 
                verticalAlign="top" 
                height={36} 
                iconType="circle" 
                iconSize={8}
                wrapperStyle={{ fontSize: '10px', textTransform: 'uppercase', fontFamily: 'monospace' }} 
              />
              <Line type="monotone" dataKey="sovereign" stroke="#10b981" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} name="Sovereign (Risk-Gated)" />
              <Line type="monotone" dataKey="shadow" stroke="#f43f5e" strokeWidth={2.5} dot={false} activeDot={{ r: 5 }} name="Shadow (Unconstrained)" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Bypassed / Vetoed Ledger Table */}
      <div className="bg-[#0A0F16] rounded-lg border border-slate-800 overflow-hidden">
        <div className="bg-slate-900 border-b border-slate-800 px-4 py-3 flex items-center justify-between">
          <h4 className="text-[10px] font-mono tracking-widest uppercase text-slate-400 flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" />
            Vetoed Decisions & Bypassed Shadow Positions Ledger
          </h4>
          <span className="text-[9px] font-bold text-rose-400 uppercase tracking-widest bg-rose-500/10 px-2.5 py-0.5 rounded">
            Tracking {bypassedTrades.length} Shadow Placements
          </span>
        </div>
        
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-800/80 text-[10px] font-mono uppercase tracking-widest text-slate-500 bg-slate-950/40">
                <th className="p-3">Time</th>
                <th className="p-3">Asset</th>
                <th className="p-3">Trade Side</th>
                <th className="p-3">Veto Reason / Risk Breach</th>
                <th className="p-3 text-right">Price</th>
                <th className="p-3 text-right">Shadow Amount</th>
                <th className="p-3 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60 font-mono text-[11px]">
              {bypassedTrades.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-slate-500 uppercase tracking-wider">
                    No vetoed decisions logged. Initialize bot to start tracking bypassed signals.
                  </td>
                </tr>
              ) : (
                bypassedTrades.map((trade: any, idx: number) => (
                  <tr key={idx} className="hover:bg-slate-900/40 transition-colors">
                    <td className="p-3 text-slate-400 whitespace-nowrap">
                      {trade.time ? new Date(trade.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '09:30 AM'}
                    </td>
                    <td className="p-3 font-bold text-white whitespace-nowrap">{trade.symbol}</td>
                    <td className="p-3 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded font-bold text-[9px] uppercase tracking-wider ${trade.side === 'BUY' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`}>
                        {trade.side}
                      </span>
                    </td>
                    <td className="p-3 text-slate-300 max-w-xs md:max-w-md truncate" title={trade.reason}>
                      {trade.reason}
                    </td>
                    <td className="p-3 text-right text-slate-400 font-bold whitespace-nowrap">${trade.price?.toFixed(2)}</td>
                    <td className="p-3 text-right text-indigo-400 font-bold whitespace-nowrap">${trade.amount?.toLocaleString()}</td>
                    <td className="p-3 text-center whitespace-nowrap">
                      <span className="text-[9px] uppercase tracking-wider bg-purple-500/10 text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded">
                        Active in Shadow
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
}
