/**
 * ==========================================================
 * Module:
 * AgentRegimeHeatmap.tsx
 *
 * Purpose:
 * Core implementation and logic for the AgentRegimeHeatmap.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AgentRegimeHeatmapx
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
  TrendingUp, 
  TrendingDown, 
  AlertTriangle, 
  RefreshCw, 
  Percent, 
  Info,
  Sliders,
  Sparkles,
  Zap
} from "lucide-react";

interface CellData {
  agent: string;
  regime: string;
  winRate: number;
  allocWeight: number;
  description: string;
  keyMetric: string;
}

const REGIMES = [
  { id: "bull", name: "Bull Market", icon: TrendingUp, color: "text-emerald-400 border-emerald-500/20" },
  { id: "bear", name: "Bear Market", icon: TrendingDown, color: "text-rose-450 border-rose-500/20" },
  { id: "volatile", name: "High Volatility", icon: AlertTriangle, color: "text-amber-400 border-amber-500/20" },
  { id: "mean_reversion", name: "Mean Reversion", icon: RefreshCw, color: "text-indigo-400 border-indigo-500/20" },
];

const AGENTS = [
  "NewsAgent",
  "MacroAgent",
  "TechAgent",
  "SentAgent",
  "FlowAgent"
];

// Matrix mapping of agents × regimes
const HEATMAP_DATA: Record<string, Record<string, CellData>> = {
  NewsAgent: {
    bull: {
      agent: "NewsAgent",
      regime: "Bull Market",
      winRate: 82,
      allocWeight: 35,
      description: "Aggressively rides momentum from earnings surprises and product launch catalysts. Minimal headwind issues.",
      keyMetric: "Catalyst Speed: 140ms"
    },
    bear: {
      agent: "NewsAgent",
      regime: "Bear Market",
      winRate: 35,
      allocWeight: 10,
      description: "Prone to fakeouts as negative news macro-correlation overrides individual stock earnings releases.",
      keyMetric: "Slippage Overhead: High"
    },
    volatile: {
      agent: "NewsAgent",
      regime: "High Volatility",
      winRate: 65,
      allocWeight: 20,
      description: "Captures sudden PR swings and panic liquidations well. Adapts quickly using real-time NLP parsers.",
      keyMetric: "Confidence Interval: 88%"
    },
    mean_reversion: {
      agent: "NewsAgent",
      regime: "Mean Reversion",
      winRate: 40,
      allocWeight: 15,
      description: "Overtrades on micro-news noise during quiet ranging markets, incurring excessive transaction slippage.",
      keyMetric: "False Alarms Rate: 18%"
    }
  },
  MacroAgent: {
    bull: {
      agent: "MacroAgent",
      regime: "Bull Market",
      winRate: 70,
      allocWeight: 25,
      description: "Maintains optimal leverage in high-beta indexes while hedging through key structural interest-rate vectors.",
      keyMetric: "Beta Tracking Err: 0.08"
    },
    bear: {
      agent: "MacroAgent",
      regime: "Bear Market",
      winRate: 78,
      allocWeight: 35,
      description: "Excellent defensive rotation. Short-biases key industrial sector ETFs based on interest hike forecasting.",
      keyMetric: "Alpha Generation: +12.4%"
    },
    volatile: {
      agent: "MacroAgent",
      regime: "High Volatility",
      winRate: 45,
      allocWeight: 15,
      description: "Struggles when macro variables fluctuate rapidly within short technical frames, creating noise buffer lags.",
      keyMetric: "Lag Indicator Delay: 2.2s"
    },
    mean_reversion: {
      agent: "MacroAgent",
      regime: "Mean Reversion",
      winRate: 55,
      allocWeight: 20,
      description: "Steady performance centering on spread differentials between corporate yield curves and short treasuries.",
      keyMetric: "Spread Accuracy: 84%"
    }
  },
  TechAgent: {
    bull: {
      agent: "TechAgent",
      regime: "Bull Market",
      winRate: 88,
      allocWeight: 40,
      description: "Phenomenal breakout detection. Rides Exponential Moving Average (EMA) extensions with high stop-loss precision.",
      keyMetric: "EMA Cross Precision: 94%"
    },
    bear: {
      agent: "TechAgent",
      regime: "Bear Market",
      winRate: 30,
      allocWeight: 5,
      description: "Prone to excessive drawdowns due to buy-the-dip oscillators firing prematurely before structural bottoming.",
      keyMetric: "Avg Drawdown Peak: -18.2%"
    },
    volatile: {
      agent: "TechAgent",
      regime: "High Volatility",
      winRate: 58,
      allocWeight: 15,
      description: "Utilizes dynamic Bollinger Band expansion buffers to adjust entry sizing, preventing immediate whipsaws.",
      keyMetric: "Volatility Band Fit: 91%"
    },
    mean_reversion: {
      agent: "TechAgent",
      regime: "Mean Reversion",
      winRate: 72,
      allocWeight: 30,
      description: "Highly optimized. Relative Strength Index (RSI) and stochastic setups reach peak historical efficiency here.",
      keyMetric: "Oscillator Return: +8.9%"
    }
  },
  SentAgent: {
    bull: {
      agent: "SentAgent",
      regime: "Bull Market",
      winRate: 75,
      allocWeight: 20,
      description: "Tracks retail buyer euphoria accurately across retail social boards, magnifying gains in high-affinity assets.",
      keyMetric: "Euphoria Signal Fit: 95%"
    },
    bear: {
      agent: "SentAgent",
      regime: "Bear Market",
      winRate: 40,
      allocWeight: 10,
      description: "Sentiment remains overly depressed for extended periods, missing short-squeeze rebound opportunities.",
      keyMetric: "Panic Floor Est: 76% Acc"
    },
    volatile: {
      agent: "SentAgent",
      regime: "High Volatility",
      winRate: 70,
      allocWeight: 25,
      description: "Incredibly fast at executing downside safety hedges when fearful news sentiment indexes spike exponentially.",
      keyMetric: "VIX Correlation: 0.92"
    },
    mean_reversion: {
      agent: "SentAgent",
      regime: "Mean Reversion",
      winRate: 50,
      allocWeight: 15,
      description: "Retail sentiment is rangebound and highly erratic, leading to back-and-forth micro trade executions.",
      keyMetric: "Chop Overhead: Moderate"
    }
  },
  FlowAgent: {
    bull: {
      agent: "FlowAgent",
      regime: "Bull Market",
      winRate: 80,
      allocWeight: 30,
      description: "Successfully captures bulk Option Sweep volume and Block Trade footprints of institutional capital buyers.",
      keyMetric: "Block Sweep Tracker: Live"
    },
    bear: {
      agent: "FlowAgent",
      regime: "Bear Market",
      winRate: 62,
      allocWeight: 25,
      description: "Flags dark pool distribution and short-covering activity, offering robust early exit cues for long positions.",
      keyMetric: "Dark Pool Div: Detected"
    },
    volatile: {
      agent: "FlowAgent",
      regime: "High Volatility",
      winRate: 74,
      allocWeight: 25,
      description: "Adjusts transaction execution slippage metrics in real-time, executing dark pool liquidity sweeps safely.",
      keyMetric: "Order Fill Rate: 98.4%"
    },
    mean_reversion: {
      agent: "FlowAgent",
      regime: "Mean Reversion",
      winRate: 66,
      allocWeight: 20,
      description: "Pairs large volume node reversals with market market-maker order books to harvest immediate spread arb.",
      keyMetric: "Spread Capture: 1.8 bps"
    }
  }
};

export default function AgentRegimeHeatmap() {
  const [selectedCell, setSelectedCell] = useState<{ agent: string; regime: string }>({
    agent: "TechAgent",
    regime: "bull",
  });
  const [isStressTested, setIsStressTested] = useState(false);

  const activeCellData = HEATMAP_DATA[selectedCell.agent]?.[selectedCell.regime];

  const getHeatColorClass = (winRate: number) => {
    // If stress-tested, drop performance slightly to represent system stress
    const adjustedRate = isStressTested ? winRate - 8 : winRate;
    
    if (adjustedRate >= 80) {
      return "bg-indigo-650/40 text-indigo-400 border-indigo-500/50 hover:bg-indigo-600/65";
    } else if (adjustedRate >= 65) {
      return "bg-emerald-650/40 text-emerald-400 border-emerald-500/50 hover:bg-emerald-600/65";
    } else if (adjustedRate >= 50) {
      return "bg-amber-650/40 text-amber-400 border-amber-500/50 hover:bg-amber-600/65";
    } else {
      return "bg-rose-650/40 text-rose-400 border-rose-500/50 hover:bg-rose-600/65";
    }
  };

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col gap-5 w-full">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 border-b border-slate-850 pb-3">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <Sliders size={16} className="text-indigo-400 animate-pulse" />
            AGENT REGIME PERFORMANCE HEATMAP
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Analyzing autonomous multi-agent consensus scoring and win-rates across market phases.
          </p>
        </div>
        
        <button
          onClick={() => setIsStressTested(!isStressTested)}
          className={`text-[10px] uppercase font-mono tracking-widest px-3 py-1.5 rounded border transition-all flex items-center gap-2 ${
            isStressTested 
              ? "bg-rose-500/20 text-rose-450 border-rose-500/40 animate-pulse" 
              : "bg-slate-800 text-slate-400 border-slate-700 hover:text-white"
          }`}
          id="toggle-stress-test"
        >
          <Zap size={11} className={isStressTested ? "text-rose-400 fill-rose-400" : ""} />
          {isStressTested ? "Stress Test Enabled (-8% WinRate)" : "Enable Stress Test"}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Heatmap Grid */}
        <div className="xl:col-span-2 overflow-x-auto">
          <div className="min-w-[500px] flex flex-col gap-1.5">
            {/* Headers Row */}
            <div className="grid grid-cols-5 gap-2 pb-1 text-center">
              <div className="text-left py-2 px-3 text-[9px] font-mono text-slate-500 uppercase tracking-widest">
                Agent Spec
              </div>
              {REGIMES.map((reg) => {
                const IconComp = reg.icon;
                return (
                  <div key={reg.id} className="py-2 px-1 border border-slate-800/40 rounded bg-[#111822]/80 flex flex-col items-center justify-center">
                    <IconComp size={12} className={`mb-1 ${reg.color.split(' ')[0]}`} />
                    <span className="text-[9px] font-mono text-slate-400 uppercase tracking-wider block truncate w-full text-center">
                      {reg.name}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Matrix Body */}
            {AGENTS.map((agent) => (
              <div key={agent} className="grid grid-cols-5 gap-2 items-center">
                {/* Agent Title Column */}
                <div className="bg-[#111822] p-3 border border-slate-850 rounded text-left flex flex-col">
                  <span className="text-xs font-bold text-slate-200 truncate">{agent}</span>
                  <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest shadow-sm">
                    consensus node
                  </span>
                </div>

                {/* Heat Cells */}
                {REGIMES.map((reg) => {
                  const data = HEATMAP_DATA[agent]?.[reg.id];
                  const value = data ? data.winRate : 50;
                  const displayValue = isStressTested ? value - 8 : value;
                  const isSelected = selectedCell.agent === agent && selectedCell.regime === reg.id;

                  return (
                    <button
                      key={reg.id}
                      onClick={() => setSelectedCell({ agent, regime: reg.id })}
                      className={`
                        h-12 border rounded transition-all flex flex-col items-center justify-center select-none cursor-pointer relative group
                        ${getHeatColorClass(value)}
                        ${isSelected ? "ring-2 ring-indigo-400 scale-[1.03] z-10 shadow-lg border-transparent" : ""}
                      `}
                    >
                      <span className="text-sm font-bold font-mono tracking-tight flex items-center">
                        {displayValue}%
                        {displayValue >= 75 && <Sparkles size={8} className="ml-0.5 opacity-60 text-white animate-pulse" />}
                      </span>
                      <span className="text-[8px] font-mono uppercase tracking-widest opacity-60">
                        winrate
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Color Key Explanation */}
          <div className="mt-5 flex items-center gap-4 text-[9px] font-mono text-slate-500 uppercase tracking-wider bg-[#111822]/50 p-2.5 rounded border border-slate-850/50">
            <span>Performance index:</span>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-indigo-650/40 border border-indigo-500/50"></span>
              <span>&gt;80% Supercharged</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-emerald-650/40 border border-emerald-500/50"></span>
              <span>65-80% Optimal</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-amber-650/40 border border-amber-500/50"></span>
              <span>50-65% Neutral</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded bg-rose-650/40 border border-rose-500/50"></span>
              <span>&lt;50% Suboptimal</span>
            </div>
          </div>
        </div>

        {/* Detailed Briefing sidebar */}
        <div className="flex flex-col gap-3 bg-[#111822] rounded-lg border border-slate-850 p-4">
          <div className="border-b border-slate-800 pb-2 flex items-center justify-between">
            <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
              Live Regime Analysis
            </span>
            <div className="flex items-center gap-1 px-2 py-0.5 rounded bg-indigo-500/15 border border-indigo-500/20 text-indigo-400 font-mono text-[9px] font-semibold uppercase tracking-wider">
              Selected Cell
            </div>
          </div>

          {activeCellData ? (
            <div className="flex flex-col gap-4 animate-fade-in">
              <div>
                <h4 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
                  <span className="text-indigo-400">{activeCellData.agent}</span>
                  <span className="text-slate-500">@</span>
                  <span className="text-slate-300 font-mono text-xs">{activeCellData.regime}</span>
                </h4>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-slate-500 text-[10px] font-mono uppercase tracking-wider">Historical Allocation:</span>
                  <span className="text-xs font-bold text-indigo-400 font-mono">{activeCellData.allocWeight}% Weight</span>
                </div>
              </div>

              <div className="bg-slate-900/50 p-3 rounded border border-slate-800/80">
                <span className="text-[9px] font-mono text-slate-500 uppercase tracking-wider block mb-1">
                  Strategy Vector Note
                </span>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {activeCellData.description}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 mt-1">
                <div className="bg-[#1A1F2B] p-2.5 rounded border border-slate-850">
                  <span className="text-[8px] font-mono text-slate-500 block uppercase mb-0.5">Key Performance Indicator</span>
                  <span className="text-xs font-bold font-mono text-slate-200">{activeCellData.keyMetric}</span>
                </div>
                <div className="bg-[#1A1F2B] p-2.5 rounded border border-slate-850 flex flex-col justify-center">
                  <span className="text-[8px] font-mono text-slate-500 block uppercase mb-0.5">Simulated Vol Shift Adjusted</span>
                  <span className={`text-xs font-bold font-mono ${isStressTested ? "text-rose-400" : "text-emerald-400"}`}>
                    {isStressTested ? `${activeCellData.winRate - 8}%` : "No Change"}
                  </span>
                </div>
              </div>

              <div className="border-t border-slate-800/80 pt-3 flex flex-col gap-1.5 text-[10px] text-slate-400 font-mono">
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
                  <span>Active weight multiplier: {isStressTested ? "0.85x" : "1.00x"}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  <span>Consensus gate authorization: ENABLED</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center py-10 flex flex-col items-center justify-center text-slate-500 leading-relaxed">
              <Info size={16} className="mb-2 text-slate-600" />
              <span className="text-[10px] font-mono uppercase tracking-widest">Select cell in heatmap</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
