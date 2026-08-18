/**
 * ==========================================================
 * Module:
 * LiveTradeJourneyOverlay.tsx
 *
 * Purpose:
 * Core implementation and logic for the LiveTradeJourneyOverlay.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for LiveTradeJourneyOverlayx
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

import React, { useState, useEffect, useMemo } from 'react';
import ReactFlow, { Background, Controls, Edge, Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { JourneyNode } from './journeyFlowTypes';
import { X, Play, Activity, TrendingUp, Newspaper, UserCheck, ShieldCheck, Send, CheckCircle2 } from 'lucide-react';
import { useEventBusTrace } from '../hooks/useEventBusTrace';

export default function LiveTradeJourneyOverlay({ trade, onClose }: { trade: any, onClose: () => void }) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const traceEvents = useEventBusTrace(trade?.trace_id || null);
  const timelineIndex = traceEvents.length > 0 ? traceEvents.length - 1 : 0;
  const flowNodeTypes = useMemo(() => ({ journey: JourneyNode }), []);

  useEffect(() => {
     if (traceEvents.length === 0) return;
     // Rebuild nodes and edges based on timelineIndex
     const activeTypes = traceEvents.slice(0, timelineIndex + 1).map(e => e.type);
     const currentEvent = traceEvents[timelineIndex] || {};
     
     const hasMarket = activeTypes.includes('MARKET_DATA');
     const hasTech = activeTypes.includes('CALCULATION_COMPLETED') || activeTypes.includes('TRADE_IDEA_GENERATED');
     const hasNews = traceEvents.some(e => e.type === 'TRADE_IDEA_GENERATED' && e.payload?.agent === 'NewsAgent') && timelineIndex >= 2;
     const hasChief = activeTypes.includes('CHIEF_APPROVED_IDEA');
     const hasRisk = activeTypes.includes('RISK_ASSESSMENT_COMPLETED');
     const hasExec = activeTypes.includes('ORDER_EXECUTED');

     const newNodes: Node[] = [
       { id: 'start', type: 'journey', position: { x: 250, y: 50 }, data: { label: 'Opportunity Detected', icon: <Activity size={18}/>, active: hasMarket, description: hasMarket ? `Tick on ${trade.symbol}` : 'Awaiting data...' } },
       { id: 'calc-tech', type: 'journey', position: { x: 100, y: 200 }, data: { label: 'Technical Engine', icon: <TrendingUp size={18}/>, active: hasTech, description: hasTech ? 'Analyzed Momentum' : '...' } },
       { id: 'calc-news', type: 'journey', position: { x: 400, y: 200 }, data: { label: 'News Sentiment', icon: <Newspaper size={18}/>, active: hasNews, description: hasNews ? `Analyzed Sentiment ${(traceEvents.find(e => e.type === 'TRADE_IDEA_GENERATED' && e.payload?.agent === 'NewsAgent')?.payload?.newsDetails?.confidence * 100 || 0).toFixed(0)}%` : '...' } },
       { id: 'chief', type: 'journey', position: { x: 250, y: 350 }, data: { label: 'Chief Debate', icon: <UserCheck size={18}/>, active: hasChief, description: hasChief ? 'Approved Trade' : '...' } },
       { id: 'risk', type: 'journey', position: { x: 250, y: 500 }, data: { label: 'Risk Constraint', icon: <ShieldCheck size={18}/>, active: hasRisk, description: hasRisk ? 'Veto/Size Limits checked' : '...' } },
       { id: 'exec', type: 'journey', position: { x: 250, y: 650 }, data: { label: 'Execution', icon: <Send size={18}/>, active: hasExec, description: hasExec ? `${trade.side || trade.decision} ${trade.symbol} Fired` : '...' } }
     ];

     const newEdges: Edge[] = [
       { id: 'e1', source: 'start', target: 'calc-tech', animated: hasMarket && !hasTech, style: { stroke: hasMarket ? '#10b981' : '#334155', strokeWidth: hasMarket ? 3 : 2 } },
       { id: 'e2', source: 'start', target: 'calc-news', animated: hasMarket && !hasNews, style: { stroke: hasNews ? '#10b981' : '#334155', strokeWidth: hasNews ? 3 : 2 } },
       { id: 'e3', source: 'calc-tech', target: 'chief', animated: hasTech && !hasChief, style: { stroke: hasTech ? '#10b981' : '#334155', strokeWidth: hasTech ? 3 : 2 } },
       { id: 'e4', source: 'calc-news', target: 'chief', animated: hasNews && !hasChief, style: { stroke: hasNews ? '#10b981' : '#334155', strokeWidth: hasNews ? 3 : 2 } },
       { id: 'e5', source: 'chief', target: 'risk', animated: hasChief && !hasRisk, style: { stroke: hasChief ? '#10b981' : '#334155', strokeWidth: hasChief ? 3 : 2 } },
       { id: 'e6', source: 'risk', target: 'exec', animated: hasRisk && !hasExec, style: { stroke: hasRisk ? '#10b981' : '#334155', strokeWidth: hasRisk ? 3 : 2 } }
     ];

     setNodes(newNodes);
     setEdges(newEdges);
  }, [timelineIndex, traceEvents, trade]);

  if (traceEvents.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-fade-in">
      <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-4xl shadow-2xl overflow-hidden flex flex-col h-[85vh]">
        
        {/* Header */}
        <div className="bg-[#111822] border-b border-slate-800 p-4 flex justify-between items-center shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-emerald-500/20 p-2 rounded text-emerald-400">
              <CheckCircle2 size={18} />
            </div>
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase text-sm">Trade Executed: {trade.symbol}</h2>
              <p className="text-emerald-400 text-[10px] font-mono">Live Decision Journey Tracing</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors bg-slate-800 p-2 rounded">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 flex relative">
           
           {/* Flow Canvas */}
           <div className="flex-1 h-full bg-[#05080C] relative">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={flowNodeTypes}
                fitView
                proOptions={{ hideAttribution: true }}
                zoomOnScroll={false}
                panOnDrag={false}
              >
                <Background color="#1e293b" gap={20} size={2} />
              </ReactFlow>
           </div>

           {/* Event Log overlay on the right side */}
           <div className="w-80 border-l border-slate-800 bg-[#111822] p-4 flex flex-col z-10 shadow-2xl">
              <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-4 border-b border-slate-800 pb-2">Analysis Context</h3>
              <div className="flex-1 overflow-y-auto space-y-3 custom-scrollbar">
                 {traceEvents.slice(0, timelineIndex + 1).map((evt, i) => (
                    <div key={i} className="animate-fade-in-right bg-slate-900/50 border border-slate-800 rounded p-3 text-[10px] font-mono shadow-inner">
                       <div className="text-emerald-400 font-bold mb-1 border-b border-slate-800/50 pb-1">{evt.type}</div>
                       <div className="text-slate-300">
                          {evt.payload.reasoning || evt.payload.rule || (evt.payload.price ? `Tick: $${evt.payload.price}` : JSON.stringify(evt.payload).substring(0,60))}
                       </div>
                    </div>
                 ))}
                 {timelineIndex < traceEvents.length - 1 && (
                    <div className="text-slate-500 font-mono text-[10px] italic flex items-center gap-2 mt-4 animate-pulse">
                       <Play size={10} className="text-indigo-400" /> Computing next step...
                    </div>
                 )}
              </div>
           </div>
           
        </div>
      </div>
    </div>
  );
}
