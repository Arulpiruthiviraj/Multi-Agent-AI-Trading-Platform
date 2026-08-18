/**
 * ==========================================================
 * Module:
 * GuardrailsPanel.tsx
 *
 * Purpose:
 * Core implementation and logic for the GuardrailsPanel.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for GuardrailsPanelx
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

import React from 'react';
import { Shield, ShieldAlert, Activity, AlertTriangle, Zap, ServerCrash } from 'lucide-react';
import { ContextualTooltip } from './ContextualTooltip';

// Real bug fix (2026-08-18 UI audit): every switch below used to be backed by one local
// useState() with zero backend calls - toggling any of them changed a CSS class and nothing
// else, silently resetting to these defaults on reload. Verified against the actual engines
// which of these are real:
//  - riskSizing: real and unconditional - PositionSizing.ts:135-136 computes riskPerShare from
//    tradingSafety.stopLossAssumptionPct and clamps maxQuantity by it on every BUY.
//  - hardCap / killSwitch: already correctly shown locked (real RiskEngine gates).
//  - driftReconcile: real and unconditional - PortfolioReconciliationWorker.reconcile() always
//    syncs local `portfolio` to the broker's reported state every cycle; there is no flag that
//    turns this off.
//  - Everything else (Kelly sizing cap, circuit-breaker auto-flatten, Amihud illiquidity veto,
//    Choppiness Index, Z-score check, OBV divergence veto, feed-health auto-emergency-stop,
//    a master webhook-alerts switch) has no corresponding RiskEngine gate, config flag, or
//    server-side toggle anywhere in this codebase - `grep`ed across src/server. Rather than wire
//    fake persistence to a fake backend, these render as honestly disabled with a real
//    explanation, the same pattern App.tsx's "REBALANCE ALL" already uses correctly.
type GuardrailStatus = 'ALWAYS_ON' | 'NOT_IMPLEMENTED';

export default function GuardrailsPanel({ globalAutoLiquidation, setGlobalAutoLiquidation, maxDrawdownPct }: any) {
  const drawdownPctLabel = typeof maxDrawdownPct === 'number' ? `${(maxDrawdownPct * 100).toFixed(0)}%` : '15%';
  const ToggleSwitch = ({ label, icon: Icon, description, status, notImplementedReason }: { label: string; icon: any; description: string; status: GuardrailStatus; notImplementedReason?: string }) => (
    <div className="flex items-start justify-between p-3 bg-[#111822] border border-slate-800 rounded gap-3">
      <div className="flex gap-3 min-w-0 flex-1">
        <div className="mt-0.5 text-slate-500 shrink-0">
          <Icon size={14} />
        </div>
        <div className="min-w-0">
          <span className="text-[10px] uppercase font-bold tracking-widest text-slate-300 flex items-center gap-1.5 mb-0.5 flex-wrap">
            {label}
            <ContextualTooltip title={label} content={description} showIcon />
            {status === 'ALWAYS_ON' && <span className="text-[8px] font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">REAL · ALWAYS ON</span>}
            {status === 'NOT_IMPLEMENTED' && <span className="text-[8px] font-bold text-slate-500 bg-slate-700/30 px-1.5 py-0.5 rounded">NOT IMPLEMENTED</span>}
          </span>
          <p className="text-[9px] font-mono text-slate-500 max-w-none md:max-w-[200px]">{description}</p>
        </div>
      </div>
      {status === 'ALWAYS_ON' ? (
        <div className="argus-touch-target w-11 h-6 rounded-full border flex items-center px-0.5 bg-emerald-500/20 border-emerald-500/50 justify-end cursor-not-allowed shrink-0" title="Enforced unconditionally in RiskEngine - not user-disableable">
          <div className="w-4 h-4 rounded-full bg-emerald-400"></div>
        </div>
      ) : (
        <div
          className="argus-touch-target w-11 h-6 rounded-full border flex items-center px-0.5 bg-[#1A1F2B] border-slate-800 justify-start cursor-not-allowed shrink-0 opacity-60"
          title={notImplementedReason || "Not implemented - no backend enforcement exists for this yet. Left off so the switch cannot imply protection that isn't real."}
          role="switch"
          aria-checked={false}
          aria-disabled
        >
          <div className="w-4 h-4 rounded-full bg-slate-700"></div>
        </div>
      )}
    </div>
  );

  const GlobalToggleSwitch = ({ label, icon: Icon, stateValue, stateSetter, description }: any) => (
    <div className="flex items-start justify-between p-3 bg-[#111822] border border-slate-800 rounded gap-3">
      <div className="flex gap-3 min-w-0 flex-1">
        <div className="mt-0.5 text-slate-500 shrink-0">
          <Icon size={14} />
        </div>
        <div className="min-w-0">
          <span className="text-[10px] uppercase font-bold tracking-widest text-slate-300 flex items-center mb-0.5 flex-wrap">
            {label}
            <ContextualTooltip title={label} content={description} showIcon />
          </span>
          <p className="text-[9px] font-mono text-slate-500 max-w-none md:max-w-[200px]">{description}</p>
        </div>
      </div>
      <div
        className={"argus-touch-target w-11 h-6 rounded-full border flex items-center px-0.5 transition-all cursor-pointer shrink-0 " + (stateValue ? "bg-rose-500/20 border-rose-500/50 justify-end" : "bg-[#1A1F2B] border-slate-700 justify-start")}
        onClick={() => stateSetter(!stateValue)}
        role="switch"
        aria-checked={stateValue}
      >
        <div className={"w-4 h-4 rounded-full transition-all " + (stateValue ? "bg-rose-400" : "bg-slate-600")}></div>
      </div>
    </div>
  );

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6 argus-responsive-form">
      <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-wide">
        <Shield size={16} className="text-emerald-400" />
        GUARDRAILS & OPS CONTROL (Tier 1-4)
      </h3>
      <p className="text-xs text-slate-400 max-w-3xl leading-relaxed mb-6">
        Configure the robust autopilot guardrails to prevent ruin, size positions dynamically, and halt trading during data anomalies.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Tier 1: Capital Protection */}
        <div className="space-y-3">
           <h4 className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest border-b border-emerald-500/20 pb-1 mb-3">Tier 1: Capital Protection</h4>
           <GlobalToggleSwitch 
             label="Global Auto-Liquidation" 
             stateValue={globalAutoLiquidation} 
             stateSetter={setGlobalAutoLiquidation} 
             icon={AlertTriangle}
             description={`Liquidates all positions immediately if portfolio drawdown exceeds ${drawdownPctLabel} (settings.maxPortfolioDrawdownPct).`}
           />
           <ToggleSwitch
              label="Risk-Based Sizing"
              icon={Activity}
              description="Size each position so stop-loss = fixed % of equity (tradingSafety.stopLossAssumptionPct)."
              status="ALWAYS_ON"
            />
           <ToggleSwitch
              label="Hard Per-Position Cap"
              icon={ShieldAlert}
              description="No position exceeds 20% of total available equity."
              status="ALWAYS_ON"
            />
           <ToggleSwitch
              label="Daily Loss Kill-Switch"
              icon={AlertTriangle}
              description="Blocks new entries at >= 80% daily-loss cap."
              status="ALWAYS_ON"
            />
           <ToggleSwitch
              label="Circuit Breaker Auto-Flatten"
              icon={Zap}
              description="Flattens all positions if severe market crash detected."
              status="NOT_IMPLEMENTED"
              notImplementedReason="No circuit-breaker/auto-flatten-on-crash gate exists in RiskEngine yet."
            />
        </div>

        {/* Tier 2: Decision Quality (Math Overrides) */}
        <div className="space-y-3">
           <h4 className="text-[10px] font-mono text-indigo-400 uppercase tracking-widest border-b border-indigo-400/20 pb-1 mb-3">Tier 2: Math Verification (Dual-Engine)</h4>
           <ToggleSwitch
              label="Kelly Criterion Sizing Cap"
              icon={Shield}
              description="Overrides requested size with mathematically optimal Kelly limit."
              status="NOT_IMPLEMENTED"
              notImplementedReason="quant/risk/ExpectedValue.ts computes a real Kelly fraction, but RiskEngine's live sizing does not consume it yet - Kelly currently only gates whether QuantSignalAgent emits an idea at all."
            />
           <ToggleSwitch
              label="Amihud Illiquidity Veto"
              icon={Activity}
              description="Vetoes trades on illiquid micro-caps to prevent massive slippage."
              status="NOT_IMPLEMENTED"
              notImplementedReason="No Amihud illiquidity gate exists in RiskEngine yet."
            />
           <ToggleSwitch
              label="Choppiness Index (CHOP)"
              icon={AlertTriangle}
              description="Vetoes trend-following entries during sideways/choppy markets."
              status="NOT_IMPLEMENTED"
              notImplementedReason="No CHOP-based veto gate exists in RiskEngine yet."
            />
           <ToggleSwitch
              label="Statistical Z-Score Check"
              icon={AlertTriangle}
              description="Vetoes buys when price is > +2.5 std devs overextended."
              status="NOT_IMPLEMENTED"
              notImplementedReason="No z-score overextension gate exists in RiskEngine yet."
            />
           <ToggleSwitch
              label="OBV Bearish Divergence"
              icon={Activity}
              description="Vetoes breakouts that lack underlying volume conviction."
              status="NOT_IMPLEMENTED"
              notImplementedReason="RSI/MACD-style divergence is computed as a quant feature (isTradeSignal: false) but is not wired as a live veto."
            />
        </div>

        {/* Tier 4: Reliability & Ops */}
        <div className="space-y-3">
           <h4 className="text-[10px] font-mono text-rose-400 uppercase tracking-widest border-b border-rose-400/20 pb-1 mb-3">Tier 4: Reliability & Ops</h4>
           <ToggleSwitch
              label="Feed-Health Watchdog"
              icon={ServerCrash}
              description="Emergency-stop if live data stream goes stale."
              status="NOT_IMPLEMENTED"
              notImplementedReason="RiskEngine's data_freshness gate blocks an individual stale-price trade proposal, but nothing automatically triggers a full emergency stop on stale market data yet."
            />
           <ToggleSwitch
              label="Broker Status Auto-Reconcile"
              icon={Activity}
              description="Sync positions from broker on drift detection."
              status="ALWAYS_ON"
            />
           <ToggleSwitch
              label="Webhook Alerts"
              icon={Zap}
              description="Push notifications on fills, kill-switches, API errors."
              status="NOT_IMPLEMENTED"
              notImplementedReason="Webhooks fire per-URL from Settings > Webhooks when one is configured there - there is no single master on/off flag for all webhook alerts."
            />
        </div>
      </div>
    </div>
  );
}
