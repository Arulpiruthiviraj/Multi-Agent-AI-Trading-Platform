/**
 * ==========================================================
 * Module:
 * AutonomousLaunchDialog.tsx
 *
 * Purpose:
 * Core implementation and logic for the AutonomousLaunchDialog.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for AutonomousLaunchDialogx
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

import React, { useState, useEffect } from 'react';
import { X, Play, Settings2, ShieldAlert, Cpu, Server, Database, AlertTriangle } from 'lucide-react';

interface AutonomousLaunchDialogProps {
  onClose: () => void;
  onStart: (config: any) => void;
  initialBudget: number;
  initialRisk: number;
}

export function AutonomousLaunchDialog({ onClose, onStart, initialBudget, initialRisk }: AutonomousLaunchDialogProps) {
  const [useGlobalBroker, setUseGlobalBroker] = useState(true);
  const [executionBroker, setExecutionBroker] = useState('Interactive Brokers Paper');
  const [marketData, setMarketData] = useState('Polygon.io');
  const [tradingMode, setTradingMode] = useState('Paper');
  const [account, setAccount] = useState('Margin');
  const [strategy, setStrategy] = useState('Hybrid AI');
  const [riskProfile, setRiskProfile] = useState('Moderate');
  
  const [agents, setAgents] = useState({
    technical: true,
    news: true,
    fundamental: true,
    macro: true,
    options: true,
    portfolio: true,
    risk: true,
    reflection: true,
    execution: true
  });

  const activeAgentsCount = Object.values(agents).filter(Boolean).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-[#0A0F16] border border-slate-800 rounded-xl max-w-3xl w-full flex flex-col shadow-2xl max-h-[90vh] overflow-hidden font-mono">
        
        {/* Header */}
        <div className="flex justify-between items-center p-5 border-b border-slate-800 bg-[#111822]">
          <div className="flex items-center gap-3">
            <Cpu className="text-indigo-500" size={24} />
            <div>
              <h2 className="text-white font-bold tracking-widest uppercase">Autonomous Mission Pre-Flight</h2>
              <p className="text-[10px] text-slate-400 uppercase">Review configuration before execution</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-white transition-colors">
            <X size={20} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="overflow-y-auto p-6 flex-1 flex flex-col gap-6">
          
          {/* Infrastructure */}
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-sky-500">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Server size={14} className="text-sky-500" /> Infrastructure & Routing
            </h3>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block">Execution Broker</label>
                <div className="flex items-center gap-2 mb-2">
                  <input type="checkbox" id="useGlobal" checked={useGlobalBroker} onChange={(e) => setUseGlobalBroker(e.target.checked)} className="accent-sky-500" />
                  <label htmlFor="useGlobal" className="text-[10px] text-slate-300 uppercase cursor-pointer">Use Global Default Broker</label>
                </div>
                <select 
                  className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-sky-500 outline-none disabled:opacity-50"
                  value={executionBroker}
                  onChange={(e) => setExecutionBroker(e.target.value)}
                  disabled={useGlobalBroker}
                >
                  <option>Alpaca Paper</option>
                  <option>Alpaca Live</option>
                  <option>Interactive Brokers Paper</option>
                  <option>Interactive Brokers Live</option>
                  <option>Questrade Margin</option>
                  <option>Questrade TFSA</option>
                  <option>Robinhood</option>
                  <option>Coinbase</option>
                  <option>Kraken</option>
                  <option>NDAX</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block">Market Data Feed</label>
                <select 
                  className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-sky-500 outline-none mt-5"
                  value={marketData}
                  onChange={(e) => setMarketData(e.target.value)}
                >
                  <option>Broker Feed</option>
                  <option>Polygon.io</option>
                  <option>Finnhub</option>
                  <option>Twelve Data</option>
                  <option>Alpha Vantage</option>
                  <option>Yahoo Finance</option>
                  <option>Financial Modeling Prep</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block mt-2">Trading Mode</label>
                <select 
                  className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-sky-500 outline-none"
                  value={tradingMode}
                  onChange={(e) => setTradingMode(e.target.value)}
                >
                  <option>Broker Paper Trading</option>
                  <option>Argus Internal Paper Simulator</option>
                  <option className="text-rose-400 font-bold">LIVE TRADING</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block mt-2">Account Sub-Type</label>
                <select 
                  className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-sky-500 outline-none"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                >
                  <option>Margin</option>
                  <option>Cash</option>
                  <option>TFSA</option>
                  <option>RRSP</option>
                </select>
              </div>
            </div>
          </div>

          {/* Strategy & Risk */}
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-rose-500">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2">
              <ShieldAlert size={14} className="text-rose-500" /> Strategy & Risk Profile
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
               <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block">Core Strategy</label>
                  <select 
                    className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-rose-500 outline-none"
                    value={strategy}
                    onChange={(e) => setStrategy(e.target.value)}
                  >
                    <option>AI Strategy</option>
                    <option>Quant Strategy</option>
                    <option>Hybrid Strategy</option>
                    <option>Custom Strategy</option>
                  </select>
               </div>
               <div>
                  <label className="text-[10px] text-slate-500 uppercase tracking-widest mb-1 block">Risk Profile</label>
                  <select 
                    className="w-full bg-[#1A1F2B] border border-slate-800 text-xs text-white p-2 rounded focus:border-rose-500 outline-none"
                    value={riskProfile}
                    onChange={(e) => setRiskProfile(e.target.value)}
                  >
                    <option>Conservative</option>
                    <option>Moderate</option>
                    <option>Aggressive</option>
                    <option>Institutional</option>
                  </select>
               </div>
            </div>
          </div>

          {/* AI Constellation */}
          <div className="bg-[#111822] border border-slate-800 p-5 rounded-lg border-l-4 border-l-indigo-500">
            <h3 className="text-xs font-bold text-slate-300 uppercase tracking-widest mb-4 flex items-center gap-2">
              <Cpu size={14} className="text-indigo-500" /> AI Agent Constellation
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {Object.entries(agents).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <input 
                    type="checkbox" 
                    id={`agent-${key}`} 
                    checked={val}
                    onChange={(e) => setAgents(prev => ({...prev, [key]: e.target.checked}))}
                    className="accent-indigo-500"
                  />
                  <label htmlFor={`agent-${key}`} className="text-[10px] text-slate-300 uppercase cursor-pointer">
                    {key} Agent
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Final Review Summary */}
          <div className="bg-[#1A1F2B] border border-emerald-900/50 p-5 rounded-lg">
            <h3 className="text-xs font-bold text-emerald-400 uppercase tracking-widest mb-4 border-b border-emerald-900/30 pb-2">Pre-Flight Manifest</h3>
            <div className="grid grid-cols-2 gap-y-2 text-xs">
              <div className="text-slate-500">Execution Broker:</div>
              <div className="text-white text-right font-bold">{useGlobalBroker ? 'Global Default' : executionBroker}</div>
              
              <div className="text-slate-500">Market Data:</div>
              <div className="text-white text-right font-bold">{marketData}</div>
              
              <div className="text-slate-500">Account:</div>
              <div className="text-white text-right font-bold">{account}</div>
              
              <div className="text-slate-500">Trading Mode:</div>
              <div className="text-right font-bold text-emerald-400">{tradingMode}</div>
              
              <div className="text-slate-500">Strategy:</div>
              <div className="text-white text-right font-bold">{strategy}</div>
              
              <div className="text-slate-500">Risk Profile:</div>
              <div className="text-white text-right font-bold">{riskProfile}</div>
              
              <div className="text-slate-500">Active AI Agents:</div>
              <div className="text-white text-right font-bold">{activeAgentsCount}</div>
              
              <div className="text-slate-500 mt-2">Buying Power:</div>
              <div className="text-emerald-400 text-right font-bold mt-2">${initialBudget.toLocaleString()}</div>
              
              <div className="text-slate-500">Max Risk Per Trade:</div>
              <div className="text-white text-right font-bold">1%</div>
              
              <div className="text-slate-500">Daily Loss Limit:</div>
              <div className="text-rose-400 text-right font-bold">${initialRisk.toLocaleString()}</div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="p-5 border-t border-slate-800 bg-[#111822] flex justify-end gap-4">
          <button 
            onClick={onClose}
            className="px-6 py-3 rounded text-xs font-bold font-mono uppercase tracking-widest text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            Cancel
          </button>
          <button 
            onClick={() => onStart({ executionBroker: useGlobalBroker ? 'GLOBAL' : executionBroker, marketData, tradingMode, account, strategy, riskProfile, agents })}
            className="px-6 py-3 rounded text-xs font-bold font-mono uppercase tracking-widest text-white bg-emerald-600 hover:bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.3)] transition-all flex items-center gap-2"
          >
            <Play size={14} /> Start Autonomous Trading
          </button>
        </div>
      </div>
    </div>
  );
}
