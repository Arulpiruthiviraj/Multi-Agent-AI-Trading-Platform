/**
 * ==========================================================
 * Module:
 * DocumentationTab.tsx
 *
 * Purpose:
 * Core implementation and logic for the DocumentationTab.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for DocumentationTabx
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

import React, { useState } from "react";
import { 
  BookOpen, Layers, Target, Activity, Wallet, BarChart3, 
  BrainCircuit, Terminal, Zap, ShieldCheck, Search, X, 
  ChevronRight, AlignLeft, Info, Settings, Database, 
  LineChart, Bot, CheckCircle2, Play, Circle, PlayCircle,
  Network, Scale, Cpu, Radar, MessageSquare, AlertTriangle, ArrowDown,
  TrendingUp, Sliders, Eye, Lock, Globe, Shield
} from "lucide-react";

interface DocumentationTabProps {
  setActiveTab: (tab: string) => void;
}

type DocSection = {
  id: string;
  category: string;
  title: string;
  icon: React.ReactNode;
  isCourse?: boolean;
  content: React.ReactNode;
};

const DocumentationTab: React.FC<DocumentationTabProps> = ({ setActiveTab }) => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSectionId, setActiveSectionId] = useState<string>("intro-basics");
  const [completedModules, setCompletedModules] = useState<Record<string, boolean>>({});
  const [beginnerMode, setBeginnerMode] = useState<boolean>(true);

  const markCompleted = (id: string) => {
    setCompletedModules(prev => ({ ...prev, [id]: true }));
  };

  const sections: DocSection[] = [
    // COURSE 1: Beginner Onboarding
    {
      id: "intro-basics",
      category: "1. Terminal Onboarding",
      title: "Argus Terminal Overview",
      isCourse: true,
      icon: <BookOpen size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-2xl font-bold text-white tracking-tight font-sans">Argus Autonomous Trading Terminal</h2>
            {beginnerMode && (
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest flex items-center gap-1.5 shadow-[0_0_10px_rgba(16,185,129,0.2)]">
                <CheckCircle2 size={12}/> Beginner Mode Active
              </span>
            )}
          </div>
          
          <p className="text-slate-300 leading-relaxed text-sm">
            Welcome to the <strong>Argus Autonomous Trading Terminal</strong>, a full-stack, event-driven multi-agent trading platform. This documentation describes what the running application actually does, verified against its own source and live behavior — not an idealized description of what it could do.
          </p>

          <div className="p-4 bg-slate-900/80 rounded border border-slate-800 flex items-start gap-3">
            <Bot size={18} className="text-indigo-400 mt-1 shrink-0" />
            <div>
              <span className="text-xs font-mono font-bold text-indigo-300 uppercase block mb-1">HOW A TRADE DECISION IS ACTUALLY MADE</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                Independent agents (Technical, News, Fundamental, Macro, and a local Chronos-based forecaster) each propose a BUY/SELL/HOLD idea with a real confidence score. The <strong>Chief Trader</strong> combines these into a single weighted consensus vote (approving only above 75% weighted confidence), and the <strong>Risk Engine</strong> checks that approved idea against real account equity, real market hours, and real circuit breakers before any order is placed.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-indigo-500/30 transition-colors group">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><LineChart size={16} className="group-hover:animate-pulse"/> 1. Dashboard Visualizers</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Live agent status, order events, and account state driven by real backend events. Some analytics panels (drawdown/heatmap/correlation-style charts) are still placeholder visuals not yet backed by real data — this is disclosed, not hidden.
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-emerald-500/30 transition-colors group">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><Target size={16} className="group-hover:animate-pulse"/> 2. Autonomous Mission Control</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Enable/disable the autonomous engine, set budget/risk level/strategy, and use the real Emergency Stop kill-switch. Enabling the AutoBot is also what starts the background news-ingestion and event-logging pipelines — they don't run on their own.
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-amber-500/30 transition-colors group">
              <h3 className="text-amber-400 font-bold mb-2 flex items-center gap-2"><Sliders size={16} className="group-hover:animate-pulse"/> 3. Backtest &amp; Walk-Forward</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Runs the same deterministic technical rules against real historical Alpaca bars, with real spread-cost modeling and a real look-ahead-bias guard. The one real result run so far shows no out-of-sample edge on AAPL — an honest finding, not a bug.
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-rose-500/30 transition-colors group">
              <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><Network size={16} className="group-hover:animate-pulse"/> 4. Local AI Stack (optional)</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Ollama-hosted chat models and a local Chronos time-series forecaster can run entirely on your machine at $0 marginal cost, as an alternative to a paid cloud LLM for some tasks. See <code className="text-[10px]">docs/LOCAL_AI_SETUP.md</code> and <code className="text-[10px]">npm run setup:ai</code>.
              </p>
            </div>
          </div>

          <div className="bg-slate-800/50 border border-slate-700 p-5 rounded-lg mt-8 flex justify-between items-center transition-all duration-300 hover:bg-slate-800">
            <div>
              <h4 className="text-white font-bold mb-1 text-sm">Interactive Beginner Mode Guidance</h4>
              <p className="text-slate-400 text-xs font-mono">Enabling beginner mode shows more detailed explanations throughout this documentation. It does not change any live trading behavior or exposure limits — those are configured in Settings/Guardrails, not here.</p>
            </div>
            <button
              onClick={() => setBeginnerMode(!beginnerMode)}
              className={"px-4 py-2 rounded text-xs font-bold transition-all duration-300 " + (beginnerMode ? "bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)] hover:bg-emerald-400" : "bg-slate-700 text-slate-300 hover:bg-slate-600")}
            >
              {beginnerMode ? "Active" : "Activate Mode"}
            </button>
          </div>

          <div className="flex justify-end mt-8">
            <button 
              onClick={() => { markCompleted("intro-basics"); setActiveSectionId("agent-council"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              Understand Agent Council <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },
    
    // COURSE 2: Intelligence & Consensus Pipeline
    {
      id: "agent-council",
      category: "1. Terminal Onboarding",
      title: "The Multi-Agent Consensus Loop",
      isCourse: true,
      icon: <BrainCircuit size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight mb-2">Multi-Agent Consensus Pipeline</h2>
          <p className="text-slate-300 text-sm mb-6">
            Independent agents each watch different real inputs and publish a <code className="text-[11px]">TRADE_IDEA_GENERATED</code> event with a symbol, side, and confidence (0-1). The Chief Trader collects these per symbol and computes one weighted decision.
          </p>

          {/* Visual flow chart */}
          <div className="bg-slate-950 border border-slate-800 p-6 rounded-lg font-mono text-xs flex flex-col items-center">

            <div className="bg-indigo-950/40 border border-indigo-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-indigo-400 block mb-1 uppercase tracking-wider">TechnicalAgent</span>
              <p className="text-[10px] text-slate-400">Real RSI/MACD/SMA/Bollinger math on every live tick. Confidence is calculated from how far the indicator values are into their trigger zone - not a fixed number.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-amber-950/40 border border-amber-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-amber-400 block mb-1 uppercase tracking-wider">News / Fundamental / Macro Agents</span>
              <p className="text-[10px] text-slate-400">Each routes a prompt through AIRouter (real news/AlphaVantage data + an LLM) and self-reports a confidence, normalized to 0-1.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-rose-950/40 border border-rose-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-rose-400 block mb-1 uppercase tracking-wider">KronosForecastAgent</span>
              <p className="text-[10px] text-slate-400">Maintains its own rolling price history per symbol and calls a local Chronos time-series model for a real numerical forecast once it has 30+ ticks.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-emerald-950/40 border border-emerald-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-emerald-400 block mb-1 uppercase tracking-wider">ChiefTraderAgent</span>
              <p className="text-[10px] text-slate-400">Weighted vote across whichever agents fired for that symbol. Approves only above 75% weighted confidence.</p>
            </div>
          </div>

          <div className="space-y-4 mt-6">
            <h3 className="text-lg font-bold text-white uppercase font-mono tracking-wide">Deep Dive into Agent Roles</h3>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-indigo-400 font-bold mb-1">
                <Bot size={16} />
                <span>TechnicalAgent</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Listens to every real market tick, computes RSI/MACD/SMA/Bollinger Bands, and checks three deterministic rule branches (momentum breakout, mean reversion, overbought). Confidence is <code className="text-[10px]">0.55 + 0.40 × avg(strength terms)</code>, where each strength term is a real 0-1 function of how far the actual indicator value is past its trigger threshold - RSI at 51 and RSI at 69 produce measurably different confidence for the same rule.
              </p>
            </div>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-amber-400 font-bold mb-1">
                <ShieldCheck size={16} />
                <span>News / Fundamental / Macro Agents</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                NewsEngine ingests real RSS and paid news APIs and clusters/scores articles. FundamentalAgent and MacroAgent pull real AlphaVantage data. All three route their analysis through <strong>AIRouter</strong> (never call a provider SDK directly) and self-report a confidence - a genuinely different input each time, but the same underlying mechanism (an LLM's own confidence claim) three times over, with no independent calibration check on whether a model's stated confidence matches its real hit rate.
              </p>
            </div>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-rose-400 font-bold mb-1">
                <Zap size={16} />
                <span>KronosForecastAgent (Chronos-backed)</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Calls a persistent local service (<code className="text-[10px]">npm run ai:serve</code>) running Amazon's Chronos time-series model. Needs 30+ real ticks of history for a symbol and a 60-second cooldown between calls per symbol. If the service isn't running, this agent honestly reports unavailable rather than fabricating a forecast - it never blocks the rest of the pipeline.
              </p>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button 
              onClick={() => setActiveSectionId("intro-basics")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button 
              onClick={() => { markCompleted("agent-council"); setActiveSectionId("atr-positioning"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              Learn ATR Positioning <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 3: Real Risk Engine Position Sizing
    {
      id: "atr-positioning",
      category: "2. Mathematical Safeguards",
      title: "Risk Engine Position Sizing",
      isCourse: true,
      icon: <Scale size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">How the Risk Engine Sizes a Position</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Every approved trade idea is sized by <code className="text-xs">RiskEngine.evaluateRisk()</code> using three independent caps, real broker account data, and the <strong>smallest</strong> of the three wins.
          </p>

          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
            <span className="text-[10px] font-mono uppercase text-slate-500 block mb-2">Mathematical Formulation</span>
            <h3 className="text-sm font-bold text-white mb-2">Three Independent Sizing Caps</h3>
            <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-xs text-slate-300 mb-4 space-y-2">
              <div>1. Risk cap: <span className="text-indigo-400">maxSharesByRisk = (equity × riskPct) / (price × 0.05)</span></div>
              <div>2. Capital cap: <span className="text-indigo-400">maxSharesByCapital = maxTradeSize / price</span></div>
              <div>3. Buying-power cap: <span className="text-indigo-400">maxSharesByBuyingPower = buyingPower / price</span></div>
            </div>
            <p className="text-xs text-slate-300">
              <code className="text-[10px]">maxQuantity = min(all three)</code>, then further reduced if it would push the position past 20% of account equity (the concentration cap), or capped to the existing position size on a SELL.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold block mb-2">STOP-LOSS ASSUMPTION</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                The risk cap assumes a flat <strong>5% per-share risk</strong> (<code className="text-[10px]">riskPerShare = price × 0.05</code>) - a simplifying assumption, not a volatility-adjusted (ATR-based) stop. This is disclosed here specifically because it's less sophisticated than the number might imply.
              </p>
            </div>

            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold block mb-2">CONCENTRATION CAP</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                No single symbol may exceed <strong>20% of real account equity</strong> after the trade fills. This reduces the order size rather than rejecting it outright, and applies on top of the three caps above.
              </p>
            </div>
          </div>

          <div className="bg-[#111822] border border-slate-800 p-4 rounded">
            <span className="text-[10px] font-mono uppercase text-amber-400 font-bold block mb-3">RISK LEVEL → PORTFOLIO RISK %</span>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Conservative</span>
                <span className="text-emerald-400 font-bold">1.0% of account equity</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Balanced (default)</span>
                <span className="text-indigo-400 font-bold">2.0% of account equity</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Aggressive</span>
                <span className="text-rose-400 font-bold">3.0% of account equity</span>
              </div>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setActiveSectionId("agent-council")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => { markCompleted("atr-positioning"); setActiveSectionId("cio-deck"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              Explore Chief Trader Consensus <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 4: Chief Trader CIO Deck
    {
      id: "cio-deck",
      category: "2. Mathematical Safeguards",
      title: "Chief Trader Consensus Math",
      isCourse: true,
      icon: <Sliders size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Chief Trader Agent: The Real Consensus Math</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            <code className="text-xs">ChiefTraderAgent</code> collects every trade idea for a symbol within a rolling window and runs one weighted-vote calculation per side (BUY/SELL).
          </p>

          <div className="space-y-4">
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STEP 1
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Weight Ideas That Agree
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Each agent has a real, DB-synced weight (default weights: TechnicalAgent 0.25, NewsAgent 0.25, FundamentalAgent 0.20, MacroAgent/KronosEngine 0.15-0.20; adjusted over time by the Reflection Engine's real accuracy tracking).
              </p>
              <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-[11px] text-slate-300">
                weightedConfidence = Σ (idea.confidence × agent.weight) for every idea agreeing on this side
              </div>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STEP 2
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Discount for Disagreement
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Any agent proposing the opposite side pulls the score down at half weight - a real penalty, not a hard veto:
              </p>
              <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-[11px] text-slate-300">
                weightedConfidence −= (idea.confidence × agent.weight × 0.5) for every disagreeing idea
                <br/>finalConfidence = clamp(weightedConfidence / totalWeight, 0, 1)
              </div>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STEP 3
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Approve Only Above 75%
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Whichever side (BUY or SELL) has the higher final confidence wins. It's only forwarded to the Risk Engine as <code className="text-[10px]">CHIEF_APPROVED_IDEA</code> if that confidence exceeds <strong className="text-emerald-400">0.75</strong> - below that, the idea is held, not silently discarded, waiting for more agreement.
              </p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Optionally, if adversarial debate mode is on and a single idea's raw confidence exceeds 0.6, Chief Trader also runs a real multi-provider AI debate (via <code className="text-[10px]">AIRouter.routeConsensus</code>, 60s cooldown per symbol) and folds that result in as an additional weighted vote before deciding.
              </p>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setActiveSectionId("atr-positioning")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => { markCompleted("cio-deck"); setActiveSectionId("veto-protocols"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              See the Real Risk Gates <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // NEW COURSE 5: Veto Protocol Specifications
    {
      id: "veto-protocols",
      category: "2. Mathematical Safeguards",
      title: "The Real Risk Gates",
      isCourse: true,
      icon: <Shield size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">RiskEngine's Real Gates</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Every <code className="text-xs">CHIEF_APPROVED_IDEA</code> passes through <code className="text-xs">RiskAgent → RiskEngine.evaluateRisk()</code> before an order can be placed. Any one of these six real, checked-in-order gates can reject a trade outright.
          </p>

          <div className="space-y-4">
            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-rose-400 uppercase font-bold block mb-1">Gate 1: Daily-Loss Kill-Switch</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Equity vs. Real Daily Baseline</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Tracks real broker equity against a real start-of-day baseline captured the first time risk is evaluated each calendar day. Blocks <strong>all</strong> new trades once the loss reaches 80% of the configured daily loss limit - a real, hand-tested circuit breaker.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">Gate 2: Consecutive-Loss Breaker</span>
              <h3 className="text-sm font-bold text-white mb-2">Three Real Losses in a Row</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Reads the real realized P&amp;L of the last 3 <code className="text-[10px]">FILLED</code> trades from the database. If all three lost money, new trades are blocked pending manual review.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-indigo-400 uppercase font-bold block mb-1">Gate 3: Market-Hours &amp; Stale-Data Checks</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Alpaca Clock + Real Tick Age</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Calls Alpaca's real <code className="text-[10px]">/v2/clock</code> endpoint (cached 60s) to refuse trades outside market hours, and rejects a trade if the last real tick for that symbol is older than 5 minutes - never trades on a symbol Argus hasn't actually heard from recently.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">Gate 4: Single-Symbol Concentration Cap</span>
              <h3 className="text-sm font-bold text-white mb-2">20% of Real Account Equity, Maximum</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Reduces the order size (rather than rejecting outright) so no single symbol's position value can exceed 20% of real account equity after the fill.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 5: High-Impact-News Veto</span>
              <h3 className="text-sm font-bold text-white mb-2">Real News Clusters, 4-Hour Window</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Vetoes a trade if a real news cluster covering that symbol, updated within the last 4 hours, has an impact score above 80. (This gate previously queried the wrong database table and could never fire for any trade - fixed and now covered by an automated test.)
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 6: Order Idempotency</span>
              <h3 className="text-sm font-bold text-white mb-2">One Order Per Trace ID</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                <code className="text-[10px]">OrderManagementService</code> checks the trades table for an existing order with the same trace ID before placing a new one - a duplicate event for the same decision can never place a second real order.
              </p>
            </div>
          </div>

          <div className="callout bg-slate-900/50 border border-slate-800 p-4 rounded-lg">
            <p className="text-xs text-slate-400 leading-relaxed mb-0">
              <strong className="text-slate-200">Not yet built:</strong> sector/correlation exposure limits. Concentration is capped per-symbol only - many uncorrelated-looking-but-actually-correlated positions could still concentrate real risk today.
            </p>
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setActiveSectionId("cio-deck")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => { markCompleted("veto-protocols"); setActiveSectionId("evolution-learning"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              See Backtesting &amp; Reflection <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 6: Practice & Evolution
    {
      id: "evolution-learning",
      category: "3. Practice & Evolution",
      title: "Learning, Reflection & Strategy Backtesting",
      isCourse: true,
      icon: <LineChart size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Reflection & Real Backtesting</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            "Learning" and "backtesting" are two separate, real systems in Argus - and one of them has an important honest limitation worth understanding before you rely on it.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <span className="text-[10px] font-mono text-indigo-400 uppercase font-bold block mb-1">
                REFLECTION ENGINE
              </span>
              <h3 className="text-sm font-bold text-white mb-2">Real Scoring, Write-Only Rules</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                <code className="text-[10px]">ReflectionEngine</code> really does score each agent's past predictions against actual price movement and updates that agent's consensus weight in the database on a 60-second cycle - this genuinely changes future Chief Trader votes.
              </p>
              <div className="bg-slate-950 p-2.5 rounded border border-slate-900 font-mono text-[9px] text-amber-300 leading-tight">
                Honest limitation: it also writes LLM-generated rule text to a "learned rules" table, and that text is loaded at startup - but it is never injected into any agent's actual prompt. The rule-writing half of this loop is currently write-only.
              </div>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">
                EXPLAINABILITY AGENT
              </span>
              <h3 className="text-sm font-bold text-white mb-2">Real Per-Trade Narratives</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                For any trade with a real event trace, <code className="text-[10px]">ExplainabilityAgent</code> generates an LLM narrative built from that trade's actual recorded events (not a template) - genuinely answers "why did Argus buy this stock" for that specific trace ID.
              </p>
            </div>
          </div>

          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg mt-6">
            <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
              <Sliders size={16} className="text-indigo-400" />
              Backtest &amp; Walk-Forward Engine
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-3">
              Runs the same deterministic technical rules TechnicalAgent uses live, against real historical Alpaca bars, with a real spread-cost model and a hard look-ahead-bias guard (it cannot access a future bar even by accident).
            </p>
            <ul className="list-disc list-inside text-xs text-slate-400 space-y-1.5 font-mono">
              <li>Real walk-forward validation (rolling train/test windows) is built and has been run against real AAPL history.</li>
              <li>The one real result so far: average out-of-sample return was <strong className="text-rose-400">negative</strong> across 11 real periods - no demonstrated edge yet.</li>
              <li>Scope, stated precisely: this backtests the deterministic technical rules only. It does not yet replay the full AI-agent consensus pipeline (News/Fundamental/Macro/Chief Trader) against history.</li>
            </ul>
          </div>

          <div className="flex justify-between mt-8">
            <button 
              onClick={() => setActiveSectionId("veto-protocols")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button 
              onClick={() => { markCompleted("evolution-learning"); setActiveSectionId("simulator-safety"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              See Safety & Education <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 7: Safety and Risk Education
    {
      id: "simulator-safety",
      category: "3. Practice & Evolution",
      title: "Trading Simulator & Safety Education",
      isCourse: true,
      icon: <PlayCircle size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Virtual Simulator & General Risk Disclaimers</h2>
          <p className="text-slate-300 text-sm mb-6">
            Before connecting a real brokerage account or utilizing actual funds, please review these key safeguards and practice using the virtual paper-trading engine.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div className="bg-[#111822] border border-slate-800 rounded-lg p-5 hover:border-emerald-500/30 transition-colors">
               <h3 className="text-white font-bold mb-3 flex items-center gap-2"><Wallet size={16} className="text-emerald-400"/> Paper Trading Simulator</h3>
               <p className="text-slate-400 text-xs mb-4">Start with a virtual $100,000 portfolio to test strategies without real-world risk. Observe how different Strategy Focus allocations change performance metrics.</p>
               <button onClick={() => setActiveTab("command")} className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-bold transition-colors shadow-md uppercase tracking-wider font-mono">
                 Open Command Center to Run Simulation
               </button>
            </div>

            <div className="bg-[#111822] border border-slate-800 rounded-lg p-5 hover:border-indigo-500/30 transition-colors">
               <h3 className="text-white font-bold mb-3 flex items-center gap-2"><Activity size={16} className="text-indigo-400"/> Step-by-Step Walkthrough</h3>
               <p className="text-slate-400 text-xs mb-4">Launch a complete trade tracing demo. See exactly how proposals are generated, verified, sized, and subsequently exited when limits hit.</p>
               <button onClick={() => setActiveTab("audit")} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)] uppercase tracking-wider font-mono">
                 Launch Audit Tracing Tab
               </button>
            </div>
          </div>

          <h3 className="text-lg font-bold text-white mb-4 border-b border-slate-800 pb-2">Important Safety Guidelines</h3>

          <div className="bg-rose-500/10 border border-rose-500/20 p-5 rounded-lg flex gap-4">
            <AlertTriangle size={32} className="text-rose-400 shrink-0"/>
            <div>
              <h4 className="text-rose-400 font-bold mb-3 uppercase tracking-widest text-xs font-mono">Core Disclaimers & Disciplinary Rules</h4>
              <ul className="list-disc list-inside text-slate-300 text-xs space-y-2.5 leading-relaxed">
                <li><strong>AI Models are Probabilistic:</strong> Generative models estimate outcomes based on historic patterns. They do not possess future sight and will experience consecutive losses during abrupt macroeconomic shifts.</li>
                <li><strong>Never Overrule the Risk Engine:</strong> The daily-loss kill-switch, consecutive-loss breaker, and concentration cap exist specifically to protect you from portfolio ruin. Disabling guardrails or force-closing positions without structured logic can result in immediate loss of capital.</li>
                <li><strong>Past Performance Disclaimers:</strong> The one real backtest run against AAPL history so far showed <em>no</em> out-of-sample edge for the deterministic strategy - a real, honest, unfavorable result. A high win rate in one historical simulation does not guarantee future profitable yield.</li>
                <li><strong>Start Conservatively:</strong> Always configure the terminal to "Conservative" (1% of equity risked per trade) and run the paper simulator for a meaningful stretch to study real multi-agent behavior before ever considering live capital.</li>
              </ul>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button 
              onClick={() => setActiveSectionId("evolution-learning")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button 
              onClick={() => { markCompleted("simulator-safety"); setActiveSectionId("live-ops"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              Learn Live Deployment <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // NEW COURSE 8: Production & Live Deployment
    {
      id: "live-ops",
      category: "4. Deployment & Live Operations",
      title: "Live Trading & Environment Configuration",
      isCourse: true,
      icon: <Lock size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Configuring Argus, and the Real Live-Trading Gate</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Argus does not have separate "dry run" vs. "live exchange" modes you switch between. Every broker connection has its own real paper/live state, and enabling live trading anywhere requires an explicit confirmation step - there is no environment variable that silently turns real-money trading on.
          </p>

          <div className="space-y-5">
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2 font-mono uppercase text-xs text-indigo-400">
                <Settings size={14} /> 1. Real Environment Variables (from .env.example)
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Copy <code className="text-[10px]">.env.example</code> to <code className="text-[10px]">.env</code> and fill in what you need. Every key here is read for real by the server on boot - nothing on this list is aspirational.
              </p>

              <div className="bg-slate-950 p-4 rounded border border-slate-900 font-mono text-xs text-slate-300 space-y-3">
                <div>
                  <span className="text-indigo-400 font-bold">ALPACA_API_KEY / ALPACA_SECRET_KEY</span>
                  <p className="text-[10px] text-slate-400 mt-1">Required for real market data and paper/live order execution via Alpaca.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY / ...</span>
                  <p className="text-[10px] text-slate-400 mt-1">Any one AI provider key is enough to run the agent pipeline - AIRouter fails over across whichever are configured.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">AUTH_PASSWORD / AUTH_SESSION_SECRET / ENCRYPTION_SECRET</span>
                  <p className="text-[10px] text-slate-400 mt-1">All three must be generated for real before any real deployment - the shipped placeholders are intentionally invalid and won't authenticate. Generate with <code className="text-[9px]">node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"</code>.</p>
                </div>
              </div>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2 font-mono uppercase text-xs text-amber-400">
                <Globe size={14} /> 2. The Real Paper→Live Confirmation Gate
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed mb-3">
                Every broker connection defaults to paper mode. Flipping a broker to live, or setting the trading mode to LIVE, requires the caller to echo back an exact confirmation phrase - a checkbox default can never accidentally enable real-money trading:
              </p>
              <div className="space-y-2.5 text-xs text-slate-400">
                <p>
                  <strong className="text-slate-200">Broker live mode:</strong> <code className="text-[10px]">BrokerManager.setLiveMode(brokerId, true, confirmationPhrase)</code> - rejects with a clear error if the phrase doesn't match exactly, or if that broker's <code className="text-[10px]">placeOrder()</code> is a known stub.
                </p>
                <p>
                  <strong className="text-slate-200">Trading mode:</strong> the same confirmation is required to set <code className="text-[10px]">tradingMode: 'LIVE'</code> via Settings or the AutoBot toggle. Reverting to paper mode never requires confirmation - that direction is always safe.
                </p>
              </div>
            </div>

            <div className="bg-rose-950/20 border border-rose-500/15 p-4 rounded-lg flex gap-3">
              <Lock size={20} className="text-rose-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-rose-400 font-bold text-xs uppercase font-mono mb-1">Real Deployment Notes</h4>
                <ul className="list-disc list-inside text-slate-300 text-[11px] space-y-1.5 leading-relaxed font-mono">
                  <li>Never commit real API keys, brokerage credentials, or the encryption key to git - <code className="text-[10px]">.env*</code> and <code className="text-[10px]">data/.encryption_key</code> are gitignored for exactly this reason.</li>
                  <li>A real multi-stage Dockerfile and docker-compose.yml exist at the repo root, with a persistent volume for <code className="text-[10px]">data/</code> - <code className="text-[10px]">GET /health</code>/<code className="text-[10px]">/ready</code> are real, unauthenticated container health checks.</li>
                  <li>Interactive Brokers requires a human to complete browser 2FA at the Gateway roughly every 24 hours - it cannot run as a fully unattended live broker the way Alpaca can.</li>
                  <li>Use the real Emergency Stop immediately if you observe abnormal behavior - it's a genuine kill-switch, live-tested, not a cosmetic button.</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="flex justify-start mt-8">
            <button 
              onClick={() => setActiveSectionId("simulator-safety")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
          </div>
        </div>
      )
    }
  ];

  // Group sections by category
  const categories = Array.from(new Set(sections.map(s => s.category))).sort();

  // Filter sections based on search query
  const filteredSections = sections.filter(s => 
    s.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (s.id.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const activeSection = filteredSections.find(s => s.id === activeSectionId) || (filteredSections.length > 0 ? filteredSections[0] : sections[0]);

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] animate-fade-in bg-[#0A0F16]" id="documentation-learning-view">
      {/* Top Header */}
      <div className="px-6 py-4 border-b border-slate-800 flex justify-between items-center bg-[#1A1F2B] shrink-0">
        <div>
          <h2 className="text-lg font-bold text-white flex items-center gap-2 uppercase tracking-wide font-sans">
            <BookOpen size={20} className="text-indigo-400" />
            Argus Learning & Documentation Center
          </h2>
          <p className="text-[11px] text-slate-400 font-mono mt-1">Interactive Academy & Platform Knowledge Base</p>
        </div>
        <div className="flex items-center gap-4">
          <div className="relative group">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-indigo-400 transition-colors" />
            <input 
              type="text" 
              placeholder="Search concepts, engines..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-[#111822] border border-slate-800 text-slate-300 text-xs rounded-full pl-9 pr-4 py-1.5 focus:outline-none focus:border-indigo-500 w-64 transition-colors"
            />
          </div>
          <button 
            onClick={() => setActiveTab("command")}
            className="text-slate-400 hover:text-white transition-colors p-1"
          >
            <X size={20} />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar Navigation */}
        <div className="w-64 border-r border-slate-800 bg-[#111822] flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-slate-800 bg-[#1A1F2B]/50">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest flex items-center gap-1.5 font-mono"><Layers size={12}/> Course Progress</span>
              <span className="text-emerald-400 text-xs font-bold font-mono">{Math.round((Object.keys(completedModules).length / sections.filter(s=>s.isCourse).length) * 100) || 0}%</span>
            </div>
            <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
              <div 
                className="bg-emerald-500 h-full transition-all duration-1000 ease-out" 
                style={{ width: `${(Object.keys(completedModules).length / sections.filter(s=>s.isCourse).length) * 100 || 0}%` }}
              ></div>
            </div>
          </div>
          
          <div className="flex-1 py-4">
            {categories.map((category, i) => {
              const categorySections = filteredSections.filter(s => s.category === category);
              if (categorySections.length === 0) return null;
              
              return (
                <div key={i} className="mb-6">
                  <h3 className="px-4 text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2 font-mono">
                    {category}
                  </h3>
                  <div className="space-y-0.5">
                    {categorySections.map(section => (
                      <button
                        key={section.id}
                        onClick={() => setActiveSectionId(section.id)}
                        className={`w-full text-left px-4 py-2.5 text-xs flex items-center justify-between transition-colors ${
                          activeSectionId === section.id 
                            ? "bg-indigo-500/10 text-indigo-400 border-r-2 border-indigo-500 font-bold font-sans" 
                            : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50 font-sans"
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className={activeSectionId === section.id ? "text-indigo-400" : "text-slate-500"}>
                            {section.icon}
                          </span>
                          {section.title}
                        </div>
                        {section.isCourse && (
                          completedModules[section.id] 
                            ? <CheckCircle2 size={12} className="text-emerald-500" />
                            : <Circle size={10} className="text-slate-600" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-[#0A0F16] p-8 lg:p-12 relative scroll-smooth">
           
           {/* Background decorative elements */}
           <div className="absolute top-0 right-0 w-[500px] h-[500px] bg-indigo-500/5 blur-[120px] rounded-full pointer-events-none"></div>
           
           <div className="max-w-4xl mx-auto relative z-10">
              {activeSection ? activeSection.content : (
                 <div className="text-center py-20 animate-fade-in">
                   <Search size={48} className="text-slate-700 mx-auto mb-4" />
                   <h3 className="text-xl font-bold text-white mb-2">No results found</h3>
                   <p className="text-slate-400">Try adjusting your search term.</p>
                   <button 
                     onClick={() => setSearchQuery("")}
                     className="mt-6 text-indigo-400 hover:text-indigo-300 font-bold text-sm"
                   >
                     Clear Search
                   </button>
                 </div>
              )}
           </div>

        </div>
      </div>
    </div>
  );
};

export default DocumentationTab;
