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
  Clock, CheckCircle, FileText, Database, Radio, Settings, Sliders, AlertTriangle, X
} from "lucide-react";
import { XAxis, YAxis, Tooltip, AreaChart, Area } from "recharts";
import { SafeResponsiveContainer } from "./shared/SafeResponsiveContainer";
import { Explainer } from "./ContextualTooltip";
import { UnavailableHint } from "./UnavailableHint";

/** Ledger fill/submit time for Recent Executed Trades. Prefers filledAt; never fabricates a clock. */
const formatTradeTimestamp = (ts: string | number | null | undefined): string => {
  if (ts == null || ts === '') return '--:--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

const tradeLedgerTimestamp = (t: {
  filledAt?: string | null;
  filled_at?: string | null;
  timestamp?: string | number | null;
  submittedAt?: string | null;
  submitted_at?: string | null;
  createdAt?: string | number | null;
  created_at?: string | number | null;
}): string =>
  formatTradeTimestamp(
    t.filledAt ?? t.filled_at ?? t.timestamp ?? t.submittedAt ?? t.submitted_at ?? t.createdAt ?? t.created_at,
  );

interface AutonomousDashboardProps {
  autoBotConfig?: any;
  portfolioData?: any;
  trades?: any[];
  pnlHistory?: any[];
  assetPrices?: Record<string, number>;
  systemState?: string;
  setSystemState?: any;
  setShowLaunchDialog?: any;
  /** Persist settings.budget (Argus allocation, not broker equity). */
  onSaveAllocatedBudget?: (budget: number) => Promise<{ ok: boolean; error?: string }>;
  onOpenMissionControl?: () => void;
}

export function AutonomousDashboard({ 
  autoBotConfig = {}, 
  portfolioData: initialPortfolioData,
  trades: initialTrades,
  pnlHistory,
  assetPrices = {},
  systemState,
  setSystemState,
  setShowLaunchDialog,
  onSaveAllocatedBudget,
  onOpenMissionControl,
}: AutonomousDashboardProps) {
  const [currentTime, setCurrentTime] = useState(new Date());
  // Allocation editor is config, not an order. Hands-Off Mode and ENGINE PAUSED must not
  // block it - that toggle is local UX only and does not pause TradingEngine or RiskEngine.
  const [budgetEditorOpen, setBudgetEditorOpen] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState("");
  const [budgetSaving, setBudgetSaving] = useState(false);
  const [budgetSaveError, setBudgetSaveError] = useState<string | null>(null);

  // Real data states with fallback fetch
  const [livePortfolio, setLivePortfolio] = useState<any>(initialPortfolioData || null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [liveTrades, setLiveTrades] = useState<any[]>(initialTrades || []);
  const [performanceData, setPerformanceData] = useState<any[]>([]);
  const [systemIntegrity, setSystemIntegrity] = useState<any>(null);
  const [learningStats, setLearningStats] = useState<any>(null);
  const [isLoadingChart, setIsLoadingChart] = useState(true);

  // Sync props to state if provided (including fail-closed null — do not keep stale equity).
  useEffect(() => {
    if (initialPortfolioData !== undefined) {
      setLivePortfolio(initialPortfolioData);
      if (initialPortfolioData) setPortfolioError(null);
    }
  }, [initialPortfolioData]);

  useEffect(() => {
    if (initialTrades) setLiveTrades(initialTrades);
  }, [initialTrades]);

  // Update clock
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Parent App.tsx already polls GET /api/v1/portfolio. A second 10s loop here was the
  // "broken KPI" 502 spam after Alpaca/proxy failures. Only self-fetch when used standalone.
  useEffect(() => {
    if (initialPortfolioData !== undefined) return;
    let isMounted = true;
    let failStreak = 0;
    let backoffUntil = 0;
    const fetchPortfolio = async () => {
      if (Date.now() < backoffUntil) return;
      try {
        const res = await fetch("/api/v1/portfolio");
        if (!res.ok) {
          if (isMounted) {
            setLivePortfolio(null);
            setPortfolioError((await res.json().catch(() => ({})))?.reason || `HTTP ${res.status}`);
          }
          failStreak += 1;
          backoffUntil = Date.now() + Math.min(60_000, 10_000 * 2 ** (failStreak - 1));
          return;
        }
        const data = await res.json();
        if (data?.available === false) {
          if (isMounted) {
            setLivePortfolio(null);
            setPortfolioError(data.reason || data.error || "Broker portfolio unavailable");
          }
          return;
        }
        failStreak = 0;
        backoffUntil = 0;
        if (isMounted) {
          setLivePortfolio(data);
          setPortfolioError(null);
        }
      } catch (e) {
        if (isMounted) {
          setLivePortfolio(null);
          setPortfolioError(e instanceof Error ? e.message : "Network error");
        }
        failStreak += 1;
        backoffUntil = Date.now() + Math.min(60_000, 10_000 * 2 ** (failStreak - 1));
      }
    };

    fetchPortfolio();
    const interval = setInterval(fetchPortfolio, 10000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [initialPortfolioData]);

  // Fetch real trades if not provided via props. Parent App.tsx already polls
  // GET /api/v1/trades; a second 12s loop here doubled that traffic even when
  // trades={[]} was passed (empty array is still "provided").
  useEffect(() => {
    if (initialTrades !== undefined) return;
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

    fetchTrades();
    const interval = setInterval(fetchTrades, 12000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [initialTrades]);

  // Analytics is already polled by App.tsx into pnlHistory. A second fetch here,
  // especially one that re-ran whenever portfolio/trades props changed, stacked
  // /pnl/analytics and froze the chart on the loading label.
  useEffect(() => {
    const formatHistory = (history: any[]) => history.map((h: any) => ({
      time: h.date || (h.timestamp ? new Date(h.timestamp * 1000).toLocaleTimeString() : "N/A"),
      value: Number(h.cumulative ?? h.equity ?? 0),
      pnl: Number(h.pnl ?? h.profit_loss ?? 0)
    }));
    if (pnlHistory !== undefined) {
      if (Array.isArray(pnlHistory) && pnlHistory.length > 0) {
        setPerformanceData(formatHistory(pnlHistory));
      }
      setIsLoadingChart(false);
      return;
    }
    let isMounted = true;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch("/api/v1/pnl/analytics");
        const data = await res.json();
        if (!isMounted) return;
        if (data.history && Array.isArray(data.history) && data.history.length > 0) {
          setPerformanceData(formatHistory(data.history));
        }
      } catch (e) {
        console.error("AutonomousDashboard PnL analytics error:", e);
      } finally {
        inFlight = false;
        if (isMounted) setIsLoadingChart(false);
      }
    };
    void load();
    const interval = setInterval(() => { void load(); }, 60_000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, [pnlHistory]);

  useEffect(() => {
    if (performanceData.length > 0) return;
    if (!Array.isArray(liveTrades) || liveTrades.length === 0) return;
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
  }, [liveTrades, livePortfolio, autoBotConfig?.budget, performanceData.length]);

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
  const allocatedBudget = autoBotConfig?.budget ?? autoBotConfig?.targetBudget;
  const rawEquity = livePortfolio?.equity ?? livePortfolio?.snapshot?.total_equity;
  const cashFallback = typeof livePortfolio?.cash === "number" ? Number(livePortfolio.cash) : undefined;
  const portfolioEquity = typeof rawEquity === "number" ? rawEquity : cashFallback;
  const brokerAvailableRaw = livePortfolio?.buying_power ?? livePortfolio?.buyingPower ?? livePortfolio?.cash;
  const brokerAvailableToTrade = typeof brokerAvailableRaw === "number" ? brokerAvailableRaw : Number(brokerAvailableRaw);
  const hasBrokerFundsSnapshot = Number.isFinite(brokerAvailableToTrade);
  const draftBudget = Number(budgetDraft);
  const draftOverBuyingPower = hasBrokerFundsSnapshot && Number.isFinite(draftBudget) && draftBudget > brokerAvailableToTrade;

  const openBudgetEditor = () => {
    setBudgetDraft(String(Number(allocatedBudget) || ""));
    setBudgetSaveError(null);
    setBudgetEditorOpen(true);
  };

  const saveBudgetFromEditor = async () => {
    if (!onSaveAllocatedBudget) {
      setBudgetSaveError("Allocated capital cannot be saved from this view.");
      return;
    }
    if (!Number.isFinite(draftBudget) || draftBudget <= 0) {
      setBudgetSaveError("Allocated capital must be a positive dollar amount.");
      return;
    }
    setBudgetSaving(true);
    setBudgetSaveError(null);
    try {
      const result = await onSaveAllocatedBudget(draftBudget);
      if (result.ok) {
        setBudgetEditorOpen(false);
      } else {
        setBudgetSaveError(result.error || "Failed to save allocated capital.");
      }
    } catch (e: any) {
      setBudgetSaveError(e?.message || "Failed to reach the server.");
    } finally {
      setBudgetSaving(false);
    }
  };
  
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

  const pnlPercent = typeof portfolioEquity === "number" && portfolioEquity > 0 ? (todaysPnl / portfolioEquity) * 100 : 0;
  const isPnlPositive = todaysPnl >= 0;

  // Active positions and recent trades
  const activePositions = Array.isArray(livePortfolio?.positions) ? livePortfolio.positions : [];
  const recentTrades = liveTrades.slice(0, 3);
  // Canonical flag is TradingEngine.state.enabled (GET /api/v1/autobot `enabled`).
  // `autoBotEnabled` is the DB column name — accept either so this badge cannot show
  // ACTIVE while Observatory AutoBot is STOPPED, or STANDBY while the engine is on.
  const autobotOn = autoBotConfig?.enabled === true || autoBotConfig?.autoBotEnabled === true;
  const isEngineActive = autobotOn && autoBotConfig?.tradingState !== "EMERGENCY_STOP";

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
                <Explainer id="engineRunBadge" quiet>{isEngineActive ? "Running Live" : "Engine Paused"}</Explainer>
              </span>
            </h1>
            <p className="text-slate-400 text-sm mt-1 flex items-center gap-2">
              <Clock size={14} /> System Time: {currentTime.toLocaleTimeString()}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4 bg-[#0A0F16] p-2 rounded-lg border border-slate-800 relative z-10">
          <div className="flex flex-col px-4 border-r border-slate-800">
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-widest"><Explainer id="operationMode">Operation Mode</Explainer></span>
            <span className="text-sm font-bold text-white mt-1">
              {String(autoBotConfig?.tradingMode || "PAPER").toUpperCase()}
            </span>
          </div>
          <div
            className="px-3 flex items-center gap-3 cursor-pointer"
            onClick={() => onOpenMissionControl?.()}
            title="Hands-Off is not a safety switch. Start/stop Autobot on Mission Control."
          >
             <span className="text-xs font-bold text-indigo-300">
               <Explainer id="handsOffMode" quiet>Open Mission Control</Explainer>
             </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        
        {/* Left Column: Stats & Chart */}
        <div className="xl:col-span-2 space-y-6">
          {/* Key Metrics */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm relative z-10">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2 flex justify-between items-center">
                <Explainer id="allocatedCapital">Allocated Capital</Explainer>
                <button
                  type="button"
                  title="Set Argus allocation (not broker equity)"
                  aria-label="Edit allocated capital"
                  onClick={openBudgetEditor}
                  className="relative z-20 p-1 -m-1 rounded text-slate-600 hover:text-slate-300 cursor-pointer transition-colors"
                >
                  <Settings size={12} />
                </button>
              </div>
              <div className="text-3xl font-bold text-white">
                {typeof allocatedBudget === "number"
                  ? `$${Number(allocatedBudget).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
                  : <UnavailableHint reason="settings.budget has not loaded from GET /api/v1/autobot yet.">--</UnavailableHint>}
              </div>
            </div>
            
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-2">
                <Explainer id="portfolioValuation">Portfolio Valuation</Explainer>
              </div>
              <div className="text-3xl font-bold text-indigo-400">
                {typeof portfolioEquity === "number"
                  ? `$${Number(portfolioEquity).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : <UnavailableHint reason={portfolioError
                    ? `GET /api/v1/portfolio failed: ${portfolioError} This is not Argus allocated capital.`
                    : "Broker equity/cash has not returned from GET /api/v1/portfolio. This is not Argus allocated capital."}>--</UnavailableHint>}
              </div>
            </div>

            <div className={`bg-[#1A1F2B] border rounded-xl p-5 shadow-sm ${
              isPnlPositive ? 'border-emerald-500/20 shadow-[0_0_20px_rgba(16,185,129,0.05)]' : 'border-rose-500/20 shadow-[0_0_20px_rgba(244,63,94,0.05)]'
            }`}>
              <div className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isPnlPositive ? 'text-emerald-500/70' : 'text-rose-500/70'}`}>
                <Explainer id="todaysPnl">Today's P/L</Explainer>
              </div>
              <div className={`text-3xl font-bold ${isPnlPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
                {!livePortfolio ? (
                  <UnavailableHint reason="Today's P/L waits on the broker portfolio snapshot. $0.00 is only shown after a real book is loaded.">--</UnavailableHint>
                ) : (
                  <>
                {isPnlPositive ? '+' : ''}${Number(todaysPnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <span className="text-xs font-mono ml-2 font-normal opacity-80">
                  ({isPnlPositive ? '+' : ''}{pnlPercent.toFixed(2)}%)
                </span>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Performance Chart */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
             <div className="flex justify-between items-center mb-6">
               <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                 <TrendingUp size={16} className="text-indigo-400" /> <Explainer id="realizedPerformance">Realized & Intraday Performance</Explainer>
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
                 <SafeResponsiveContainer>
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
                 </SafeResponsiveContainer>
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
              <Activity size={14} className="text-indigo-400" /> <Explainer id="aiEngineOps">AI Engine Operations</Explainer>
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
                 <span className="text-slate-300"><Explainer id="riskEngineGates" quiet>RiskEngine: ordered safety gates (live sizing is not ATR)</Explainer></span>
               </div>
               <div className="flex items-center gap-3 text-xs">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-600'}`}></div>
                 <span className="text-slate-300">ChiefTraderAgent: Dynamic weight consensus</span>
               </div>
               <div className="flex items-center gap-3 text-xs pt-1 border-t border-slate-800">
                 <div className={`w-2 h-2 rounded-full ${isEngineActive ? 'bg-indigo-400 animate-pulse' : 'bg-amber-500'}`}></div>
                 {isEngineActive ? (
                   <span className="text-indigo-300 font-bold">Autonomous EventBus polling active</span>
                 ) : (
                   <button
                     type="button"
                     onClick={() => onOpenMissionControl?.()}
                     className="text-amber-400 font-bold text-left hover:text-amber-300"
                   >
                     Engine on standby — click Start in Mission Control
                   </button>
                 )}
               </div>
            </div>
          </div>

          {/* System Health */}
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Server size={14} className="text-indigo-400" /> <Explainer id="subsystemIntegrity">Subsystem Integrity</Explainer>
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Radio size={12}/> <Explainer id="newsEngineStatus">News Engine</Explainer></span>
                <span className={`font-bold px-2 py-0.5 rounded text-[10px] ${
                  !systemIntegrity
                    ? 'text-slate-400 bg-slate-800'
                    : systemIntegrity?.checks?.news_provider_configured?.status === 'PASS'
                    ? 'text-emerald-400 bg-emerald-500/10'
                    : 'text-amber-400 bg-amber-500/10'
                }`}>
                  {!systemIntegrity
                    ? 'Checking…'
                    : systemIntegrity?.checks?.news_provider_configured?.status === 'PASS'
                      ? 'Configured'
                      : 'Warning'}
                </span>
              </div>
              
              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Database size={12}/> SQLite Database</span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]">
                  <Explainer id="sqliteWal">WAL Mode</Explainer>
                </span>
              </div>

              <div className="flex justify-between items-center text-xs">
                <span className="text-slate-400 flex items-center gap-2"><Cpu size={12}/> <Explainer id="riskEngineGates">Risk Engine Gates</Explainer></span>
                <span className="text-emerald-400 font-bold bg-emerald-500/10 px-2 py-0.5 rounded text-[10px]">
                  Ordered gates armed
                </span>
              </div>

              <div className="h-px w-full bg-slate-800 my-2"></div>
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1"><Explainer id="aiRouterGateway">AI Router Gateway</Explainer></div>
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
                <ShieldCheck size={14} className="text-emerald-400" /> <Explainer id="activeRiskLimits">Active Risk Limits</Explainer>
              </h3>
              <button
                type="button"
                title="Edit daily loss / max trade / max positions on Mission Control"
                onClick={() => onOpenMissionControl?.()}
                className="text-slate-500 hover:text-white"
              >
                <Sliders size={14} />
              </button>
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between text-slate-400">
                <span><Explainer id="dailyLossLimitMetric">Maximum Daily Loss</Explainer></span>
                <span className="text-white font-bold font-mono">
                  ${Number(autoBotConfig?.dailyLossLimit ?? 5000).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span><Explainer id="maxTradeSizeMetric">Max Single Trade Size</Explainer></span>
                <span className="text-white font-bold font-mono">
                  ${Number(autoBotConfig?.maxTradeSize ?? 3000).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span><Explainer id="maxOpenPositionsMetric">Max Open Positions</Explainer></span>
                <span className="text-white font-bold font-mono">
                  {autoBotConfig?.maxOpenPositions ?? 10}
                </span>
              </div>
              <div className="flex justify-between text-slate-400 mt-2 pt-2 border-t border-slate-800">
                <span><Explainer id="emergencyBreaker">Emergency Circuit Breaker</Explainer></span>
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
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1"><Explainer id="agentWinRateMetric">Agent Win Rate</Explainer></div>
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
              <div className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-1"><Explainer id="learnedRulesMetric">Learned Rules</Explainer></div>
              <div className="text-xl font-bold text-indigo-400">
                {learningStats?.learnedRulesCount ?? 0}
              </div>
              <div className="text-xs text-slate-400">Memory rules extracted</div>
            </div>
          </div>
          
          <div className="md:col-span-3">
             <h4 className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mb-3">
               <Explainer id="recentTradesList">Recent Executed Trades</Explainer> ({recentTrades.length})
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
                           <div className="mt-1 flex items-center gap-1 text-[10px] font-mono text-slate-400 tabular-nums tracking-wide normal-case">
                             <Clock size={10} className="text-slate-500 shrink-0" />
                             {tradeLedgerTimestamp(t)}
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
                 No recent trades recorded on the ledger. {isEngineActive ? "Autobot is on — fills appear after consensus and RiskEngine pass." : "Autobot is paused. Start it from Mission Control; this panel does not invent fills."}
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

      {budgetEditorOpen && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm"
          onClick={() => !budgetSaving && setBudgetEditorOpen(false)}
        >
          <form
            className="bg-[#0A0F16] border border-slate-800 rounded-xl w-full max-w-md shadow-2xl font-mono"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              void saveBudgetFromEditor();
            }}
          >
            <div className="flex justify-between items-center p-4 border-b border-slate-800 bg-[#111822]">
              <div>
                <h2 className="text-white font-bold tracking-widest uppercase text-sm">Allocated Capital</h2>
                <p className="text-[10px] text-slate-500 uppercase mt-1">Argus allocation cap, not broker equity</p>
              </div>
              <button
                type="button"
                aria-label="Close allocated capital editor"
                disabled={budgetSaving}
                onClick={() => setBudgetEditorOpen(false)}
                className="text-slate-500 hover:text-white transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-[11px] text-slate-400 leading-relaxed">
                This is the dollar slice Argus may commit (`settings.budget`). RiskEngine still sizes and refuses orders. It is not the broker account value shown as Portfolio Valuation.
              </p>
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-widest block mb-2">Current allocation</label>
                <div className="flex items-center gap-2 border-b border-slate-700 pb-1">
                  <span className="text-xl font-bold text-slate-200">$</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    autoFocus
                    className={"w-full bg-transparent text-xl font-bold outline-none " + (draftOverBuyingPower ? "text-rose-400" : "text-white")}
                    value={budgetDraft}
                    onChange={(e) => setBudgetDraft(e.target.value)}
                    disabled={budgetSaving}
                  />
                </div>
              </div>
              <div className="flex justify-between text-[10px] font-mono text-slate-500">
                <span>Broker available</span>
                <span className={draftOverBuyingPower ? "text-rose-400 font-bold" : "text-emerald-400"}>
                  {hasBrokerFundsSnapshot
                    ? `$${brokerAvailableToTrade.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                    : <UnavailableHint reason="Broker buying power/cash has not returned yet.">--</UnavailableHint>}
                </span>
              </div>
              {draftOverBuyingPower && (
                <p className="text-[10px] text-rose-400 leading-relaxed">
                  This exceeds the active broker's buying power/cash. You can still save the allocation, but Autobot Start will reject until you lower it or the broker reports more available funds.
                </p>
              )}
              {budgetSaveError && (
                <p className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2 leading-relaxed">
                  {budgetSaveError}
                </p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  disabled={budgetSaving}
                  onClick={() => setBudgetEditorOpen(false)}
                  className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={budgetSaving}
                  className="px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-widest bg-indigo-500 hover:bg-indigo-400 text-white disabled:opacity-50"
                >
                  {budgetSaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
      
    </div>
  );
}
