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
import tradingSafety from "../../config/tradingSafety.json";
import agentWeights from "../../config/agentWeights.json";

const pctLabel = (fraction: number) => `${Math.round(fraction * 100)}%`;
const consensusPct = pctLabel(tradingSafety.consensusApprovalThreshold);
const stopPct = pctLabel(tradingSafety.stopLossAssumptionPct);
const w = agentWeights.defaults;

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
            Welcome to the <strong>Argus Autonomous Trading Terminal</strong>, a full-stack, event-driven multi-agent trading platform. This documentation describes what the running application actually does, verified against its own source — not an idealized description of what it could do.
          </p>

          <div className="p-4 bg-rose-950/20 rounded border border-rose-500/20 flex items-start gap-3">
            <AlertTriangle size={18} className="text-rose-400 mt-1 shrink-0" />
            <div>
              <span className="text-xs font-mono font-bold text-rose-300 uppercase block mb-1">Ground truth (do not inflate)</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                LIVE real-money trading is <strong className="text-rose-300">NO-GO</strong> in this environment. NewsAgent last scored pass was about 44.6% on 242 predictions. Walk-forward out-of-sample for the checked Quant combos failed. There is no SentimentAgent or OrderFlowAgent on the live path. Quant stays off unless <code className="text-[10px]">QUANT_ENGINE_ENABLED=true</code>.
              </p>
            </div>
          </div>

          <div className="p-4 bg-slate-900/80 rounded border border-slate-800 flex items-start gap-3">
            <Bot size={18} className="text-indigo-400 mt-1 shrink-0" />
            <div>
              <span className="text-xs font-mono font-bold text-indigo-300 uppercase block mb-1">HOW A TRADE DECISION IS ACTUALLY MADE</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                Live path: EventBus → agents → ChiefTrader → RiskEngine → OMS → BrokerManager. Independent agents (Technical, News, Fundamental, Macro, optional KronosForecast, optional QuantEngine) emit <code className="text-[10px]">TRADE_IDEA_GENERATED</code>. PortfolioMonitor can emit SELL ideas for exits. Chief Trader requires at least {tradingSafety.minIndependentAgreeingAgents} independent agreeing agents and weighted confidence ≥ {consensusPct} (from <code className="text-[10px]">config/tradingSafety.json</code>). HOLD can veto. RiskEngine records every gate; the first failure is the reported rejection. AI never invents prices or expected value.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-indigo-500/30 transition-colors group">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><LineChart size={16} className="group-hover:animate-pulse"/> 1. Dashboard Visualizers</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Live agent status, order events, and account state driven by real backend events. Agent Network win rates now come from <code className="text-[10px]">agent_performance_stats</code> (lifetime scored sample), not a fake 24h series. Some Arena analytics (L2 ladder, several sunburst/treemap charts) are still placeholder or unavailable — disclosed, not hidden.
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-emerald-500/30 transition-colors group">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><Target size={16} className="group-hover:animate-pulse"/> 2. Autonomous Mission Control</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Enable/disable the autonomous engine, set allocated budget (Argus allocation, not broker equity), risk level, and use the existing Emergency Stop / <code className="text-[10px]">TRADING_PAUSED</code> kill-switch — there is not a second one. Do not treat every Mission Control widget as live; some Arena/Mission panels remain mock (see FINAL_ANALYSIS).
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-amber-500/30 transition-colors group">
              <h3 className="text-amber-400 font-bold mb-2 flex items-center gap-2"><Sliders size={16} className="group-hover:animate-pulse"/> 3. Backtest &amp; Walk-Forward</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Runs deterministic technical rules against real historical Alpaca bars (fees/slippage modeling, corporate-action halt, look-ahead guard) plus a separate per-strategy backtest for the five Quant core strategies. Quant live cycle is off unless enabled in env. Walk-forward OOS for checked combos has failed — run a fresh backtest; do not trust a number written here.
              </p>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-rose-500/30 transition-colors group">
              <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><Network size={16} className="group-hover:animate-pulse"/> 4. Local AI Stack (optional)</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Ollama-hosted chat models and a local Chronos time-series forecaster can run entirely on your machine at $0 marginal cost, as an alternative to a paid cloud LLM for some tasks. See <code className="text-[10px]">README.md</code> (Local AI) / <code className="text-[10px]">CLAUDE.md</code> and <code className="text-[10px]">npm run setup:ai</code>.
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
              <p className="text-[10px] text-slate-400">Maintains rolling price history and calls local Chronos once it has 30+ ticks. Honest unavailable if /health is down. Weight key: KronosEngine.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-slate-900/80 border border-slate-600/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-slate-300 block mb-1 uppercase tracking-wider">Optional: QuantEngine / PortfolioMonitor</span>
              <p className="text-[10px] text-slate-400">QuantSignalAgent only if QUANT_ENGINE_ENABLED=true. PortfolioMonitor emits SELL ideas from take-profit / trailing-stop / thesis invalidation — still through ChiefTrader and RiskEngine, not raw broker flattens.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-emerald-950/40 border border-emerald-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-emerald-400 block mb-1 uppercase tracking-wider">ChiefTraderAgent</span>
              <p className="text-[10px] text-slate-400">Weighted vote. Approves only above {consensusPct} and at least {tradingSafety.minIndependentAgreeingAgents} independent agreeing agents. HOLD can veto.</p>
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
                NewsEngine ingests RSS and paid news APIs and clusters/scores articles. Last scored NewsAgent accuracy in this environment: about 44.6% on 242 predictions — not a calibrated edge. FundamentalAgent and MacroAgent pull AlphaVantage. All three go through AIRouter. LLM self-reported confidence is not a calibrated win rate. SentimentAgent does not exist on this path.
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
              Learn Position Sizing <ChevronRight size={16} />
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
              <div>1. Risk cap: <span className="text-indigo-400">maxSharesByRisk = (equity × riskPct) / (price × {tradingSafety.stopLossAssumptionPct})</span></div>
              <div>2. Capital cap: <span className="text-indigo-400">maxSharesByCapital = maxTradeSize / price</span></div>
              <div>3. Buying-power cap: <span className="text-indigo-400">maxSharesByBuyingPower = buyingPower / price</span></div>
            </div>
            <p className="text-xs text-slate-300">
              <code className="text-[10px]">maxQuantity = min(all three)</code>, then further reduced if it would push the position past {pctLabel(tradingSafety.maxSingleSymbolConcentrationPct)} of account equity (the concentration cap), or capped to the existing position size on a SELL. Default notional cap is FIXED_DOLLAR <code className="text-[10px]">settings.maxTradeSize</code> (often $3,000) — PERCENT_OF_EQUITY is opt-in. Whole shares only (<code className="text-[10px]">Math.floor</code>); no Alpaca notional orders.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold block mb-2">STOP-LOSS ASSUMPTION</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                The risk cap assumes a flat <strong>{stopPct} per-share risk</strong> (<code className="text-[10px]">tradingSafety.stopLossAssumptionPct</code>) — not ATR. Live RiskEngine does not size from Kelly.
              </p>
            </div>

            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold block mb-2">CONCENTRATION CAPS</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                No single symbol may exceed <strong>{pctLabel(tradingSafety.maxSingleSymbolConcentrationPct)}</strong> of real account equity, no sector may exceed <strong>{pctLabel(tradingSafety.maxSectorConcentrationPct)}</strong>, and no basket of pairwise-correlated symbols (correlation &gt; {tradingSafety.correlationThreshold}) may exceed <strong>{pctLabel(tradingSafety.maxCorrelatedExposurePct)}</strong> combined. Thresholds live in <code className="text-[10px]">tradingSafety.json</code>.
              </p>
            </div>
          </div>

          <div className="bg-[#111822] border border-slate-800 p-4 rounded mt-4">
            <span className="text-[10px] font-mono uppercase text-rose-400 font-bold block mb-2">NOT YET IN LIVE SIZING</span>
            <p className="text-xs text-slate-400 leading-relaxed">
              A real fractional-Kelly / expected-value module exists (<code className="text-[10px]">quant/risk/ExpectedValue.ts</code>, refuses below 20 closed trades, Kelly fraction capped at 10% of capital). When Quant is enabled, QuantSignalAgent can refuse to emit a strategy idea if EV is missing or non-positive. <strong>RiskEngine still does not size from Kelly</strong> and still uses {stopPct} stop-loss assumption, not ATR.
            </p>
          </div>

          <div className="bg-[#111822] border border-slate-800 p-4 rounded">
            <span className="text-[10px] font-mono uppercase text-amber-400 font-bold block mb-3">RISK LEVEL → PORTFOLIO RISK %</span>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Conservative</span>
                <span className="text-emerald-400 font-bold">{pctLabel(tradingSafety.riskPctConservative)} of account equity</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Balanced (default)</span>
                <span className="text-indigo-400 font-bold">{pctLabel(tradingSafety.riskPctBalanced)} of account equity</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Aggressive</span>
                <span className="text-rose-400 font-bold">{pctLabel(tradingSafety.riskPctAggressive)} of account equity</span>
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
                Each agent has a DB-synced weight (defaults from <code className="text-[10px]">config/agentWeights.json</code>: Technical {w.TechnicalAgent}, News {w.NewsAgent}, Fundamental {w.FundamentalAgent}, Macro {w.MacroAgent}, KronosEngine {w.KronosEngine}, QuantEngine {w.QuantEngine}). ReflectionEngine updates <code className="text-[10px]">agent_performance_stats.currentWeight</code>. MarketRegimeAgent / AdvancedQuantEngines compute but do not vote.
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
                Any agent proposing the opposite side pulls the score down at {tradingSafety.disagreementPenalty}× weight — a penalty, not a hard veto:
              </p>
              <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-[11px] text-slate-300">
                weightedConfidence −= (idea.confidence × agent.weight × {tradingSafety.disagreementPenalty}) for every disagreeing idea
                <br/>finalConfidence = clamp(weightedConfidence / totalWeight, 0, 1)
              </div>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STEP 3
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Approve Only Above {consensusPct}
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Whichever side (BUY or SELL) has the higher final confidence wins. It is only forwarded as <code className="text-[10px]">CHIEF_APPROVED_IDEA</code> if that confidence exceeds <strong className="text-emerald-400">{tradingSafety.consensusApprovalThreshold}</strong> (<code className="text-[10px]">consensusApprovalThreshold</code>) <em>and</em> at least {tradingSafety.minIndependentAgreeingAgents} independent agents agree. HOLD can veto. Below the bar, the idea is held.
              </p>
              <p className="text-xs text-slate-400 leading-relaxed">
                Optionally, if a single idea's raw confidence exceeds {tradingSafety.debateTriggerConfidence}, Chief Trader may run <code className="text-[10px]">AIRouter.routeConsensus</code> (per-symbol cooldown) and fold that in. Learned-rule text is truncated into this debate prompt only ({tradingSafety.debateLearnedRulesCount} rules × {tradingSafety.debateLearnedRuleMaxChars} chars) — it does not override RiskEngine. Bull/Bear qualitative notes only if <code className="text-[10px]">QUANT_BULL_BEAR_ENABLED=true</code>; LLM-invented prices/EV are nulled.
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
            Every <code className="text-xs">CHIEF_APPROVED_IDEA</code> passes through <code className="text-xs">RiskAgent → RiskEngine.evaluateRisk()</code> before OMS can place. All gates are recorded even after the first failure (audit trail); the first failure in evaluation order is the reported reason. OMS idempotency (one order per trace ID) runs <em>after</em> RiskEngine — it is not a RiskEngine gate. Thresholds below come from <code className="text-[10px]">tradingSafety.json</code> / settings, not TypeScript literals.
          </p>

          <div className="space-y-4">
            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-rose-400 uppercase font-bold block mb-1">Gate 1: Emergency Stop</span>
              <h3 className="text-sm font-bold text-white mb-2">Global Kill-Switch, Checked First</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Blocks every new trade whenever <code className="text-[10px]">tradingState !== 'TRADING_ENABLED'</code> - the real Emergency Stop button sets this directly and is checked before any other gate runs.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-rose-400 uppercase font-bold block mb-1">Gate 2: Daily-Loss Kill-Switch</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Equity vs. Real Daily Baseline</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Tracks real broker equity against a start-of-day baseline. Blocks new trades once the loss reaches {pctLabel(tradingSafety.dailyLossKillSwitchFraction)} of the configured daily loss limit. Distinct from the daily BUY notional cap.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">Gate 3: Consecutive-Loss Breaker</span>
              <h3 className="text-sm font-bold text-white mb-2">Three Real Losses in a Row</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Reads realized P&amp;L of the last {tradingSafety.maxConsecutiveLosses} <code className="text-[10px]">FILLED</code> trades. If all lost money, new trades are blocked pending review.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">Gate 4: Portfolio Drawdown Circuit Breaker</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Peak-Equity High-Water Mark</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Tracks real persisted peak equity and blocks new trades once the drawdown from that peak exceeds a configured threshold (15% by default) - distinct from the daily-loss gate, which resets every trading day; this one tracks drawdown from the all-time high.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">Gate 5: Order Rate Limit</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Runaway-Loop Protection</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Counts real risk-assessment rows in the trailing 60 seconds and blocks new trades above a configured ceiling (5/minute by default) - catches a signal-loop bug generating far more proposals than any real strategy should, independent of whether each individual proposal would otherwise pass.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-indigo-400 uppercase font-bold block mb-1">Gate 6: Market-Hours &amp; Stale-Data Checks</span>
              <h3 className="text-sm font-bold text-white mb-2">Real Alpaca Clock + Real Tick Age</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Alpaca clock: <strong>skip</strong> if no Alpaca keys; <strong>fail-closed</strong> if keys exist but the clock HTTP/network fails (an outage is not treated as open). Closed session blocks. Also rejects if the last tick is older than {tradingSafety.stalePriceThresholdMs / 60000} minutes (<code className="text-[10px]">stalePriceThresholdMs</code>). Refuses if there is no live price.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 7: High-Impact-News Veto</span>
              <h3 className="text-sm font-bold text-white mb-2">Real News Clusters, 4-Hour Window</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Vetoes a trade if a real news cluster covering that symbol, updated within the last 4 hours, has an impact score above 80 - regardless of the article's actual direction, so a bullish high-impact story vetoes a SELL exactly the same as a BUY.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 8: Price Validity</span>
              <h3 className="text-sm font-bold text-white mb-2">No Order on a Broken Price</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Rejects a trade outright if the current price used for sizing isn't a real finite number greater than zero - a last-line defense-in-depth check, not expected to fire under normal conditions.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">Gate 9: Position-Sizing Caps</span>
              <h3 className="text-sm font-bold text-white mb-2">Single-Symbol, Sector, and Correlation Concentration - All Real, All Live</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Reduces size so no symbol exceeds <strong>{pctLabel(tradingSafety.maxSingleSymbolConcentrationPct)}</strong> of equity, no sector <strong>{pctLabel(tradingSafety.maxSectorConcentrationPct)}</strong>, correlated basket (ρ &gt; {tradingSafety.correlationThreshold}) <strong>{pctLabel(tradingSafety.maxCorrelatedExposurePct)}</strong>. Also <code className="text-[10px]">order_notional_cap</code>, <code className="text-[10px]">sufficient_size</code>, <code className="text-[10px]">open_positions_cap</code>. Restricted LIVE adds file-reviewed ceilings (max order ${tradingSafety.restrictedLiveMaxOrderNotionalDollars}, {tradingSafety.restrictedLiveMaxOpenPositions} open positions, ${tradingSafety.restrictedLiveMaxDailyLossDollars} daily loss) — not UI knobs.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 10: Sell-Position-Exists</span>
              <h3 className="text-sm font-bold text-white mb-2">Can't Sell What You Don't Hold</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                A SELL idea is only sized above zero if the real broker portfolio actually shows an open position in that symbol - no broker in Argus supports short selling, so this is a hard structural check, not a configurable preference.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 11: Argus Capital Allocation</span>
              <h3 className="text-sm font-bold text-white mb-2">settings.budget Is Not Broker Equity</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                <code className="text-[10px]">argus_capital_allocation</code> enforces the Argus allocated budget vs buying power. TradingEngine.toggle() also rejects enable if allocated budget exceeds broker buyingPower/cash.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">Gate 12: Daily BUY Notional</span>
              <h3 className="text-sm font-bold text-white mb-2">Cumulative Buys This NY Session</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Distinct from the daily-loss kill-switch. Paper uses reviewed <code className="text-[10px]">maxDailyBuyNotionalDollars</code> (currently ${tradingSafety.maxDailyBuyNotionalDollars}). LIVE always uses <code className="text-[10px]">restrictedLiveMaxDailyBuyNotionalDollars</code> (${tradingSafety.restrictedLiveMaxDailyBuyNotionalDollars}).
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-slate-300 uppercase font-bold block mb-1">After RiskEngine: OMS Idempotency</span>
              <h3 className="text-sm font-bold text-white mb-2">One Order Per Trace ID</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                <code className="text-[10px]">OrderManagementService</code> checks the trades table for an existing order with the same trace ID (DB unique constraint) before placing. Duplicate events cannot place a second order. This is not a RiskEngine gate.
              </p>
            </div>
          </div>

          <div className="callout bg-slate-900/50 border border-slate-800 p-4 rounded-lg">
            <p className="text-xs text-slate-400 leading-relaxed mb-0">
              <strong className="text-slate-200">Kelly vs live sizing:</strong> QuantSignalAgent may suppress a Quant idea when EV is missing/non-positive (only if Quant is enabled). Live RiskEngine still uses the caps above, not Kelly. OpenAlice is optional, fire-and-forget, and never blocks this trade.
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
                Honest limitation: learned-rule text is truncated into ChiefTrader's adversarial debate prompt only. It does not override RiskEngine, resize positions, or retrain models.
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
              Runs the same deterministic technical rules TechnicalAgent uses live, against real historical Alpaca bars, with real commission/slippage modeling and a hard look-ahead-bias guard (it cannot access a future bar even by accident, unit-tested to prove the guard fires).
            </p>
            <ul className="list-disc list-inside text-xs text-slate-400 space-y-1.5 font-mono">
              <li>Real walk-forward validation (rolling train/test windows, e.g. 365-day train / 90-day test) is built and self-reports <code className="text-[10px]">insufficientPeriods</code> honestly when a date range is too short to trust.</li>
              <li>Real multi-symbol/multi-year runs consistently show a win rate close to a coin flip once pooled across enough trades - whatever positive expectancy shows up tends to come from the exit rule's reward:risk asymmetry, not from the entry signal predicting direction. Out-of-sample walk-forward return has not shown a reliable edge in any real run so far.</li>
              <li>A real stock split inside the requested date range (e.g. AAPL, NVDA, TSLA all split in recent years) correctly halts the run with <code className="text-[10px]">CORPORATE_ACTION_DETECTED</code> rather than silently computing a corrupted result - if a backtest refuses to run on a familiar symbol, this is why.</li>
              <li>Scope, stated precisely: this backtests the deterministic technical rules only - it does not replay the full AI-agent consensus pipeline (News/Fundamental/Macro/Chief Trader) against history. The additive Quant Layer's 5 strategies have their own separate real backtest (<code className="text-[10px]">runStrategyBacktest</code>), also deterministic-only.</li>
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
               <p className="text-slate-400 text-xs mb-4">Default order-placing broker if none selected is InternalPaperBroker (in-memory fills, $100k default cash). Real pipeline writes SQLite <code className="text-[10px]">trades</code>. Legacy <code className="text-[10px]">GET /api/v1/signals</code> is quarantined (HTTP 410) — it previously fabricated votes, wrote <code className="text-[10px]">portfolio.json</code>, and bypassed RiskEngine. Live orders only go EventBus → ChiefTrader → RiskEngine → OMS.</p>
               <button onClick={() => setActiveTab("command")} className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-xs font-bold transition-colors shadow-md uppercase tracking-wider font-mono">
                 Open Mission Control
               </button>
            </div>

            <div className="bg-[#111822] border border-slate-800 rounded-lg p-5 hover:border-indigo-500/30 transition-colors">
               <h3 className="text-white font-bold mb-3 flex items-center gap-2"><Activity size={16} className="text-indigo-400"/> End-to-end Trace (real)</h3>
               <p className="text-slate-400 text-xs mb-4">Observatory shows real <code className="text-[10px]">/api/v2/transactions*</code> rows and trace IDs. The Observability &amp; Tracing tab is not a substitute — treat Observatory as the source of truth for a real trace.</p>
               <button onClick={() => setActiveTab("observatory")} className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)] uppercase tracking-wider font-mono">
                 Open Observatory
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
                <li><strong>Past Performance Disclaimers:</strong> Real backtests against the deterministic strategy have not shown a statistically reliable out-of-sample edge - win rates pooled across enough real trades land close to a coin flip, and whatever positive expectancy shows up leans on the exit rule's reward:risk shape rather than the entry signal predicting direction. A high win rate in any one historical simulation does not guarantee future profitable yield.</li>
                <li><strong>Start Conservatively:</strong> Conservative risk is {pctLabel(tradingSafety.riskPctConservative)} of equity per the risk table. Stay on paper. LIVE is NO-GO here until readiness says otherwise.</li>
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
            Broker connections have paper vs live state. Enabling LIVE requires an explicit confirmation phrase — there is no env var that silently turns real-money trading on. <strong className="text-rose-300">This environment remains LIVE NO-GO</strong> per <code className="text-[10px]">CLAUDE.md</code>. Adding files does not raise that score.
          </p>

          <div className="space-y-5">
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2 font-mono uppercase text-xs text-indigo-400">
                <Settings size={14} /> 1. Real Environment Variables (from .env.example)
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Copy <code className="text-[10px]">.env.example</code> to <code className="text-[10px]">.env</code>. Keys listed here are the ones this academy page is willing to claim. Do not assume every name in .env.example has a dedicated provider class.
              </p>

              <div className="bg-slate-950 p-4 rounded border border-slate-900 font-mono text-xs text-slate-300 space-y-3">
                <div>
                  <span className="text-indigo-400 font-bold">ALPACA_API_KEY / ALPACA_SECRET_KEY</span>
                  <p className="text-[10px] text-slate-400 mt-1">Required for real market data and paper/live order execution via Alpaca.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">GEMINI_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY / NVIDIA_API_KEY</span>
                  <p className="text-[10px] text-slate-400 mt-1">Router-native today: Gemini, OpenAI, DeepSeek, Nvidia, OpenAI-compatible (Ollama). Extra env keys may exist without a dedicated provider class.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">AUTH_PASSWORD / AUTH_SESSION_SECRET / ENCRYPTION_SECRET</span>
                  <p className="text-[10px] text-slate-400 mt-1">Auth is on when AUTH_PASSWORD is set; production refuses to boot unauthenticated. Generate secrets with <code className="text-[9px]">node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"</code>.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">QUANT_ENGINE_ENABLED / QUANT_SMC_STRATEGY_ENABLED / QUANT_BULL_BEAR_ENABLED</span>
                  <p className="text-[10px] text-slate-400 mt-1">All default off. Do not enable them to “see if it works.” SMC stays UNVALIDATED. Bull/Bear notes are qualitative; invented numerics are nulled.</p>
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
                  <li>Never commit API keys or <code className="text-[10px]">data/.encryption_key</code>.</li>
                  <li>Canadian automated routing is blocked (IIROC). <code className="text-[10px]">markets.json</code> documents this; it does not unlock IBKR/Questrade execution. IBKR cannot place Canadian-exchange equities.</li>
                  <li>IBKR Gateway needs human 2FA ~24h (<code className="text-[10px]">requiresManualReauth</code>). Questrade is read-only (placeOrder throws). Coinbase <code className="text-[10px]">placeOrder()</code> refuses in paper (no sandbox).</li>
                  <li>One Emergency Stop / <code className="text-[10px]">TRADING_PAUSED</code> — do not add a second kill switch.</li>
                  <li><code className="text-[10px]">PORT</code> is not read; the server hardcodes 3000.</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setActiveSectionId("simulator-safety")}
              className="text-slate-400 hover:text-white px-4 py-2 text-sm font-bold transition-colors"
            >
              Previous
            </button>
            <button
              onClick={() => { markCompleted("live-ops"); setActiveSectionId("quant-decision-layer"); }}
              className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded flex items-center gap-2 text-sm font-bold transition-colors shadow-[0_0_15px_rgba(79,70,229,0.3)]"
            >
              Explore the Additive Quant Layer <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 5: Additive Quant Decision Layer
    {
      id: "quant-decision-layer",
      category: "5. Additive Quant Decision Layer",
      title: "Deterministic Regime, Strategy & Scoring Engine",
      isCourse: true,
      icon: <Radar size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">A Deterministic Quant Layer, Entirely Additive</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            <code className="text-xs">src/server/quant/</code> and <code className="text-xs">QuantSignalAgent.ts</code> add a deterministic regime/strategy/scoring engine on top of the agent pipeline. Off unless <code className="text-xs">QUANT_ENGINE_ENABLED=true</code>. Live <code className="text-xs">evaluateAll()</code> is the original five CORE strategies unless a per-id env flag from <code className="text-xs">config/quantExperimentalStrategies.json</code> is the string <code className="text-xs">true</code>. The 10-family master catalog lives in <code className="text-xs">config/quantMasterTaxonomy.json</code>; 760 named aliases live in <code className="text-xs">config/quantStrategyTaxonomy.json</code> — they are not 1,000 independent live edges. Experimental modules stay UNVALIDATED. Backtest is long-only. Walk-forward OOS for checked combos failed. Options, L2, HFT, pairs, PEAD, and similar families are honest NOT_SUPPORTED.
          </p>

          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
            <span className="text-[10px] font-mono uppercase text-slate-500 block mb-2">The Real Pipeline</span>
            <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-[11px] text-slate-300 space-y-1.5">
              <div>Real daily bars (same <code className="text-[10px]">ohlcv_bars</code> cache every other engine uses)</div>
              <div className="text-indigo-400">↓ RegimeEngine.classifyRegime() - multi-signal, never a single indicator</div>
              <div className="text-indigo-400">↓ MarketContext.getMarketContext() - SPY/QQQ/IWM/sector relative strength</div>
              <div className="text-indigo-400">↓ StrategyEngine.evaluateAll() - five CORE strategies by default; experimental families only if their env flags are true</div>
              <div className="text-indigo-400">↓ GroupedScores.computeGroupedScores() - probabilistic, correlation-aware scoring</div>
              <div className="text-indigo-400">↓ QuantContradictionAnalyzer - real AI qualitative review (optional, never overrides the math)</div>
              <div>↓ eventBus.emit('TRADE_IDEA_GENERATED', {"{"}agent: 'QuantEngine', ...{"}"}) - same contract every agent uses</div>
              <div>↓ ChiefTraderAgent → RiskEngine → OrderManagementService - completely unchanged, never bypassed</div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold block mb-2">5 REAL STRATEGIES</span>
              <ul className="text-xs text-slate-400 leading-relaxed space-y-1 font-mono">
                <li><strong className="text-slate-200">Momentum Breakout</strong> - structural break + RVOL + volatility expansion</li>
                <li><strong className="text-slate-200">Pullback Continuation</strong> - retrace to an MA without breaking the trend</li>
                <li><strong className="text-slate-200">Mean Reversion</strong> - RSI/StochRSI extremes outside the Keltner Channel</li>
                <li><strong className="text-slate-200">Trend Following</strong> - rides an established trend, no fixed target</li>
                <li><strong className="text-slate-200">Range Reversion</strong> - fades whichever real range boundary is nearest</li>
              </ul>
              <p className="text-[10px] text-slate-500 mt-2">Each strategy discloses <code className="text-[9px]">conditionsMet</code>/<code className="text-[9px]">conditionsFailed</code>. Off-regime confidence is discounted by <code className="text-[9px]">regimeMismatchConfidenceMultiplier</code> ({tradingSafety.regimeMismatchConfidenceMultiplier}), never zeroed. Experimental SMC is not in this five.</p>
            </div>

            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-amber-400 font-bold block mb-2">NOT A VOTE COUNT</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                RSI, Stochastic RSI, CCI, and Williams %R all measure the same "is price stretched" fact - <code className="text-[10px]">GroupedScores.ts</code> blends them into <strong>one</strong> reading, not four independent votes, before combining it with a genuinely different signal (MACD/ROC). Counting correlated indicators as independent evidence is exactly the mistake this layer is built to avoid.
              </p>
            </div>
          </div>

          <div className="bg-[#111822] border border-slate-800 p-4 rounded">
            <span className="text-[10px] font-mono uppercase text-rose-400 font-bold block mb-3">REAL EXPECTED VALUE & KELLY - NEVER A GUESSED WIN RATE</span>
            <p className="text-xs text-slate-300 leading-relaxed mb-2">
              <code className="text-[10px]">quant/risk/ExpectedValue.ts</code> computes EV/Kelly from a strategy backtest's own win rate and R-multiples — never an LLM-invented win rate. When Quant is on, QuantSignalAgent can refuse to emit if EV is missing or ≤ 0. RiskEngine still does not size from Kelly.
            </p>
            <ul className="list-disc list-inside text-slate-400 text-[11px] space-y-1 font-mono">
              <li>Kelly refuses below <strong className="text-slate-200">20 real closed trades</strong> backing the win-rate estimate - "insufficient sample size," not a fabricated number.</li>
              <li>Even when justified, the suggested size is hard-capped at <strong className="text-slate-200">10% of capital</strong>, regardless of what the raw formula computes.</li>
            </ul>
          </div>

          <div className="bg-rose-950/20 border border-rose-500/15 p-4 rounded-lg flex gap-3">
            <AlertTriangle size={20} className="text-rose-400 shrink-0 mt-0.5" />
            <div>
              <h4 className="text-rose-400 font-bold text-xs uppercase font-mono mb-1">What This Layer Does Not Claim</h4>
              <p className="text-slate-300 text-[11px] leading-relaxed font-mono">
                A scoring engine does not prove an edge. Checked Quant walk-forward OOS failed. Do not enable live Quant/SMC flags “to see if it works.” L2 depth, options, breadth, and volume profile are <code className="text-[10px]">NOT_SUPPORTED</code> — zeros are never filled.
              </p>
            </div>
          </div>

          <div className="flex justify-start mt-8">
            <button
              onClick={() => setActiveSectionId("live-ops")}
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
