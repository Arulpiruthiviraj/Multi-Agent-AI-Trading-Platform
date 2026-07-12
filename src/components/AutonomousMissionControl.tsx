import React, { useState, useEffect } from "react";
import {
  BrainCircuit,
  Sliders,
  ShieldCheck,
  HelpCircle,
  Activity,
  TrendingUp,
  BarChart3,
  Terminal,
  Play,
  Pause,
  SkipForward,
  SkipBack,
  Download,
  RefreshCw,
  Layers,
  Award,
  Target,
  Landmark,
  AlertCircle,
  Sparkles,
  BookOpen,
  UserCheck,
  Flame,
  History,
  Scale,
  Percent,
  Search,
  Filter,
  ArrowRight,
  Maximize2,
  ChevronDown,
  X,
  Gauge,
  Compass
} from "lucide-react";

interface AutonomousMissionControlProps {
  autoBotConfig: any;
  toggleAutoBot: () => Promise<void>;
  onClose: () => void;
  enginesHalted: boolean;
  setEnginesHalted: (halted: boolean) => void;
  setHaltReason: (reason: string) => void;
  setHaltTime: (time: string) => void;
}

interface Strategy {
  name: string;
  returnPct: number;
  volatility: number;
  maxDrawdown: number;
  winRate: number;
  active: boolean;
}

export function AutonomousMissionControl({
  autoBotConfig,
  toggleAutoBot,
  onClose,
  enginesHalted,
  setEnginesHalted,
  setHaltReason,
  setHaltTime
}: AutonomousMissionControlProps) {
  // Global View Configurations (Feature 19)
  const [tradingMode, setTradingMode] = useState<"BEGINNER" | "ASSISTED" | "AUTONOMOUS" | "HEDGE_FUND">("AUTONOMOUS");
  const [isBeginnerExplanation, setIsBeginnerExplanation] = useState<boolean>(false);
  const [activeSubTab, setActiveSubTab] = useState<"cio" | "scanner" | "tactical" | "arena" | "journal">("cio");

  // === CHIEF TRADER AGENT (CIO) DECK STATE ===
  const [cioTasks, setCioTasks] = useState<any[]>([
    { id: "task-1", agent: "Gemini Node", taskType: "Sentiment Harvesting", priority: "HIGH", status: "COMPLETED", findings: "Bullish retail momentum detected. Chat volume up 24% after hours on NVDA." },
    { id: "task-2", agent: "Technical Node", taskType: "Volatility Analysis", priority: "MEDIUM", status: "PROCESSING", findings: "Analyzing Bollinger Band width expansion on daily 1-hour candles." },
    { id: "task-3", agent: "Risk Node", taskType: "Correlation Mapping", priority: "CRITICAL", status: "COMPLETED", findings: "High asset-to-index correlation (0.87). Advise scaling back size of correlated bets." },
    { id: "task-4", agent: "Claude Node", taskType: "Regime Detection", priority: "LOW", status: "IDLE", findings: "Awaiting instructions." },
  ]);

  const [newTaskAgent, setNewTaskAgent] = useState<string>("Gemini Node");
  const [newTaskType, setNewTaskType] = useState<string>("Sentiment Harvesting");
  const [newTaskPriority, setNewTaskPriority] = useState<string>("HIGH");
  const [newTaskStatusMsg, setNewTaskStatusMsg] = useState<string>("");

  const [cioSelectedStrategy, setCioSelectedStrategy] = useState<string>("Volatility Breakout Core");
  const [strategyParameters, setStrategyParameters] = useState({
    riskMultiplier: 1.5,
    trendSensitivity: 75,
    minAtrFilter: 1.5,
    correlationLimit: 0.70,
  });

  // State to simulate the multi-layer decision veto
  const [customProposalSymbol, setCustomProposalSymbol] = useState<string>("TSLA");
  const [customProposalType, setCustomProposalType] = useState<"BUY" | "SELL">("BUY");
  const [customProposalPrice, setCustomProposalPrice] = useState<string>("185.50");
  const [customProposalReason, setCustomProposalReason] = useState<string>("Chasing breakout near $185 resistance");

  const [vetoPipelineStep, setVetoPipelineStep] = useState<number>(-1); // -1 = idle, 0 = sentiment check, 1 = ATR risk check, 2 = correlation check, 3 = CIO discretionary overlay, 4 = final outcome
  const [vetoPipelineResults, setVetoPipelineResults] = useState<any>({
    layer1: null, // Sentiment check (e.g. PASS, FAILED)
    layer2: null, // Hard ATR check
    layer3: null, // Correlation check
    layer4: null, // CIO final decision
    reasoning: "",
    status: "STANDBY" // "STANDBY", "EVALUATING", "VETOED", "APPROVED"
  });

  const [isProcessingCioTask, setIsProcessingCioTask] = useState<boolean>(false);


  // 1. AI CIO Configuration & Weights (Feature 1, 20)
  const [cioStrategyFocus, setCioStrategyFocus] = useState<string>("Balanced Growth");
  const [agentWeights, setAgentWeights] = useState({
    technical: 84,
    news: 79,
    risk: 93,
    claude: 82,
    chatgpt: 86,
    gemini: 80
  });

  // 2. 24/7 Scanner State (Feature 2)
  const [scanningStatus, setScanningStatus] = useState<string>("Idling");
  const [scannerSearchQuery, setScannerSearchQuery] = useState<string>("");
  const [scannedAssets, setScannedAssets] = useState<any[]>([
    { symbol: "NVDA", assetClass: "Stock", matchScore: 91, reasons: ["Earnings momentum", "Institutional buying", "Technical breakout", "Positive AI news"] },
    { symbol: "TSLA", assetClass: "Stock", matchScore: 84, reasons: ["High relative volume", "Retail options flow buy-skew"] },
    { symbol: "BTC-USD", assetClass: "Crypto", matchScore: 88, reasons: ["MACD crossover on daily chart", "Support holding at $58,000"] },
    { symbol: "SPY", assetClass: "ETF", matchScore: 76, reasons: ["Passive inflow momentum", "Low implied volatility"] },
    { symbol: "AMD", assetClass: "Stock", matchScore: 68, reasons: ["Consolidating inside key range"] }
  ]);

  // 3. Trade Simulation State (Feature 9)
  const [simulatingAsset, setSimulatingAsset] = useState<string>("NVDA");
  const [isSimulating, setIsSimulating] = useState<boolean>(false);
  const [simResults, setSimResults] = useState<any | null>(null);

  // 4. Pre-Trade Checklist (Feature 4)
  const [checklistSymbol, setChecklistSymbol] = useState<string>("NVDA");
  const [checklistResults, setChecklistResults] = useState<any>({
    trend: true,
    volume: true,
    regime: true,
    news: true,
    earnings: true,
    riskReward: true,
    stopLossDefined: true,
    rewardRiskRatio: 2.4
  });

  // 5. Market Regime (Feature 5)
  const [marketRegime, setMarketRegime] = useState<"BULL" | "BEAR" | "VOLATILE">("BULL");
  const [regimeConfidence, setRegimeConfidence] = useState<number>(88);

  // 6. Custom Strategy Generator (Feature 14)
  const [userStrategyPrompt, setUserStrategyPrompt] = useState<string>("Find a high reward strategy for volatile crypto under $100 budget");
  const [generatedStrategy, setGeneratedStrategy] = useState<any | null>(null);
  const [isGeneratingStrategy, setIsGeneratingStrategy] = useState<boolean>(false);

  // 7. Replay / Decision Logs State (Feature 6, 7, 8, 10, 16)
  const [activeReplayId, setActiveReplayId] = useState<string>("TRD-2026-001");
  const [replayStep, setReplayStep] = useState<number>(-1); // -1 = standby, 0-6 = steps
  const [replaySpeed, setReplaySpeed] = useState<number>(1);
  const [isReplayPlaying, setIsReplayPlaying] = useState<boolean>(false);

  // 8. Live Log Viewer & Filters (Feature 12)
  const [logFilterComponent, setLogFilterComponent] = useState<string>("ALL");
  const [logFilterSeverity, setLogFilterSeverity] = useState<string>("ALL");
  const [logSearchQuery, setLogSearchQuery] = useState<string>("");
  const [isLogPaused, setIsLogPaused] = useState<boolean>(false);
  const [logsList, setLogsList] = useState<any[]>([
    { timestamp: "08:30:05", severity: "INFO", component: "CIO", text: "Chief Investment Officer active. Selected profile: Balanced Growth." },
    { timestamp: "08:31:12", severity: "SUCCESS", component: "Scanner", text: "24/7 Scanner detected unusual block institutional purchases on NVDA." },
    { timestamp: "08:31:15", severity: "INFO", component: "Regime", text: "Market Regime analysis locked in: Bull Market (88% confidence)." },
    { timestamp: "08:32:01", severity: "WARNING", component: "Devil's Advocate", text: "Bear Agent raises warning: Near resistance level of $185.00." },
    { timestamp: "08:32:04", severity: "SUCCESS", component: "Pre-Trade", text: "Pre-Trade Checklist complete: 7/7 requirements met successfully." },
    { timestamp: "08:32:10", severity: "SUCCESS", component: "Risk Manager", text: "Dynamic ATR Stop Loss calculated at $177.20. Capital allocated: 1.5%." },
    { timestamp: "08:32:15", severity: "SUCCESS", component: "Execution", text: "Hedge Fund Mode: Order routed & filled at $182.40." }
  ]);

  // 9. Trading Journal State (Feature 3, 17)
  const [journalEntries, setJournalEntries] = useState<any[]>([
    {
      id: "TRD-2026-001",
      symbol: "NVDA",
      entryPrice: 182.40,
      exitPrice: 188.50,
      pnl: 12.40,
      outcome: "Profit",
      strategy: "Momentum & Breakout",
      notes: "Clean support bounce off EMA 20 with volume verification. Exited early near short-term daily target.",
      coachFeedback: "Excellent discipline waiting for volume. However, you underestimated the strength of the breakout and could have trailed your stop-loss further for an extra 3% profit.",
      emotionRating: "Calm & Objective",
      checklistFailed: false
    },
    {
      id: "TRD-2026-002",
      symbol: "TSLA",
      entryPrice: 248.50,
      exitPrice: 238.22,
      pnl: -41.20,
      outcome: "Loss",
      strategy: "High Volatility Scalp",
      notes: "Tried to chase top near RSI of 78 without waiting for structural confirmation. Revenge scalp attempt.",
      coachFeedback: "Classic FOMO. Historically, 70% of your trades initiated with RSI > 75 fail. Avoid chasing breakouts in overheated markets.",
      emotionRating: "Impulsive / Overtrading",
      checklistFailed: true
    }
  ]);

  // Strategy Competition Arena (Feature 15)
  const [arenaStrategies, setArenaStrategies] = useState<Strategy[]>([
    { name: "Momentum Breakout", returnPct: 21.4, volatility: 14.2, maxDrawdown: 5.8, winRate: 64, active: true },
    { name: "Mean Reversion", returnPct: 12.1, volatility: 8.5, maxDrawdown: 4.1, winRate: 58, active: true },
    { name: "AI Generated (Low Capital Volatility)", returnPct: 27.5, volatility: 11.8, maxDrawdown: 6.2, winRate: 71, active: true },
    { name: "Hedge Fund Optimized Portfolio", returnPct: 34.2, volatility: 10.5, maxDrawdown: 3.9, winRate: 74, active: true }
  ]);

  // Handle live simulations for Trading Arena
  useEffect(() => {
    if (enginesHalted) return;
    const interval = setInterval(() => {
      // Small random P&L variations for Arena strategy stats
      setArenaStrategies(prev => prev.map(s => {
        if (!s.active) return s;
        const change = (Math.random() - 0.48) * 0.4;
        return {
          ...s,
          returnPct: parseFloat((s.returnPct + change).toFixed(2))
        };
      }));
    }, 5000);
    return () => clearInterval(interval);
  }, [enginesHalted]);

  // Trigger simulated trade pre-calculation
  const handleRunSimulation = () => {
    setIsSimulating(true);
    setTimeout(() => {
      setSimResults({
        probabilityProfit: 74,
        probabilityLoss: 26,
        expectedReturn: 6.84,
        riskRewardRatio: 2.5,
        targetPrice: 195.00,
        stopPrice: 177.20
      });
      setIsSimulating(false);
    }, 1500);
  };

  // Generate Custom Strategy
  const handleGenerateStrategy = () => {
    setIsGeneratingStrategy(true);
    setTimeout(() => {
      setGeneratedStrategy({
        name: "Low Capital Momentum Core",
        indicators: "RSI (40-60), VWAP Deviation < 1%, Price > 50 EMA",
        winRate: 68,
        historicalReturn: "18% annualized",
        bestAsset: "Crypto Assets (BTC, ETH, SOL)",
        ruleDescription: "Enter long when relative volume exceeds 2x and daily candles close above the 50-period Exponential Moving Average."
      });
      setIsGeneratingStrategy(false);
    }, 1800);
  };

  // Trigger dynamic stop loss calculation (Feature 8)
  const calculateDynamicStop = (symbol: string, currentPrice: number) => {
    const atrValue = 3.42;
    const supportLevel = currentPrice - 1.2 * atrValue;
    return supportLevel.toFixed(2);
  };

  // === NEW: CHIEF TRADER AGENT CIO HELPERS ===
  const handleDispatchCioTask = () => {
    if (isProcessingCioTask) return;
    setIsProcessingCioTask(true);
    setNewTaskStatusMsg("Dispatching quantitative query to Agent Council Nodes...");
    
    const id = `task-${Date.now()}`;
    const newTask = {
      id,
      agent: newTaskAgent,
      taskType: newTaskType,
      priority: newTaskPriority,
      status: "PROCESSING",
      findings: ""
    };
    
    setCioTasks(prev => [newTask, ...prev]);

    // Add log
    setLogsList(prev => [
      {
        timestamp: new Date().toTimeString().split(" ")[0],
        severity: "INFO",
        component: "CIO",
        text: `CIO assigned task [${newTaskType}] to ${newTaskAgent} (Priority: ${newTaskPriority}).`
      },
      ...prev
    ]);

    setTimeout(() => {
      let findingsMsg = "";
      switch (newTaskType) {
        case "Sentiment Harvesting":
          findingsMsg = `Harvested sentiment on target assets. Social heat index is moderate (58/100). No short squeeze threats detected.`;
          break;
        case "Volatility Analysis":
          findingsMsg = `14-day ATR for selected assets is healthy. Detected standard deviation levels inside 1-sigma historical boundaries.`;
          break;
        case "Regime Detection":
          findingsMsg = `Market structural shift indicators indicate continuation of current regime. No imminent macro trend reversal flags.`;
          break;
        case "Correlation Mapping":
          findingsMsg = `Asset correlation matrix checked. Broad equity sector correlation stands at 0.65, well within safe portfolio bounds.`;
          break;
        case "Order Flow Audit":
          findingsMsg = `Institutional block order sizes increased by 14% on support retests. Retail options buy-skew remains dominant.`;
          break;
        default:
          findingsMsg = `Analysis finished successfully. All key metrics are locked within nominal bounds.`;
      }

      setCioTasks(prev => prev.map(t => {
        if (t.id === id) {
          return { ...t, status: "COMPLETED", findings: findingsMsg };
        }
        return t;
      }));

      setLogsList(prev => [
        {
          timestamp: new Date().toTimeString().split(" ")[0],
          severity: "SUCCESS",
          component: newTaskAgent.replace(" Node", "").toUpperCase(),
          text: `${newTaskAgent} completed assigned research task: "${newTaskType}".`
        },
        ...prev
      ]);

      setNewTaskStatusMsg("Research task dispatched and compiled successfully!");
      setIsProcessingCioTask(false);
      setTimeout(() => setNewTaskStatusMsg(""), 3000);
    }, 2000);
  };

  const handleRunVetoEvaluation = (symbolPreset?: string) => {
    let symbol = customProposalSymbol;
    let type = customProposalType;
    let price = parseFloat(customProposalPrice) || 150;
    let reason = customProposalReason;

    if (symbolPreset === "TSLA") {
      symbol = "TSLA";
      type = "BUY";
      price = 248.50;
      reason = "FOMO: Chasing high daily breakout with RSI at 78 without waiting for retest.";
    } else if (symbolPreset === "SPY") {
      symbol = "SPY";
      type = "BUY";
      price = 520.00;
      reason = "Index Tracker: Hedging general market beta exposure. Correlation is highly locked to macro index.";
    } else if (symbolPreset === "NVDA") {
      symbol = "NVDA";
      type = "BUY";
      price = 182.40;
      reason = "Structural: Support bounce off EMA 20 on high volume. Healthy ATR-based stop-loss defined.";
    }

    setVetoPipelineStep(0);
    setVetoPipelineResults({
      layer1: "PENDING",
      layer2: "PENDING",
      layer3: "PENDING",
      layer4: "PENDING",
      reasoning: `Initiating multi-layer evaluation pipeline for ${type} ${symbol} at $${price}...`,
      status: "EVALUATING"
    });

    // 1. Layer 1: Sentiment Check
    setTimeout(() => {
      setVetoPipelineStep(1);
      const sentimentPass = !reason.toLowerCase().includes("fomo") && !reason.toLowerCase().includes("chasing");
      setVetoPipelineResults(prev => ({
        ...prev,
        layer1: sentimentPass ? "PASS" : "WARN",
        reasoning: sentimentPass 
          ? "Layer 1 (Sentiment): Retail and news sentiment consensus is positive (74% confidence)."
          : "Layer 1 (Sentiment): WARNING - Overheated sentiment or emotional chasing detected."
      }));

      // 2. Layer 2: Hard ATR Risk Ceiling
      setTimeout(() => {
        setVetoPipelineStep(2);
        // ATR check
        const atrValue = 3.42;
        const stopDistance = price * 0.05; // mock stop loss distance (5%)
        const minDistanceRequired = strategyParameters.minAtrFilter * atrValue;
        const atrPass = stopDistance >= minDistanceRequired;

        setVetoPipelineResults(prev => ({
          ...prev,
          layer2: atrPass ? "PASS" : "FAILED",
          reasoning: atrPass
            ? `Layer 2 (Hard ATR): Stop loss buffer of $${stopDistance.toFixed(2)} exceeds minimum of $${minDistanceRequired.toFixed(2)} required by ${strategyParameters.minAtrFilter}x ATR filter.`
            : `Layer 2 (Hard ATR): FAILED - Stop loss buffer is too tight. Noise stop-out risk is extremely high.`
        }));

        // 3. Layer 3: Correlation Safety Cap
        setTimeout(() => {
          setVetoPipelineStep(3);
          const isCorrelationBreached = symbol === "SPY" || strategyParameters.correlationLimit < 0.60;
          setVetoPipelineResults(prev => ({
            ...prev,
            layer3: !isCorrelationBreached ? "PASS" : "FAILED",
            reasoning: !isCorrelationBreached
              ? `Layer 3 (Correlation Limit): Current correlation is 0.65 (below your safety limit of ${strategyParameters.correlationLimit}).`
              : `Layer 3 (Correlation Limit): FAILED - Target asset correlation is 0.87 (exceeds limit of ${strategyParameters.correlationLimit}).`
          }));

          // 4. Layer 4: CIO Discretionary Overlay / Final Veto Switch
          setTimeout(() => {
            setVetoPipelineStep(4);
            let finalDecision = "APPROVED";
            let reasonSummary = "";

            if (reason.toLowerCase().includes("fomo") || reason.toLowerCase().includes("chasing") || reason.toLowerCase().includes("breakout")) {
              finalDecision = "VETOED";
              reasonSummary = "Chief Trader CIO VETO: Proposal breaches active memory rule 'Avoid chasing RSI > 75 breakouts without a structural retest'. Refusing emotional sentiment trap.";
            } else if (strategyParameters.correlationLimit < 0.60 || symbol === "SPY") {
              finalDecision = "VETOED";
              reasonSummary = "Chief Trader CIO VETO: Asset exceeds correlation limit. Portfolio diversification guidelines strictly violate exposure bounds.";
            } else {
              finalDecision = "APPROVED";
              reasonSummary = "Chief Trader CIO APPROVED: Proposal cleared for live execution. All quantitative, risk, and correlation thresholds satisfied.";
            }

            setVetoPipelineResults(prev => ({
              ...prev,
              layer4: finalDecision,
              status: finalDecision,
              reasoning: reasonSummary
            }));

            // Log final decision
            setLogsList(p => [
              {
                timestamp: new Date().toTimeString().split(" ")[0],
                severity: finalDecision === "APPROVED" ? "SUCCESS" : "WARNING",
                component: "CIO",
                text: `Multi-Layer Decision complete for ${symbol}: ${finalDecision}. ${reasonSummary}`
              },
              ...p
            ]);

          }, 1500);
        }, 1500);
      }, 1500);
    }, 1500);
  };


  // Dynamic weights update based on evolution success rates (Feature 20)
  const triggerEvolutionShift = () => {
    setAgentWeights(prev => ({
      technical: Math.min(100, Math.max(50, prev.technical + (Math.random() > 0.5 ? 1 : -1))),
      news: Math.min(100, Math.max(50, prev.news + (Math.random() > 0.5 ? 1 : -1))),
      risk: Math.min(100, Math.max(50, prev.risk + (Math.random() > 0.5 ? 1 : -1))),
      claude: Math.min(100, Math.max(50, prev.claude + (Math.random() > 0.5 ? 1 : -1))),
      chatgpt: Math.min(100, Math.max(50, prev.chatgpt + (Math.random() > 0.5 ? 1 : -1))),
      gemini: Math.min(100, Math.max(50, prev.gemini + (Math.random() > 0.5 ? 1 : -1)))
    }));
  };

  // Simulate evolving agent weights periodically
  useEffect(() => {
    const interval = setInterval(() => {
      if (!enginesHalted) {
        triggerEvolutionShift();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [enginesHalted]);

  // Export Trace File helper
  const handleExportTrace = (format: "log" | "json" | "csv" | "txt") => {
    let fileContent = "";
    let mimeType = "text/plain";

    if (format === "json") {
      fileContent = JSON.stringify({
        terminalId: "ARGUS-CIO-001",
        systemStatus: enginesHalted ? "HALTED" : "ACTIVE",
        activeMode: tradingMode,
        activeRegime: marketRegime,
        agentPerformance: agentWeights,
        scannedOpportunities: scannedAssets,
        journalAudit: journalEntries
      }, null, 2);
      mimeType = "application/json";
    } else if (format === "csv") {
      fileContent = "Timestamp,Component,Severity,LogMessage\n" + 
        logsList.map(l => `"${l.timestamp}","${l.component}","${l.severity}","${l.text.replace(/"/g, '""')}"`).join("\n");
      mimeType = "text/csv";
    } else {
      fileContent = logsList.map(l => `[${l.timestamp}] [${l.severity}] [${l.component}] ${l.text}`).join("\n");
    }

    const blob = new Blob([fileContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `argus_trading_system_trace.${format}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="bg-[#0A0F16] border border-[#1E293B] rounded-xl p-6 min-h-screen text-slate-100 flex flex-col font-sans relative overflow-hidden" id="argus-mission-control-panel">
      {/* Background Ambience */}
      <div className="absolute top-0 right-0 w-96 h-96 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none"></div>
      <div className="absolute bottom-0 left-0 w-96 h-96 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none"></div>

      {/* HEADER SECTION */}
      <div className="flex flex-col xl:flex-row xl:items-center justify-between border-b border-slate-800 pb-5 mb-6 gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 bg-indigo-500/10 text-indigo-400 rounded border border-indigo-500/20">
              <BrainCircuit className="animate-pulse" size={22} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-mono font-bold tracking-widest text-white uppercase">
                  ARGUS AI HEDGE FUND SYSTEM
                </h1>
                <span className="text-[10px] bg-indigo-500/20 text-indigo-400 font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-indigo-500/30">
                  v3.4 Autonomous
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Multi-agent CIO orchestration workspace. Complete quantitative research, risk checking, and automated journaling.
              </p>
            </div>
          </div>
        </div>

        {/* TOP LEVEL MODE SELECTORS */}
        <div className="flex flex-wrap items-center gap-3">
          {/* 19. Mode Presets */}
          <div className="flex items-center bg-slate-900 border border-slate-800 p-1 rounded">
            <span className="text-[10px] font-mono text-slate-500 uppercase px-2">Hedge Fund Mode:</span>
            {(["BEGINNER", "ASSISTED", "AUTONOMOUS", "HEDGE_FUND"] as const).map(mode => (
              <button
                key={mode}
                onClick={() => setTradingMode(mode)}
                className={`text-[9px] font-mono uppercase px-2 py-1 rounded transition-all ${
                  tradingMode === mode ? "bg-indigo-600 text-white font-bold shadow-md" : "text-slate-400 hover:text-slate-200"
                }`}
                title={
                  mode === "BEGINNER" ? "AI acts as educational simulation guide." :
                  mode === "ASSISTED" ? "AI scouts and drafts trades, awaits user confirmation." :
                  mode === "AUTONOMOUS" ? "AI handles entries, stop-loss calculations, and exits." :
                  "Dynamic portfolio allocations, multi-strategy tournament, continuous evolution."
                }
              >
                {mode.replace("_", " ")}
              </button>
            ))}
          </div>

          {/* 10. Beginner Explanation Toggle */}
          <button
            onClick={() => setIsBeginnerExplanation(!isBeginnerExplanation)}
            className={`px-3 py-1.5 rounded font-mono text-[10px] tracking-widest border transition-all flex items-center gap-1.5 ${
              isBeginnerExplanation ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-300"
            }`}
          >
            <HelpCircle size={12} />
            {isBeginnerExplanation ? "BEGINNER ON" : "BEGINNER MODE"}
          </button>

          {/* Close Panel */}
          <button
            onClick={onClose}
            className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 border border-slate-800 text-[10px] font-mono text-slate-300 rounded transition-all uppercase tracking-widest font-bold"
          >
            ← CLOSE PORTAL
          </button>
        </div>
      </div>

      {/* BEGINNER EDUCATIONAL ANCHOR */}
      {isBeginnerExplanation && (
        <div className="bg-emerald-950/20 border border-emerald-500/20 rounded-lg p-4 mb-6 flex gap-3.5 items-start animate-fade-in">
          <Sparkles className="text-emerald-400 shrink-0 mt-0.5" size={18} />
          <div className="text-xs text-emerald-300 leading-relaxed">
            <h4 className="font-bold uppercase tracking-widest font-mono text-emerald-400 mb-1">
              Beginner Friendly Tutorial Active
            </h4>
            <p>
              Welcome to the trading brain. Instead of standard "buy and sell" guessing games, this layout showcases how elite hedge fund operations manage capital. Turn on tooltips on each section below to discover how mathematical engines, the Chief Investment Officer, and the Devil's Advocate protect your account.
            </p>
          </div>
        </div>
      )}

      {/* CORE VIEWPORT TABS */}
      <div className="flex border-b border-slate-800/60 mb-6 gap-2 overflow-x-auto">
        <button
          onClick={() => setActiveSubTab("cio")}
          className={`px-4 py-2.5 text-xs font-mono font-bold tracking-wider uppercase border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === "cio" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Compass size={14} /> CIO Orchestration
        </button>
        <button
          onClick={() => setActiveSubTab("scanner")}
          className={`px-4 py-2.5 text-xs font-mono font-bold tracking-wider uppercase border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === "scanner" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Search size={14} /> Opportunity Ingest
        </button>
        <button
          onClick={() => setActiveSubTab("tactical")}
          className={`px-4 py-2.5 text-xs font-mono font-bold tracking-wider uppercase border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === "tactical" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Sliders size={14} /> Tactical Guardrails
        </button>
        <button
          onClick={() => setActiveSubTab("arena")}
          className={`px-4 py-2.5 text-xs font-mono font-bold tracking-wider uppercase border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === "arena" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <Award size={14} /> Tournaments & Sandbox
        </button>
        <button
          onClick={() => setActiveSubTab("journal")}
          className={`px-4 py-2.5 text-xs font-mono font-bold tracking-wider uppercase border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === "journal" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          <BookOpen size={14} /> AI Journal & Logs
        </button>
      </div>

      {/* SUB-TABS INTERACTIVE VIEWPORTS */}

      {/* VIEW: CIO ORCHESTRATION */}
      {activeSubTab === "cio" && (
        <>
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* CIO PROFILE & STATS */}
          <div className="lg:col-span-4 bg-[#111822] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <span className="text-[10px] font-mono uppercase text-indigo-400 tracking-wider">Hedge Fund Layer</span>
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded font-bold">Active</span>
              </div>
              <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <UserCheck size={16} className="text-indigo-400" />
                AI Chief Investment Officer
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                Directs multi-LLM consensus. Challenges assumptions, filters overtrading sentiment traps, and dynamically locks optimal execution settings.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-950 p-2.5 rounded text-[10px] text-slate-300 border border-slate-800 mb-4">
                  💡 <span className="font-bold">What is AI CIO?</span> Instead of running a single prediction model, the CIO acts like the brain of a multi-million dollar fund. It receives advice from the Quant, News, and Risk engines and makes the absolute final approval.
                </div>
              )}

              {/* Strategy focus config */}
              <div className="space-y-3 pt-3 border-t border-slate-800/60">
                <label className="text-[10px] font-mono uppercase text-slate-500 tracking-wider block">Investment Mandate</label>
                <div className="grid grid-cols-2 gap-2">
                  {["Balanced Growth", "Aggressive Volatility", "Capital Preservation", "Alpha Generator"].map(opt => (
                    <button
                      key={opt}
                      onClick={() => setCioStrategyFocus(opt)}
                      className={`text-[9px] font-mono p-2 rounded text-left border transition-all ${
                        cioStrategyFocus === opt ? "bg-indigo-600/15 border-indigo-500 text-white font-bold" : "bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-800">
              <span className="text-[10px] font-mono uppercase text-slate-500 tracking-wider block mb-2">CIO Directives Overview</span>
              <div className="space-y-1.5 text-xs font-mono">
                <div className="flex justify-between"><span className="text-slate-400">Emotional Veto:</span><span className="text-emerald-400 font-bold">ACTIVE</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Strategy Diversity:</span><span className="text-indigo-400 font-bold">4 Active</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Auto-Weight Shifts:</span><span className="text-emerald-400 font-bold">ENABLED</span></div>
              </div>
            </div>
          </div>

          {/* 20. AI TRADER EVOLUTION AGENT WEIGHTS */}
          <div className="lg:col-span-8 bg-[#1A1F2B] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <Activity size={14} className="text-emerald-400 animate-pulse" />
                  AI Trader Evolution & Accuracy Tracking
                </h3>
                <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded font-bold uppercase">
                  Self-Learning System
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-relaxed mb-5">
                Every trade outcome is logged. The CIO automatically evaluates which agent's advice led to success or unexpected drawdowns, adjusting their relative prompt voting weight dynamic on the fly.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 rounded text-[10px] text-slate-300 border border-slate-800 mb-4">
                  💡 <span className="font-bold">What is Evolution?</span> In high-speed markets, static systems fail. The Evolution agent acts as a scorekeeper. If Gemini is performing best on news, its weight rises. If Claude makes a mistake, its impact weight is reduced.
                </div>
              )}

              {/* Progress Gauges for Agents */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {Object.entries(agentWeights).map(([key, val]) => (
                  <div key={key} className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
                    <span className="text-[10px] font-mono uppercase text-slate-400 font-bold">{key} Node</span>
                    <div className="flex items-end gap-1.5 my-2">
                      <span className="text-lg font-mono font-bold text-white">{val}%</span>
                      <span className="text-[9px] font-mono text-emerald-400 mb-1">Influence</span>
                    </div>
                    {/* Visual bar */}
                    <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden">
                      <div className="bg-indigo-500 h-full rounded-full transition-all duration-1000" style={{ width: `${val}%` }}></div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-between items-center mt-6 pt-4 border-t border-slate-800 text-[10px] font-mono text-slate-400">
              <span className="flex items-center gap-1"><RefreshCw size={10} className="animate-spin text-indigo-400" /> Auto-optimizing database models every 10 seconds...</span>
              <button
                onClick={triggerEvolutionShift}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-bold uppercase tracking-wider px-2.5 py-1 rounded transition-all text-[9px]"
              >
                Force Evolution Sweep
              </button>
            </div>
          </div>

        </div>

        {/* === NEW CHIEF TRADER CIO DECK COMPONENT === */}
        <div className="mt-6">
          <div className="bg-[#111822] border border-slate-800/80 rounded-lg p-6 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/5 rounded-full blur-3xl pointer-events-none"></div>
            
            {/* Deck Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800 pb-4 mb-6 gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <span className="p-1.5 bg-indigo-500/10 text-indigo-400 rounded border border-indigo-500/20">
                    <Layers size={16} />
                  </span>
                  <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
                    Chief Trader Agent: Autonomous CIO Deck
                  </h3>
                </div>
                <p className="text-xs text-slate-400 mt-1">
                  Multi-tier discretionary oversight node. Schedules research tasks, sets strategy weights, and exercises final trade block vetoes.
                </p>
              </div>
              
              {/* Visual indicator */}
              <div className="flex items-center gap-4 bg-slate-950 px-3 py-1.5 rounded border border-slate-800 font-mono text-[10px]">
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span>
                  <span className="text-slate-400">CIO STATUS:</span>
                  <span className="text-emerald-400 font-bold">MONITORING</span>
                </div>
                <div className="h-4 w-px bg-slate-800"></div>
                <div className="flex items-center gap-1.5">
                  <span className="text-slate-400">ACTIVE MANDATE:</span>
                  <span className="text-indigo-400 font-bold uppercase">{cioStrategyFocus}</span>
                </div>
              </div>
            </div>

            {/* Grid for Task Assignment and Strategy Selection */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
              
              {/* COLUMN 1: AGENT TASK ASSIGNMENT (4-cols) */}
              <div className="xl:col-span-4 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider">
                      1. Quantitative Task Assignment
                    </span>
                    <span className="text-[9px] font-mono text-slate-500 uppercase">Live Dispatcher</span>
                  </div>

                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Instruct the Chief Trader to assign high-priority analytical tasks to specialized consensus nodes.
                  </p>

                  {/* Dispatch Form */}
                  <div className="space-y-3 bg-slate-900/50 p-3 rounded border border-slate-800/50 mb-4">
                    <div>
                      <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Target Analyst Node</label>
                      <select 
                        value={newTaskAgent}
                        onChange={(e) => setNewTaskAgent(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono"
                      >
                        <option value="Gemini Node">Gemini Node (Alpha/Reasoning)</option>
                        <option value="Technical Node">Technical Node (Patterns/ATR)</option>
                        <option value="Risk Node">Risk Node (Limits/Correlation)</option>
                        <option value="Claude Node">Claude Node (Market Regimes)</option>
                      </select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Task Category</label>
                        <select 
                          value={newTaskType}
                          onChange={(e) => setNewTaskType(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono"
                        >
                          <option value="Sentiment Harvesting">Sentiment Harvesting</option>
                          <option value="Volatility Analysis">Volatility Analysis</option>
                          <option value="Regime Detection">Regime Detection</option>
                          <option value="Correlation Mapping">Correlation Mapping</option>
                          <option value="Order Flow Audit">Order Flow Audit</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Priority Level</label>
                        <select 
                          value={newTaskPriority}
                          onChange={(e) => setNewTaskPriority(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono"
                        >
                          <option value="LOW">LOW</option>
                          <option value="MEDIUM">MEDIUM</option>
                          <option value="HIGH">HIGH</option>
                          <option value="CRITICAL">CRITICAL</option>
                        </select>
                      </div>
                    </div>

                    <button
                      onClick={handleDispatchCioTask}
                      disabled={isProcessingCioTask}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-mono text-xs font-bold uppercase tracking-widest rounded transition-all shadow-md flex items-center justify-center gap-2"
                    >
                      {isProcessingCioTask ? (
                        <>
                          <RefreshCw size={12} className="animate-spin text-white" />
                          PROCESSING DISPATCH...
                        </>
                      ) : (
                        "DISPATCH ASSIGNMENT"
                      )}
                    </button>

                    {newTaskStatusMsg && (
                      <div className="text-[10px] font-mono text-emerald-400 text-center animate-pulse mt-1">
                        {newTaskStatusMsg}
                      </div>
                    )}
                  </div>

                  {/* Task assignment live tracking ledger */}
                  <span className="text-[9px] font-mono uppercase text-slate-500 block mb-2">Assignment Registry Ledger</span>
                  <div className="space-y-2 max-h-[160px] overflow-y-auto pr-1">
                    {cioTasks.map((task) => (
                      <div key={task.id} className="bg-slate-900/60 border border-slate-800/40 p-2.5 rounded text-[11px]">
                        <div className="flex justify-between items-center mb-1">
                          <span className="font-mono font-bold text-slate-300">{task.agent}</span>
                          <div className="flex gap-1.5 items-center">
                            <span className={`text-[8px] font-mono px-1.5 rounded font-bold ${
                              task.priority === "CRITICAL" ? "bg-rose-500/20 text-rose-400 border border-rose-500/30" :
                              task.priority === "HIGH" ? "bg-amber-500/20 text-amber-400 border border-amber-500/30" :
                              "bg-slate-800 text-slate-400"
                            }`}>
                              {task.priority}
                            </span>
                            <span className={`text-[8px] font-mono px-1 rounded ${
                              task.status === "COMPLETED" ? "bg-emerald-500/20 text-emerald-400 font-bold" :
                              task.status === "PROCESSING" ? "bg-indigo-500/20 text-indigo-400 animate-pulse font-bold" :
                              "bg-slate-800 text-slate-500"
                            }`}>
                              {task.status}
                            </span>
                          </div>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono mb-1">Task: {task.taskType}</div>
                        {task.findings && (
                          <div className="text-[10px] text-indigo-300 font-mono italic bg-slate-950 p-1.5 rounded border border-slate-800/50">
                            🔎 Findings: {task.findings}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* COLUMN 2: STRATEGY SELECTION & WEIGHTS (3-cols) */}
              <div className="xl:col-span-3 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider">
                      2. CIO Strategy Selection
                    </span>
                    <span className="text-[9px] font-mono text-slate-500 uppercase">Active Core</span>
                  </div>

                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Toggle and tune parameters of the algorithmic core currently steered by the Chief Investment Officer.
                  </p>

                  <div className="space-y-2 mb-4">
                    {[
                      { name: "Volatility Breakout Core", desc: "Seeks ATR momentum expansions", win: 74 },
                      { name: "Funding Rate Arb Node", desc: "Hedges neutral spot/futures premium", win: 81 },
                      { name: "Liquidity Sweeping Alpha", desc: "Hunts support/resistance stop hunts", win: 68 },
                      { name: "Macro Regime Tracker", desc: "Identifies cyclical structural shifts", win: 62 }
                    ].map((strat) => (
                      <button
                        key={strat.name}
                        onClick={() => setCioSelectedStrategy(strat.name)}
                        className={`w-full p-2.5 rounded border text-left transition-all ${
                          cioSelectedStrategy === strat.name
                            ? "bg-indigo-600/15 border-indigo-500 text-white"
                            : "bg-slate-900/60 border-slate-800/40 text-slate-400 hover:text-slate-300 hover:border-slate-700"
                        }`}
                      >
                        <div className="flex justify-between items-center">
                          <span className="text-[11px] font-mono font-bold">{strat.name}</span>
                          <span className="text-[9px] font-mono text-emerald-400">{strat.win}% WR</span>
                        </div>
                        <p className="text-[9px] text-slate-500 mt-0.5 font-mono">{strat.desc}</p>
                      </button>
                    ))}
                  </div>

                  {/* Fine-Tuning Parameters */}
                  <div className="space-y-3 pt-3 border-t border-slate-800/60">
                    <span className="text-[10px] font-mono uppercase text-slate-400 font-bold block">
                      Core Strategy Tune Parameters
                    </span>
                    
                    <div>
                      <div className="flex justify-between text-[10px] font-mono mb-1">
                        <span className="text-slate-500">ATR Stop-Loss Buffer</span>
                        <span className="text-indigo-400 font-bold">{strategyParameters.riskMultiplier}x</span>
                      </div>
                      <input
                        type="range"
                        min="1.0"
                        max="3.0"
                        step="0.1"
                        value={strategyParameters.riskMultiplier}
                        onChange={(e) => setStrategyParameters({ ...strategyParameters, riskMultiplier: parseFloat(e.target.value) })}
                        className="w-full h-1 bg-slate-900 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                      <div>
                        <div className="flex justify-between text-[9px] font-mono mb-1">
                          <span className="text-slate-500">Min ATR</span>
                          <span className="text-slate-300 font-bold">{strategyParameters.minAtrFilter}</span>
                        </div>
                        <select
                          value={strategyParameters.minAtrFilter}
                          onChange={(e) => setStrategyParameters({ ...strategyParameters, minAtrFilter: parseFloat(e.target.value) })}
                          className="w-full bg-slate-900 border border-slate-800 text-[10px] text-slate-300 rounded p-1 outline-none font-mono"
                        >
                          <option value="1.0">1.0 ATR</option>
                          <option value="1.5">1.5 ATR</option>
                          <option value="2.0">2.0 ATR</option>
                        </select>
                      </div>
                      <div>
                        <div className="flex justify-between text-[9px] font-mono mb-1">
                          <span className="text-slate-500">Corr Limit</span>
                          <span className="text-slate-300 font-bold">{strategyParameters.correlationLimit}</span>
                        </div>
                        <select
                          value={strategyParameters.correlationLimit}
                          onChange={(e) => setStrategyParameters({ ...strategyParameters, correlationLimit: parseFloat(e.target.value) })}
                          className="w-full bg-slate-900 border border-slate-800 text-[10px] text-slate-300 rounded p-1 outline-none font-mono"
                        >
                          <option value="0.50">0.50 Cap</option>
                          <option value="0.70">0.70 Cap</option>
                          <option value="0.85">0.85 Cap</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* COLUMN 3: MULTI-LAYER TRADE VETO GATE (5-cols) */}
              <div className="xl:col-span-5 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider">
                      3. Multi-Layer Discretionary Veto
                    </span>
                    <span className="text-[9px] font-mono text-slate-500 uppercase">CIO Veto Gate</span>
                  </div>

                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Run any trade proposal through the CIO's 4-layer decision gate. If a proposal violates rules, the Chief Trader issues an immediate veto.
                  </p>

                  {/* Pre-made Templates */}
                  <div className="grid grid-cols-3 gap-2 mb-4">
                    <button
                      onClick={() => handleRunVetoEvaluation("TSLA")}
                      className="bg-rose-950/20 hover:bg-rose-950/40 border border-rose-500/20 text-rose-400 p-2 rounded text-center transition-all font-mono text-[9px]"
                    >
                      <div className="font-bold">TSLA FOMO</div>
                      <div className="text-[8px] text-slate-500 mt-0.5">Veto Target</div>
                    </button>
                    <button
                      onClick={() => handleRunVetoEvaluation("SPY")}
                      className="bg-amber-950/20 hover:bg-amber-950/40 border border-amber-500/20 text-amber-400 p-2 rounded text-center transition-all font-mono text-[9px]"
                    >
                      <div className="font-bold">SPY High Corr</div>
                      <div className="text-[8px] text-slate-500 mt-0.5">Veto Target</div>
                    </button>
                    <button
                      onClick={() => handleRunVetoEvaluation("NVDA")}
                      className="bg-emerald-950/20 hover:bg-emerald-950/40 border border-emerald-500/20 text-emerald-400 p-2 rounded text-center transition-all font-mono text-[9px]"
                    >
                      <div className="font-bold">NVDA Support</div>
                      <div className="text-[8px] text-slate-500 mt-0.5">Will Pass</div>
                    </button>
                  </div>

                  {/* Custom submission inputs */}
                  <div className="bg-slate-900/60 border border-slate-800/50 p-3 rounded mb-4">
                    <span className="text-[9px] font-mono uppercase text-slate-500 block mb-2">Custom Proposal Builder</span>
                    
                    <div className="grid grid-cols-12 gap-2 mb-2">
                      <div className="col-span-3">
                        <input
                          type="text"
                          placeholder="Symbol"
                          value={customProposalSymbol}
                          onChange={(e) => setCustomProposalSymbol(e.target.value.toUpperCase())}
                          className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1 outline-none font-mono text-center"
                        />
                      </div>
                      <div className="col-span-3">
                        <select
                          value={customProposalType}
                          onChange={(e) => setCustomProposalType(e.target.value as any)}
                          className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-300 rounded p-1 outline-none font-mono"
                        >
                          <option value="BUY">BUY</option>
                          <option value="SELL">SELL</option>
                        </select>
                      </div>
                      <div className="col-span-6">
                        <input
                          type="text"
                          placeholder="Price"
                          value={customProposalPrice}
                          onChange={(e) => setCustomProposalPrice(e.target.value)}
                          className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1 outline-none font-mono text-center"
                        />
                      </div>
                    </div>

                    <div className="mb-3">
                      <input
                        type="text"
                        placeholder="Logic (e.g., support bounce, breakout)..."
                        value={customProposalReason}
                        onChange={(e) => setCustomProposalReason(e.target.value)}
                        className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-300 rounded p-1.5 outline-none font-mono"
                      />
                    </div>

                    <button
                      onClick={() => handleRunVetoEvaluation()}
                      disabled={vetoPipelineResults.status === "EVALUATING"}
                      className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 text-white font-mono text-xs font-bold uppercase tracking-widest rounded transition-all shadow-md flex items-center justify-center gap-1.5"
                    >
                      <Sliders size={12} />
                      ENGAGE VETO PIPELINE
                    </button>
                  </div>

                  {/* Veto evaluation steps */}
                  <div className="space-y-2.5">
                    {/* Step 1: Sentiment Check */}
                    <div className="flex items-center justify-between text-[11px] font-mono border-b border-slate-900 pb-1.5">
                      <span className="text-slate-400">Layer 1: Sentiment Consensus Gate</span>
                      <div className="flex items-center gap-1.5">
                        {vetoPipelineStep >= 0 && <span className="text-[9px] text-slate-500 animate-pulse">Checking...</span>}
                        {vetoPipelineResults.layer1 === "PASS" && <span className="text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 text-[9px]">PASSED</span>}
                        {vetoPipelineResults.layer1 === "WARN" && <span className="text-amber-400 font-bold bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20 text-[9px]">WARNING</span>}
                        {vetoPipelineResults.layer1 === null && <span className="text-slate-600 text-[9px]">WAITING</span>}
                      </div>
                    </div>

                    {/* Step 2: ATR Risk */}
                    <div className="flex items-center justify-between text-[11px] font-mono border-b border-slate-900 pb-1.5">
                      <span className="text-slate-400">Layer 2: Hard ATR Noise Filter Cap</span>
                      <div className="flex items-center gap-1.5">
                        {vetoPipelineStep >= 1 && <span className="text-[9px] text-slate-500 animate-pulse">Checking...</span>}
                        {vetoPipelineResults.layer2 === "PASS" && <span className="text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 text-[9px]">PASSED</span>}
                        {vetoPipelineResults.layer2 === "FAILED" && <span className="text-rose-400 font-bold bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20 text-[9px]">BREACHED</span>}
                        {vetoPipelineResults.layer2 === null && <span className="text-slate-600 text-[9px]">WAITING</span>}
                      </div>
                    </div>

                    {/* Step 3: Correlation Safety */}
                    <div className="flex items-center justify-between text-[11px] font-mono border-b border-slate-900 pb-1.5">
                      <span className="text-slate-400">Layer 3: Macro Correlation Safety Limit</span>
                      <div className="flex items-center gap-1.5">
                        {vetoPipelineStep >= 2 && <span className="text-[9px] text-slate-500 animate-pulse">Checking...</span>}
                        {vetoPipelineResults.layer3 === "PASS" && <span className="text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 text-[9px]">PASSED</span>}
                        {vetoPipelineResults.layer3 === "FAILED" && <span className="text-rose-400 font-bold bg-rose-500/10 px-1.5 py-0.5 rounded border border-rose-500/20 text-[9px]">BREACHED</span>}
                        {vetoPipelineResults.layer3 === null && <span className="text-slate-600 text-[9px]">WAITING</span>}
                      </div>
                    </div>

                    {/* Step 4: Discretionary Overlay / Final decision */}
                    <div className="flex items-center justify-between text-[11px] font-mono">
                      <span className="text-slate-400 font-bold">Layer 4: CIO Discretionary Overlay</span>
                      <div className="flex items-center gap-1.5">
                        {vetoPipelineStep >= 3 && <span className="text-[9px] text-slate-500 animate-pulse">Deliberating...</span>}
                        {vetoPipelineResults.layer4 === "APPROVED" && <span className="text-emerald-400 font-bold bg-emerald-500/15 px-2 py-0.5 rounded border border-emerald-500/30 text-[9px]">APPROVED</span>}
                        {vetoPipelineResults.layer4 === "VETOED" && <span className="text-rose-400 font-bold bg-rose-500/15 px-2 py-0.5 rounded border border-rose-500/30 text-[9px]">VETOED</span>}
                        {vetoPipelineResults.layer4 === null && <span className="text-slate-600 text-[9px]">WAITING</span>}
                      </div>
                    </div>

                    {/* Results Logger Summary */}
                    {vetoPipelineResults.reasoning && (
                      <div className={`mt-3 p-3 rounded border text-xs font-mono transition-all duration-300 ${
                        vetoPipelineResults.status === "APPROVED" ? "bg-emerald-950/20 border-emerald-500/25 text-emerald-300" :
                        vetoPipelineResults.status === "VETOED" ? "bg-rose-950/20 border-rose-500/25 text-rose-300" :
                        "bg-slate-900 border-slate-800 text-slate-300"
                      }`}>
                        <div className="flex items-center gap-1.5 font-bold uppercase mb-1">
                          <Sliders size={12} className="text-indigo-400" />
                          CIO Pipeline Trace Log:
                        </div>
                        <div className="leading-relaxed whitespace-pre-line text-[11px]">{vetoPipelineResults.reasoning}</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

            </div>
          </div>
        </div>
        </>
      )}


      {/* VIEW: OPPORTUNITY INGEST */}
      {activeSubTab === "scanner" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* 2. 24/7 SCANNER HUNTER LIST */}
          <div className="lg:col-span-5 bg-[#111822] border border-slate-800 p-5 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                <Search size={14} className="text-indigo-400" />
                Opportunity Hunter (24/7 Scanner)
              </h3>
              <span className="text-[9px] font-mono bg-indigo-500/10 text-indigo-400 px-2 py-0.5 rounded uppercase">
                8600+ Assets Checked
              </span>
            </div>
            
            <p className="text-xs text-slate-400 mb-4 leading-relaxed">
              Continuously monitors stocks, ETFs, crypto markets. High correlation patterns or volume anomalies trigger instant CIO debate.
            </p>

            {isBeginnerExplanation && (
              <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                💡 <span className="font-bold">How the Scanner works:</span> The bot does not stop. It screens 8,000+ equities and 100+ cryptocurrencies constantly, highlighting high probability trades. Select an asset to run trade simulations.
              </div>
            )}

            {/* In-tab Scanner search */}
            <div className="flex gap-2 mb-4">
              <input
                type="text"
                placeholder="Filter symbols..."
                value={scannerSearchQuery}
                onChange={(e) => setScannerSearchQuery(e.target.value)}
                className="bg-slate-950 text-xs text-white border border-slate-800 rounded px-3 py-1.5 outline-none flex-1 font-mono"
              />
              <button className="bg-slate-800 hover:bg-slate-700 text-xs px-3 rounded text-slate-300 font-mono">
                GO
              </button>
            </div>

            {/* List */}
            <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
              {scannedAssets
                .filter(a => a.symbol.includes(scannerSearchQuery.toUpperCase()))
                .map((asset, i) => (
                  <div
                    key={i}
                    onClick={() => {
                      setSimulatingAsset(asset.symbol);
                      setChecklistSymbol(asset.symbol);
                    }}
                    className={`p-3 bg-slate-950 border rounded flex justify-between items-center cursor-pointer hover:border-indigo-500/40 transition-colors ${
                      simulatingAsset === asset.symbol ? "border-indigo-500 bg-indigo-500/[0.02]" : "border-slate-850"
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-white">{asset.symbol}</span>
                        <span className="text-[8px] font-mono text-slate-500 uppercase px-1 rounded bg-slate-900">{asset.assetClass}</span>
                      </div>
                      <p className="text-[9px] text-slate-400 mt-1 line-clamp-1">{asset.reasons.join(" • ")}</p>
                    </div>
                    <div className="text-right">
                      <span className="text-xs font-mono font-bold text-emerald-400">{asset.matchScore}% Match</span>
                      <span className="text-[8px] font-mono text-slate-500 block mt-0.5">Click to simulate</span>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {/* 9. TRADE SIMULATION BEFORE EXECUTION & DEVIL'S ADVOCATE */}
          <div className="lg:col-span-7 bg-[#1A1F2B] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <Sliders size={14} className="text-indigo-400" />
                  Pre-Execution Trade Simulator
                </h3>
                <span className="text-[10px] font-mono text-slate-500 uppercase">Target: {simulatingAsset}</span>
              </div>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                  💡 <span className="font-bold">What is Trade Simulation?</span> Before executing with capital, the system maps out the mathematical probabilities. It calculates win rates, stop-losses, and forces a dedicated Bull agent and Bear agent (Devil's Advocate) to debate.
                </div>
              )}

              {/* Simulation Box */}
              <div className="bg-slate-950/60 p-4 border border-slate-800 rounded mb-4">
                <div className="flex justify-between items-center mb-3">
                  <span className="text-xs font-mono text-slate-300">Run sandbox trace simulation on <span className="font-bold text-white">{simulatingAsset}</span></span>
                  <button
                    onClick={handleRunSimulation}
                    disabled={isSimulating}
                    className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-mono font-bold text-[10px] uppercase tracking-wider px-3 py-1.5 rounded"
                  >
                    {isSimulating ? "Simulating..." : "Calculate Outcomes"}
                  </button>
                </div>

                {simResults ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-3 pt-3 border-t border-slate-800/60 font-mono text-xs">
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase block">Profit Probability</span>
                      <span className="text-sm font-bold text-emerald-400">{simResults.probabilityProfit}%</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase block">Loss Probability</span>
                      <span className="text-sm font-bold text-rose-400">{simResults.probabilityLoss}%</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase block">Dynamic Stop Loss</span>
                      <span className="text-sm font-bold text-slate-300">${simResults.stopPrice}</span>
                    </div>
                    <div>
                      <span className="text-[9px] text-slate-500 uppercase block">Target Price</span>
                      <span className="text-sm font-bold text-indigo-400">${simResults.targetPrice}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-[10px] text-slate-500 font-mono text-center py-2">Click Calculate to build predictive outcome probability matrix.</p>
                )}
              </div>

              {/* 10. AI DEVIL'S ADVOCATE ARGUMENT VIEW */}
              <div className="space-y-3 pt-2">
                <span className="text-[10px] font-mono uppercase text-slate-500 tracking-wider block">AI Devil's Advocate Dialogue</span>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {/* Bull Proposer */}
                  <div className="bg-[#111822] border-l-2 border-emerald-500 p-3 rounded-r">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-mono font-bold text-emerald-400">Bull Agent (Proposer)</span>
                      <span className="text-[8px] font-mono text-emerald-500">BUY OPTIMIST</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed font-mono">
                      "Strong trend support and institutional buying. Technical patterns show high velocity momentum above key Resistance lines."
                    </p>
                  </div>

                  {/* Bear Devil's Advocate */}
                  <div className="bg-[#111822] border-l-2 border-rose-500 p-3 rounded-r">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-mono font-bold text-rose-400">Bear Agent (Devil's Advocate)</span>
                      <span className="text-[8px] font-mono text-rose-500">VETO COUNTER</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed font-mono">
                      "Resistance at $185.00 has held 3 times historically. Overbought RSI suggests high pullback probability. Risk of chasing top is elevated."
                    </p>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* VIEW: TACTICAL GUARDRAILS */}
      {activeSubTab === "tactical" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* 4. PRE-TRADE CHECKLIST */}
          <div className="lg:col-span-4 bg-[#111822] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-emerald-400" />
                  Pre-Trade Checklist Agent
                </h3>
                <span className="text-[9px] font-mono text-slate-500">Asset: {checklistSymbol}</span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                Strict requirements filter. If any requirement fails, the transaction is immediately rejected and passed back to the CIO log.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                  💡 <span className="font-bold">What is Checklist?</span> Wall Street traders use checklists to prevent emotional choices. The AI automatically scans 7 checkpoints (like technical trends, news risk levels, and risk/reward ratios) before placing any trade.
                </div>
              )}

              {/* Checklist list */}
              <div className="space-y-2 font-mono text-[10px]">
                <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                  <span className="text-slate-300">Trend Confirmed (EMA above EMA)</span>
                  <span className="text-emerald-400 font-bold">✓ PASS</span>
                </div>
                <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                  <span className="text-slate-300">Volume Confirmation & Flow</span>
                  <span className="text-emerald-400 font-bold">✓ PASS</span>
                </div>
                <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                  <span className="text-slate-300">Earnings Date checked (&gt; 5 days out)</span>
                  <span className="text-emerald-400 font-bold">✓ PASS</span>
                </div>
                <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                  <span className="text-slate-300">Volatility Regime Check</span>
                  <span className="text-emerald-400 font-bold">✓ PASS</span>
                </div>
                <div className="flex justify-between items-center bg-slate-950 p-2 rounded">
                  <span className="text-slate-300">Risk/Reward Ratio check (&gt; 2.0)</span>
                  <span className="text-emerald-400 font-bold">✓ PASS ({checklistResults.rewardRiskRatio})</span>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 text-[9px] font-mono text-slate-500 text-center">
              Veto status: <span className="text-emerald-400 font-bold">No breaches detected</span>
            </div>
          </div>

          {/* 5. MARKET REGIME AI & 11. SMART CAPITAL ALLOCATION */}
          <div className="lg:col-span-8 bg-[#1A1F2B] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-start mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <Layers size={14} className="text-sky-400" />
                  Market Regime & Capital Sizer
                </h3>
                <span className="text-[9px] font-mono bg-sky-500/10 text-sky-400 px-2 py-0.5 rounded font-bold uppercase">
                  Adaptive Logic
                </span>
              </div>

              <p className="text-xs text-slate-400 mb-5">
                Identifies overall index conditions. Adjusts active trading strategies and defines stop-loss ATR sizes according to market volatility.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                  💡 <span className="font-bold">Regime & Sizing:</span> Strategies that work in bull markets lose money in volatile sideways markets. The system detects the environment ("Bullish", "Bearish" or "High Volatility") and dynamically sizes your cash.
                </div>
              )}

              {/* Grid split */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Market Regime */}
                <div className="bg-[#111822] p-4 border border-slate-800 rounded">
                  <span className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">Market Regime</span>
                  <div className="flex items-center gap-2 mt-2">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
                    <span className="text-sm font-mono font-bold text-white uppercase">{marketRegime} Market ({regimeConfidence}% conf)</span>
                  </div>
                  <div className="mt-4 space-y-1 text-xs font-mono text-slate-400">
                    <div>• Recommended: <span className="text-emerald-400">Momentum strategies</span></div>
                    <div>• Avoid: <span className="text-rose-400">Mean reversion trades</span></div>
                    <div>• Target ATR range multiplier: <span className="text-indigo-400">1.5x</span></div>
                  </div>
                </div>

                {/* Capital Allocation & Dynamic Stop */}
                <div className="bg-[#111822] p-4 border border-slate-800 rounded">
                  <span className="text-[10px] font-mono uppercase text-slate-500 tracking-wider">Smart Capital Allocator</span>
                  <div className="mt-2 space-y-1.5 text-xs font-mono">
                    <div className="flex justify-between"><span className="text-slate-400">NVDA Exposure:</span><span className="text-white font-bold">$40.00 (40%)</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">TSLA Exposure:</span><span className="text-white font-bold">$30.00 (30%)</span></div>
                    <div className="flex justify-between"><span className="text-slate-400">Liquid Cash:</span><span className="text-indigo-400 font-bold">$30.00 (30%)</span></div>
                    <div className="flex justify-between pt-1 border-t border-slate-800/60"><span className="text-slate-500">Total Account:</span><span className="text-emerald-400 font-bold">$100.00</span></div>
                  </div>
                </div>
              </div>

              {/* Stop loss formula visualization */}
              <div className="bg-slate-950 p-3 rounded border border-slate-800/80 mt-4 text-[11px] font-mono text-slate-400 flex items-center justify-between">
                <span>Calculated Stop (ATR-based Volatility Formula):</span>
                <span className="text-indigo-400 font-bold">Stop = Support - (1.5 * Current ATR)</span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 text-[10px] font-mono text-slate-500">
              Risk parameters synchronized across active trade positions.
            </div>
          </div>

        </div>
      )}

      {/* VIEW: TOURNAMENTS & SANDBOX */}
      {activeSubTab === "arena" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* 14. AI STRATEGY GENERATOR */}
          <div className="lg:col-span-5 bg-[#111822] border border-slate-800 p-5 rounded-lg">
            <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white mb-4 flex items-center gap-1.5">
              <Sparkles size={14} className="text-indigo-400" />
              AI Custom Strategy Builder
            </h3>

            <p className="text-xs text-slate-400 leading-relaxed mb-4">
              Write custom parameters and let Gemini generate mathematical logic, filter variables, and compute backtest win-rates.
            </p>

            {isBeginnerExplanation && (
              <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                💡 <span className="font-bold">What is Strategy Generator?</span> Users can write standard prompts (e.g. "Create a strategy that buys safe momentum on solar stocks"). The AI turns it into mathematical code rules and backtests it instantly.
              </div>
            )}

            <div className="space-y-3">
              <textarea
                value={userStrategyPrompt}
                onChange={(e) => setUserStrategyPrompt(e.target.value)}
                placeholder="Type strategy objectives..."
                className="w-full bg-slate-950 text-xs text-white border border-slate-800 rounded p-3 outline-none font-mono h-20 resize-none"
              />
              <button
                onClick={handleGenerateStrategy}
                disabled={isGeneratingStrategy}
                className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-mono font-bold text-xs uppercase tracking-widest py-2 rounded transition-all"
              >
                {isGeneratingStrategy ? "Synthesizing Strategy..." : "GENERATE STRATEGY"}
              </button>
            </div>

            {generatedStrategy && (
              <div className="bg-slate-950 p-4 rounded border border-slate-800 mt-4 font-mono text-xs text-slate-300 space-y-2">
                <div className="flex justify-between text-indigo-400 font-bold">
                  <span>{generatedStrategy.name}</span>
                  <span className="text-emerald-400">{generatedStrategy.winRate}% Win-Rate</span>
                </div>
                <div><span className="text-slate-500 text-[10px] block">Indicators:</span> {generatedStrategy.indicators}</div>
                <div><span className="text-slate-500 text-[10px] block">Backtest:</span> {generatedStrategy.historicalReturn}</div>
                <div className="text-[11px] text-slate-400 pt-2 border-t border-slate-800/60">{generatedStrategy.ruleDescription}</div>
              </div>
            )}
          </div>

          {/* 15. STRATEGY COMPETITION TOURNAMENT ARENA */}
          <div className="lg:col-span-7 bg-[#1A1F2B] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <Activity size={14} className="text-emerald-400 animate-pulse" />
                  Strategy Competition Arena (Simulated Backtest)
                </h3>
                <span className="text-[9px] font-mono text-slate-500">Live Bracket Mode</span>
              </div>

              <p className="text-xs text-slate-400 mb-4">
                Active trading algorithms compete against each other using historical and live simulated price feeds to demonstrate absolute profit yield.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                  💡 <span className="font-bold">What is Tournament Arena?</span> Wall Street hedge funds deploy hundreds of strategies in sandboxes. The ones with the highest returns and lowest drawdowns get allocated real cash, while weaker ones are disabled.
                </div>
              )}

              {/* Tournament Leaderboard */}
              <div className="space-y-3">
                {arenaStrategies.map((s, i) => (
                  <div key={i} className="bg-[#111822] border border-slate-800/80 rounded p-3 flex justify-between items-center">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold text-slate-200">{s.name}</span>
                        {i === 0 && <span className="text-[8px] bg-amber-500/10 text-amber-400 font-bold uppercase px-1 rounded">LEADER</span>}
                      </div>
                      <div className="flex gap-4 text-[10px] text-slate-400 font-mono mt-1">
                        <span>Win-rate: <span className="text-slate-200">{s.winRate}%</span></span>
                        <span>Max DD: <span className="text-rose-400">-{s.maxDrawdown}%</span></span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className={`text-sm font-mono font-bold ${s.returnPct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {s.returnPct >= 0 ? "+" : ""}{s.returnPct}%
                      </span>
                      <span className="text-[9px] font-mono text-slate-500 block mt-0.5">Return Pct</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center text-[10px] font-mono text-slate-500">
              <span>Dynamic simulated live updates actively streaming...</span>
              <span className="text-indigo-400 font-bold">Hedge Fund Optimized Portfolio winning</span>
            </div>
          </div>

        </div>
      )}

      {/* VIEW: AI JOURNAL & LOGS */}
      {activeSubTab === "journal" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* 3. AI TRADING JOURNAL & 17. COACH */}
          <div className="lg:col-span-5 bg-[#111822] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                  <BookOpen size={14} className="text-indigo-400" />
                  Personal AI Trading Journal
                </h3>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Self reflection logs</span>
              </div>

              <p className="text-xs text-slate-400 leading-relaxed mb-4">
                The Coach agent audits closed trades, highlighting psychological errors like FOMO or overtrading.
              </p>

              {isBeginnerExplanation && (
                <div className="bg-slate-900 p-2.5 border border-slate-800 rounded text-[10px] text-slate-300 mb-4">
                  💡 <span className="font-bold">What is AI Coach?</span> Journaling helps you find errors in your process. The Coach reviews past wins/losses and warns you if you repeat bad habits, protecting your long-term success.
                </div>
              )}

              {/* Journal list */}
              <div className="space-y-4 max-h-96 overflow-y-auto pr-1">
                {journalEntries.map((item, i) => (
                  <div key={i} className="bg-slate-950 p-4 border border-slate-850 rounded">
                    <div className="flex justify-between items-start mb-2">
                      <div>
                        <span className="text-xs font-mono font-bold text-white">{item.symbol}</span>
                        <span className="text-[8px] font-mono text-slate-500 ml-2 uppercase">({item.id})</span>
                      </div>
                      <span className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-0.5 rounded ${
                        item.outcome === "Profit" ? "bg-emerald-500/20 text-emerald-400" : "bg-rose-500/20 text-rose-400"
                      }`}>
                        {item.outcome} (${item.pnl >= 0 ? "+" : ""}{item.pnl})
                      </span>
                    </div>

                    <div className="text-[11px] font-mono text-slate-300 space-y-1.5 mb-3">
                      <div><span className="text-slate-500">Decision Rule:</span> {item.strategy}</div>
                      <div><span className="text-slate-500">Emotion:</span> <span className={item.checklistFailed ? "text-rose-400 font-bold" : "text-emerald-400"}>{item.emotionRating}</span></div>
                      <div className="text-slate-400 mt-1 italic">"{item.notes}"</div>
                    </div>

                    {/* Coach reflection feedback (Feature 17) */}
                    <div className="bg-indigo-950/20 border border-indigo-500/20 rounded p-2.5 text-[10px] font-mono text-indigo-300 leading-relaxed">
                      <span className="font-bold block uppercase tracking-wider text-[9px] text-indigo-400 mb-0.5">Coach Reflection:</span>
                      {item.coachFeedback}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 text-[10px] font-mono text-slate-500 text-center">
              Learn from losses rule database locked & active.
            </div>
          </div>

          {/* 7. REAL-TIME LOG VIEWER */}
          <div className="lg:col-span-7 bg-[#1A1F2B] border border-slate-800 p-5 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-xs font-mono font-bold uppercase tracking-widest text-white flex items-center gap-1.5">
                    <Terminal size={14} className="text-emerald-400 animate-pulse" />
                    Autonomous Trace Log Reader
                  </h3>
                  <span className="text-[9px] font-mono text-slate-500 block mt-0.5">Live background transaction auditing</span>
                </div>

                {/* Log Control buttons */}
                <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 p-0.5 rounded">
                  <button
                    onClick={() => setIsLogPaused(!isLogPaused)}
                    className={`text-[9px] font-mono uppercase px-2 py-1 rounded transition-all ${
                      isLogPaused ? "bg-amber-600/20 text-amber-400 border border-amber-600/30" : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    {isLogPaused ? "Paused" : "Pause Live"}
                  </button>
                  <button
                    onClick={() => setLogsList(LOGS_SAMPLE)}
                    className="text-[9px] font-mono uppercase px-2 py-1 text-slate-400 hover:text-slate-200 rounded"
                  >
                    Clear Cache
                  </button>
                </div>
              </div>

              {/* Logs Filter row */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4 bg-slate-950 p-2 border border-slate-850 rounded font-mono text-[10px]">
                <div>
                  <label className="text-slate-500 block mb-1">Component</label>
                  <select
                    value={logFilterComponent}
                    onChange={(e) => setLogFilterComponent(e.target.value)}
                    className="bg-slate-900 text-white rounded p-1 outline-none w-full"
                  >
                    <option value="ALL">All Components</option>
                    <option value="CIO">CIO</option>
                    <option value="Scanner">Scanner</option>
                    <option value="Regime">Regime</option>
                    <option value="Pre-Trade">Pre-Trade</option>
                    <option value="Risk Manager">Risk Manager</option>
                    <option value="Execution">Execution</option>
                  </select>
                </div>
                <div>
                  <label className="text-slate-500 block mb-1">Severity</label>
                  <select
                    value={logFilterSeverity}
                    onChange={(e) => setLogFilterSeverity(e.target.value)}
                    className="bg-slate-900 text-white rounded p-1 outline-none w-full"
                  >
                    <option value="ALL">All Severities</option>
                    <option value="INFO">INFO</option>
                    <option value="SUCCESS">SUCCESS</option>
                    <option value="WARNING">WARNING</option>
                    <option value="ERROR">ERROR</option>
                  </select>
                </div>
                <div className="col-span-2 sm:col-span-1">
                  <label className="text-slate-500 block mb-1">Keyword Search</label>
                  <input
                    type="text"
                    value={logSearchQuery}
                    onChange={(e) => setLogSearchQuery(e.target.value)}
                    placeholder="Search messages..."
                    className="bg-slate-900 text-white rounded p-1 outline-none w-full"
                  />
                </div>
              </div>

              {/* Terminal View */}
              <div className="bg-slate-950/80 border border-slate-850 rounded p-4 font-mono text-[11px] leading-relaxed text-slate-300 min-h-64 max-h-80 overflow-y-auto space-y-2">
                {logsList
                  .filter(l => {
                    const matchesSearch = l.text.toLowerCase().includes(logSearchQuery.toLowerCase());
                    const matchesComp = logFilterComponent === "ALL" || l.component === logFilterComponent;
                    const matchesSev = logFilterSeverity === "ALL" || l.severity === logFilterSeverity;
                    return matchesSearch && matchesComp && matchesSev;
                  })
                  .map((log, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="text-slate-500 shrink-0">[{log.timestamp}]</span>
                      <span className={`font-bold shrink-0 ${
                        log.severity === "SUCCESS" ? "text-emerald-400" :
                        log.severity === "WARNING" ? "text-amber-400" :
                        log.severity === "ERROR" ? "text-rose-400" :
                        "text-sky-400"
                      }`}>
                        [{log.severity}]
                      </span>
                      <span className="text-indigo-400 shrink-0">[{log.component}]</span>
                      <span className="text-slate-200">{log.text}</span>
                    </div>
                  ))}
              </div>
            </div>

            {/* 8. EXPORT COMPLETE TRADING TRACE BUTTONS */}
            <div className="flex flex-wrap items-center justify-between border-t border-slate-800/80 pt-4 mt-6 gap-3">
              <span className="text-[10px] font-mono text-slate-500">Audit trace records package size: ~24.1KB</span>
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-mono text-slate-500 uppercase mr-1">Export:</span>
                <button
                  onClick={() => handleExportTrace("txt")}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded transition-colors"
                >
                  .txt
                </button>
                <button
                  onClick={() => handleExportTrace("json")}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded transition-colors"
                >
                  .json
                </button>
                <button
                  onClick={() => handleExportTrace("csv")}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded transition-colors"
                >
                  .csv
                </button>
              </div>
            </div>
          </div>

        </div>
      )}

      {/* FOOTER REPLAY OVERVIEW TIMELINE */}
      <div className="border-t border-slate-800/80 pt-6 mt-6 bg-[#0A0F16]">
        <div className="flex flex-col md:flex-row items-center justify-between gap-4 bg-[#111822] border border-slate-800/85 rounded-lg p-5">
          <div className="flex items-center gap-2.5">
            <span className="p-1.5 bg-sky-500/10 text-sky-400 rounded">
              <Sliders size={16} />
            </span>
            <div>
              <span className="text-[9px] font-mono uppercase text-slate-500 tracking-wider">System Operational Guardrail</span>
              <h4 className="text-xs font-mono font-bold text-white uppercase mt-0.5">Interactive Master Emergency Kill-Switch</h4>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-[10px] font-mono text-slate-400 max-w-sm text-right hidden xl:block">
              Force-halts all active strategy loops and blocks pending trade signals dynamically.
            </span>
            <button
              onClick={async () => {
                await toggleAutoBot();
                if (!autoBotConfig.enabled) {
                  setEnginesHalted(true);
                  setHaltReason("MANUAL INTERVENTION — KILLS SWITCH TRIGGERED BY RISK OFFICER");
                  setHaltTime(new Date().toLocaleTimeString());
                }
              }}
              className={`px-5 py-2.5 rounded font-mono font-bold uppercase text-[10px] tracking-widest border transition-all ${
                autoBotConfig.enabled
                  ? "bg-rose-500 hover:bg-rose-400 text-white shadow-[0_0_15px_rgba(239,68,68,0.3)] border-rose-600"
                  : "bg-slate-900 border-slate-800 text-slate-400 cursor-not-allowed"
              }`}
            >
              {autoBotConfig.enabled ? "HALT ALL SYSTEMS / SHUTDOWN BOT" : "BOT SYSTEM OFF"}
            </button>
          </div>
        </div>
      </div>

    </div>
  );
}
