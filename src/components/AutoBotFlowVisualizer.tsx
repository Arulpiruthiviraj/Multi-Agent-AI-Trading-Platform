import React from 'react';
import { BrainCircuit, Search, ArrowRight, ShieldCheck, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';

interface AutoBotFlowVisualizerProps {
  cycle: any;
}

export default function AutoBotFlowVisualizer({ cycle }: AutoBotFlowVisualizerProps) {
  if (!cycle) {
    return (
      <div className="flex flex-col items-center justify-center h-40 text-slate-500 font-mono text-xs italic opacity-50">
        <BrainCircuit size={32} className="mb-2 text-slate-700" />
        Waiting for next scan cycle...
      </div>
    );
  }

  const { status, symbol, amount, researchData, proposerData, riskData, executionData, finalAction } = cycle;

  return (
    <div className="relative h-64 flex items-center justify-between px-2 w-full font-mono mt-8 mb-4">
      
      {/* 1. SCAN / RESEARCH NODE */}
      <div className={`relative flex flex-col items-center z-10 transition-all duration-500 ${(status === 'scanning' || status === 'researching') ? 'scale-110' : 'opacity-70'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg mb-2 ${(status === 'scanning' || status === 'researching') ? 'bg-sky-500/20 border-sky-400 text-sky-400 animate-pulse shadow-sky-500/20' : researchData ? 'bg-sky-900 border-sky-700 text-sky-400' : 'bg-slate-800 border-slate-600 text-slate-400'}`}>
          <Search size={18} />
        </div>
        <span className="text-[9px] uppercase tracking-widest font-bold text-slate-300">Macro<br/>Research</span>
        {symbol && (
          <div className="absolute top-14 mt-6 whitespace-nowrap text-center">
            <span className="text-xs font-bold text-sky-400 bg-sky-900/30 px-2 py-0.5 rounded block mb-1">{symbol}</span>
            {researchData && <span className={`text-[9px] ${researchData.sentiment === 'BULLISH' ? 'text-emerald-500' : researchData.sentiment === 'BEARISH' ? 'text-rose-500' : 'text-slate-500'}`}>{researchData.sentiment}</span>}
          </div>
        )}
        {(status === 'scanning' || status === 'researching') && (
           <div className="absolute top-28 w-40 bg-sky-900/40 border border-sky-700 text-sky-300 text-[9px] p-2 rounded shadow-lg animate-pulse whitespace-normal text-center z-20">
              <span className="flex items-center justify-center gap-1"><BrainCircuit size={10} className="animate-spin" /> Thinking...</span>
           </div>
        )}
        {researchData?.thinking && status !== 'scanning' && status !== 'researching' && (
           <div className="absolute top-28 w-40 bg-[#1A1F2B] border border-sky-900 text-sky-400/80 text-[8px] p-2 rounded shadow-lg whitespace-normal text-center z-20 transition-all hover:text-sky-300">
              "{researchData.thinking}"
           </div>
        )}
      </div>

      <div className={`flex-1 h-px bg-gradient-to-r transition-all duration-700 mx-2 ${(status === 'proposing' || status === 'verifying' || status === 'optimizing' || status === 'executed' || status === 'vetoed' || status === 'rejected') ? 'from-sky-500 to-indigo-500' : 'from-slate-700 to-slate-700'}`}></div>

      {/* 2. PROPOSER NODE */}
      <div className={`relative flex flex-col items-center z-10 transition-all duration-500 ${status === 'proposing' ? 'scale-110' : status === 'rejected' ? 'opacity-80' : 'opacity-70'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg mb-2 ${status === 'proposing' ? 'bg-indigo-500/20 border-indigo-400 text-indigo-400 animate-pulse shadow-indigo-500/20' : proposerData?.decision ? (proposerData.decision === 'HOLD' ? 'bg-slate-800 border-slate-500 text-slate-500' : 'bg-indigo-900 border-indigo-700 text-indigo-400') : 'bg-slate-800 border-slate-600 text-slate-400'}`}>
          <BrainCircuit size={18} />
        </div>
        <span className="text-[9px] uppercase tracking-widest font-bold text-slate-300">Proposer<br/>Agent</span>
        {proposerData && (
          <div className="absolute top-14 mt-6 whitespace-nowrap text-center">
            <span className={`text-xs font-bold px-2 py-0.5 rounded block mb-1 ${proposerData.decision === 'HOLD' ? 'bg-slate-800 text-slate-400' : proposerData.decision === 'BUY' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>{proposerData.decision}</span>
            <span className={`text-[9px] ${proposerData.confidence > 75 ? 'text-emerald-500' : 'text-amber-500'}`}>Conf: {proposerData.confidence}%</span>
          </div>
        )}
        {status === 'proposing' && (
           <div className="absolute top-28 w-40 bg-indigo-900/40 border border-indigo-700 text-indigo-300 text-[9px] p-2 rounded shadow-lg animate-pulse whitespace-normal text-center z-20">
              <span className="flex items-center justify-center gap-1"><BrainCircuit size={10} className="animate-spin" /> Thinking...</span>
           </div>
        )}
        {proposerData?.thinking && status !== 'proposing' && (
           <div className="absolute top-28 w-40 bg-[#1A1F2B] border border-indigo-900 text-indigo-400/80 text-[8px] p-2 rounded shadow-lg whitespace-normal text-center z-20 transition-all hover:text-indigo-300">
              "{proposerData.thinking}"
           </div>
        )}
        {status === 'rejected' && <XCircle size={28} className="absolute text-rose-500 drop-shadow-md right-[-8px] top-[-8px]" />}
      </div>

      <div className={`flex-1 h-px bg-gradient-to-r transition-all duration-700 mx-2 ${(status === 'verifying' || status === 'optimizing' || status === 'executed' || status === 'vetoed') ? 'from-indigo-500 to-amber-500' : 'from-slate-700 to-slate-700'}`}></div>

      {/* 3. RISK MGR NODE */}
      <div className={`relative flex flex-col items-center z-10 transition-all duration-500 ${status === 'verifying' ? 'scale-110' : status === 'vetoed' ? 'opacity-80' : 'opacity-70'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg mb-2 ${status === 'verifying' ? 'bg-amber-500/20 border-amber-400 text-amber-400 animate-pulse shadow-amber-500/20' : riskData?.verdict ? 'bg-amber-900/50 border-amber-700 text-amber-500' : 'bg-slate-800 border-slate-600 text-slate-400'}`}>
          <ShieldCheck size={18} />
        </div>
        <span className="text-[9px] uppercase tracking-widest font-bold text-slate-300">Risk<br/>Manager</span>
        {riskData && (
          <div className="absolute top-14 mt-6 whitespace-nowrap text-center">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded block ${riskData.verdict === 'APPROVE' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-rose-500/20 text-rose-400'}`}>{riskData.verdict}</span>
          </div>
        )}
        {status === 'verifying' && (
           <div className="absolute top-28 w-40 bg-amber-900/40 border border-amber-700 text-amber-300 text-[9px] p-2 rounded shadow-lg animate-pulse whitespace-normal text-center z-20">
              <span className="flex items-center justify-center gap-1"><BrainCircuit size={10} className="animate-spin" /> Thinking...</span>
           </div>
        )}
        {riskData?.thinking && status !== 'verifying' && (
           <div className="absolute top-28 w-40 bg-[#1A1F2B] border border-amber-900/50 text-amber-400/80 text-[8px] p-2 rounded shadow-lg whitespace-normal text-center z-20 transition-all hover:text-amber-300">
              "{riskData.thinking}"
           </div>
        )}
        {status === 'vetoed' && <XCircle size={28} className="absolute text-rose-500 drop-shadow-md right-[-8px] top-[-8px]" />}
      </div>
      
      <div className={`flex-1 h-px bg-gradient-to-r transition-all duration-700 mx-2 ${(status === 'optimizing' || status === 'executed') ? 'from-amber-500 to-fuchsia-500' : 'from-slate-700 to-slate-700'}`}></div>

      {/* 4. EXECUTION AGENT NODE */}
      <div className={`relative flex flex-col items-center z-10 transition-all duration-500 ${status === 'optimizing' ? 'scale-110' : 'opacity-70'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg mb-2 ${status === 'optimizing' ? 'bg-fuchsia-500/20 border-fuchsia-400 text-fuchsia-400 animate-pulse shadow-fuchsia-500/20' : executionData?.strategy ? 'bg-fuchsia-900/50 border-fuchsia-700 text-fuchsia-500' : 'bg-slate-800 border-slate-600 text-slate-400'}`}>
          <BrainCircuit size={18} />
        </div>
        <span className="text-[9px] uppercase tracking-widest font-bold text-slate-300">Execution<br/>Agent</span>
        {executionData && (
          <div className="absolute top-14 mt-6 whitespace-nowrap text-center">
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded block bg-fuchsia-500/20 text-fuchsia-400 mb-1`}>{executionData.strategy}</span>
            <span className={`text-[9px] text-slate-500`}>Max Slip: {executionData.maxSlippage}%</span>
          </div>
        )}
        {status === 'optimizing' && (
           <div className="absolute top-28 w-40 bg-fuchsia-900/40 border border-fuchsia-700 text-fuchsia-300 text-[9px] p-2 rounded shadow-lg animate-pulse whitespace-normal text-center z-20">
              <span className="flex items-center justify-center gap-1"><BrainCircuit size={10} className="animate-spin" /> Thinking...</span>
           </div>
        )}
        {executionData?.thinking && status !== 'optimizing' && (
           <div className="absolute top-28 w-40 bg-[#1A1F2B] border border-fuchsia-900/50 text-fuchsia-400/80 text-[8px] p-2 rounded shadow-lg whitespace-normal text-center z-20 transition-all hover:text-fuchsia-300">
              "{executionData.thinking}"
           </div>
        )}
      </div>

      <div className={`flex-1 h-px bg-gradient-to-r transition-all duration-700 mx-2 ${status === 'executed' ? 'from-fuchsia-500 to-emerald-500' : 'from-slate-700 to-slate-700'}`}></div>

      {/* 5. BROKER RELAY NODE */}
      <div className={`relative flex flex-col items-center z-10 transition-all duration-500 ${status === 'executed' ? 'scale-110 opacity-100' : 'opacity-50'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 shadow-lg mb-2 ${status === 'executed' ? 'bg-emerald-500/20 border-emerald-400 text-emerald-400 animate-pulse shadow-emerald-500/20' : 'bg-slate-800 border-slate-600 text-slate-400'}`}>
          <CheckCircle2 size={18} />
        </div>
        <span className="text-[9px] uppercase tracking-widest font-bold text-slate-300">Broker<br/>Relay</span>
        {finalAction === 'EXECUTED' && (
          <div className="absolute top-14 mt-6 whitespace-nowrap text-center">
             <span className="text-xs font-bold text-emerald-400 bg-emerald-900/30 px-2 py-0.5 rounded block">DEPLOYED</span>
          </div>
        )}
      </div>

      {/* GATING TELEMETRY STATUS BAR */}
      {cycle.currentATR !== undefined && (
        <div className="absolute bottom-[-32px] left-0 right-0 mx-auto max-w-xl bg-slate-900/90 border border-slate-850 rounded px-3 py-1.5 flex items-center justify-between text-[10px] text-slate-400 gap-4 shadow-md backdrop-blur z-20">
          <div className="flex items-center gap-1">
            <span className="text-slate-500 uppercase tracking-widest font-bold">ATR-14:</span>
            <span className="font-bold text-amber-400 font-mono">${cycle.currentATR.toFixed(2)}</span>
          </div>
          <div className="w-px h-3 bg-slate-800"></div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 uppercase tracking-widest font-bold">Forced SL (1.5x):</span>
            <span className="font-bold text-rose-400 font-mono">${cycle.atrStopLoss.toFixed(2)}</span>
          </div>
          <div className="w-px h-3 bg-slate-800"></div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 uppercase tracking-widest font-bold">Max Sizing:</span>
            <span className="font-bold text-sky-400 font-mono">{Math.floor(cycle.maxShares)} shares</span>
          </div>
          <div className="w-px h-3 bg-slate-800"></div>
          <div className="flex items-center gap-1">
            <span className="text-slate-500 uppercase tracking-widest font-bold">Allocated:</span>
            <span className="font-bold text-emerald-400 font-mono">${cycle.amount.toFixed(2)}</span>
          </div>
        </div>
      )}

    </div>
  );
}
