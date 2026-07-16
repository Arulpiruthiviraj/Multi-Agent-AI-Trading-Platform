import React, { useState, useEffect } from 'react';
import { X, Terminal, Activity, CheckCircle2, ShieldCheck, Newspaper, Send, TrendingUp, UserCheck, Clock, BookOpen } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

export default function NodeInspectionPanel({ nodeId, onClose, activeEvents }: { nodeId: string, onClose: () => void, activeEvents: any[] }) {
   const [nodeState, setNodeState] = useState<any>({});
   const [localLogs, setLocalLogs] = useState<any[]>([]);

   useEffect(() => {
       // Filter events that match this node
       let relevant = [];
       if (nodeId === 'market-data-worker') {
           relevant = activeEvents.filter(e => e.type === 'MARKET_DATA');
       } else if (nodeId === 'technical-engine') {
           relevant = activeEvents.filter(e => e.type === 'CALCULATION_COMPLETED' && e.payload.engine === 'TechnicalEngine');
       } else if (nodeId === 'news-agent') {
           relevant = activeEvents.filter(e => e.type === 'TRADE_IDEA_GENERATED' && e.payload.agent === 'NewsAgent');
       } else if (nodeId === 'chief-trader') {
           relevant = activeEvents.filter(e => e.type === 'CHIEF_APPROVED_IDEA');
       } else if (nodeId === 'risk-manager') {
           relevant = activeEvents.filter(e => e.type === 'RISK_ASSESSMENT_COMPLETED');
       } else if (nodeId === 'order-management') {
           relevant = activeEvents.filter(e => e.type === 'ORDER_EXECUTED');
       } else if (nodeId === 'portfolio-monitor') {
           relevant = activeEvents.filter(e => e.type === 'PORTFOLIO_UPDATE' || (e.type === 'TRADE_IDEA_GENERATED' && e.payload.agent === 'PortfolioManager'));
       } else if (nodeId === 'learning-engine') {
           relevant = activeEvents.filter(e => e.type === 'NEW_RULE_LEARNED');
       }

       setLocalLogs(relevant.slice(0, 50));
       
       if (relevant.length > 0) {
           setNodeState(relevant[0].payload);
       }
   }, [nodeId, activeEvents]);

   const getIcon = () => {
      switch(nodeId) {
         case 'market-data-worker': return <Activity size={24} className="text-sky-400" />;
         case 'technical-engine': return <TrendingUp size={24} className="text-amber-400" />;
         case 'news-agent': return <Newspaper size={24} className="text-fuchsia-400" />;
         case 'chief-trader': return <UserCheck size={24} className="text-emerald-400" />;
         case 'risk-manager': return <ShieldCheck size={24} className="text-rose-400" />;
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
               {/* Internal State Viewer */}
               <div className="bg-[#0A0F16] border border-slate-800 rounded p-3">
                   <h4 className="text-[10px] uppercase font-bold text-slate-400 mb-2 border-b border-slate-800/50 pb-1 flex justify-between">
                      Current State Snapshot
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
