import React, { useState, useEffect } from "react";
import { Activity, ShieldCheck, Zap, TrendingUp, Cpu, Server, CheckCircle2, Clock, CheckCircle, FileText, Database, Radio, CheckSquare, Settings, Sliders } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";

export function AutonomousDashboard({ autoBotConfig, setAutoBotConfig }: { autoBotConfig: any, setAutoBotConfig: any }) {
  const [handsOffMode, setHandsOffMode] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const performanceData = [
    { time: "09:30", value: 100 },
    { time: "10:00", value: 100.5 },
    { time: "11:00", value: 101.2 },
    { time: "12:00", value: 100.8 },
    { time: "13:00", value: 102.1 },
    { time: "14:00", value: 102.5 },
    { time: "15:00", value: 103.1 },
    { time: "16:00", value: 103.45 }
  ];

  return (
    <div className="flex-1 p-6 overflow-y-auto custom-scrollbar animate-fade-in space-y-6">
      
      {/* Top Banner */}
      <div className="bg-[#111822] border border-indigo-500/50 rounded-2xl p-6 shadow-[0_0_40px_rgba(99,102,241,0.1)] flex items-center justify-between relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="flex items-center gap-6 relative z-10">
          <div className="w-16 h-16 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center relative">
            <div className="absolute inset-0 rounded-full border border-indigo-400 animate-ping opacity-20"></div>
            <Zap className="text-indigo-400" size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              AUTONOMOUS TRADING ACTIVE
              <span className="text-[10px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-1 rounded flex items-center gap-2 tracking-widest uppercase">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                Running Smoothly
              </span>
            </h1>
            <p className="text-slate-400 text-sm mt-1 flex items-center gap-2">
              <Clock size={14} /> System Time: {currentTime.toLocaleTimeString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 bg-[#0A0F16] p-2 rounded-lg border border-slate-800 relative z-10">
          <div className="flex flex-col px-4 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Operation Mode</span>
            <span className="text-sm font-bold text-white mt-1">Fully Autonomous</span>
          </div>
          <div className="px-3 flex items-center gap-3 cursor-pointer" onClick={() => setHandsOffMode(!handsOffMode)}>
             <div className={`w-12 h-6 rounded-full border p-0.5 transition-all ${handsOffMode ? 'bg-indigo-500/20 border-indigo-500/50' : 'bg-slate-800 border-slate-700'}`}>
                <div className={`w-4 h-4 rounded-full bg-white transition-transform ${handsOffMode ? 'translate-x-6' : 'translate-x-0'}`}></div>
             </div>
             <span className="text-xs font-bold text-slate-400">Hands-Off Mode</span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Left Column: Stats & Chart */}
        <div className="xl:col-span-2 space-y-6">
          {/* Key Metrics */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2 flex justify-between items-center">
                Allocated Capital
                <Settings size={12} className="text-slate-600 hover:text-slate-300 cursor-pointer transition-colors" />
              </div>
              <div className="text-3xl font-bold text-white">${autoBotConfig.targetBudget || 100}</div>
            </div>
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2">Portfolio Value</div>
              <div className="text-3xl font-bold text-indigo-400">$103.45</div>
            </div>
            <div className="bg-[#1A1F2B] border border-emerald-500/20 rounded-xl p-5 shadow-[0_0_20px_rgba(16,185,129,0.05)]">
              <div className="text-[10px] text-emerald-500/70 font-bold uppercase tracking-widest mb-2">Today's P/L</div>
              <div className="text-3xl font-bold text-emerald-400">+$3.45</div>
            </div>
          </div>

          {/* Performance Chart */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
             <div className="flex justify-between items-center mb-6">
               <h3 className="text-sm font-bold text-white uppercase tracking-widest">Intraday Performance</h3>
               <select className="bg-[#0A0F16] border border-slate-800 text-xs text-slate-400 rounded outline-none px-2 py-1">
                 <option>Today</option>
                 <option>1W</option>
                 <option>1M</option>
               </select>
             </div>
             <div className="h-64 w-full">
               <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={performanceData}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <XAxis dataKey="time" stroke="#334155" fontSize={10} tickMargin={10} />
                    <YAxis stroke="#334155" fontSize={10} tickFormatter={(val) => `$${val}`} domain={['auto', 'auto']} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }}
                      itemStyle={{ color: '#818cf8' }}
                    />
                    <Area type="monotone" dataKey="value" stroke="#818cf8" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                  </AreaChart>
               </ResponsiveContainer>
             </div>
          </div>
        </div>

        {/* Right Column: AI Activity & Health */}
        <div className="space-y-6">
          
          {/* Current Activity */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Activity size={14} className="text-indigo-400" /> What is the AI doing?
            </h3>
            <div className="space-y-4">
               <div className="flex items-center gap-3 text-sm">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                 <span className="text-slate-300">Monitoring 5,000 stocks</span>
               </div>
               <div className="flex items-center gap-3 text-sm">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                 <span className="text-slate-300">Reading latest market news</span>
               </div>
               <div className="flex items-center gap-3 text-sm">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                 <span className="text-slate-300">Analyzing existing positions</span>
               </div>
               <div className="flex items-center gap-3 text-sm">
                 <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
                 <span className="text-slate-300">Searching opportunities</span>
               </div>
               <div className="flex items-center gap-3 text-sm">
                 <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse"></div>
                 <span className="text-amber-400 font-bold">Waiting for high-confidence setup</span>
               </div>
            </div>
          </div>

          {/* System Health */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Server size={14} className="text-indigo-400" /> AI System Health
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Radio size={12}/> News Agent</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">Healthy</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Database size={12}/> Broker Connection</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">Healthy</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Cpu size={12}/> Calculation Engines</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded">Healthy</span>
              </div>
              <div className="h-px w-full bg-slate-800 my-2"></div>
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">AI Providers</div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">ChatGPT</span>
                <span className="text-emerald-400 font-bold">Available</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Claude</span>
                <span className="text-emerald-400 font-bold">Available</span>
              </div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Gemini</span>
                <span className="text-emerald-400 font-bold">Available</span>
              </div>
            </div>
          </div>

          {/* Safety Controls Overview */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <ShieldCheck size={14} className="text-emerald-400" /> Safety Controls
              </h3>
              <Sliders size={14} className="text-slate-500 cursor-pointer hover:text-white" />
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Maximum Daily Loss</span>
                <span className="text-white font-bold">${autoBotConfig.dailyLossLimit || 5}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Maximum Single Trade</span>
                <span className="text-white font-bold">$20</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Max Positions</span>
                <span className="text-white font-bold">5</span>
              </div>
              <div className="flex justify-between text-slate-400 mt-2 pt-2 border-t border-slate-800">
                <span>Emergency Stop</span>
                <span className="text-emerald-400 font-bold">Enabled</span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Daily Report */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-6 shadow-sm">
        <div className="flex justify-between items-center mb-6">
           <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
             <FileText size={16} className="text-indigo-400" /> Daily AI Trading Report
           </h3>
           <span className="text-xs font-mono text-slate-500">{new Date().toLocaleDateString()}</span>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="space-y-4">
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-4">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">AI Performance</div>
              <div className="text-xl font-bold text-white">8/10</div>
              <div className="text-xs text-slate-400">Correct predictions</div>
            </div>
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-4">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Avg Confidence</div>
              <div className="text-xl font-bold text-indigo-400">87%</div>
              <div className="text-xs text-slate-400">Council Agreement</div>
            </div>
          </div>
          
          <div className="md:col-span-3">
             <h4 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3">Executed Trades</h4>
             <div className="space-y-3">
               <div className="bg-[#0A0F16] border border-emerald-500/30 rounded-lg p-3 flex flex-col sm:flex-row justify-between gap-4">
                 <div className="flex items-center gap-4">
                   <div className="bg-emerald-500/20 text-emerald-400 px-3 py-1 rounded font-bold text-xs uppercase tracking-widest border border-emerald-500/30">BUY</div>
                   <div>
                     <div className="font-bold text-white font-mono">AAPL</div>
                     <div className="text-[10px] text-slate-500 uppercase tracking-widest">Apple Inc.</div>
                   </div>
                 </div>
                 <div className="flex-1 sm:border-l border-slate-800 sm:pl-4">
                   <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">AI Reasoning</div>
                   <div className="text-xs text-slate-300">Strong earnings + positive sentiment detected across news feeds. Quant models show momentum divergence.</div>
                 </div>
               </div>
               <div className="bg-[#0A0F16] border border-rose-500/30 rounded-lg p-3 flex flex-col sm:flex-row justify-between gap-4">
                 <div className="flex items-center gap-4">
                   <div className="bg-rose-500/20 text-rose-400 px-3 py-1 rounded font-bold text-xs uppercase tracking-widest border border-rose-500/30">SELL</div>
                   <div>
                     <div className="font-bold text-white font-mono">AMD</div>
                     <div className="text-[10px] text-slate-500 uppercase tracking-widest">Adv. Micro Devices</div>
                   </div>
                 </div>
                 <div className="flex-1 sm:border-l border-slate-800 sm:pl-4">
                   <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">AI Reasoning</div>
                   <div className="text-xs text-slate-300">Momentum weakening. Council consensus reached to secure profits ahead of sector volatility.</div>
                 </div>
               </div>
             </div>
             
             <div className="mt-6">
               <h4 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3">Current Holdings</h4>
               <div className="flex gap-4">
                 <div className="bg-[#0A0F16] border border-slate-800 rounded px-4 py-2 flex items-center justify-between min-w-[120px]">
                   <span className="font-bold text-slate-300 font-mono">NVDA</span>
                   <span className="text-emerald-400 font-bold text-sm">+$4.20</span>
                 </div>
                 <div className="bg-[#0A0F16] border border-slate-800 rounded px-4 py-2 flex items-center justify-between min-w-[120px]">
                   <span className="font-bold text-slate-300 font-mono">MSFT</span>
                   <span className="text-emerald-400 font-bold text-sm">+$1.80</span>
                 </div>
               </div>
             </div>
          </div>
        </div>
      </div>
      
    </div>
  );
}
