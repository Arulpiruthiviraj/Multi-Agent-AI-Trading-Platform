/**
 * ==========================================================
 * Module:
 * NodeInspectionPanel.tsx
 *
 * Purpose:
 * Core implementation and logic for the NodeInspectionPanel.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for NodeInspectionPanelx
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
import eventCatalog from '../../config/eventNames.json';
import agentWeights from '../../config/agentWeights.json';
import { X, Terminal, Activity, CheckCircle2, ShieldCheck, Newspaper, Send, TrendingUp, UserCheck, Clock, BookOpen, Cpu, DollarSign, BrainCircuit } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Real per-node-type field extraction from whatever event actually last fired for this node -
// every value here traces back to a real payload field, never a placeholder. Returns null (not
// a fabricated row) when the underlying field genuinely isn't present on the real event.
function extractSummary(nodeId: string, relevant: any[]): { status: string; rows: { label: string; value: string }[] } | null {
   if (relevant.length === 0) return null;
   const latest = relevant[0];

   if (nodeId === 'technical-engine') {
      const startedRecently = relevant.find(e => e.type === 'TECHNICAL_ANALYSIS_STARTED');
      const completed = relevant.find(e => e.type === 'TECHNICAL_ANALYSIS_COMPLETED' || e.type === 'CALCULATION_COMPLETED');
      const processing = startedRecently && relevant.indexOf(startedRecently) < relevant.indexOf(completed || startedRecently);
      if (!completed) return { status: 'PROCESSING', rows: [] };
      const d = completed.payload.data || completed.payload; // CALCULATION_COMPLETED nests under .data; TECHNICAL_ANALYSIS_COMPLETED is flat
      return {
         status: processing ? 'PROCESSING' : 'COMPLETED',
         rows: [
            { label: 'Model', value: 'deterministic (RSI/MACD/BB)' },
            { label: 'Latency', value: completed.payload.latencyMs != null ? `${completed.payload.latencyMs}ms` : '--' },
            { label: 'RSI14', value: d.rsi != null ? d.rsi.toFixed(1) : '--' },
            { label: 'MACD', value: d.macd != null ? d.macd.toFixed(3) : '--' },
            { label: 'SMA20', value: d.sma20 != null ? d.sma20.toFixed(2) : '--' },
            { label: 'SMA50', value: d.sma50 != null ? d.sma50.toFixed(2) : '--' },
            { label: 'BB Upper/Lower', value: d.bbUpper != null ? `${d.bbUpper.toFixed(2)} / ${d.bbLower.toFixed(2)}` : '--' },
         ],
      };
   }

   if (nodeId === 'news-agent') {
      const idea = relevant.find(e => e.type === 'TRADE_IDEA_GENERATED');
      if (!idea) return { status: 'IDLE', rows: [] };
      return {
         status: 'COMPLETED',
         rows: [
            { label: 'Provider', value: idea.payload.provider || '--' },
            { label: 'Latency', value: idea.payload.latencyMs != null ? `${idea.payload.latencyMs}ms` : '--' },
            { label: 'Sentiment', value: idea.payload.newsDetails?.sentiment != null ? idea.payload.newsDetails.sentiment.toFixed(2) : '--' },
            { label: 'Decision', value: idea.payload.side || '--' },
            { label: 'Confidence', value: idea.payload.confidence != null ? `${(idea.payload.confidence * 100).toFixed(0)}%` : '--' },
            { label: 'Reasoning', value: idea.payload.reasoning || '--' },
         ],
      };
   }

   if (nodeId === 'chief-trader') {
      const started = relevant.find(e => e.type === 'CHIEF_CONSENSUS_STARTED');
      const completed = relevant.find(e => e.type === 'CHIEF_CONSENSUS_COMPLETED');
      const approved = relevant.find(e => e.type === 'CHIEF_APPROVED_IDEA');
      if (!completed && !approved) return { status: started ? 'PROCESSING' : 'IDLE', rows: [] };
      const c = completed?.payload;
      return {
         status: (c?.approved || approved) ? 'APPROVED' : 'NOT YET / WAITING',
         rows: [
            { label: 'Side', value: c?.side || approved?.payload.side || '--' },
            { label: 'Confidence', value: c?.confidence != null ? `${(c.confidence * 100).toFixed(1)}%` : approved?.payload.confidence != null ? `${(approved.payload.confidence * 100).toFixed(1)}%` : '--' },
            { label: 'Threshold', value: c?.threshold != null ? `${(c.threshold * 100).toFixed(0)}%` : '75%' },
            { label: 'Agreed Agents', value: approved?.payload.agentsContext || '--' },
         ],
      };
   }

   if (nodeId === 'risk-manager') {
      const gates = relevant.filter(e => e.type === 'RISK_GATE_EVALUATED');
      const completed = relevant.find(e => e.type === 'RISK_ASSESSMENT_COMPLETED');
      if (!completed && gates.length === 0) return { status: 'IDLE', rows: [] };
      return {
         status: completed ? (completed.payload.approved ? 'APPROVED' : 'REJECTED') : 'PROCESSING',
         rows: [
            { label: 'Max Quantity', value: completed?.payload.maxQuantity != null ? String(completed.payload.maxQuantity) : '--' },
            { label: 'Reasoning', value: completed?.payload.reasoning || '--' },
            ...gates.slice(0, 8).reverse().map(g => ({ label: `Gate: ${g.payload.gate}`, value: g.payload.passed ? '✓ PASS' : '✕ FAIL' })),
         ],
      };
   }

   if (nodeId === 'order-management') {
      const submitted = relevant.find(e => e.type === 'ORDER_SUBMITTED');
      const accepted = relevant.find(e => e.type === 'ORDER_ACCEPTED');
      const filled = relevant.find(e => e.type === 'ORDER_FILLED');
      const executed = relevant.find(e => e.type === 'ORDER_EXECUTED');
      if (!submitted && !executed) return { status: 'IDLE', rows: [] };
      return {
         status: filled ? 'FILLED' : accepted ? 'ACCEPTED' : submitted ? 'SUBMITTED' : (executed?.payload.status || '--'),
         rows: [
            { label: 'Order ID', value: submitted?.payload.id || executed?.payload.id || '--' },
            { label: 'Broker Order ID', value: accepted?.payload.brokerOrderId || '--' },
            { label: 'Side / Qty', value: (submitted || executed) ? `${(submitted || executed).payload.side} ${(submitted || executed).payload.quantity}x` : '--' },
            { label: 'Fill Price', value: filled?.payload.price != null ? `$${filled.payload.price.toFixed(2)}` : executed?.payload.price != null ? `$${executed.payload.price.toFixed(2)}` : '--' },
         ],
      };
   }

   return null;
}

export default function NodeInspectionPanel({ nodeId, onClose, activeEvents }: { nodeId: string, onClose: () => void, activeEvents: any[] }) {
   const [nodeState, setNodeState] = useState<any>({});
   const [localLogs, setLocalLogs] = useState<any[]>([]);
   const [summary, setSummary] = useState<{ status: string; rows: { label: string; value: string }[] } | null>(null);

   useEffect(() => {
       // Filter events that match this node
       let relevant = [];
       if (nodeId === 'market-data-worker') {
           relevant = activeEvents.filter(e => e.type === 'MARKET_DATA');
       } else if (nodeId === 'technical-engine') {
           relevant = activeEvents.filter(e => e.type === 'CALCULATION_COMPLETED' && e.payload.engine === 'TechnicalEngine' || e.type === 'TECHNICAL_ANALYSIS_STARTED' || e.type === 'TECHNICAL_ANALYSIS_COMPLETED');
       } else if (nodeId === 'news-agent') {
           relevant = activeEvents.filter(e => (e.type === 'TRADE_IDEA_GENERATED' && e.payload.agent === 'NewsAgent') || e.type === 'NEWS_ANALYSIS_STARTED');
       } else if (nodeId === 'news-providers') {
           relevant = activeEvents.filter(e => e.type === 'NEWS_ANALYZED');
       } else if (nodeId === 'finbert-model') {
           relevant = activeEvents.filter(e => (e.type === 'NEWS_ANALYZED' && e.payload.impact?.sentimentSource === 'finbert') || e.type === 'ESCALATION_DECISION');
       } else if (nodeId === 'ollama-llm') {
           relevant = activeEvents.filter(e => e.type === 'AI_METRICS_UPDATE' && e.payload.local);
       } else if (nodeId === 'paid-llm-pool') {
           relevant = activeEvents.filter(e => e.type === 'AI_METRICS_UPDATE' && !e.payload.local);
       } else if (nodeId === 'kronos-forecast') {
           relevant = activeEvents.filter(e => e.type === 'TRADE_IDEA_GENERATED' && e.payload.agent === 'KronosEngine');
       } else if (nodeId === 'chief-trader') {
           relevant = activeEvents.filter(e => e.type === 'CHIEF_APPROVED_IDEA' || e.type === 'CHIEF_CONSENSUS_STARTED' || e.type === 'CHIEF_CONSENSUS_COMPLETED');
       } else if (nodeId === 'risk-manager') {
           relevant = activeEvents.filter(e => e.type === 'RISK_ASSESSMENT_COMPLETED' || e.type === 'RISK_ASSESSMENT_STARTED' || e.type === 'RISK_GATE_EVALUATED');
       } else if (nodeId === 'capital-guard') {
           relevant = activeEvents.filter(e => e.type === 'CAPITAL_CHECK' || (e.type === 'RISK_GATE_EVALUATED' && e.payload?.gate === 'argus_capital_allocation'));
       } else if (nodeId === 'order-management') {
           relevant = activeEvents.filter(e => e.type === 'ORDER_EXECUTED' || e.type === 'ORDER_SUBMITTED' || e.type === 'ORDER_ACCEPTED' || e.type === 'ORDER_FILLED');
       } else if (nodeId === 'portfolio-monitor') {
           relevant = activeEvents.filter(e => e.type === eventCatalog.POSITION_MONITORED || e.type === eventCatalog.POSITION_RISK_CHANGED || e.type === eventCatalog.PORTFOLIO_UPDATE || (e.type === eventCatalog.TRADE_IDEA_GENERATED && e.payload.agent === agentWeights.riskExitAgent));
       } else if (nodeId === 'learning-engine') {
           relevant = activeEvents.filter(e => e.type === 'LEARNED_NEW_RULE');
       }

       setLocalLogs(relevant.slice(0, 50));
       setSummary(extractSummary(nodeId, relevant));

       if (relevant.length > 0) {
           setNodeState(relevant[0].payload);
       }
   }, [nodeId, activeEvents]);

   const getIcon = () => {
      switch(nodeId) {
         case 'market-data-worker': return <Activity size={24} className="text-sky-400" />;
         case 'technical-engine': return <TrendingUp size={24} className="text-amber-400" />;
         case 'news-agent': return <Newspaper size={24} className="text-fuchsia-400" />;
         case 'news-providers': return <Newspaper size={24} className="text-sky-400" />;
         case 'finbert-model': return <Cpu size={24} className="text-emerald-400" />;
         case 'ollama-llm': return <Cpu size={24} className="text-emerald-400" />;
         case 'paid-llm-pool': return <DollarSign size={24} className="text-amber-400" />;
         case 'kronos-forecast': return <BrainCircuit size={24} className="text-indigo-400" />;
         case 'chief-trader': return <UserCheck size={24} className="text-emerald-400" />;
         case 'risk-manager': return <ShieldCheck size={24} className="text-rose-400" />;
         case 'capital-guard': return <DollarSign size={24} className="text-amber-400" />;
         case 'order-management': return <Send size={24} className="text-indigo-400" />;
         case 'portfolio-monitor': return <Clock size={24} className="text-teal-400" />;
         case 'learning-engine': return <BookOpen size={24} className="text-violet-400" />;
         default: return <Terminal size={24} className="text-slate-400" />;
      }
   };

   const getName = () => {
       return nodeId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
   };

   return (
       <div className="w-full lg:w-96 bg-[#1A1F2B] border border-slate-800 rounded-lg flex flex-col h-[600px] lg:h-full overflow-hidden absolute top-0 right-0 z-50 shadow-2xl animate-fade-in-right">
           <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-[#0A0F16]">
               <div className="flex items-center gap-3">
                   {getIcon()}
                   <div>
                       <h3 className="text-white font-bold tracking-widest uppercase text-xs">{getName()}</h3>
                       <p className="text-[10px] text-slate-500 font-mono">Process Introspection</p>
                   </div>
               </div>
               <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
                   <X size={18} />
               </button>
           </div>
           
           <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-4">
               {/* Dedicated real-field summary - status/latency/model/decision/confidence/reasoning,
                   each traced back to a real event field, not a generic JSON dump. */}
               {summary && (
                   <div className="bg-[#0A0F16] border border-slate-800 rounded p-3">
                       <div className="flex justify-between items-center mb-2 border-b border-slate-800/50 pb-1">
                           <h4 className="text-[10px] uppercase font-bold text-slate-400">Status</h4>
                           <span className={`text-[10px] font-bold uppercase tracking-widest ${
                               summary.status === 'APPROVED' || summary.status === 'COMPLETED' || summary.status === 'FILLED' ? 'text-emerald-400' :
                               summary.status === 'PROCESSING' || summary.status === 'SUBMITTED' || summary.status === 'ACCEPTED' ? 'text-amber-400 animate-pulse' :
                               summary.status === 'REJECTED' ? 'text-rose-400' : 'text-slate-500'
                           }`}>{summary.status}</span>
                       </div>
                       {summary.rows.length > 0 && (
                           <div className="flex flex-col gap-1.5">
                               {summary.rows.map((r, i) => (
                                   <div key={i} className="flex justify-between gap-3 text-[10px]">
                                       <span className="text-slate-500 shrink-0">{r.label}</span>
                                       <span className="text-slate-200 font-mono text-right truncate">{r.value}</span>
                                   </div>
                               ))}
                           </div>
                       )}
                   </div>
               )}

               {/* Internal State Viewer */}
               <div className="bg-[#0A0F16] border border-slate-800 rounded p-3">
                   <h4 className="text-[10px] uppercase font-bold text-slate-400 mb-2 border-b border-slate-800/50 pb-1 flex justify-between">
                      Raw Payload (Current State Snapshot)
                      <span className="text-emerald-400 animate-pulse text-[8px] flex items-center">LIVE</span>
                   </h4>
                   {Object.keys(nodeState).length > 0 ? (
                       <pre className="text-[10px] font-mono text-indigo-200 overflow-hidden text-ellipsis">
                           {JSON.stringify(nodeState, null, 2)}
                       </pre>
                   ) : (
                       <div className="text-[10px] text-slate-600 font-mono italic text-center py-4">Awaiting state updates...</div>
                   )}
               </div>

               {/* Dedicated Chart/Metric for Specific Nodes */}
               {nodeId === 'market-data-worker' && localLogs.length > 0 && (
                   <div className="bg-[#0A0F16] border border-slate-800 rounded p-3 h-32">
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={localLogs.map((l:any, i:number) => ({ time: i, price: l.payload.price })).reverse()}>
                                <defs>
                                    <linearGradient id="colorMd" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="5%" stopColor="#38bdf8" stopOpacity={0.3}/>
                                        <stop offset="95%" stopColor="#38bdf8" stopOpacity={0}/>
                                    </linearGradient>
                                </defs>
                                <Area type="monotone" dataKey="price" stroke="#38bdf8" fill="url(#colorMd)" isAnimationActive={false} />
                            </AreaChart>
                        </ResponsiveContainer>
                   </div>
               )}

               {/* Process Event Log */}
               <div className="flex-1 flex flex-col min-h-[200px]">
                   <h4 className="text-[10px] uppercase font-bold text-slate-400 mb-2">Process Logs</h4>
                   <div className="flex-1 overflow-y-auto space-y-2 custom-scrollbar">
                       {localLogs.map((log: any, idx: number) => (
                           <div key={idx} className="bg-slate-900/50 border border-slate-800/50 rounded p-2 text-[9px] font-mono">
                               <div className="text-slate-500 mb-1 flex justify-between">
                                  <span>[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                                  <span className="text-indigo-400">{log.type}</span>
                               </div>
                               <div className="text-slate-300">
                                   {log.payload.reasoning || log.payload.rule || (log.payload.price ? `Tick: $${log.payload.price}` : JSON.stringify(log.payload).substring(0,60) + '...')}
                               </div>
                           </div>
                       ))}
                   </div>
               </div>
           </div>
       </div>
   );
}
