/**
 * ==========================================================
 * Module:
 * LiveBotTelemetryPanel.tsx
 *
 * Purpose:
 * Core implementation and logic for the LiveBotTelemetryPanel.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for LiveBotTelemetryPanelx
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

import React, { useState, useEffect } from 'react';
import { useWebSocket } from '../context/WebSocketContext';
import { Activity, Cpu, HardDrive, Network, Zap, Clock, ShieldCheck } from 'lucide-react';

export default function LiveBotTelemetryPanel({ autoBotConfig }: { autoBotConfig: any }) {
  const [latency, setLatency] = useState<number | null>(null);
  const [heapPct, setHeapPct] = useState<number | null>(null);

  const { subscribe, status: wsStatus } = useWebSocket();

  useEffect(() => {
    if (!autoBotConfig.enabled) return;

    const unsub = subscribe('SYSTEM_METRICS', (data) => {
      if (data && data.system && data.system.heapTotal > 0) {
        setHeapPct(Math.min(100, (data.system.heapUsed / data.system.heapTotal) * 100));
      }
      const procs = data?.processes as Record<string, any> | undefined;
      if (procs) {
        const lats = Object.values(procs).map(p => Number(p.latency)).filter(n => Number.isFinite(n) && n > 0);
        setLatency(lats.length ? Math.max(...lats) : null);
      }
    });

    return () => unsub();
  }, [autoBotConfig.enabled, subscribe]);


  // Real executed trading metrics
  const totalExecutions = autoBotConfig.totalTrades || 0;
  const [winRate, setWinRate] = useState<number | null>(null);
  const [upl, setUpl] = useState<number | null>(null);
  
  useEffect(() => {
    // Real bug found and fixed this pass: this fetch had no unmount/supersession guard, unlike
    // the sibling SYSTEM_METRICS subscription effect right above it. A tab-switch-away before the
    // request resolved, or autoBotConfig.enabled toggling twice in quick succession, could call
    // setWinRate/setUpl on an unmounted component or let an earlier request overwrite a later one.
    let cancelled = false;
    fetch('/api/v1/pnl/analytics').then(r => r.json()).then(d => {
      if (cancelled) return;
      if (d.summary) {
        const wr = d.summary.winRate;
        setWinRate(typeof wr === 'number' && Number.isFinite(wr) && d.summary.sampleSize > 0 ? wr : null);
        const pnl = d.summary.totalProfitLoss;
        setUpl(typeof pnl === 'number' && Number.isFinite(pnl) ? pnl : null);
      }
    }).catch((e) => { if (!cancelled) console.error(e); });
    return () => { cancelled = true; };
  }, [autoBotConfig.enabled]);
  
  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
       <div className="flex items-center justify-between mb-5">
         <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
           <Activity size={16} className="text-emerald-400" />
           Live Autobot Telemetry & Execution Analytics
         </h3>
         <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${autoBotConfig.enabled ? 'bg-emerald-400' : 'bg-slate-500'}`}></span>
              <span className={`relative inline-flex rounded-full h-2 w-2 ${autoBotConfig.enabled ? 'bg-emerald-500' : 'bg-slate-500'}`}></span>
            </span>
            <span className="text-[10px] font-mono text-slate-400 tracking-widest uppercase">
               {wsStatus === 'connected' ? (autoBotConfig.enabled ? 'WS connected' : 'WS connected · bot off') : wsStatus === 'connecting' ? 'WS connecting' : 'WS disconnected'}
            </span>
         </div>
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
         
         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
             <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Cpu size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Total Executions</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
               {totalExecutions}
            </div>
         </div>

         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <ShieldCheck size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Live Win Rate</span>
            </div>
            <div className="text-2xl font-bold text-emerald-400 font-mono">
               {winRate == null ? 'AWAITING_EVIDENCE' : `${winRate.toFixed(1)}%`}
            </div>
         </div>

         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
             <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Zap size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Total Live PNL</span>
            </div>
            <div className={`text-2xl font-bold font-mono ${upl == null ? 'text-slate-500' : upl >= 0 ? 'text-sky-400' : 'text-rose-400'}`}>
               {upl == null ? 'N/A' : `${upl >= 0 ? '+' : '-'}$${Math.abs(upl).toFixed(2)}`}
            </div>
         </div>
         
         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Clock size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Avg Execution Latency</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
               {latency == null ? '—' : latency.toFixed(0)}{latency != null && <span className="text-sm text-slate-500 ml-1">ms</span>}
            </div>
         </div>

       </div>

       {/* System Hardware State */}
       <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-800 pt-4 mt-2">
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <Cpu size={14} />
                <span className="text-xs font-mono uppercase">Process heap</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${heapPct ?? 0}%` }}></div>
                </div>
                <span className="text-[10px] font-mono text-indigo-400 w-8 text-right">{heapPct == null ? '—' : `${heapPct.toFixed(0)}%`}</span>
             </div>
          </div>
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <HardDrive size={14} />
                <span className="text-xs font-mono uppercase">CPU (per-worker)</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-slate-500 transition-all duration-300" style={{ width: '0%' }}></div>
                </div>
                <span className="text-[10px] font-mono text-slate-500 w-8 text-right">N/A</span>
             </div>
          </div>
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <Network size={14} />
                <span className="text-xs font-mono uppercase">Network Streams</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-slate-500 transition-all duration-300" style={{ width: `0%` }}></div>
                </div>
                <span className="text-[10px] font-mono text-slate-500 w-8 text-right">N/A</span>
             </div>
          </div>
       </div>

    </div>
  );
}
