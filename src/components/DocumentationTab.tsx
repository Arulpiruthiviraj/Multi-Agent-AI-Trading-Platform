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
            Welcome to the <strong>Argus Autonomous Trading Terminal</strong>, an advanced, full-stack multi-agent AI terminal designed to execute and execute continuous trading evaluations under strict risk mathematical constraints.
          </p>

          <div className="p-4 bg-slate-900/80 rounded border border-slate-800 flex items-start gap-3">
            <Bot size={18} className="text-indigo-400 mt-1 shrink-0" />
            <div>
              <span className="text-xs font-mono font-bold text-indigo-300 uppercase block mb-1">THE CIO OVERSIGHT CONCEPT</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                Argus introduces the concept of a virtual <strong>Chief Investment Officer (CIO)</strong>. The CIO steers strategy weights, schedules quantitative tasks, and runs all proposed trades through a multi-layer decision pipeline to block emotional sentiment traps and enforce hard mathematical risk boundaries.
              </p>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-indigo-500/30 transition-colors group">
              <h3 className="text-indigo-400 font-bold mb-2 flex items-center gap-2"><LineChart size={16} className="group-hover:animate-pulse"/> 1. Dashboard Visualizers</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Observe live-market feeds, multi-node correlation matrices, and dynamic agent weight networks showing current AI voting consensus in real time.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-emerald-500/30 transition-colors group">
              <h3 className="text-emerald-400 font-bold mb-2 flex items-center gap-2"><Target size={16} className="group-hover:animate-pulse"/> 2. Autonomous Mission Control</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Take control of the "Black Box" trading engine. Configure budget limits, strategy focus, risk levels, and utilize the Master Kill-Switch or custom tactical guardrails.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-amber-500/30 transition-colors group">
              <h3 className="text-amber-400 font-bold mb-2 flex items-center gap-2"><Sliders size={16} className="group-hover:animate-pulse"/> 3. Strategy Backtest Arena</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Backtest and compare different strategy styles against executed market conditions side-by-side with line toggle visualizations.
              </p>
            </div>
            
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800 hover:border-rose-500/30 transition-colors group">
              <h3 className="text-rose-400 font-bold mb-2 flex items-center gap-2"><Network size={16} className="group-hover:animate-pulse"/> 4. Semantic Precedent Database</h3>
              <p className="text-slate-400 text-xs leading-relaxed">
                Use the Vec Event Memory to search for historical market macro shocks (e.g., oil crisis, black swan events) using standard human prose.
              </p>
            </div>
          </div>
          
          <div className="bg-slate-800/50 border border-slate-700 p-5 rounded-lg mt-8 flex justify-between items-center transition-all duration-300 hover:bg-slate-800">
            <div>
              <h4 className="text-white font-bold mb-1 text-sm">Interactive Beginner Mode Guidance</h4>
              <p className="text-slate-400 text-xs font-mono">Enabling beginner mode forces detailed tooltips, limits max exposure parameters, and explains complex mathematical formulas in simple terminology.</p>
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
            Unlike simple single-bot setups, Argus employs a structured <strong>multi-agent pipeline</strong>. Each node is engineered with unique prompts, focusing on separate areas of analysis.
          </p>

          {/* Visual flow chart */}
          <div className="bg-slate-950 border border-slate-800 p-6 rounded-lg font-mono text-xs flex flex-col items-center">
            
            <div className="bg-indigo-950/40 border border-indigo-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-indigo-400 block mb-1 uppercase tracking-wider">Agent 1: The Proposer</span>
              <p className="text-[10px] text-slate-400">Scans market, detects breakout momentum, submits BUY/SELL target logic.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-amber-950/40 border border-amber-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-amber-400 block mb-1 uppercase tracking-wider">Agent 2: Risk Verification Node</span>
              <p className="text-[10px] text-slate-400">Computes 14-period Wilder's ATR and forces math safety limits on stop-loss.</p>
            </div>

            <div className="h-6 w-px bg-slate-800 flex flex-col justify-center items-center"><ArrowDown size={12} className="text-slate-500 relative top-3"/></div>

            <div className="bg-rose-950/40 border border-rose-500/40 p-3 rounded text-center w-72 text-white">
              <span className="font-bold text-rose-400 block mb-1 uppercase tracking-wider">Agent 3: Reflection & Memory Engine</span>
              <p className="text-[10px] text-slate-400">Audits past unexpected losses, compiles persistent "Learned Rules" to inject back into system.</p>
            </div>
          </div>

          <div className="space-y-4 mt-6">
            <h3 className="text-lg font-bold text-white uppercase font-mono tracking-wide">Deep Dive into Agent Roles</h3>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-indigo-400 font-bold mb-1">
                <Bot size={16} />
                <span>Agent 1 (The Proposer)</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                The Proposer acts as the alpha-hunting scanner. It reads technical indicator inputs (such as EMA, RSI, and Bollinger bands), sentiment parameters, and news trends. Based on the user's selected <strong>Strategy Focus</strong> and <strong>Risk Level</strong>, it generates a proposal containing the target asset, transaction type (BUY/SELL/HOLD), and an initial confidence score. Critically, it receives past memory rule injects to avoid previously encountered pitfalls.
              </p>
            </div>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-amber-400 font-bold mb-1">
                <ShieldCheck size={16} />
                <span>Agent 2 (The Risk Manager)</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                The Risk Manager or RiskVerification Node evaluates proposed trades against system-wide risk settings and hard mathematical constraints. It computes the 14-period Average True Range (ATR) using Wilder's smoothed moving average method. It enforces a strict rule where stop-losses must be set at a <strong>minimum of 1.5x the ATR value</strong>. This prevents stop-outs due to simple market noise. It also dynamically scales the position size based on the allocated budget risk level.
              </p>
            </div>

            <div className="bg-[#111822] p-4 rounded border border-slate-800">
              <div className="flex items-center gap-2 text-rose-400 font-bold mb-1">
                <Zap size={16} />
                <span>Agent 3 (Reflection / Memory Engine)</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                The Reflection Engine is the self-improving brain of Argus. It reviews closed positions (especially losing trades with unexpected drawdowns) and extracts logical post-mortems. It converts these findings into human-readable, strictly formatted "Memory Rules". These rules are stored permanently and automatically prepended to subsequent system prompts (Context Engineering) to ensure previous trade mistakes are never repeated.
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

    // COURSE 3: Math and ATR Positioning
    {
      id: "atr-positioning",
      category: "2. Mathematical Safeguards",
      title: "Wilder's ATR & Risk-Based Position Sizing",
      isCourse: true,
      icon: <Scale size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">ATR & Mathematical Risk Scaling</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Many algorithmic traders fail because they risk arbitrary amounts on every trade, ignoring market volatility. Argus prevents this using a <strong>14-period Average True Range (ATR) based Risk Engine</strong>.
          </p>

          {/* ATR Formula Panel */}
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
            <span className="text-[10px] font-mono uppercase text-slate-500 block mb-2">Mathematical Formulation</span>
            <h3 className="text-sm font-bold text-white mb-2">Wilder's Average True Range (ATR-14)</h3>
            <p className="text-xs text-slate-300 mb-4 leading-relaxed">
              First, the True Range (TR) for each candle is calculated as the maximum of three values:
            </p>
            <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-xs text-slate-300 mb-4 space-y-1">
              <div>1. Current High minus Current Low: <span className="text-indigo-400">H_t - L_t</span></div>
              <div>2. Absolute of Current High minus Previous Close: <span className="text-indigo-400">|H_t - C_(t-1)|</span></div>
              <div>3. Absolute of Current Low minus Previous Close: <span className="text-indigo-400">|L_t - C_(t-1)|</span></div>
            </div>
            <p className="text-xs text-slate-300 mb-3">
              Then, Wilder's smoothed moving average is applied over 14 historical candles:
            </p>
            <div className="bg-slate-950 p-3 rounded border border-slate-800/80 font-mono text-xs text-slate-300 text-center">
              <span className="text-indigo-300 font-bold">ATR_t = ( (ATR_(t-1) * 13) + TR_t ) / 14</span>
            </div>
          </div>

          {/* Sizing constraints */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold block mb-2">1. NOISE FILTER PROTECTION</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                Argus forces stop-losses to a **minimum of 1.5x the current ATR value** away from the entry price. If a stop-loss is placed any closer, normal price noise would stop out the trade prematurely.
              </p>
            </div>

            <div className="bg-slate-900/60 p-4 rounded border border-slate-800">
              <span className="text-[10px] font-mono uppercase text-emerald-400 font-bold block mb-2">2. RISK CAPITAL SCALING</span>
              <p className="text-xs text-slate-400 leading-relaxed">
                The trade sizing matches your configured risk level. Maximum allowable shares are calculated so the maximum potential loss does not exceed your risk capital ceiling.
              </p>
            </div>
          </div>

          {/* Allocation settings explanation */}
          <div className="bg-[#111822] border border-slate-800 p-4 rounded">
            <span className="text-[10px] font-mono uppercase text-amber-400 font-bold block mb-3">BUDGET RISK LEVEL MULTIPLIERS</span>
            <div className="space-y-2 text-xs font-mono">
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Low Risk Setting</span>
                <span className="text-emerald-400 font-bold">1.0% of Total Budget</span>
              </div>
              <div className="flex justify-between border-b border-slate-800 pb-1">
                <span className="text-slate-400">Medium Risk Setting</span>
                <span className="text-indigo-400 font-bold">1.5% of Total Budget</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">High Risk Setting</span>
                <span className="text-rose-400 font-bold">3.0% of Total Budget</span>
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
              Explore CIO Deck <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // COURSE 4: Chief Trader CIO Deck
    {
      id: "cio-deck",
      category: "2. Mathematical Safeguards",
      title: "Chief Trader Autonomous CIO Deck",
      isCourse: true,
      icon: <Sliders size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Chief Trader Agent: Autonomous CIO Deck</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            The **Chief Trader Agent** acts as the virtual Chief Investment Officer (CIO) of your autonomous terminal. It orchestrates three key areas to maintain discipline and optimize alpha extraction:
          </p>

          <div className="space-y-4">
            {/* Step 1: Task Assignment */}
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STAGE 1
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Quantitative Task Dispatching
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                The CIO distributes research tasks to specialized analyst nodes to collect intelligence before trade proposals are compiled.
              </p>
              <ul className="list-disc list-inside text-xs text-slate-300 space-y-1 font-mono">
                <li><strong className="text-slate-100">Sentiment Harvesting</strong> assigned to Gemini Node</li>
                <li><strong className="text-slate-100">Volatility Analysis</strong> assigned to Technical Node</li>
                <li><strong className="text-slate-100">Correlation Mapping</strong> assigned to Risk Node</li>
                <li><strong className="text-slate-100">Regime Detection</strong> assigned to Claude Node</li>
              </ul>
            </div>

            {/* Step 2: Strategy Tuning */}
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STAGE 2
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Core Strategy Selection & Tuning
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                The CIO toggles between four core algorithmic styles, allowing you to fine-tune strategy properties directly from the terminal console:
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
                  <span className="text-indigo-400 font-bold block mb-0.5">Volatility Breakout Core</span>
                  <p className="text-[10px] text-slate-500">Capitalizes on sudden momentum expansion from historical ranges.</p>
                </div>
                <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
                  <span className="text-emerald-400 font-bold block mb-0.5">Funding Rate Arb Node</span>
                  <p className="text-[10px] text-slate-500">Collects risk-free premium on spot versus futures contract premiums.</p>
                </div>
                <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
                  <span className="text-amber-400 font-bold block mb-0.5">Liquidity Sweeping Alpha</span>
                  <p className="text-[10px] text-slate-500">Trades support/resistance breaches targeting stop-loss hunt events.</p>
                </div>
                <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
                  <span className="text-rose-400 font-bold block mb-0.5">Macro Regime Tracker</span>
                  <p className="text-[10px] text-slate-500">Detects shifts in overall inflation or interest rate cycles.</p>
                </div>
              </div>
            </div>

            {/* Step 3: Multi-Layer Veto Gate */}
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs bg-indigo-500/15 border border-indigo-500/30 text-indigo-400 font-mono font-bold px-2 py-0.5 rounded">
                  STAGE 3
                </span>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider font-mono">
                  Multi-Layer Discretionary Veto
                </h3>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                All trade proposals enter the CIO's vetting gate. If any rule is breached, the proposal is forcefully blocked to avoid capital degradation:
              </p>
              
              <div className="space-y-2 font-mono text-[11px] bg-slate-950 p-3 rounded border border-slate-800/80">
                <div className="flex justify-between items-center text-slate-300">
                  <span>Layer 1: Sentiment Consensus Gate</span>
                  <span className="text-emerald-400 font-bold font-mono">BLOCKS EMOTIONAL FOMO CHASES</span>
                </div>
                <div className="flex justify-between items-center text-slate-300">
                  <span>Layer 2: Hard ATR Noise Filter Cap</span>
                  <span className="text-amber-400 font-bold font-mono">REJECTS TIGHT NOISE STOP-LOSSES</span>
                </div>
                <div className="flex justify-between items-center text-slate-300">
                  <span>Layer 3: Macro Correlation Safety Limit</span>
                  <span className="text-indigo-400 font-bold font-mono">STRICT SECTOR EXPOSURE DIVERSIFICATION</span>
                </div>
                <div className="flex justify-between items-center text-slate-300">
                  <span>Layer 4: CIO Discretionary Overlay</span>
                  <span className="text-rose-400 font-bold font-mono font-bold">APPLIES HISTORICAL MEMORY RULES</span>
                </div>
              </div>
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
              See Veto Protocols <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )
    },

    // NEW COURSE 5: Veto Protocol Specifications
    {
      id: "veto-protocols",
      category: "2. Mathematical Safeguards",
      title: "Veto Gate Specifications & Flow",
      isCourse: true,
      icon: <Shield size={16} />,
      content: (
        <div className="space-y-6 animate-fade-in">
          <h2 className="text-2xl font-bold text-white tracking-tight">Discretionary Veto Protocol Specifications</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Every transaction executed by the <strong>Argus Black-Box Autonomous Loop</strong> undergoes immediate vetting via the CIO Veto Pipeline. There are four distinct, serialized gates that can issue a hard rejection veto.
          </p>

          <div className="space-y-4">
            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">Gate 1: Sentiment & Discipline Filter</span>
              <h3 className="text-sm font-bold text-white mb-2">Psychological Trap Avoidance</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                The Proposer node may suggest an entry driven by sudden social buzz. Gate 1 scans the logical thesis of the proposal using natural language models to extract high-risk emotional flags (e.g. "rocket", "to the moon", "hype", "FOMO"). If sentiment is heavily hyper-inflated without technical consolidation backup, the trade is instantly vetoed as an emotional trap.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-amber-400 uppercase font-bold block mb-1">Gate 2: Wilder's ATR Noise Check</span>
              <h3 className="text-sm font-bold text-white mb-2">Stop-Loss Math Validation</h3>
              <p className="text-xs text-slate-400 leading-relaxed font-mono text-[11px]">
                We calculate Wilder's Average True Range over 14 candles (ATR-14). Gate 2 evaluates the exact stop-loss distance of the proposed trade:
                <br />
                <span className="text-indigo-400 font-bold">StopLossDistance = |EntryPrice - StopLossPrice|</span>
                <br />
                The protocol forces a strict threshold constraint: <span className="text-amber-400 font-bold">StopLossDistance ≥ 1.5 * ATR-14</span>. Any proposal with a stop loss tighter than this value is blocked immediately to prevent normal intraday volatility noise from triggering stop-outs.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-indigo-400 uppercase font-bold block mb-1">Gate 3: Covariance & Concentration Cap</span>
              <h3 className="text-sm font-bold text-white mb-2">Sector Over-concentration Shield</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Even if a trade is technically perfect, Gate 3 cross-references existing assets held within the autonomous portfolio. If the covariance matrix shows a sector or correlation index exceeding <strong className="text-slate-200">0.75</strong>, or if maximum allocation budget is reached for high-beta tech assets, the trade is vetoed to diversify the active capital base.
              </p>
            </div>

            <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
              <span className="text-[10px] font-mono text-rose-400 uppercase font-bold block mb-1">Gate 4: CIO Discretionary Overlay</span>
              <h3 className="text-sm font-bold text-white mb-2">Dynamic Memory Rules Injection</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                The final gate applies persistent "Memory Rules" compiled by the Reflection Agent from previous trading post-mortems. If the proposed asset, timeframe, or market regime conflicts with an active memory guideline, the CIO overrides consensus and issues a final, binding veto.
              </p>
            </div>
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
              See Evolution & Backtesting <ChevronRight size={16} />
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
          <h2 className="text-2xl font-bold text-white tracking-tight">Strategy Evolution & Manual Reflection</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Argus is designed around continuous adaptation. The terminal provides two distinct interfaces for reflection: automatic machine-learning loops and qualitative human trade journaling.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <span className="text-[10px] font-mono text-indigo-400 uppercase font-bold block mb-1">
                AUTOMATED CONTEXT ENGINEERING
              </span>
              <h3 className="text-sm font-bold text-white mb-2">The Memory Reflection Loop</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                When the terminal suffers unexpected losses or hits stop-loss triggers, the reflection node converts that information into strict markdown directives. These directives are persisted and injected back into the active prompt files for Agent 1 and 2 automatically.
              </p>
              <div className="bg-slate-950 p-2.5 rounded border border-slate-900 font-mono text-[9px] text-rose-300 leading-tight">
                "RULE #04: Do not trade correlated tech assets (e.g., NVDA, TSLA) simultaneously if macro indexes (SPY) exhibit 10-day ATR volatility exceeds 2.5."
              </div>
            </div>

            <div className="bg-[#111822] p-5 rounded-lg border border-slate-800">
              <span className="text-[10px] font-mono text-emerald-400 uppercase font-bold block mb-1">
                QUALITATIVE MANUAL JOURNALING
              </span>
              <h3 className="text-sm font-bold text-white mb-2">Trade Reflection Modal</h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                In the Historical Trade Decisions Ledger, users can access a custom Trade Journal Modal. This is designed to capture human psychology feedback, allowing you to annotate trades with private qualitative logs.
              </p>
              <div className="bg-slate-950 p-2.5 rounded border border-slate-900 font-mono text-[9px] text-emerald-300 leading-tight">
                "Note: Trade was well-conceived off weekly EMA support, but my risk-tolerance multiplier was set too high. Need to tune down to Low Risk next time."
              </div>
            </div>
          </div>

          {/* Backtesting tutorial */}
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg mt-6">
            <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
              <Sliders size={16} className="text-indigo-400" />
              Strategy Backtest Engine Tutorial
            </h3>
            <p className="text-xs text-slate-300 leading-relaxed mb-3">
              The Strategy Backtest Engine executes two distinct portfolios under matching market feeds. Use the line toggle check-boxes to compare:
            </p>
            <ul className="list-disc list-inside text-xs text-slate-400 space-y-1.5 font-mono">
              <li>Compare <strong className="text-indigo-400">Argus Multi-Agent Dynamic Core</strong> versus a simple <strong className="text-slate-200">Buy & Hold Benchmark</strong>.</li>
              <li>Filter the realized performance over custom metrics (Last 7 Days, Last 30 Days, Month-to-Date, or Year-to-Date).</li>
              <li>Toggle line charts dynamically to see exactly where volatility drawdowns occur in each setup.</li>
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
                <li><strong>Never Overrule the Risk Manager:</strong> The 14-day Wilder's ATR and dynamic size caps are calibrated to protect you from portfolio ruin. Disabling guardrails or force-closing positions without structured logic can result in immediate loss of capital.</li>
                <li><strong>Past Performance Disclaimers:</strong> Just because a consensus portfolio has achieved a high win rate over historical simulations does not guarantee future profitable yield, as market regimes evolve.</li>
                <li><strong>Start Conservatively:</strong> Always configure the terminal to "Low Risk" (1.0% capital allocation per trade) and run the simulator for a minimum of 30 days to study multi-agent behavior thoroughly before committing capital.</li>
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
          <h2 className="text-2xl font-bold text-white tracking-tight">Configuring Argus for Live Environments</h2>
          <p className="text-slate-300 text-sm leading-relaxed">
            Transitioning your autonomous terminal from local simulation loops to real production execution requires setting appropriate environment variables and choosing proper execution adapters.
          </p>

          <div className="space-y-5">
            {/* Environment variables card */}
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2 font-mono uppercase text-xs text-indigo-400">
                <Settings size={14} /> 1. Crucial Environment Variables
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-3">
                Ensure you copy `.env.example` to `.env` in your workspace and define the keys. The application utilizes a secure Express/TypeScript proxy server, protecting your private tokens from browser discovery.
              </p>
              
              <div className="bg-slate-950 p-4 rounded border border-slate-900 font-mono text-xs text-slate-300 space-y-3">
                <div>
                  <span className="text-indigo-400 font-bold">GEMINI_API_KEY=</span>
                  <span className="text-slate-500">{"your_google_ai_studio_api_key"}</span>
                  <p className="text-[10px] text-slate-400 mt-1">Required for the multi-agent consensus logic. Prepopulated automatically in AI Studio container environments.</p>
                </div>
                <div className="border-t border-slate-800/80 pt-2">
                  <span className="text-indigo-400 font-bold">PORT=3000</span>
                  <p className="text-[10px] text-slate-400 mt-1">Hardcoded by the server container layer. Dev servers automatically bind to port 3000 on host 0.0.0.0.</p>
                </div>
              </div>
            </div>

            {/* Dry Run vs Real Exchange */}
            <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg">
              <h3 className="text-white font-bold mb-3 flex items-center gap-2 font-mono uppercase text-xs text-amber-400">
                <Globe size={14} /> 2. Dry Run Mode vs Live Exchange Adaption
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed mb-3">
                By default, the platform initiates a defaulted execution thread:
              </p>
              <div className="space-y-2.5 text-xs text-slate-400">
                <p>
                  <strong className="text-slate-200">DRY_RUN (Standard/default Mode):</strong> All proposed buy/sell decisions verified by the Risk Node are appended to the in-memory `autoBotState` transaction arrays. No connection to outside brokerages is opened. This is optimal for testing the LLM consensus loop.
                </p>
                <p>
                  <strong className="text-slate-200">LIVE_EXCHANGE Mode (Custom):</strong> When ready, developers can swap the simulation defaults with standard Web3 or stock broker wrappers (e.g., Alpaca API, Interactive Brokers C++, or CCXT for Crypto spot/futures).
                </p>
              </div>
            </div>

            {/* Safety checklist */}
            <div className="bg-rose-950/20 border border-rose-500/15 p-4 rounded-lg flex gap-3">
              <Lock size={20} className="text-rose-400 shrink-0 mt-0.5" />
              <div>
                <h4 className="text-rose-400 font-bold text-xs uppercase font-mono mb-1">Production Safety Checklist</h4>
                <ul className="list-disc list-inside text-slate-300 text-[11px] space-y-1.5 leading-relaxed font-mono">
                  <li>Never push real API keys, brokerage passwords, or seed phrases to Github.</li>
                  <li>Verify that your `server.ts` build step utilizes strict `esbuild` compression to bundle Node.js dependency paths correctly.</li>
                  <li>Enable the Master Kill-Switch immediately if you notice latency spikes or abnormal consecutive multi-layer rejections.</li>
                  <li>Ensure your hosting instance (such as Cloud Run) utilizes persistent logging to trace full multi-node consensus reasoning histories for audit logging.</li>
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
