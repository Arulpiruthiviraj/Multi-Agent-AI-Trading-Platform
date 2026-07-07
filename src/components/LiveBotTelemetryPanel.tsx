import React, { useState, useEffect } from 'react';
import { Activity, Cpu, HardDrive, Network, Zap, Clock, ShieldCheck, Crosshair } from 'lucide-react';

export default function LiveBotTelemetryPanel({ autoBotConfig }: { autoBotConfig: any }) {
  const [latency, setLatency] = useState(14);
  const [cpuUsage, setCpuUsage] = useState(32);
  const [memUsage, setMemUsage] = useState(45);
  
  // Simulate active changing hardware metrics
  useEffect(() => {
    if(!autoBotConfig.enabled) return;
    const interval = setInterval(() => {
      setLatency(prev => Math.max(5, Math.min(120, prev + (Math.random() * 10 - 5))));
      setCpuUsage(prev => Math.max(10, Math.min(95, prev + (Math.random() * 14 - 7))));
      setMemUsage(prev => Math.max(20, Math.min(85, prev + (Math.random() * 4 - 2))));
    }, 1000);
    return () => clearInterval(interval);
  }, [autoBotConfig.enabled]);

  // Derive simulated trading metrics based on budget spent
  const spent = autoBotConfig.spent || 0;
  const estimatedTrades = Math.floor(spent / (autoBotConfig.maxTradeSize || 1000) * 1.5);
  const simulatedWinRate = autoBotConfig.enabled ? (65 + (Math.random() * 5)).toFixed(1) : "0.0";
  const simulatedUpl = autoBotConfig.enabled ? ((spent * 0.045) * (Math.random() * 0.4 + 0.8)).toFixed(2) : "0.00";
  
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
               {autoBotConfig.enabled ? 'Connection Stable' : 'System Offline'}
            </span>
         </div>
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
         
         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Crosshair size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Est. Executions</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
               {estimatedTrades}
            </div>
         </div>

         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <ShieldCheck size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Sim. Win Rate</span>
            </div>
            <div className="text-2xl font-bold text-emerald-400 font-mono">
               {simulatedWinRate}%
            </div>
         </div>

         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Zap size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Est. Unrealized PNL</span>
            </div>
            <div className="text-2xl font-bold text-sky-400 font-mono">
               +${simulatedUpl}
            </div>
         </div>
         
         <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
            <div className="flex items-center gap-2 text-slate-500 mb-2">
               <Clock size={12} />
               <span className="text-[10px] uppercase font-mono tracking-widest">Avg Execution Latency</span>
            </div>
            <div className="text-2xl font-bold text-white font-mono">
               {latency.toFixed(0)}<span className="text-sm text-slate-500 ml-1">ms</span>
            </div>
         </div>

       </div>

       {/* System Hardware Mock */}
       <div className="grid grid-cols-1 md:grid-cols-3 gap-4 border-t border-slate-800 pt-4 mt-2">
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <Cpu size={14} />
                <span className="text-xs font-mono uppercase">AI Core CPU Load</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${cpuUsage}%` }}></div>
                </div>
                <span className="text-[10px] font-mono text-indigo-400 w-8 text-right">{cpuUsage.toFixed(0)}%</span>
             </div>
          </div>
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <HardDrive size={14} />
                <span className="text-xs font-mono uppercase">Vector DB Mem</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${memUsage}%` }}></div>
                </div>
                <span className="text-[10px] font-mono text-emerald-400 w-8 text-right">{memUsage.toFixed(0)}%</span>
             </div>
          </div>
          <div className="flex items-center justify-between">
             <div className="flex items-center gap-2 text-slate-400">
                <Network size={14} />
                <span className="text-xs font-mono uppercase">Network Streams</span>
             </div>
             <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 bg-slate-800 rounded overflow-hidden">
                   <div className="h-full bg-sky-500 transition-all duration-300" style={{ width: `${autoBotConfig.enabled ? 88 : 0}%` }}></div>
                </div>
                <span className="text-[10px] font-mono text-sky-400 w-8 text-right">{autoBotConfig.enabled ? '88' : '0'}%</span>
             </div>
          </div>
       </div>

    </div>
  );
}
