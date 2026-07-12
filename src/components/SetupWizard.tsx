import React, { useState, useEffect } from "react";
import { Check, Shield, Zap, TrendingUp, AlertTriangle, Settings, Activity, Cpu, CheckCircle2, ChevronRight, X } from "lucide-react";

export function SetupWizard({ onComplete }: { onComplete: (config: any) => void }) {
  const [step, setStep] = useState(1);
  const [budget, setBudget] = useState(100);
  const [riskLevel, setRiskLevel] = useState("Balanced");
  const [isInitializing, setIsInitializing] = useState(false);
  const [initStep, setInitStep] = useState(0);

  const initSteps = [
    "Loading market intelligence",
    "Starting news monitoring",
    "Activating calculation engines",
    "Starting AI agent council",
    "Starting portfolio monitoring",
    "Connecting execution engine"
  ];

  const handleInitialize = () => {
    setIsInitializing(true);
    let currentStep = 0;
    const interval = setInterval(() => {
      currentStep++;
      setInitStep(currentStep);
      if (currentStep >= initSteps.length) {
        clearInterval(interval);
        setTimeout(() => {
          onComplete({ budget, riskLevel });
        }, 1000);
      }
    }, 800);
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
      <div className="bg-[#1A1F2B] border border-indigo-500/50 shadow-[0_0_50px_rgba(99,102,241,0.15)] rounded-xl w-full max-w-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-[#111822] p-6 border-b border-slate-800 flex justify-between items-center relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-1 bg-slate-800">
            <div className="h-full bg-indigo-500 transition-all duration-500" style={{ width: `${(step / 4) * 100}%`}}></div>
          </div>
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              <Zap className="text-indigo-400" size={24} />
              Autonomous Trading Setup
            </h2>
            <p className="text-slate-400 text-sm mt-1">Configure your AI trading team in just a few clicks.</p>
          </div>
          <div className="text-indigo-400 font-mono font-bold text-xl">
            Step {step}/4
          </div>
        </div>

        {/* Content */}
        <div className="p-8 flex-1 min-h-[400px]">
          {step === 1 && (
            <div className="space-y-6 animate-fade-in">
              <h3 className="text-lg font-bold text-white mb-4">Connect Services</h3>
              <p className="text-sm text-slate-400 mb-6">Connect your brokerage and data providers to enable autonomous trading.</p>
              
              <div className="grid grid-cols-2 gap-6">
                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Required Connections</h4>
                  <div className="space-y-3">
                    <div className="bg-[#111822] border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between group">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 size={18} className="text-emerald-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-200">Broker API</div>
                          <div className="text-[10px] text-slate-500">Connected to Alpaca</div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-[#111822] border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 size={18} className="text-emerald-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-200">Market Data API</div>
                          <div className="text-[10px] text-slate-500">Live data feed active</div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-[#111822] border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 size={18} className="text-emerald-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-200">News API</div>
                          <div className="text-[10px] text-slate-500">News stream connected</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                
                <div>
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-3">Optional LLM APIs</h4>
                  <div className="space-y-3">
                    <div className="bg-[#111822] border border-emerald-500/30 rounded-lg p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <CheckCircle2 size={18} className="text-emerald-500" />
                        <div>
                          <div className="text-sm font-bold text-slate-200">Gemini API</div>
                          <div className="text-[10px] text-emerald-400">Primary reasoning engine</div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-[#111822] border border-slate-700 rounded-lg p-3 flex items-center justify-between opacity-60">
                      <div className="flex items-center gap-3">
                        <div className="w-4 h-4 rounded-full border border-slate-600"></div>
                        <div>
                          <div className="text-sm font-bold text-slate-200">ChatGPT API</div>
                          <div className="text-[10px] text-slate-500">Not configured</div>
                        </div>
                      </div>
                    </div>
                    <div className="bg-[#111822] border border-slate-700 rounded-lg p-3 flex items-center justify-between opacity-60">
                      <div className="flex items-center gap-3">
                        <div className="w-4 h-4 rounded-full border border-slate-600"></div>
                        <div>
                          <div className="text-sm font-bold text-slate-200">Claude API</div>
                          <div className="text-[10px] text-slate-500">Not configured</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-6 animate-fade-in flex flex-col items-center justify-center h-full">
              <h3 className="text-2xl font-bold text-white mb-2 text-center">Set Trading Capital</h3>
              <p className="text-slate-400 text-center max-w-sm mb-8">This is the maximum amount the autonomous trading system is allowed to manage and allocate.</p>
              
              <div className="bg-[#111822] border border-indigo-500/50 rounded-2xl p-8 flex items-center gap-4 relative shadow-[0_0_30px_rgba(99,102,241,0.1)]">
                <span className="text-5xl font-bold text-slate-400">$</span>
                <input 
                  type="number" 
                  className="bg-transparent text-6xl font-bold text-white outline-none w-48 text-center" 
                  value={budget}
                  onChange={(e) => setBudget(Number(e.target.value))}
                />
              </div>
              <p className="text-xs text-indigo-400 font-mono mt-4 uppercase tracking-widest bg-indigo-500/10 px-4 py-2 rounded-lg border border-indigo-500/20">
                Recommended initial budget: $100
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-6 animate-fade-in h-full">
              <h3 className="text-xl font-bold text-white mb-2">Select Risk Profile</h3>
              <p className="text-slate-400 text-sm mb-6">The AI system will automatically configure position sizing, stop losses, and trade frequency based on your selection.</p>
              
              <div className="grid grid-cols-1 gap-4">
                <div 
                  onClick={() => setRiskLevel("Conservative")}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${riskLevel === "Conservative" ? "bg-emerald-500/10 border-emerald-500/50 shadow-[0_0_20px_rgba(16,185,129,0.15)]" : "bg-[#111822] border-slate-800 hover:border-slate-600"}`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-4 h-4 rounded-full bg-emerald-500"></div>
                    <span className="text-lg font-bold text-white">Conservative</span>
                  </div>
                  <p className="text-sm text-slate-400 pl-7">Lower risk, fewer trades. Prioritizes capital preservation over high returns. Tight stop-losses.</p>
                </div>

                <div 
                  onClick={() => setRiskLevel("Balanced")}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${riskLevel === "Balanced" ? "bg-amber-500/10 border-amber-500/50 shadow-[0_0_20px_rgba(245,158,11,0.15)]" : "bg-[#111822] border-slate-800 hover:border-slate-600"}`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-4 h-4 rounded-full bg-amber-500"></div>
                    <span className="text-lg font-bold text-white">Balanced</span>
                  </div>
                  <p className="text-sm text-slate-400 pl-7">Moderate risk and opportunity. Seeks steady growth while managing drawdowns.</p>
                </div>

                <div 
                  onClick={() => setRiskLevel("Aggressive")}
                  className={`p-4 rounded-xl border cursor-pointer transition-all ${riskLevel === "Aggressive" ? "bg-rose-500/10 border-rose-500/50 shadow-[0_0_20px_rgba(244,63,94,0.15)]" : "bg-[#111822] border-slate-800 hover:border-slate-600"}`}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-4 h-4 rounded-full bg-rose-500"></div>
                    <span className="text-lg font-bold text-white">Aggressive</span>
                  </div>
                  <p className="text-sm text-slate-400 pl-7">Higher risk, more frequent trading. Seeks maximum returns and tolerates higher volatility.</p>
                </div>
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-6 animate-fade-in h-full flex flex-col">
              {!isInitializing ? (
                <>
                  <h3 className="text-2xl font-bold text-white mb-2 text-center">Ready to Initialize</h3>
                  <p className="text-slate-400 text-center mb-8">Review your autonomous trading configuration.</p>
                  
                  <div className="bg-[#111822] border border-indigo-500/30 rounded-xl p-6 grid grid-cols-2 gap-y-6 gap-x-8">
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Trading Capital</div>
                      <div className="text-xl font-bold text-white">${budget}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Risk Profile</div>
                      <div className={`text-lg font-bold ${riskLevel === 'Conservative' ? 'text-emerald-400' : riskLevel === 'Balanced' ? 'text-amber-400' : 'text-rose-400'}`}>{riskLevel}</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Active AI Agents</div>
                      <div className="text-lg font-bold text-white flex items-center gap-2"><Cpu size={16} className="text-indigo-400"/> 8 Agents</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Calculation Engines</div>
                      <div className="text-lg font-bold text-white flex items-center gap-2"><Activity size={16} className="text-indigo-400"/> 25 Active</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Market Monitoring</div>
                      <div className="text-sm font-bold text-white">24/7 Continuous</div>
                    </div>
                    <div>
                      <div className="text-[10px] text-slate-500 uppercase tracking-widest font-bold mb-1">Risk Protection</div>
                      <div className="text-sm font-bold text-emerald-400">Enabled (Auto)</div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center flex-1 py-10">
                  <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-8"></div>
                  <h3 className="text-xl font-bold text-white mb-6">Initializing Autonomous Trading...</h3>
                  <div className="w-full max-w-sm space-y-3">
                    {initSteps.map((s, idx) => (
                      <div key={idx} className="flex items-center gap-3">
                        {idx < initStep ? (
                          <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
                        ) : idx === initStep ? (
                          <div className="w-4 h-4 rounded-full border-2 border-indigo-500 border-t-transparent animate-spin shrink-0"></div>
                        ) : (
                          <div className="w-4 h-4 rounded-full border-2 border-slate-700 shrink-0"></div>
                        )}
                        <span className={`text-sm ${idx < initStep ? "text-slate-300" : idx === initStep ? "text-white font-bold" : "text-slate-600"}`}>
                          {s}
                        </span>
                      </div>
                    ))}
                    {initStep >= initSteps.length && (
                      <div className="text-center pt-4 text-emerald-400 font-bold uppercase tracking-widest text-sm animate-pulse">
                        System Ready
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {!isInitializing && (
          <div className="bg-[#111822] p-6 border-t border-slate-800 flex justify-between items-center">
            {step > 1 ? (
              <button 
                onClick={() => setStep(step - 1)}
                className="px-6 py-2.5 rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 font-bold text-sm transition-colors"
              >
                Back
              </button>
            ) : (
              <div></div>
            )}
            
            {step < 4 ? (
              <button 
                onClick={() => setStep(step + 1)}
                className="px-6 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm transition-colors flex items-center gap-2 shadow-[0_0_15px_rgba(99,102,241,0.3)]"
              >
                Continue <ChevronRight size={16} />
              </button>
            ) : (
              <button 
                onClick={handleInitialize}
                className="px-8 py-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm uppercase tracking-wider transition-colors shadow-[0_0_20px_rgba(16,185,129,0.4)]"
              >
                Initialize Autonomous Trading
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
