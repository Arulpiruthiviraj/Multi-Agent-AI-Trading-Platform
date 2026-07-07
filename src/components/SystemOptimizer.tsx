import React, { useState, useEffect, useRef } from "react";
import { 
  ShieldCheck, Terminal, Scale, Activity, Database, Zap, Sparkles, 
  Settings, AlertTriangle, CheckCircle2, Play, RefreshCw, BarChart2 
} from "lucide-react";

export default function SystemOptimizer() {
  // === MODULE 1: DUAL-ENGINE VALIDATOR STATE ===
  const [aiPrediction, setAiPrediction] = useState("Strong Buy (95% Confidence)");
  const [localRSI, setLocalRSI] = useState(72);
  const [localMACD, setLocalMACD] = useState("Bearish Crossover");
  const [localVWAP, setLocalVWAP] = useState("Price 5% Above VWAP");
  const [localATR, setLocalATR] = useState(4.50); // ATR in dollars
  const [orderSize, setOrderSize] = useState(3500); // Order size in shares
  const [volatility, setVolatility] = useState(3.2); // Volatility %
  
  const [isValidating, setIsValidating] = useState(false);
  const [validationResult, setValidationResult] = useState<null | string>(null);

  // Calculated Dual-Engine Stats
  const basePrice = 150; // Reference price of target asset
  const stopLossDistance = 2 * localATR; // Stop loss is 2 * ATR
  const maxRiskCapital = 50000; // Account size
  const riskLimitPct = 1.5; // Max account risk pct per trade
  const maxAllowedRiskDollar = maxRiskCapital * (riskLimitPct / 100); // $750 max risk
  
  // Volatility adjusted size cap
  const maxSizingCap = Math.floor(maxAllowedRiskDollar / stopLossDistance);
  const totalNotional = orderSize * basePrice;
  const isSizeViolated = orderSize > maxSizingCap;

  // Slippage Calculation
  // Slippage = (Order Size / Average Daily Volume) * Volatility * Spot Price
  const averageDailyVolume = 1200000; // 1.2M shares reference ADV
  const rawSlippagePct = (orderSize / averageDailyVolume) * (volatility / 100);
  const totalSlippageCost = rawSlippagePct * totalNotional;

  const runDualEngineValidation = () => {
    setIsValidating(true);
    setValidationResult(null);
    
    setTimeout(() => {
      let feedback = [];
      const isBuy = aiPrediction.includes("Buy");
      const isStrong = aiPrediction.includes("Strong");

      feedback.push(`ℹ️ **Volatility Baseline**: ATR is \$${localATR.toFixed(2)}. Calculated volatility risk stop distance (2x ATR) is \$${stopLossDistance.toFixed(2)}.`);
      feedback.push(`ℹ️ **Adaptive Sizing Cap**: Based on \$${maxAllowedRiskDollar} maximum allowable risk capital (1.5% of Portfolio), the absolute safety cap is ${maxSizingCap.toLocaleString()} shares.`);

      if (isSizeViolated) {
        feedback.push(`🚫 **TRADE SIZING BLOCKED**: Requested order size of ${orderSize.toLocaleString()} shares exceeds your adaptive volatility safety cap of ${maxSizingCap.toLocaleString()} shares. Sizing has been forced-capped at ${maxSizingCap.toLocaleString()} to protect capital.`);
      } else {
        feedback.push(`✅ **Sizing Cleared**: Requested ${orderSize.toLocaleString()} shares is within safe risk boundaries.`);
      }

      feedback.push(`📊 **Slippage Impact**: Execution slippage is calculated at ${(rawSlippagePct * 100).toFixed(4)}% due to volume/depth ratios. Est. Slippage Cost: \$${totalSlippageCost.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}.`);

      if (isBuy) {
        if (localRSI >= 70) {
          feedback.push(`🚫 **TRADE BLOCKED**: AI suggested "Buy", but deterministic local RSI is ${localRSI} (Overbought limit is >70). Local gating vetoed order to prevent buying cyclical top.`);
        } else {
          feedback.push(`✅ **RSI Cleared**: Local RSI of ${localRSI} is within healthy trend limits.`);
        }

        if (localMACD === "Bearish Crossover") {
          feedback.push(`🚫 **TRADE BLOCKED**: AI suggested "Buy", but local MACD shows Bearish Crossover. Dynamic price momentum is actively decelerating.`);
        } else {
          feedback.push(`✅ **MACD Cleared**: Current MACD supports upward trend direction.`);
        }

        if (localVWAP.includes("Above")) {
          feedback.push(`⚠️ **WARNING**: Spot Price is significantly above VWAP. Entering at a premium intraday. Proceeding with caution.`);
        } else {
          feedback.push(`✅ **VWAP Cleared**: Price is near or below VWAP support.`);
        }
      } else {
        // Sell logic gating
        if (localRSI <= 30) {
          feedback.push(`🚫 **TRADE BLOCKED**: AI suggested "Sell", but local RSI is ${localRSI} (Oversold limit is <30). Vetoed to prevent selling at a historical bottom.`);
        } else {
          feedback.push(`✅ **RSI Cleared**: Local RSI of ${localRSI} suggests room for exit execution.`);
        }

        if (localMACD === "Bullish Crossover") {
          feedback.push(`🚫 **TRADE BLOCKED**: AI suggested "Sell/Short", but local MACD shows Bullish Crossover. Active price momentum is swinging upward.`);
        } else {
          feedback.push(`✅ **MACD Cleared**: MACD confirms bearish bias.`);
        }
      }

      // Check for absolute approval
      const hasBlockers = feedback.some(f => f.includes("BLOCKED"));
      if (!hasBlockers) {
        feedback.push(`🚀 **TRADE DUAL-APPROVED**: Probabilistic AI prediction has been successfully cross-verified and authorized by local deterministic parameters.`);
      }

      setValidationResult(feedback.join("\n"));
      setIsValidating(false);
    }, 1200);
  };


  // === MODULE 2: HIGH-CONCURRENCY BACKEND SIMULATOR ===
  const [dbPoolMax, setDbPoolMax] = useState(50);
  const [dbTimeoutMs, setDbTimeoutMs] = useState(10000);
  const [syncInterval, setSyncInterval] = useState(15); // seconds
  const [simulationSpeed, setSimulationSpeed] = useState(5); // ticks per second (stress factor)
  const [syncMode, setSyncMode] = useState<"ASYNCHRONOUS" | "SYNCHRONOUS">("ASYNCHRONOUS");

  // Dynamic system meters (change during stress test)
  const [eventLoopLag, setEventLoopLag] = useState(1.2);
  const [dbPoolUtilization, setDbPoolUtilization] = useState(15);
  const [apiConcurrency, setApiConcurrency] = useState(4);
  const [queryLatency, setQueryLatency] = useState(8);
  const [successfulRequests, setSuccessfulRequests] = useState(100);
  const [failedRequests, setFailedRequests] = useState(0);
  const [isStressTesting, setIsStressTesting] = useState(false);
  const [logMessages, setLogMessages] = useState<string[]>([
    "System running optimally. Idle connection pools warmed.",
    "Asynchronous Cache synchronizer active (interval: 15s)."
  ]);

  const testTimerRef = useRef<NodeJS.Timeout | null>(null);

  const startStressTest = () => {
    if (isStressTesting) {
      stopStressTest();
      return;
    }
    setIsStressTesting(true);
    setSuccessfulRequests(100);
    setFailedRequests(0);
    setLogMessages(prev => [`[${new Date().toLocaleTimeString()}] 🚀 CONCURRENCY STRESS TEST TRIGGERED. Initiating continuous LLM and database load...`, ...prev]);
  };

  const stopStressTest = () => {
    setIsStressTesting(false);
    if (testTimerRef.current) {
      clearInterval(testTimerRef.current);
      testTimerRef.current = null;
    }
    setEventLoopLag(1.2);
    setDbPoolUtilization(10);
    setApiConcurrency(2);
    setQueryLatency(8);
    setLogMessages(prev => [`[${new Date().toLocaleTimeString()}] 🛑 Stress test completed. State returned to idle equilibrium.`, ...prev]);
  };

  useEffect(() => {
    if (!isStressTesting) return;

    testTimerRef.current = setInterval(() => {
      // Calculate dynamic values based on settings
      const stressFactor = simulationSpeed; // Higher speed = more load
      
      // If SYNCHRONOUS, each write blocks and holds a connection. 
      // If pool is small, connections exhaust and query latency spikes.
      const syncPenalty = syncMode === "SYNCHRONOUS" ? 4.5 : 1.0;
      const poolExhaustionLimit = dbPoolMax;

      const activeConns = Math.min(
        poolExhaustionLimit, 
        Math.floor(Math.random() * 15 * stressFactor * syncPenalty) + 5
      );

      setDbPoolUtilization(activeConns);

      // API Concurrency varies randomly simulating 3 agents (Proposer, Risk, Reflection)
      const currentApiThreads = Math.floor(Math.random() * 4) + Math.floor(stressFactor / 2) + 1;
      setApiConcurrency(currentApiThreads);

      // Connection choke check
      let droppedPct = 0;
      let latency = 8 + (activeConns / poolExhaustionLimit) * 50 * syncPenalty;
      
      if (activeConns >= poolExhaustionLimit) {
        latency += 200; // Extreme connection pool queuing delay
        droppedPct = 0.35 * (syncMode === "SYNCHRONOUS" ? 2 : 1);
        if (dbTimeoutMs < 5000) {
          droppedPct += 0.25; // Strict quick timeouts under heavy load cause drops
        }
      }

      setQueryLatency(Math.round(latency));

      // Event Loop lag spikes when blocked by synchronous DB processes or high latency queues
      const targetLag = 1.2 + (syncMode === "SYNCHRONOUS" ? (stressFactor * 4.8) + (latency / 12) : (stressFactor * 0.4) + (latency / 80));
      setEventLoopLag(parseFloat(targetLag.toFixed(2)));

      // Random logs
      const randomSymbol = ["TSLA", "NVDA", "AAPL", "BTC", "ETH"][Math.floor(Math.random() * 5)];
      const isDropped = Math.random() < droppedPct;

      if (isDropped) {
        setFailedRequests(prev => prev + 1);
        setLogMessages(prev => [
          `[${new Date().toLocaleTimeString()}] ❌ DB_POOL_EXHAUSTED: Request for ${randomSymbol} state write failed. Connections active: ${activeConns}/${poolExhaustionLimit}.`,
          ...prev.slice(0, 15)
        ]);
      } else {
        setSuccessfulRequests(prev => prev + 1);
        if (Math.random() < 0.3) {
          setLogMessages(prev => [
            `[${new Date().toLocaleTimeString()}] ⚡ Agent consensus complete on ${randomSymbol}. State written successfully in ${Math.round(latency)}ms.`,
            ...prev.slice(0, 15)
          ]);
        }
      }
    }, 400);

    return () => {
      if (testTimerRef.current) clearInterval(testTimerRef.current);
    };
  }, [isStressTesting, dbPoolMax, dbTimeoutMs, syncMode, simulationSpeed]);

  useEffect(() => {
    return () => {
      if (testTimerRef.current) clearInterval(testTimerRef.current);
    };
  }, []);

  // System Status Label
  let systemStatusText = "OPTIMAL";
  let systemStatusColor = "text-emerald-400 border-emerald-500/20 bg-emerald-500/10";
  if (eventLoopLag > 80 || queryLatency > 150) {
    systemStatusText = "EVENT LOOP BLOCKED";
    systemStatusColor = "text-rose-400 border-rose-500/20 bg-rose-500/10 animate-pulse";
  } else if (dbPoolUtilization >= dbPoolMax * 0.85) {
    systemStatusText = "POOL EXHAUSTION DANGER";
    systemStatusColor = "text-amber-400 border-amber-500/20 bg-amber-500/10 animate-pulse";
  } else if (isStressTesting) {
    systemStatusText = "LOAD TESTING ACTIVE";
    systemStatusColor = "text-indigo-400 border-indigo-500/20 bg-indigo-500/10";
  }

  return (
    <div className="animate-fade-in flex flex-col gap-6">
      {/* SECTION 1: DUAL ENGINE ARCHITECTURE SIMULATOR */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <div className="flex items-center justify-between mb-4 border-b border-slate-800 pb-4">
          <h2 className="text-sm font-bold text-white flex items-center gap-2 tracking-widest uppercase font-mono">
            <ShieldCheck className="text-emerald-400" size={18} />
            Dual-Engine Volatility & Gating Simulator
          </h2>
          <button 
            onClick={runDualEngineValidation} 
            disabled={isValidating}
            className={`px-4 py-2 text-[10px] font-mono font-black uppercase tracking-widest rounded border transition-all cursor-pointer ${
              isValidating 
                ? 'bg-slate-700/20 border-slate-700 text-slate-500' 
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 hover:border-emerald-500'
            }`}
          >
            {isValidating ? "Validating..." : "Execute Validation Run"}
          </button>
        </div>
        
        <p className="text-xs text-slate-400 mb-6 leading-relaxed max-w-3xl">
          Protects your terminal by combining probabilistic AI predictions with local, hard-coded volatility rules (ATR, RSI, MACD). If volatility spikes, the math engine automatically widens stops, caps order sizes, and blocks momentum-chasing trades.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column: UI Inputs */}
          <div className="flex flex-col gap-4">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-800/80 pb-2 flex items-center gap-1.5 font-mono">
              <Sparkles size={11} className="text-indigo-400" /> Probabilistic AI Signal
            </h3>
            
            <div className="flex flex-col">
              <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest mb-1">AI Agent Prediction Intent</label>
              <select 
                value={aiPrediction} 
                onChange={(e) => setAiPrediction(e.target.value)}
                className="bg-[#0A0F16] border border-slate-800 text-xs font-bold text-indigo-400 rounded px-3 py-2 outline-none focus:border-indigo-500/50 font-mono"
              >
                <option>Strong Buy (95% Confidence)</option>
                <option>Buy (62% Confidence)</option>
                <option>Strong Sell (85% Confidence)</option>
              </select>
            </div>

            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-800/80 pb-2 mt-2 flex items-center gap-1.5 font-mono">
              <Scale size={11} className="text-emerald-400" /> Local Deterministic Math Engine
            </h3>

            {/* RSI Slider */}
            <div className="flex flex-col">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">Local 14-period RSI</label>
                <span className="text-xs font-bold font-mono text-slate-300 bg-[#0A0F16] border border-slate-800 px-2 py-0.5 rounded">{localRSI}</span>
              </div>
              <input 
                type="range"
                min="10" max="90"
                value={localRSI}
                onChange={(e) => setLocalRSI(parseInt(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="text-[9px] font-mono mt-1 flex justify-between text-slate-500">
                <span className="text-emerald-500/80">Oversold &lt;30</span>
                <span className="text-rose-500/80">Overbought &gt;70</span>
              </div>
            </div>

            {/* ATR Input */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">Average True Range (ATR)</label>
                  <span className="text-[11px] font-bold font-mono text-emerald-400">\${localATR.toFixed(2)}</span>
                </div>
                <input 
                  type="range"
                  min="0.5" max="15" step="0.25"
                  value={localATR}
                  onChange={(e) => setLocalATR(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>

              <div className="flex flex-col">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest font-bold">ATR STOP LOSS (2x ATR)</label>
                  <span className="text-[11px] font-bold font-mono text-rose-400">\${stopLossDistance.toFixed(2)}</span>
                </div>
                <div className="bg-[#0A0F16] border border-slate-800 rounded px-3 py-1.5 text-xs text-slate-400 font-mono text-center">
                  Stop Margin: <span className="text-white font-black">-{((stopLossDistance/basePrice)*100).toFixed(1)}%</span>
                </div>
              </div>
            </div>

            {/* MACD & VWAP select options */}
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest mb-1">Local MACD (12/26)</label>
                <select 
                  value={localMACD} 
                  onChange={(e) => setLocalMACD(e.target.value)}
                  className="bg-[#0A0F16] border border-slate-800 text-xs font-mono font-bold text-slate-300 rounded px-3 py-2 outline-none focus:border-emerald-500/50"
                >
                  <option>Bullish Crossover</option>
                  <option>Bearish Crossover</option>
                  <option>Neutral Convergence</option>
                </select>
              </div>

              <div className="flex flex-col">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest mb-1">Intraday VWAP Pivot</label>
                <select 
                  value={localVWAP} 
                  onChange={(e) => setLocalVWAP(e.target.value)}
                  className="bg-[#0A0F16] border border-slate-800 text-xs font-mono font-bold text-slate-300 rounded px-3 py-2 outline-none focus:border-emerald-500/50"
                >
                  <option>Price 5% Below VWAP</option>
                  <option>Price on VWAP</option>
                  <option>Price 5% Above VWAP</option>
                </select>
              </div>
            </div>

            {/* Sizing & Slippage Inputs */}
            <div className="grid grid-cols-2 gap-4 border-t border-slate-800/80 pt-4 mt-2">
              <div className="flex flex-col">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">Order Size (Shares)</label>
                  <span className="text-[11px] font-mono font-bold text-indigo-400">{orderSize.toLocaleString()} shs</span>
                </div>
                <input 
                  type="range"
                  min="500" max="10000" step="100"
                  value={orderSize}
                  onChange={(e) => setOrderSize(parseInt(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>

              <div className="flex flex-col">
                <div className="flex justify-between items-center mb-1">
                  <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">Asset Volatility</label>
                  <span className="text-[11px] font-mono font-bold text-indigo-400">{volatility.toFixed(1)}%</span>
                </div>
                <input 
                  type="range"
                  min="0.5" max="8" step="0.1"
                  value={volatility}
                  onChange={(e) => setVolatility(parseFloat(e.target.value))}
                  className="w-full accent-indigo-500"
                />
              </div>
            </div>

          </div>

          {/* Right Column: Decisions Console */}
          <div className="bg-[#0A0F16] rounded border border-slate-800 p-5 flex flex-col relative overflow-hidden">
            <h3 className="text-xs uppercase tracking-widest text-slate-500 font-bold mb-4 flex items-center gap-2 font-mono">
              <Terminal size={14} className="text-emerald-400" /> Local Guardrail Output Console
            </h3>
            
            {validationResult === null && !isValidating ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-500 text-xs font-mono text-center py-12 px-6">
                <Scale size={36} className="mb-4 opacity-50 text-indigo-400 animate-pulse" />
                <span>Adjust deterministic indicator parameters on the left and click <span className="text-emerald-400 font-bold">"Execute Validation Run"</span> to trigger the gating protocol logic.</span>
              </div>
            ) : isValidating ? (
              <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-4 py-16">
                <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin"></div>
                <span className="text-xs font-mono animate-pulse uppercase tracking-widest text-slate-300">Evaluating Signal Discrepancies...</span>
              </div>
            ) : (
              <div className="flex-1 flex flex-col animate-fade-in gap-4">
                <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                  <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono font-bold">Execution Verdict</span>
                  <span className={`text-sm font-black font-mono px-2 py-0.5 rounded border ${validationResult?.includes("BLOCKED") ? 'text-rose-400 bg-rose-500/10 border-rose-500/20' : 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'}`}>
                    {validationResult?.includes("BLOCKED") ? '🚫 VETOED & BLOCKED' : '✅ ORDER CLEARED'}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar space-y-2.5 max-h-[290px]">
                  {validationResult?.split('\n').filter(Boolean).map((line, idx) => {
                     const isVeto = line.includes("BLOCKED");
                     const isWarn = line.includes("WARNING");
                     const isPass = line.includes("✅");
                     return (
                       <div key={idx} className={`text-[10.5px] leading-relaxed font-mono p-3 rounded border ${isVeto ? 'bg-rose-950/20 border-rose-500/30 text-rose-300' : isWarn ? 'bg-amber-950/20 border-amber-500/25 text-amber-300' : isPass ? 'bg-emerald-950/20 border-emerald-500/25 text-emerald-300' : 'bg-slate-900/40 border-slate-800 text-slate-300'}`}>
                         {line}
                       </div>
                     );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* SECTION 2: HIGH-CONCURRENCY BACKEND OPTIMIZATION SYSTEM */}
      <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-4 border-b border-slate-800 pb-4">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2 tracking-widest uppercase font-mono">
              <Database className="text-indigo-400" size={18} />
              High-Concurrency Engine & Pool Optimizer
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed mt-1">
              Visualize and stress-test the balance between LLM API concurrency, database connection pools, and background state synchronization.
            </p>
          </div>
          <button
            onClick={startStressTest}
            className={`px-4 py-2 text-[10px] font-mono font-black uppercase tracking-widest rounded border transition-all cursor-pointer flex items-center gap-2 ${
              isStressTesting
                ? "bg-rose-500/10 border-rose-500/40 text-rose-400 hover:bg-rose-500/20"
                : "bg-indigo-500/10 border-indigo-500/30 text-indigo-400 hover:bg-indigo-500/20"
            }`}
          >
            <Zap size={12} className={isStressTesting ? "animate-bounce text-rose-400" : "text-indigo-400"} />
            {isStressTesting ? "HALT STRESS TEST" : "TRIGGER STRESS TEST"}
          </button>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          {/* Controls Panel */}
          <div className="bg-[#0A0F16] rounded border border-slate-800 p-4 flex flex-col gap-4">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-850 pb-2 font-mono flex items-center gap-1">
              <Settings size={12} /> Optimization Tuners
            </h3>

            {/* Sync Mode */}
            <div className="flex flex-col">
              <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest mb-1">State Sync Strategy</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setSyncMode("ASYNCHRONOUS")}
                  className={`px-3 py-1.5 text-[9px] font-mono font-black rounded border transition-all ${
                    syncMode === "ASYNCHRONOUS"
                      ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-400"
                      : "bg-[#111822]/40 border-slate-800 text-slate-500 hover:text-slate-350"
                  }`}
                >
                  ASYNCHRONOUS FLUSH
                </button>
                <button
                  onClick={() => setSyncMode("SYNCHRONOUS")}
                  className={`px-3 py-1.5 text-[9px] font-mono font-black rounded border transition-all ${
                    syncMode === "SYNCHRONOUS"
                      ? "bg-rose-500/10 border-rose-500/40 text-rose-400"
                      : "bg-[#111822]/40 border-slate-800 text-slate-500 hover:text-slate-350"
                  }`}
                >
                  SYNCHRONOUS WRITE
                </button>
              </div>
              <p className="text-[9px] text-slate-500 font-mono mt-1 text-center leading-normal">
                {syncMode === "ASYNCHRONOUS" 
                  ? "Flushes in-memory cache to DB every 15s. Light execution overhead."
                  : "Writes directly to database on every tick. Locks pools on high load."}
              </p>
            </div>

            {/* Connection Pool Slider */}
            <div className="flex flex-col">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">DB_POOL_MAX (Pool Limit)</label>
                <span className="text-[11px] font-mono font-bold text-slate-300">{dbPoolMax} conns</span>
              </div>
              <input
                type="range"
                min="5" max="100" step="5"
                value={dbPoolMax}
                onChange={(e) => setDbPoolMax(parseInt(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>

            {/* Query Idle Timeout Slider */}
            <div className="flex flex-col">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">DB_IDLE_TIMEOUT_MS</label>
                <span className="text-[11px] font-mono font-bold text-slate-300">{dbTimeoutMs} ms</span>
              </div>
              <input
                type="range"
                min="1000" max="30000" step="1000"
                value={dbTimeoutMs}
                onChange={(e) => setDbTimeoutMs(parseInt(e.target.value))}
                className="w-full accent-indigo-500"
              />
            </div>

            {/* Sync Cache Interval */}
            <div className="flex flex-col">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[9px] text-slate-500 font-mono uppercase tracking-widest">Sync Flush Interval</label>
                <span className="text-[11px] font-mono font-bold text-slate-300">{syncInterval}s</span>
              </div>
              <input
                type="range"
                min="5" max="60" step="5"
                value={syncInterval}
                onChange={(e) => setSyncInterval(parseInt(e.target.value))}
                className="w-full accent-indigo-500"
                disabled={syncMode === "SYNCHRONOUS"}
              />
            </div>

            {/* Stress Factor (Simulation Speed) */}
            <div className="flex flex-col pt-2 border-t border-slate-850">
              <div className="flex justify-between items-center mb-1">
                <label className="text-[9px] text-rose-400 font-mono uppercase tracking-widest font-black">STRESS LOAD FREQUENCY</label>
                <span className="text-[11px] font-mono font-bold text-rose-400">{simulationSpeed} Hz</span>
              </div>
              <input
                type="range"
                min="1" max="10" step="1"
                value={simulationSpeed}
                onChange={(e) => setSimulationSpeed(parseInt(e.target.value))}
                className="w-full accent-rose-500"
              />
            </div>
          </div>

          {/* Real-time Dashboard Indicators */}
          <div className="bg-[#0A0F16] rounded border border-slate-800 p-4 flex flex-col gap-4">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-850 pb-2 font-mono flex items-center justify-between">
              <span className="flex items-center gap-1"><Activity size={12} /> Live Engine telemetry</span>
              <span className={`text-[9px] border px-1.5 py-0.5 rounded font-black ${systemStatusColor}`}>{systemStatusText}</span>
            </h3>

            {/* Event Loop Lag */}
            <div className="bg-[#111822] p-3 rounded border border-slate-850 flex items-center justify-between">
              <div>
                <div className="text-[8px] text-slate-500 font-mono uppercase tracking-widest">Node.js Event Loop Lag</div>
                <div className="text-xl font-bold font-mono text-white mt-0.5">{eventLoopLag} ms</div>
              </div>
              <div className="text-right">
                <div className="text-[8px] text-slate-500 font-mono uppercase tracking-widest">Performance</div>
                <span className={`text-[10px] font-bold font-mono ${eventLoopLag > 50 ? "text-rose-400" : eventLoopLag > 15 ? "text-amber-400" : "text-emerald-400"}`}>
                  {eventLoopLag > 50 ? "⚠️ SEVERELY BLOCKED" : eventLoopLag > 15 ? "MODERATE LAG" : "EXCELLENT"}
                </span>
              </div>
            </div>

            {/* Database Pool Utilization Bar */}
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between text-[9px] font-mono text-slate-500">
                <span>DB Connections Active</span>
                <span>{dbPoolUtilization} / {dbPoolMax} conns ({Math.round((dbPoolUtilization/dbPoolMax)*100)}%)</span>
              </div>
              <div className="h-2.5 bg-slate-850/60 rounded-full overflow-hidden flex">
                <div 
                  className={`h-full transition-all duration-300 ${
                    dbPoolUtilization >= dbPoolMax * 0.85 
                      ? "bg-rose-500 animate-pulse" 
                      : dbPoolUtilization >= dbPoolMax * 0.6 
                        ? "bg-amber-400" 
                        : "bg-emerald-400"
                  }`} 
                  style={{ width: `${Math.min(100, (dbPoolUtilization / dbPoolMax) * 100)}%` }}
                ></div>
              </div>
            </div>

            {/* Thread Concurrency Count */}
            <div className="flex flex-col gap-1.5 pt-2 border-t border-slate-850">
              <div className="flex justify-between text-[9px] font-mono text-slate-500">
                <span>Active Gemini API Tasks</span>
                <span>{apiConcurrency} Threads concurrent</span>
              </div>
              <div className="flex gap-1.5">
                {Array.from({ length: 10 }).map((_, i) => (
                  <div 
                    key={i} 
                    className={`flex-1 h-3 rounded transition-colors ${
                      i < apiConcurrency 
                        ? "bg-indigo-500 shadow-[0_0_8px_rgba(99,102,241,0.5)] animate-pulse" 
                        : "bg-slate-850"
                    }`}
                  ></div>
                ))}
              </div>
            </div>

            {/* Query Execution Latency */}
            <div className="bg-[#111822] p-3 rounded border border-slate-850 flex items-center justify-between">
              <div>
                <div className="text-[8px] text-slate-500 font-mono uppercase tracking-widest font-bold">Query Execution Latency</div>
                <div className="text-xl font-bold font-mono text-white mt-0.5">{queryLatency} ms</div>
              </div>
              <div className="text-right">
                <div className="text-[8px] text-slate-500 font-mono uppercase tracking-widest font-bold">Health Status</div>
                <span className={`text-[10px] font-bold font-mono ${queryLatency > 150 ? "text-rose-400 animate-pulse" : queryLatency > 40 ? "text-amber-400" : "text-emerald-400"}`}>
                  {queryLatency > 150 ? "❌ SOCKET QUEUE CHOKE" : queryLatency > 40 ? "QUEUEING LATENCY" : "HEALTHY"}
                </span>
              </div>
            </div>

            {/* Connection Success/Failure count */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="bg-emerald-500/5 border border-emerald-500/10 p-2.5 rounded text-center">
                <div className="text-[8px] text-emerald-400/70 font-mono uppercase tracking-widest font-bold">Successful Writes</div>
                <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">{successfulRequests}</div>
              </div>
              <div className="bg-rose-500/5 border border-rose-500/10 p-2.5 rounded text-center">
                <div className="text-[8px] text-rose-400/70 font-mono uppercase tracking-widest font-bold">Dropped Requests</div>
                <div className="text-lg font-bold font-mono text-rose-400 mt-0.5">{failedRequests}</div>
              </div>
            </div>
          </div>

          {/* Telemetry Logger */}
          <div className="bg-[#0A0F16] rounded border border-slate-800 p-4 flex flex-col relative overflow-hidden h-[330px]">
            <h3 className="text-[10px] uppercase tracking-widest text-slate-500 font-bold border-b border-slate-850 pb-2 font-mono flex items-center gap-1">
              <Terminal size={12} /> Optimization Live Events
            </h3>

            <div className="flex-1 overflow-y-auto pr-1.5 mt-2 space-y-2.5 custom-scrollbar text-[10px] font-mono leading-relaxed">
              {logMessages.map((msg, i) => {
                const isErr = msg.includes("❌");
                const isSucc = msg.includes("⚡") || msg.includes("🚀");
                const isWarn = msg.includes("⚠️") || msg.includes("🛑");
                return (
                  <div 
                    key={i} 
                    className={`p-2 rounded border transition-colors ${
                      isErr 
                        ? "bg-rose-500/5 border-rose-500/15 text-rose-300" 
                        : isSucc 
                          ? "bg-indigo-500/5 border-indigo-500/15 text-indigo-300" 
                          : isWarn 
                            ? "bg-amber-500/5 border-amber-500/15 text-amber-300"
                            : "bg-slate-900/40 border-slate-850 text-slate-400"
                    }`}
                  >
                    {msg}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
