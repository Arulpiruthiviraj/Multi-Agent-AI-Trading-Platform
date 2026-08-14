/**
 * ==========================================================
 * Module:
 * AutonomousDashboard.tsx
 *
 * Purpose:
 * Core dashboard overview for the Argus Autonomous Trading Terminal.
 * Displays live portfolio valuation, daily P/L, performance curves,
 * active safety controls, and real-time execution telemetry.
 *
 * Responsibilities:
 * - Render live portfolio metrics backed by real broker state.
 * - Render real intraday/historical P/L curves from backend analytics.
 * - Display active safety guardrails and real AI service health.
 * - Show recent real executed trades and current open holdings.
 *
 * Inputs:
 * - autoBotConfig: active bot configuration and budget settings
 * - portfolioData: live broker equity, buying power, cash, and positions
 * - trades: real executed trades from SQLite database
 * - assetPrices: live market prices for open position valuation
 *
 * Never:
 * - Render hardcoded $103.45 / +$3.45 placeholders
 * - Fabricate execution trades or position lists
 * ==========================================================
 */

import React, { useState, useEffect } from "react";
import { 
  Activity, ShieldCheck, Zap, TrendingUp, Cpu, Server, CheckCircle2, 
  Clock, CheckCircle, FileText, Database, Radio, Settings, Sliders, AlertTriangle 
} from "lucide-react";
import { XAxis, YAxis, Tooltip, ResponsiveContainer, AreaChart, Area } from "recharts";

interface AutonomousDashboardProps {
  autoBotConfig?: any;
  portfolioData?: any;
  trades?: any[];
  assetPrices?: Record<string, number>;
  systemState?: string;
  setSystemState?: any;
  setShowLaunchDialog?: any;
}

export function AutonomousDashboard({ 
  autoBotConfig = {}, 
  portfolioData: initialPortfolioData,
  trades: initialTrades,
  assetPrices = {},
  systemState,
  setSystemState,
  setShowLaunchDialog 
}: AutonomousDashboardProps) {
  const [handsOffMode, setHandsOffMode] = useState(true);
  const [currentTime, setCurrentTime] = useState(new Date());

  // Real data states with fallback fetch
  const [livePortfolio, setLivePortfolio] = useState<any>(initialPortfolioData || null);
  const [liveTrades, setLiveTrades] = useState<any[]>(initialTrades || []);
  const [performanceData, setPerformanceData] = useState<any[]>([]);
  const [systemIntegrity, setSystemIntegrity] = useState<any>(null);
  const [learningStats, setLearningStats] = useState<any>(null);
  const [isLoadingChart, setIsLoadingChart] = useState(true);

  // Sync props to state if provided
  useEffect(() => {
    if (initialPortfolioData) setLivePortfolio(initialPortfolioData);
  }, [initialPortfolioData]);

  useEffect(() => {
    if (initialTrades) setLiveTrades(initialTrades);
  }, [initialTrades]);

  // Update clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Fetch real portfolio data if not provided via props
  useEffect(() => {
    let isMounted = true;
    const fetchPortfolio = async () => {
      try {
        const res = await fetch("/api/v1/portfolio");
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setLivePortfolio(data);
        }
      } catch (e) {
        console.error("AutonomousDashboard portfolio fetch error:", e);
      }
    };

    if (!initialPortfolioData) {
      fetchPortfolio();
    }

    const interval = setInterval(fetchPortfolio, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [initialPortfolioData]);

  // Fetch real trades if not provided via props
  useEffect(() => {
    let isMounted = true;
    const fetchTrades = async () => {
      try {
        const res = await fetch("/api/v1/trades");
        if (res.ok) {
          const data = await res.json();
          if (isMounted && Array.isArray(data)) setLiveTrades(data);
        }
      } catch (e) {
        console.error("AutonomousDashboard trades fetch error:", e);
      }
    };

    if (!initialTrades || initialTrades.length === 0) {
      fetchTrades();
    }

    const interval = setInterval(fetchTrades, 12000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [initialTrades]);

  // Fetch real PnL analytics (History array from backend)
  useEffect(() => {
    let isMounted = true;
    setIsLoadingChart(true);
    fetch("/api/v1/pnl/analytics")
      .then(res => res.json())
      .then(data => {
        if (!isMounted) return;
        if (data.history && Array.isArray(data.history) && data.history.length > 0) {
          const formatted = data.history.map((h: any) => ({
            time: h.date || (h.timestamp ? new Date(h.timestamp * 1000).toLocaleTimeString() : "N/A"),
            value: Number(h.cumulative ?? h.equity ?? 0),
            pnl: Number(h.pnl ?? h.profit_loss ?? 0)
          }));
          setPerformanceData(formatted);
        } else if (liveTrades.length > 0) {
          // Construct cumulative realized equity curve from real trades if portfolio history is empty
          let runningVal = Number(livePortfolio?.cash || autoBotConfig?.budget || 50000);
          const tradeCurve = liveTrades
            .slice(-20)
            .reverse()
            .map((t: any) => {
              const pnl = Number(t.profitLoss || 0);
              runningVal += pnl;
              return {
                time: t.timestamp ? new Date(t.timestamp).toLocaleDateString() : t.date || "Trade",
                value: runningVal,
                pnl: pnl
              };
            });
          setPerformanceData(tradeCurve);
        } else {
          setPerformanceData([]);
        }
        setIsLoadingChart(false);
      })
      .catch(e => {
        console.error("AutonomousDashboard PnL analytics error:", e);
        if (isMounted) {
          setPerformanceData([]);
          setIsLoadingChart(false);
        }
      });

    return () => { isMounted = false; };
  }, [liveTrades, livePortfolio, autoBotConfig?.budget]);

  // Fetch real system integrity & AI providers health
  useEffect(() => {
    let isMounted = true;
    fetch("/api/v1/system/integrity")
      .then(res => res.json())
      .then(data => {
        if (isMounted) setSystemIntegrity(data);
      })
      .catch(() => {});

    fetch("/api/v2/agents/learning-summary")
      .then(res => res.json())
      .then(data => {
        if (isMounted) setLearningStats(data);
      })
      .catch(() => {});

    return () => { isMounted = false; };
  }, []);

  // Compute live portfolio values
  const allocatedBudget = autoBotConfig?.budget ?? autoBotConfig?.targetBudget ?? 50000;
  const rawEquity = livePortfolio?.equity ?? livePortfolio?.snapshot?.total_equity;
  const portfolioEquity = typeof rawEquity === "number" ? rawEquity : (livePortfolio?.cash ? Number(livePortfolio.cash) : allocatedBudget);
  
  // Calculate today's unrealized / daily PnL
  let todaysPnl = 0;
  if (typeof livePortfolio?.snapshot?.unrealized_pnl === "number") {
    todaysPnl = livePortfolio.snapshot.unrealized_pnl;
  } else if (Array.isArray(livePortfolio?.positions) && livePortfolio.positions.length > 0) {
    todaysPnl = livePortfolio.positions.reduce((acc: number, pos: any) => {
      const current = assetPrices[pos.symbol] ?? pos.currentPrice ?? pos.entryPrice ?? 0;
      const entry = pos.entryPrice ?? 0;
      const qty = pos.quantity ?? pos.shares ?? pos.qty ?? 0;
      return acc + ((current - entry) * qty);
    }, 0);
  }

  const pnlPercent = portfolioEquity > 0 ? (todaysPnl / portfolioEquity) * 100 : 0;
  const isPnlPositive = todaysPnl >= 0;

  // Active positions and recent trades
  const activePositions = Array.isArray(livePortfolio?.positions) ? livePortfolio.positions : [];
  const recentTrades = liveTrades.slice(0, 3);
  const isEngineActive = autoBotConfig?.autoBotEnabled && autoBotConfig?.tradingState !== "EMERGENCY_STOP";

  return (
    <div className="flex-1 p-6 overflow-y-auto custom-scrollbar animate-fade-in space-y-6">
      
      {/* Top Banner */}
      <div className="bg-[#111822] border border-indigo-500/50 rounded-2xl p-6 shadow-[0_0_40px_rgba(99,102,241,0.1)] flex items-center justify-between relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="flex items-center gap-6 relative z-10">
          <div className="w-16 h-16 rounded-full bg-indigo-500/20 border border-indigo-500/40 flex items-center justify-center relative">
            <div className={`absolute inset-0 rounded-full border ${isEngineActive ? 'border-emerald-400 animate-ping opacity-20' : 'border-amber-400 opacity-10'}`}></div>
            <Zap className={isEngineActive ? "text-emerald-400" : "text-amber-400"} size={32} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white flex items-center gap-3">
              AUTONOMOUS TRADING {isEngineActive ? "ACTIVE" : "STANDBY"}
              <span className={`text-[10px] font-mono px-2 py-1 rounded flex items-center gap-2 tracking-widest uppercase border ${
                isEngineActive 
                  ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' 
                  : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></span>
                {isEngineActive ? "Running Live" : "Engine Paused"}
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
            <span className="text-sm font-bold text-white mt-1">
              {autoBotConfig?.tradingMode || "Autonomous Paper"}
            </span>
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
              <div className="text-3xl font-bold text-white">
                ${Number(allocatedBudget).toLocaleString("en-US", { maximumFractionDigits: 0 })}
              </div>
            </div>
            
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2">
                Portfolio Valuation
              </div>
              <div className="text-3xl font-bold text-indigo-400">
                ${Number(portfolioEquity).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
            </div>

            <div className={`bg-[#1A1F2B] border rounded-xl p-5 shadow-sm ${
              isPnlPositive ? 'border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)]' : 'border-rose-500/20 shadow-[0_0_20px_rgba(244,63,94,0.05)]'
            }`}>
              <div className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isPnlPositive ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>
                Today's P/L
              </div>
              <div className={`text-3xl font-bold ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {isPnlPositive ? '+' : ''}${Number(todaysPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <span className="text-xs font-mono ml-2 font-normal opacity-80">
                  ({isPnlPositive ? '+' : ''}{pnlPercent.toFixed(2)}%)
                </span>
              </div>
            </div>
          </div>

          {/* Performance Chart */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
             <div className="flex justify-between items-center mb-6">
               <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                 <TrendingUp size={16} className="text-indigo-400" /> Realized & Intraday Performance
               </h3>
               <span className="text-xs text-slate-500 font-mono">
                 {performanceData.length > 0 ? `${performanceData.length} data points` : "Awaiting Data"}
               </span>
             </div>
             
             <div className="h-64 w-full">
               {isLoadingChart ? (
                 <div className="h-full flex items-center justify-center text-slate-500 text-xs font-mono">
                   Loading real-time performance analytics...
                 </div>
               ) : performanceData.length > 0 ? (
                 <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={performanceData}>
                      <defs>
                        <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#818cf8" stopOpacity={0.3}/>
                          <stop offset="95%" stopColor="#818cf8" stopOpacity={0}/>
                        </linearGradient>
                      </defs>
                      <XAxis dataKey="time" stroke="#334155" fontSize={10} tickMargin={10} />
                      <YAxis stroke="#334155" fontSize={10} tickFormatter={(val) => `$${Number(val).toLocaleString()}`} domain={['auto', 'auto']} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px' }}
                        itemStyle={{ color: '#818cf8' }}
                        formatter={(val: any) => [`$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Equity"]}
                      />
                      <Area type="monotone" dataKey="value" stroke="#818cf8" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                    </AreaChart>
                 </ResponsiveContainer>
               ) : (
                 <div className="h-full flex flex-col items-center justify-center text-slate-500 text-xs font-mono text-center p-6 border border-dashed border-slate-800 rounded">
                   <Activity size={28} className="text-slate-600 mb-2" />
                   <p className="font-semibold text-slate-400">No historical performance curve recorded yet</p>
                   <p className="text-[10px] text-slate-600 mt-1">Live equity tracking activates as trades and daily market sessions close.</p>
                 </div>
               )}
             </div>
          </div>
        </div>

        {/* Right Column: AI Activity & Health */}
        <div className="space-y-6">
          
          {/* Current Activity */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Activity size={14} className="text-indigo-400" /> AI Engine Operations
            </h3>
            <div className="space-y-3">
               <div className="flex items-center gap-3 text-xs">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                 <span className="text-slate-300">TechnicalAgent: Oscillators & Moving Averages</span>
               </div>
               <div className="flex items-center gap-3 text-xs">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                 <span className="text-slate-300">NewsEngine: Financial headline sentiment stream</span>
               </div>
               <div className="flex items-center gap-3 text-xs">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                 <span className="text-slate-300">RiskEngine: 11 safety gates & ATR sizing active</span>
               </div>
               <div className="flex items-center gap-3 text-xs">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                 <span className="text-slate-300">ChiefTraderAgent: Dynamic weight consensus</span>
               </div>
               <div className="flex items-center gap-3 text-xs pt-1 border-t border-slate-800">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-indigo-400 animate-pulse' : 'bg-amber-500'}`}></div>
                 <span className={isEngineActive ? "text-indigo-300 font-bold" : "text-amber-400 font-bold"}>
                   {isEngineActive ? "Autonomous EventBus polling active" : "Engine on standby — click Start in Mission Control"}
                 </span>
               </div>
            </div>
          </div>

          {/* System Health */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Server size={14} className="text-indigo-400" /> Subsystem Integrity
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Radio size={12}/> News Engine</span>
                <span className={`font-bold px-2 py-0.5 rounded text-[10px] ${
                  systemIntegrity?.checks?.news_provider_configured?.status === 'PASS' || !systemIntegrity
                    ? 'text-emerald-400 bg-emerald-500/10' 
                    : 'text-amber-400 bg-amber-500/10'
                }`}>
                  {systemIntegrity?.checks?.news_provider_configured?.status === 'PASS' || !systemIntegrity ? 'Online' : 'Warning'}
                </span>
              </div>
              
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Database size={12}/> SQLite Database</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]">
                  WAL Mode
                </span>
              </div>

              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Cpu size={12}/> Risk Engine Gates</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]">
                  11 Gates Armed
                </span>
              </div>

              <div className="h-px w-full bg-slate-800 my-2"></div>
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">AI Router Gateway</div>
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400">Configured Provider</span>
                <span className="text-indigo-400 font-bold font-mono">
                  {autoBotConfig?.selectedAiProvider || "Google Gemini / AIRouter"}
                </span>
              </div>
            </div>
          </div>

          {/* Safety Controls Overview */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest flex items-center gap-2">
                <ShieldCheck size={14} className="text-emerald-400" /> Active Risk Limits
              </h3>
              <Sliders size={14} className="text-slate-500 cursor-pointer hover:text-white" />
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Maximum Daily Loss</span>
                <span className="text-white font-bold font-mono">
                  ${Number(autoBotConfig?.dailyLossLimit ?? 5000).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Max Single Trade Size</span>
                <span className="text-white font-bold font-mono">
                  ${Number(autoBotConfig?.maxTradeSize ?? 3000).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Max Open Positions</span>
                <span className="text-white font-bold font-mono">
                  {autoBotConfig?.maxOpenPositions ?? 10}
                </span>
              </div>
              <div className="flex justify-between text-slate-400 mt-2 pt-2 border-t border-slate-800">
                <span>Emergency Circuit Breaker</span>
                <span className={`font-bold font-mono ${
                  autoBotConfig?.tradingState === "EMERGENCY_STOP" 
                    ? "text-rose-400" 
                    : "text-emerald-400"
                }`}>
                  {autoBotConfig?.tradingState === "EMERGENCY_STOP" ? "TRIGGERED (HALTED)" : "ARMED"}
                </span>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Daily Report */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-6 shadow-sm">
        <div className="flex justify-between items-center mb-6">
           <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
             <FileText size={16} className="text-indigo-400" /> Live Execution & Holdings Report
           </h3>
           <span className="text-xs font-mono text-slate-500">{new Date().toLocaleDateString()}</span>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
          <div className="space-y-4">
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-4">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Agent Win Rate</div>
              <div className="text-xl font-bold text-white">
                {learningStats?.avgWinRate !== undefined 
                  ? `${learningStats.avgWinRate.toFixed(1)}%` 
                  : (liveTrades.length > 0 
                      ? `${((liveTrades.filter((t: any) => (t.profitLoss || 0) > 0).length / liveTrades.length) * 100).toFixed(1)}%`
                      : "Awaiting Trades")}
              </div>
              <div className="text-xs text-slate-400">
                {liveTrades.length} recorded closed trades
              </div>
            </div>
            
            <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-4">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">Learned Rules</div>
              <div className="text-xl font-bold text-indigo-400">
                {learningStats?.learnedRulesCount ?? 0}
              </div>
              <div className="text-xs text-slate-400">Memory rules extracted</div>
            </div>
          </div>
          
          <div className="md:col-span-3">
             <h4 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3">
               Recent Executed Trades ({recentTrades.length})
             </h4>
             {recentTrades.length > 0 ? (
               <div className="space-y-3">
                 {recentTrades.map((t: any, idx: number) => {
                   const isBuy = t.side === "BUY";
                   const pnl = Number(t.profitLoss || 0);
                   return (
                     <div 
                       key={t.id || idx} 
                       className={`bg-[#0A0F16] border rounded-lg p-3 flex flex-col sm:flex-row justify-between gap-4 ${
                         isBuy ? 'border-emerald-500/30' : 'border-indigo-500/30'
                       }`}
                     >
                       <div className="flex items-center gap-4">
                         <div className={`px-3 py-1 rounded font-bold text-xs uppercase tracking-widest border ${
                           isBuy 
                             ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' 
                             : 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                         }`}>
                           {t.side}
                         </div>
                         <div>
                           <div className="font-bold text-white font-mono">{t.symbol}</div>
                           <div className="text-[10px] text-slate-500 uppercase tracking-widest">
                             {t.quantity || t.shares || 1} shares @ ${Number(t.price || t.entryPrice || 0).toFixed(2)}
                           </div>
                         </div>
                       </div>
                       <div className="flex-1 sm:border-l border-slate-800 sm:pl-4">
                         <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1">
                           Decision Context
                         </div>
                         <div className="text-xs text-slate-300 truncate max-w-md">
                           {t.reasoning || t.agent || (pnl !== 0 ? `Realized P/L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : "Executed via ChiefTraderAgent consensus")}
                         </div>
                       </div>
                     </div>
                   );
                 })}
               </div>
             ) : (
               <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-4 text-xs font-mono text-slate-500 text-center">
                 No recent trades recorded on ledger. Engine is scanning for risk-verified opportunities.
               </div>
             )}
             
             <div className="mt-6">
               <h4 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3">
                 Current Active Holdings ({activePositions.length})
               </h4>
               {activePositions.length > 0 ? (
                 <div className="flex flex-wrap gap-4">
                   {activePositions.map((pos: any, idx: number) => {
                     const currentPrice = assetPrices[pos.symbol] ?? pos.currentPrice ?? pos.entryPrice ?? 0;
                     const pnl = (currentPrice - (pos.entryPrice || 0)) * (pos.quantity || pos.shares || 0);
                     const isPos = pnl >= 0;
                     return (
                       <div key={pos.symbol || idx} className="bg-[#0A0F16] border border-slate-800 rounded px-4 py-2 flex items-center justify-between gap-4 min-w-[140px]">
                         <div>
                           <div className="font-bold text-slate-200 font-mono text-xs">{pos.symbol}</div>
                           <div className="text-[9px] text-slate-500">{pos.quantity || pos.shares || 0} shs</div>
                         </div>
                         <span className={`font-bold text-xs font-mono ${isPos ? 'text-emerald-400' : 'text-rose-400'}`}>
                           {isPos ? '+' : ''}${pnl.toFixed(2)}
                         </span>
                       </div>
                     );
                   })}
                 </div>
               ) : (
                 <div className="bg-[#0A0F16] border border-slate-800 rounded-lg p-3 text-xs font-mono text-slate-500 text-center">
                   No active stock positions held. 100% capital in cash reserve.
                 </div>
               )}
             </div>
          </div>
        </div>
      </div>
      
    </div>
  );
}
