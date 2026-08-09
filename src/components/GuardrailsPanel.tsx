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

import React, { useState } from 'react';
import { Shield, ShieldAlert, Activity, AlertTriangle, Zap, ServerCrash } from 'lucide-react';
import { ContextualTooltip } from './ContextualTooltip';

export default function GuardrailsPanel({ globalAutoLiquidation, setGlobalAutoLiquidation }: any) {
  const [toggles, setToggles] = useState({
    riskSizing: true,
    hardCap: true,
    killSwitch: true,
    circuitBreaker: true,
    volSkip: false,
    spreadFilter: true,
    backtestGate: true,
    obvDivergence: true,
    watchdog: true,
    webhook: false,
    driftReconcile: true
  });

  const toggle = (key: keyof typeof toggles) => {
    setToggles(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const ToggleSwitch = ({ label, icon: Icon, stateKey, description, locked }: any) => (
    <div className="flex items-start justify-between p-3 bg-[#111822] border border-slate-800 rounded">
      <div className="flex gap-3">
        <div className="mt-0.5 text-slate-500">
          <Icon size={14} />
        </div>
        <div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-slate-300 flex items-center gap-1.5 mb-0.5">
            {label}
            <ContextualTooltip title={label} content={description} />
            {locked && <span className="text-[8px] font-bold text-emerald-500 bg-emerald-500/10 px-1.5 py-0.5 rounded">REAL · ALWAYS ON</span>}
          </span>
          <p className="text-[9px] font-mono text-slate-500 max-w-[200px]">{description}</p>
        </div>
      </div>
      {locked ? (
        <div className="w-8 h-4 rounded-full border flex items-center px-0.5 bg-emerald-500/20 border-emerald-500/50 justify-end cursor-not-allowed" title="Enforced unconditionally in RiskEngine - not user-disableable">
          <div className="w-3 h-3 rounded-full bg-emerald-400"></div>
        </div>
      ) : (
        <div
          className={"w-8 h-4 rounded-full border flex items-center px-0.5 transition-all cursor-pointer " + (toggles[stateKey as keyof typeof toggles] ? "bg-emerald-500/20 border-emerald-500/50 justify-end" : "bg-[#1A1F2B] border-slate-700 justify-start")}
          onClick={() => toggle(stateKey as keyof typeof toggles)}
        >
          <div className={"w-3 h-3 rounded-full transition-all " + (toggles[stateKey as keyof typeof toggles] ? "bg-emerald-400" : "bg-slate-600")}></div>
        </div>
      )}
    </div>
  );

  const GlobalToggleSwitch = ({ label, icon: Icon, stateValue, stateSetter, description }: any) => (
    <div className="flex items-start justify-between p-3 bg-[#111822] border border-slate-800 rounded">
      <div className="flex gap-3">
        <div className="mt-0.5 text-slate-500">
          <Icon size={14} />
        </div>
        <div>
          <span className="text-[10px] uppercase font-bold tracking-widest text-slate-300 flex items-center mb-0.5">
            {label}
            <ContextualTooltip title={label} content={description} />
          </span>
          <p className="text-[9px] font-mono text-slate-500 max-w-[200px]">{description}</p>
        </div>
      </div>
      <div 
        className={"w-8 h-4 rounded-full border flex items-center px-0.5 transition-all cursor-pointer " + (stateValue ? "bg-rose-500/20 border-rose-500/50 justify-end" : "bg-[#1A1F2B] border-slate-700 justify-start")}
        onClick={() => stateSetter(!stateValue)}
      >
        <div className={"w-3 h-3 rounded-full transition-all " + (stateValue ? "bg-rose-400" : "bg-slate-600")}></div>
      </div>
    </div>
  );

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6">
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
             description="Liquidates all positions immediately if daily drawdown exceeds 15%." 
           />
           <ToggleSwitch 
              label="Risk-Based Sizing" 
              stateKey="riskSizing" 
              icon={Activity} 
              description="Size each position so stop-loss = fixed % of equity (e.g. 0.5%)." 
            />
           <ToggleSwitch
              label="Hard Per-Position Cap"
              stateKey="hardCap"
              icon={ShieldAlert}
              description="No position exceeds 20% of total available equity."
              locked
            />
           <ToggleSwitch
              label="Daily Loss Kill-Switch"
              stateKey="killSwitch"
              icon={AlertTriangle}
              description="Blocks new entries at >= 80% daily-loss cap."
              locked
            />
           <ToggleSwitch 
              label="Circuit Breaker Auto-Flatten" 
              stateKey="circuitBreaker" 
              icon={Zap} 
              description="Flattens all positions if severe market crash detected." 
            />
        </div>

        {/* Tier 2: Decision Quality (Math Overrides) */}
        <div className="space-y-3">
           <h4 className="text-[10px] font-mono text-indigo-400 uppercase tracking-widest border-b border-indigo-400/20 pb-1 mb-3">Tier 2: Math Verification (Dual-Engine)</h4>
           <ToggleSwitch 
              label="Kelly Criterion Sizing Cap" 
              stateKey="riskSizing" 
              icon={Shield} 
              description="Overrides requested size with mathematically optimal Kelly limit." 
            />
           <ToggleSwitch 
              label="Amihud Illiquidity Veto" 
              stateKey="spreadFilter" 
              icon={Activity} 
              description="Vetoes trades on illiquid micro-caps to prevent massive slippage." 
            />
           <ToggleSwitch 
              label="Choppiness Index (CHOP)" 
              stateKey="volSkip" 
              icon={AlertTriangle} 
              description="Vetoes trend-following entries during sideways/choppy markets." 
            />
           <ToggleSwitch 
              label="Statistical Z-Score Check" 
              stateKey="backtestGate" 
              icon={AlertTriangle} 
              description="Vetoes buys when price is > +2.5 std devs overextended." 
            />
           <ToggleSwitch 
              label="OBV Bearish Divergence" 
              stateKey="obvDivergence" 
              icon={Activity} 
              description="Vetoes breakouts that lack underlying volume conviction." 
            />
        </div>

        {/* Tier 4: Reliability & Ops */}
        <div className="space-y-3">
           <h4 className="text-[10px] font-mono text-rose-400 uppercase tracking-widest border-b border-rose-400/20 pb-1 mb-3">Tier 4: Reliability & Ops</h4>
           <ToggleSwitch 
              label="Feed-Health Watchdog" 
              stateKey="watchdog" 
              icon={ServerCrash} 
              description="Emergency-stop if live data stream goes stale." 
            />
           <ToggleSwitch 
              label="Broker Status Auto-Reconcile" 
              stateKey="driftReconcile" 
              icon={Activity} 
              description="Sync positions from broker on drift detection." 
            />
           <ToggleSwitch 
              label="Webhook Alerts" 
              stateKey="webhook" 
              icon={Zap} 
              description="Push notifications on fills, kill-switches, API errors." 
            />
        </div>
      </div>
    </div>
  );
}
