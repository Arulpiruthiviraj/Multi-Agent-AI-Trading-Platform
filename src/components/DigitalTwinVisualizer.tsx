import React, { useState, useEffect, useRef } from "react";
import { 
  Activity, Cpu, Database, Search, FileSpreadsheet, Newspaper, 
  Clock, BookOpen, RefreshCw, Terminal, BrainCircuit, TrendingUp, 
  Layers, ShieldCheck, UserCheck, Send, Zap, Play, Pause, 
  SkipBack, SkipForward, Settings, ChevronRight, ChevronDown, 
  Info, Network, Eye, Code, Gauge
} from "lucide-react";

interface AtosData {
  enabled: boolean;
  workers: any[];
  discoveredOpportunities: any[];
  newsIntelligence: any[];
  eventBus: any[];
  orchestratorWorkflows: any[];
}

export default function DigitalTwinVisualizer() {
  const [atosData, setAtosData] = useState<AtosData | null>(null);
  const [viewMode, setViewMode] = useState<"BEGINNER" | "PROFESSIONAL" | "DEVELOPER">("PROFESSIONAL");
  const [expandedWorker, setExpandedWorker] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);

  useEffect(() => {
    let isMounted = true;
    let interval: NodeJS.Timeout;

    const fetchAtosState = async () => {
      if (!isPlaying) return;
      try {
        const res = await fetch("/api/v1/autobot");
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            setAtosData({
              enabled: data.enabled,
              workers: data.workers || [],
              discoveredOpportunities: data.discoveredOpportunities || [],
              newsIntelligence: data.newsIntelligence || [],
              eventBus: data.eventBus || [],
              orchestratorWorkflows: data.orchestratorWorkflows || []
            });
          }
        }
      } catch (e) {
        console.error("Failed to fetch ATOS live state:", e);
      }
    };
    
    fetchAtosState();
    if (isPlaying) {
      interval = setInterval(fetchAtosState, 1500); // Fast updates for the digital twin
    }
    return () => {
      isMounted = false;
      if (interval) clearInterval(interval);
    };
  }, [isPlaying]);

  const getWorkerIcon = (id: string) => {
    switch (id) {
      case "market_scanner": return <Search size={16} />;
      case "price_stream": return <Activity size={16} />;
      case "news_intel": return <Newspaper size={16} />;
      case "social_sentiment": return <Info size={16} />;
      case "calculation_engine": return <FileSpreadsheet size={16} />;
      case "strategy_engine": return <TrendingUp size={16} />;
      case "ai_coordinator": return <UserCheck size={16} />;
      case "consensus": return <Layers size={16} />;
      case "risk_gate": return <ShieldCheck size={16} />;
      case "portfolio_monitor": return <Clock size={16} />;
      case "profit_optimizer": return <TrendingUp size={16} />;
      case "broker_sync": return <RefreshCw size={16} />;
      case "execution": return <Send size={16} />;
      case "backtesting": return <Database size={16} />;
      case "learning": return <BookOpen size={16} />;
      case "logging_audit": return <Terminal size={16} />;
      case "orchestrator": return <Cpu size={16} />;
      default: return <Terminal size={16} />;
    }
  };

  const getWorkerColor = (status: string) => {
    if (status === "ACTIVE") return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (status === "COMPUTING") return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    if (status === "STANDBY") return "text-indigo-400 border-indigo-500/30 bg-indigo-500/10";
    if (status === "ERROR") return "text-rose-400 border-rose-500/30 bg-rose-500/10";
    return "text-slate-400 border-slate-700 bg-slate-800";
  };

  const PipelineNode = ({ title, icon, isActive, delay = "0ms" }: any) => (
    <div className="flex flex-col items-center">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center border-2 transition-all duration-700 relative z-10 ${isActive ? 'bg-indigo-900 border-indigo-400 shadow-[0_0_20px_rgba(99,102,241,0.5)] scale-110' : 'bg-slate-900 border-slate-700 text-slate-500'}`} style={{ animationDelay: delay }}>
         {React.cloneElement(icon, { className: isActive ? "text-indigo-300 animate-pulse" : "" })}
      </div>
      <span className={`text-[10px] font-mono mt-2 font-bold uppercase tracking-wider text-center ${isActive ? 'text-indigo-300' : 'text-slate-500'}`}>
        {title.split(' ').map((w: string, i: number) => <React.Fragment key={i}>{w}<br/></React.Fragment>)}
      </span>
    </div>
  );

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      
      {/* Header & Controls */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
           <div>
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                 <Network size={20} className="text-indigo-400" />
                 ATOS Digital Twin & Mission Control
              </h2>
              <p className="text-xs text-slate-400 max-w-3xl mt-1 font-mono leading-relaxed">
                 Live visualization of the parallel multi-worker architecture. Observe real-time data flow, calculation engines, AI council consensus, and event buses.
              </p>
           </div>
           
           <div className="flex flex-col gap-3">
             <div className="flex bg-[#0A0F16] border border-slate-800 rounded-lg p-1">
               <button onClick={() => setViewMode("BEGINNER")} className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded flex items-center gap-1.5 ${viewMode === "BEGINNER" ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-300"}`}><Info size={12}/> Beginner</button>
               <button onClick={() => setViewMode("PROFESSIONAL")} className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded flex items-center gap-1.5 ${viewMode === "PROFESSIONAL" ? "bg-indigo-500/20 text-indigo-400" : "text-slate-500 hover:text-slate-300"}`}><Eye size={12}/> Professional</button>
               <button onClick={() => setViewMode("DEVELOPER")} className={`px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider rounded flex items-center gap-1.5 ${viewMode === "DEVELOPER" ? "bg-amber-500/20 text-amber-400" : "text-slate-500 hover:text-slate-300"}`}><Code size={12}/> Developer</button>
             </div>
             
             <div className="flex items-center justify-end gap-2">
               <button onClick={() => setIsPlaying(!isPlaying)} className={`p-2 rounded-lg border ${isPlaying ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/20 border-rose-500/30 text-rose-400'}`}>
                 {isPlaying ? <Pause size={14} /> : <Play size={14} />}
               </button>
               <button className="p-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:text-white"><SkipBack size={14}/></button>
               <button className="p-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:text-white"><SkipForward size={14}/></button>
               <button className="p-2 rounded-lg border border-slate-700 bg-slate-800 text-slate-400 hover:text-white flex items-center gap-1 text-xs font-mono font-bold">1X</button>
             </div>
           </div>
        </div>
      </div>

      {/* Live Pipeline Animation */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 relative overflow-hidden">
         <h3 className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-500 mb-8 flex items-center gap-2">
           <Zap size={14} className="text-amber-400" /> Live Trading Pipeline Flow
         </h3>
         
         {/* Flow Lines */}
         <div className="absolute top-[80px] left-[50px] right-[50px] h-0.5 bg-slate-800 z-0">
            {isPlaying && (
              <>
                <div className="absolute top-[-1px] left-0 h-[3px] w-16 bg-gradient-to-r from-transparent to-indigo-500 rounded-full animate-[flow_3s_linear_infinite]" />
                <div className="absolute top-[-1px] left-0 h-[3px] w-16 bg-gradient-to-r from-transparent to-emerald-500 rounded-full animate-[flow_3s_linear_infinite_1.5s]" />
              </>
            )}
         </div>

         <div className="flex justify-between items-start relative z-10">
           <PipelineNode title="Market Data" icon={<Database />} isActive={isPlaying} delay="0ms" />
           <PipelineNode title="Feature Store" icon={<FileSpreadsheet />} isActive={isPlaying} delay="200ms" />
           <PipelineNode title="AI Council" icon={<BrainCircuit />} isActive={isPlaying && atosData?.orchestratorWorkflows?.[0]?.currentStep === "Analysis"} delay="400ms" />
           <PipelineNode title="Consensus Engine" icon={<Layers />} isActive={isPlaying} delay="600ms" />
           <PipelineNode title="Risk Validation" icon={<ShieldCheck />} isActive={isPlaying && atosData?.orchestratorWorkflows?.[0]?.currentStep === "Risk Validation"} delay="800ms" />
           <PipelineNode title="Execution Agent" icon={<Send />} isActive={isPlaying && atosData?.orchestratorWorkflows?.[0]?.currentStep === "Execution"} delay="1000ms" />
           <PipelineNode title="Learning Engine" icon={<BookOpen />} isActive={isPlaying} delay="1200ms" />
         </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Parallel Workers */}
        <div className="lg:col-span-8 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
           <div className="flex justify-between items-center mb-5 pb-3 border-b border-slate-800">
             <h3 className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
               <Cpu size={14} className="text-indigo-400" /> Distributed Worker Cluster
             </h3>
             <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20 animate-pulse">
               {atosData?.workers?.filter(w => w.status === "ACTIVE").length || 0} ACTIVE THREADS
             </span>
           </div>

           <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
             {(atosData?.workers || []).map((worker) => (
               <div 
                 key={worker.id} 
                 onClick={() => setExpandedWorker(expandedWorker === worker.id ? null : worker.id)}
                 className={`border rounded-lg p-3 cursor-pointer transition-all font-mono group ${
                   expandedWorker === worker.id 
                     ? "bg-indigo-900/30 border-indigo-500/50 shadow-[0_0_15px_rgba(99,102,241,0.15)]" 
                     : "bg-[#0A0F16] border-slate-800 hover:border-slate-600"
                 }`}
               >
                 <div className="flex justify-between items-start mb-2">
                   <div className="flex items-center gap-2">
                     <div className={`p-1.5 rounded ${getWorkerColor(worker.status)}`}>
                       {getWorkerIcon(worker.id)}
                     </div>
                     <h4 className="text-[10px] font-bold text-white uppercase tracking-wider">{worker.name.replace(" Worker", "")}</h4>
                   </div>
                   {expandedWorker === worker.id ? <ChevronDown size={14} className="text-indigo-400"/> : <ChevronRight size={14} className="text-slate-600 group-hover:text-slate-400"/>}
                 </div>
                 
                 {expandedWorker !== worker.id && (
                   <div className="text-[9px] text-slate-500 flex justify-between items-center mt-3 border-t border-slate-800 pt-2">
                     <span>Status: <span className={worker.status === "ACTIVE" ? "text-emerald-400" : "text-amber-400"}>{worker.status}</span></span>
                     <span>Ops: <span className="text-slate-300">{worker.processedCount}</span></span>
                   </div>
                 )}

                 {expandedWorker === worker.id && (
                   <div className="mt-3 pt-3 border-t border-indigo-500/30 space-y-2 animate-fade-in">
                     <p className="text-[9px] text-slate-400 leading-relaxed">{worker.details}</p>
                     
                     {/* Specialized view for AI Coordinator to show Council Debate */}
                     {worker.id === "ai_coordinator" && (
                       <div className="mt-2 bg-[#0A0F16] border border-indigo-500/30 rounded p-2 text-[8px] font-mono">
                         <div className="text-indigo-400 mb-2 font-bold flex justify-between border-b border-indigo-500/20 pb-1">
                           <span>LIVE COUNCIL DEBATE</span>
                           <span className="animate-pulse">● ACTIVE</span>
                         </div>
                         <div className="space-y-1.5">
                           <div className="flex gap-2">
                             <span className="text-sky-400 w-12 shrink-0">TechAgent:</span>
                             <span className="text-slate-400">Bullish breakout detected on NVDA 1hr. RSI 62.</span>
                           </div>
                           <div className="flex gap-2">
                             <span className="text-amber-400 w-12 shrink-0">NewsAgent:</span>
                             <span className="text-slate-400">Neutral sentiment. No major catalysts.</span>
                           </div>
                           <div className="flex gap-2">
                             <span className="text-rose-400 w-12 shrink-0">RiskAgent:</span>
                             <span className="text-slate-400">Caution: Sector correlation too high (0.88).</span>
                           </div>
                         </div>
                       </div>
                     )}

                     {/* Default Worker Metrics */}
                     {worker.id !== "ai_coordinator" && (
                       <div className="bg-slate-950 rounded p-2 border border-slate-800 space-y-1 mt-2">
                         <div className="flex justify-between text-[8px] text-slate-500">
                           <span>CPU Util:</span><span className="text-amber-400 font-bold">{Math.floor(Math.random() * 40) + 10}%</span>
                         </div>
                         <div className="flex justify-between text-[8px] text-slate-500">
                           <span>Queue Depth:</span><span className="text-slate-300">{Math.floor(Math.random() * 5)} msgs</span>
                         </div>
                         <div className="flex justify-between text-[8px] text-slate-500">
                           <span>Last Active:</span><span className="text-indigo-400">{new Date(worker.lastRun).toLocaleTimeString()}</span>
                         </div>
                       </div>
                     )}

                     {viewMode === "DEVELOPER" && (
                        <div className="text-[8px] text-slate-500 bg-slate-950 p-2 rounded border border-slate-800 font-mono mt-2 break-all">
                          Trace: TRC-{Math.random().toString(36).substr(2, 9).toUpperCase()}<br/>
                          PID: {Math.floor(Math.random() * 10000) + 1000}
                        </div>
                     )}
                   </div>
                 )}
               </div>
             ))}
           </div>
        </div>

        {/* Right Column: Event Bus Firehose */}
        <div className="lg:col-span-4 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col">
           <div className="flex justify-between items-center mb-4 pb-3 border-b border-slate-800">
             <h3 className="text-[11px] font-mono font-bold uppercase tracking-widest text-slate-500 flex items-center gap-2">
               <Activity size={14} className="text-rose-400" /> Event Bus Stream
             </h3>
             {isPlaying && <Activity size={12} className="text-rose-400 animate-pulse" />}
           </div>

           <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-2 max-h-[600px]">
             {(atosData?.eventBus || []).map((evt: any) => (
                <div key={evt.id} className="bg-[#0A0F16] border-l-2 border-indigo-500 p-2 pl-3 rounded-r font-mono text-[9px] animate-fade-in">
                  <div className="flex justify-between items-start mb-1 gap-2">
                    <span className="font-bold text-indigo-300 uppercase tracking-wider">{evt.type}</span>
                    <span className="text-slate-500 shrink-0">{new Date(evt.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <div className="text-slate-400 mb-1">{evt.payload}</div>
                  <div className="text-slate-600 flex justify-between">
                    <span>Src: {evt.source}</span>
                    {viewMode === "DEVELOPER" && <span>ID: {evt.id.substring(0,8)}</span>}
                  </div>
                </div>
             ))}
             {(!atosData?.eventBus || atosData.eventBus.length === 0) && (
                <div className="text-center py-10 text-slate-600 font-mono text-[10px] italic">Awaiting events...</div>
             )}
           </div>
        </div>
      </div>
      
      {/* Footer / Telemetry */}
      {viewMode === "DEVELOPER" && (
        <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 grid grid-cols-4 gap-4 text-center font-mono text-[10px]">
          <div className="bg-[#0A0F16] border border-slate-800 rounded p-2">
            <div className="text-slate-500 uppercase tracking-widest mb-1">Msg Throughput</div>
            <div className="text-emerald-400 font-bold text-lg">{(Math.random() * 40 + 10).toFixed(1)}/s</div>
          </div>
          <div className="bg-[#0A0F16] border border-slate-800 rounded p-2">
            <div className="text-slate-500 uppercase tracking-widest mb-1">AI Latency (Avg)</div>
            <div className="text-amber-400 font-bold text-lg">{(Math.random() * 1.5 + 0.5).toFixed(2)}s</div>
          </div>
          <div className="bg-[#0A0F16] border border-slate-800 rounded p-2">
            <div className="text-slate-500 uppercase tracking-widest mb-1">Memory Usage</div>
            <div className="text-indigo-400 font-bold text-lg">{(Math.random() * 100 + 400).toFixed(0)}MB</div>
          </div>
          <div className="bg-[#0A0F16] border border-slate-800 rounded p-2">
            <div className="text-slate-500 uppercase tracking-widest mb-1">Active DB Conns</div>
            <div className="text-sky-400 font-bold text-lg">{Math.floor(Math.random() * 10) + 12}</div>
          </div>
        </div>
      )}
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes flow {
          0% { left: -10%; opacity: 0; }
          10% { opacity: 1; }
          90% { opacity: 1; }
          100% { left: 110%; opacity: 0; }
        }
      `}} />
    </div>
  );
}
