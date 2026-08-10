/**
 * ==========================================================
 * Module:
 * TradeReplayModal.tsx
 *
 * Purpose:
 * Core implementation and logic for the TradeReplayModal.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for TradeReplayModalx
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
import { X, Play, Pause, SkipBack, FastForward, Activity, BrainCircuit, BarChart2, ShieldCheck, Send, CheckCircle2, XCircle } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function TradeReplayModal({ trade, onClose }: { trade: any, onClose: () => void }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [traceEvents, setTraceEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [explainabilityReport, setExplainabilityReport] = useState<any>(null);
  const [showExplainability, setShowExplainability] = useState(false);

  useEffect(() => {
    const fetchTrace = async () => {
       // Real API fields are camelCase (traceId, not trace_id) - Drizzle rows never had the
       // snake_case shape this modal was reading; the fetches below always silently failed.
       if (trade.traceId) {
          try {
             const expRes = await fetch(`/api/v2/data/explainability/${trade.traceId}`);
             const expData = await expRes.json();
             if (expData.report) {
                 setExplainabilityReport(expData.report);
             }
          } catch(e) {}
       }
       if (trade.traceId) {
          try {
             const res = await fetch(`/api/v2/system/trace/${trade.traceId}`);
             const data = await res.json();
             if (data.trace && data.trace.length > 0) {
                 setTraceEvents(data.trace);
                 setLoading(false);
                 return;
             }
          } catch(e) {}
       }

       // No real trace data available - previously this silently fabricated a 6-event sample
       // trace with no visual indication it wasn't real, which is exactly the "fake
       // observability" this project's own conventions forbid. Leave traceEvents empty; the
       // render path below shows an explicit "no trace data available" state instead.
       setTraceEvents([]);
       setLoading(false);
    };
    fetchTrace();
  }, [trade]);

  useEffect(() => {
    let interval: any;
    if (isPlaying) {
      interval = setInterval(() => {
        setTimelineIndex(prev => {
          if (prev >= traceEvents.length - 1) {
            setIsPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 1500);
    }

    return () => clearInterval(interval);
  }, [isPlaying, traceEvents.length]);

  if (loading) return null;

  if (traceEvents.length === 0) {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
        <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-lg shadow-2xl overflow-hidden animate-fade-in relative flex flex-col font-mono">
          <div className="bg-[#111822] border-b border-slate-800 p-4 flex justify-between items-center">
            <h2 className="text-white font-bold tracking-widest uppercase text-sm">Trade Replay: {trade.symbol}</h2>
            <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors"><X size={20} /></button>
          </div>
          <div className="p-8 flex flex-col items-center text-center gap-3">
            <XCircle size={32} className="text-slate-600" />
            <p className="text-sm font-bold uppercase tracking-widest text-slate-400">No Trace Data Available</p>
            <p className="text-xs text-slate-500 max-w-sm">
              This trade has no persisted event trace to replay - either it predates this
              instance's event history, or no traceId was recorded for it. Nothing is fabricated
              here in its place.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const currentEvent = traceEvents[timelineIndex] || {};
  const chartData = traceEvents.map((e, i) => {
     let price = trade.price;
     if (e.type === 'MARKET_DATA') price = e.payload.price;
     return { time: `Step ${i}`, price: price + (i * (trade.decision === 'BUY' ? 0.5 : -0.5)) };
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-5xl shadow-2xl overflow-hidden animate-fade-in relative flex flex-col font-mono max-h-[90vh]">
        <div className="bg-[#111822] border-b border-slate-800 p-4 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-indigo-500/20 p-2 rounded text-indigo-400">
              <Activity size={18} />
            </div>
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase text-sm">Trade Replay: {trade.symbol}</h2>
              <p className="text-slate-500 text-[10px]">End-to-End Decision Flow Visualization</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
             {explainabilityReport && (
                 <button onClick={() => setShowExplainability(!showExplainability)} className="text-[10px] bg-indigo-500/20 text-indigo-400 px-3 py-1.5 rounded uppercase tracking-widest font-bold hover:bg-indigo-500/30 transition-colors">
                    {showExplainability ? "Hide Explainability Report" : "View Explainability Report"}
                 </button>
             )}
            <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
              <X size={20} />
            </button>
          </div>
        </div>

        <div className="p-6 flex flex-col gap-6 overflow-y-auto">
          {showExplainability && explainabilityReport ? (
              <div className="bg-[#111822] border border-indigo-500/30 rounded p-6">
                 <h3 className="text-sm font-bold uppercase tracking-widest text-indigo-400 mb-4 flex items-center gap-2">
                    <BrainCircuit size={16} /> Human Explainability Report
                 </h3>
                 <div className="prose prose-invert prose-sm max-w-none text-slate-300">
                    {explainabilityReport.reportText.split('\n').map((line: string, i: number) => (
                       <p key={i} className="mb-2 whitespace-pre-wrap">{line}</p>
                    ))}
                 </div>
              </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Left: Journey Timeline */}
              <div className="md:col-span-1 border border-slate-800 bg-[#111822] p-4 rounded flex flex-col gap-3 max-h-[400px] overflow-y-auto">
                 <h3 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">Decision Journey</h3>
                 {traceEvents.map((evt, i) => (
                    <div key={i} className={`flex flex-col p-2 border-l-2 transition-all ${i === timelineIndex ? 'border-emerald-500 bg-slate-800/40' : i < timelineIndex ? 'border-indigo-500/50 opacity-70' : 'border-slate-800 opacity-30'}`}>
                       <span className={`text-[10px] font-bold ${i === timelineIndex ? 'text-emerald-400' : 'text-slate-400'}`}>{evt.type.replace(/_/g, ' ')}</span>
                       <span className="text-[9px] text-slate-500 truncate">{new Date(evt.timestamp || Date.now()).toLocaleTimeString()}</span>
                    </div>
                 ))}
              </div>

              {/* Center: Detail View */}
              <div className="md:col-span-2 flex flex-col gap-4">
                  {/* Event Details Card */}
                  <div className="bg-[#111822] border border-slate-800 rounded p-5 flex flex-col h-[200px] justify-center items-center text-center relative overflow-hidden">
                      <div className="absolute inset-0 bg-gradient-to-t from-transparent to-indigo-500/5 pointer-events-none" />
                      
                      {currentEvent.type === 'MARKET_DATA' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <BarChart2 size={32} className="text-sky-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">Market Data Discovered</h4>
                             <p className="text-sm text-slate-400">Targeting {currentEvent.payload.symbol} at ${currentEvent.payload.price}</p>
                          </div>
                      )}
                      
                      {currentEvent.type === 'CALCULATION_COMPLETED' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <Activity size={32} className="text-amber-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">{currentEvent.payload.engine} Running</h4>
                             <p className="text-xs text-slate-400 mb-2">Analyzing technical parameters...</p>
                             <pre className="text-[10px] text-amber-200 bg-amber-500/10 p-2 rounded text-left w-full max-w-xs overflow-hidden">
                                {JSON.stringify(currentEvent.payload.data, null, 2)}
                             </pre>
                          </div>
                      )}
                      
                      {currentEvent.type === 'TRADE_IDEA_GENERATED' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <BrainCircuit size={32} className="text-indigo-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">{currentEvent.payload.agent}</h4>
                             <div className="text-[11px] bg-indigo-500/20 text-indigo-300 p-2 rounded max-w-md border border-indigo-500/30">
                                <span className="font-bold mr-2 text-indigo-400">IDEA: {currentEvent.payload.side}</span>
                                {currentEvent.payload.reasoning}
                             </div>
                          </div>
                      )}
                      
                      {currentEvent.type === 'CHIEF_APPROVED_IDEA' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <CheckCircle2 size={32} className="text-emerald-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">Chief AI Consensus</h4>
                             <div className="text-[11px] bg-emerald-500/20 text-emerald-300 p-2 rounded max-w-md border border-emerald-500/30">
                                {currentEvent.payload.reasoning}
                             </div>
                          </div>
                      )}
                      
                      {currentEvent.type === 'RISK_ASSESSMENT_COMPLETED' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             {currentEvent.payload.approved ? <ShieldCheck size={32} className="text-emerald-400 mb-3" /> : <XCircle size={32} className="text-rose-400 mb-3" />}
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">Risk Validation</h4>
                             <p className={`text-xs ${currentEvent.payload.approved ? 'text-emerald-400' : 'text-rose-400'}`}>{currentEvent.payload.reasoning}</p>
                             {currentEvent.payload.approved && <p className="text-[10px] text-slate-500 mt-2">Max Sizing: {currentEvent.payload.maxQuantity} shares</p>}
                          </div>
                      )}
                      
                      {currentEvent.type === 'ORDER_EXECUTED' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <Send size={32} className="text-sky-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">Execution Engine</h4>
                             <div className="text-[11px] font-bold tracking-widest text-white mt-1">
                                 {currentEvent.payload.side} {currentEvent.payload.quantity} {currentEvent.payload.symbol} @ ${Number(currentEvent.payload.price).toFixed(2)}
                             </div>
                             <p className="text-[10px] text-slate-500 mt-1">Status: {currentEvent.payload.status}</p>
                          </div>
                      )}
                      
                      {currentEvent.type === 'LEARNED_NEW_RULE' && (
                          <div className="animate-fade-in flex flex-col items-center">
                             <BrainCircuit size={32} className="text-fuchsia-400 mb-3" />
                             <h4 className="text-white font-bold uppercase tracking-widest mb-1">Reflection Engine Update</h4>
                             <div className="text-[11px] bg-fuchsia-500/20 text-fuchsia-300 p-2 rounded max-w-md border border-fuchsia-500/30 mt-2">
                                {currentEvent.payload.rule}
                             </div>
                          </div>
                      )}
                  </div>

                  {/* Price Context Chart */}
                  <div className="bg-[#111822] border border-slate-800 rounded p-4 h-[184px] flex flex-col">
                    <h3 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2 flex items-center gap-2">
                      <BarChart2 size={12} className="text-sky-400" />
                      Simulated Price Trajectory
                    </h3>
                    <div className="flex-1 w-full relative">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={chartData.slice(0, timelineIndex + 1)}>
                          <defs>
                            <linearGradient id="colorPrice" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3}/>
                              <stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/>
                            </linearGradient>
                          </defs>
                          <XAxis dataKey="time" hide />
                          <YAxis hide domain={['dataMin - 5', 'dataMax + 5']} />
                          <Tooltip contentStyle={{ backgroundColor: '#111822', borderColor: '#1e293b', fontSize: '10px' }} />
                          <Area type="stepAfter" dataKey="price" stroke="#38bdf8" fillOpacity={1} fill="url(#colorPrice)" isAnimationActive={false} />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
              </div>
            </div>
          )}

          {/* Transport Controls */}
          <div className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col gap-4">
             <div className="flex justify-between items-center">
                <button onClick={() => { setTimelineIndex(0); setIsPlaying(false); }} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors">
                  <SkipBack size={14} />
                </button>
                <button onClick={() => setIsPlaying(!isPlaying)} className={`px-6 py-2 flex items-center gap-2 rounded font-bold tracking-widest uppercase text-[10px] transition-colors ${isPlaying ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50 hover:bg-amber-500/30' : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500/30'}`}>
                  {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                  {isPlaying ? "Pause" : "Play Replay"}
                </button>
                <button onClick={() => { setTimelineIndex(traceEvents.length - 1); setIsPlaying(false); }} className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition-colors">
                  <FastForward size={14} />
                </button>
             </div>
             <div className="relative pt-4 pb-2">
                <input type="range" min="0" max={traceEvents.length - 1} value={timelineIndex} onChange={(e) => { setTimelineIndex(parseInt(e.target.value)); setIsPlaying(false); }} className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500" />
             </div>
          </div>

        </div>
      </div>
    </div>
  );
}
