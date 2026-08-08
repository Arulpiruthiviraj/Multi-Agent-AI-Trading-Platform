/**
 * ==========================================================
 * Module:
 * ContextMemoryEngineering.tsx
 *
 * Purpose:
 * Core implementation and logic for the ContextMemoryEngineering.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for ContextMemoryEngineeringx
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
import { BrainCircuit, X, Plus, BookOpen, Fingerprint } from "lucide-react";

/* === COMPONENT: ContextMemoryEngineering === */
/*
  This module serves as the primary visualizer for Context Engineering
  and the Memory Vault. It pulls strictly learned context from the Argus 
  Reflection Agent (from the backend autoBotState) and allows operators 
  to view, add, or manually override constraints.
*/

interface RuleObject {
  rule: string;
  dsr?: number;
  trials?: number;
  overfitRisk?: "LOW" | "HIGH";
}

interface ContextMemoryEngineeringProps {
  memoryRules: Array<string | RuleObject>;
  onAddRule: (rule: string) => void;
  onDeleteRule: (index: number) => void;
}

export default function ContextMemoryEngineering({ memoryRules, onAddRule, onDeleteRule }: ContextMemoryEngineeringProps) {
  const [newRule, setNewRule] = useState("");

  const handleAdd = () => {
    if (newRule.trim()) {
      onAddRule(newRule.trim());
      setNewRule("");
    }
  };

  return (
    <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col h-full animate-fade-in" id="context-engineering-panel">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
            <BrainCircuit size={16} className="text-emerald-400" />
            Context & Memory Engineering
          </h3>
          <p className="text-xs text-slate-400 mt-1">
            Dynamic context injections shielded by Deflated Sharpe Ratio (DSR) analysis.
          </p>
        </div>
        <div className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded text-[10px] uppercase font-mono tracking-widest flex items-center gap-2">
          <Fingerprint size={12} />
          {memoryRules?.length || 0} Strict Bounds Active
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4">
        {/* Input for Manual Engineering */}
        <div className="flex flex-col md:flex-row gap-3">
          <input
            type="text"
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="Manually inject structural context (e.g., 'Never buy tech before major CPI prints...')"
            className="flex-1 bg-[#111822] border border-slate-700/80 rounded-lg px-4 py-2.5 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
          />
          <button
            onClick={handleAdd}
            disabled={!newRule.trim()}
            className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-5 py-2.5 rounded-lg text-xs tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2 shrink-0"
          >
            <Plus size={14} />
            INJECT CONTEXT
          </button>
        </div>

        {/* Existing Rules List */}
        <div className="flex-1 overflow-y-auto space-y-3 bg-[#111822] border border-slate-800/80 rounded-lg p-4 max-h-[300px]">
          {!memoryRules || memoryRules.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full opacity-50 py-10">
              <BookOpen size={32} className="text-slate-500 mb-3" />
              <p className="text-xs font-mono text-slate-400 uppercase tracking-widest text-center">
                Memory Vault is Empty<br />
                <span className="text-[10px]">Awaiting auto-reflection or manual injection</span>
              </p>
            </div>
          ) : (
            memoryRules.map((rule, idx) => {
              const isObject = typeof rule !== "string";
              const ruleText = isObject ? (rule as RuleObject).rule : (rule as string);
              const ruleDsr = isObject ? (rule as RuleObject).dsr : undefined;
              const ruleTrials = isObject ? (rule as RuleObject).trials : undefined;
              const ruleRisk = isObject ? (rule as RuleObject).overfitRisk : undefined;

              return (
                <div key={idx} className="bg-[#1A1F2B] border border-slate-800 rounded p-3 flex flex-col gap-2 group transition-colors hover:border-slate-600">
                  <div className="flex items-start gap-3 w-full">
                    <div className="mt-0.5 w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center border border-slate-700 text-slate-400 text-[10px] font-bold shrink-0">
                      {idx + 1}
                    </div>
                    <div className="flex-1 text-xs text-slate-300 leading-relaxed font-mono">
                      {ruleText}
                    </div>
                    <button
                      onClick={() => onDeleteRule(idx)}
                      className="text-slate-500 hover:text-rose-400 transition-colors p-1 self-start"
                      title="Remove Rule"
                    >
                      <X size={14} />
                    </button>
                  </div>
                  {isObject && ruleDsr !== undefined && (
                    <div className="pl-8 flex flex-wrap items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                      <span className="bg-indigo-500/10 text-indigo-400 px-1.5 py-0.5 rounded border border-indigo-500/20 font-semibold">
                        DSR: {(ruleDsr * 100).toFixed(1)}%
                      </span>
                      <span className="bg-slate-800/80 text-slate-400 px-1.5 py-0.5 rounded border border-slate-700">
                        Trials (N): {ruleTrials}
                      </span>
                      {ruleRisk === "HIGH" ? (
                        <span className="bg-rose-500/10 text-rose-400 px-1.5 py-0.5 rounded border border-rose-500/20 font-bold animate-pulse">
                          ⚠️ HIGH OVERFIT RISK
                        </span>
                      ) : (
                        <span className="bg-emerald-500/10 text-emerald-400 px-1.5 py-0.5 rounded border border-emerald-500/20 font-bold">
                          🛡️ OPTIMIZED SHIELDED
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
