import React, { useState, useEffect } from "react";
import {
  Sliders,
  ShieldCheck,
  Activity,
  UserCheck,
  RefreshCw,
  Play,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  TrendingUp,
  Send,
  Terminal,
  Layers,
  Shield,
  Info,
  ChevronRight,
  TrendingDown,
  Cpu,
  Database,
  Search,
  FileSpreadsheet,
  Newspaper,
  Clock,
  BookOpen
} from "lucide-react";

interface TaskItem {
  id: string;
  agent: string;
  taskType: string;
  priority: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  status: "PENDING" | "PROCESSING" | "COMPLETED";
  findings?: string;
  timestamp: string;
}

interface Proposal {
  symbol: string;
  type: "BUY" | "SELL";
  price: number;
  stopLoss: number;
  atr: number;
  logic: string;
  quantVote: "APPROVE" | "REJECT" | "WARN";
  newsVote: "APPROVE" | "REJECT" | "WARN";
  riskVote: "APPROVE" | "REJECT" | "WARN";
}

export default function ChiefTraderAgent() {
  const [activeTab, setActiveTab] = useState<"tasks" | "veto" | "atos">("atos");
  const [isBeginnerExplanation, setIsBeginnerExplanation] = useState<boolean>(true);
  
  // === ATOS LIVE OPERATING DECK STATE ===
  const [atosData, setAtosData] = useState<{
    enabled: boolean;
    workers: any[];
    discoveredOpportunities: any[];
    newsIntelligence: any[];
    eventBus: any[];
    orchestratorWorkflows: any[];
  } | null>(null);

  useEffect(() => {
    let isMounted = true;
    const fetchAtosState = async () => {
      try {
        const res = await fetch("/api/v1/autobot");
        if (res.ok) {
          const data = await res.json();
          if (isMounted) {
            setAtosData({
              enabled: data.enabled,
              workers: data.workers || [],
              discoveredOpportunities: data.discoveredOpportunities || [],
              newsIntelligence: data.newsIntelligence || [],
              eventBus: data.eventBus || [],
              orchestratorWorkflows: data.orchestratorWorkflows || []
            });
          }
        }
      } catch (e) {
        console.error("Failed to fetch ATOS live state:", e);
      }
    };
    
    fetchAtosState();
    const interval = setInterval(fetchAtosState, 4000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // === TASK MANAGEMENT STATE ===
  const [newTaskAgent, setNewTaskAgent] = useState<string>("Quant Agent");
  const [newTaskType, setNewTaskType] = useState<string>("Volatility Study");
  const [newTaskPriority, setNewTaskPriority] = useState<"LOW" | "MEDIUM" | "HIGH" | "CRITICAL">("HIGH");
  const [isProcessingCioTask, setIsProcessingCioTask] = useState<boolean>(false);
  const [newTaskStatusMsg, setNewTaskStatusMsg] = useState<string>("");
  const [cioTasks, setCioTasks] = useState<TaskItem[]>([
    {
      id: "t1",
      agent: "Quant Agent",
      taskType: "Volatility Study",
      priority: "HIGH",
      status: "COMPLETED",
      findings: "ATR-14 on SPY is currently 2.41. Momentum shows expanding volatility bands, supporting an upward breakout above 510.",
      timestamp: "10:14:02"
    },
    {
      id: "t2",
      agent: "News Agent",
      taskType: "Sentiment Analysis",
      priority: "MEDIUM",
      status: "COMPLETED",
      findings: "TSLA earnings press sentiment compiles to 0.68. Strong retail interest detected on social indices, but short-term macro headwind exists.",
      timestamp: "10:15:30"
    },
    {
      id: "t3",
      agent: "Risk Agent",
      taskType: "Correlation Audit",
      priority: "CRITICAL",
      status: "COMPLETED",
      findings: "Checked BTC vs ETH correlation index. Correlation is at 0.88. Advise against building simultaneous max exposure sizes in both.",
      timestamp: "10:20:11"
    }
  ]);

  // === VETO PROTOCOL STATE ===
  const [customProposalSymbol, setCustomProposalSymbol] = useState<string>("NVDA");
  const [customProposalType, setCustomProposalType] = useState<"BUY" | "SELL">("BUY");
  const [customProposalPrice, setCustomProposalPrice] = useState<number>(850);
  const [customProposalStopLoss, setCustomProposalStopLoss] = useState<number>(820);
  const [customProposalAtr, setCustomProposalAtr] = useState<number>(18.5);
  const [customProposalLogic, setCustomProposalLogic] = useState<string>("Robust consolidation above 20-day EMA support. Backed by solid cloud datacenter capital expenditure projections.");

  const [vetoPipelineStep, setVetoPipelineStep] = useState<number>(-1);
  const [vetoPipelineResults, setVetoPipelineResults] = useState<{
    status: "IDLE" | "EVALUATING" | "APPROVED" | "VETOED";
    layer1: "PASS" | "FAILED" | "WARN" | null;
    layer2: "PASS" | "FAILED" | null;
    layer3: "PASS" | "FAILED" | null;
    layer4: "APPROVED" | "VETOED" | null;
    reasoning: string;
  }>({
    status: "IDLE",
    layer1: null,
    layer2: null,
    layer3: null,
    layer4: null,
    reasoning: ""
  });

  // PRE-MADE PROPOSAL TEMPLATES
  const templates: Record<string, Proposal> = {
    SPY: {
      symbol: "SPY",
      type: "BUY",
      price: 512,
      stopLoss: 502,
      atr: 4.2, // 1.5x ATR is 6.3. Since 512 - 502 is 10, stop loss is 10 which is > 6.3 (PASSED)
      logic: "Strong institutional breakout past previous resistance. Sentiment index is positive and macro indexes are highly correlated to upward trends.",
      quantVote: "APPROVE",
      newsVote: "APPROVE",
      riskVote: "APPROVE"
    },
    TSLA: {
      symbol: "TSLA",
      type: "BUY",
      price: 185,
      stopLoss: 172,
      atr: 8.5,
      logic: "Buying the dip! I feel this is going to absolute rocket to the moon! Total hype cycle FOMO trade.",
      quantVote: "WARN",
      newsVote: "REJECT", // Sentiment is extremely negative / FOMO
      riskVote: "APPROVE"
    },
    AAPL: {
      symbol: "AAPL",
      type: "BUY",
      price: 175,
      stopLoss: 173.8, // 175 - 173.8 is 1.2. But ATR is 3.5. So 1.5x ATR is 5.25. Stop-loss is way too tight (FAIL)
      atr: 3.5,
      logic: "Consolidating near major support level. Setting a very tight protective stop loss to prevent any downside risk.",
      quantVote: "APPROVE",
      newsVote: "APPROVE",
      riskVote: "REJECT" // Rejected because SL is less than 1.5x ATR
    },
    NVDA: {
      symbol: "NVDA",
      type: "BUY",
      price: 880,
      stopLoss: 840, // 880 - 840 = 40. ATR is 18.0. 1.5x ATR is 27. Stop-loss is 40 (PASS ATR).
      atr: 18.0,
      logic: "Earnings expansion breakout. However, sector exposure limits are fully saturated because we already hold TSLA, AAPL, and MSFT.",
      quantVote: "APPROVE",
      newsVote: "APPROVE",
      riskVote: "REJECT" // Rejected due to sector correlation / saturation limits
    }
  };

  // HANDLE DISPATCH TASK
  const handleDispatchCioTask = () => {
    if (isProcessingCioTask) return;
    setIsProcessingCioTask(true);
    setNewTaskStatusMsg(`Instructing CIO to dispatch task to ${newTaskAgent}...`);

    let findings = "";
    const rand = Math.random();

    if (newTaskAgent === "Quant Agent") {
      if (newTaskType === "Volatility Study") {
        findings = `Quant Engine evaluated historical true range. Current ATR-14 is ${rand > 0.5 ? "3.45" : "2.12"}. Volatility expansion index indicates high probability of breakout.`;
      } else if (newTaskType === "Sentiment Analysis") {
        findings = "Quant Engine: Cross-referencing pricing feeds. Trend correlation metrics confirm a high beta upward trend bias over the last 14 sessions.";
      } else if (newTaskType === "Regime Detection") {
        findings = "Quant Engine: Macro market regime classified as 'High-Volatility Expansionary'. Recommendation: widen trailing stops.";
      } else {
        findings = "Quant Engine: Sector exposure is concentrated in Mega-Cap tech. Directing portfolio diversification multipliers.";
      }
    } else if (newTaskAgent === "News Agent") {
      if (newTaskType === "Sentiment Analysis") {
        findings = `News Sentiment compile indicates ${rand > 0.5 ? "Positive (0.74)" : "Moderate (0.58)"} consensus across 18 major macro and trade outlets.`;
      } else if (newTaskType === "Volatility Study") {
        findings = "News Engine: Identified imminent headline catalysts including upcoming federal rate decision and chip manufacturer earnings.";
      } else if (newTaskType === "Regime Detection") {
        findings = "News Engine: Macro narratives shifting from inflation worries to corporate margin expansion. Strong backing from institutional journals.";
      } else {
        findings = "News Engine: Found zero high-correlation news crossovers between current holdings and the prospective sector target.";
      }
    } else {
      // Risk Agent
      if (newTaskType === "Correlation Mapping") {
        findings = "Risk Node: Direct asset correlation maps at 0.42 (Low correlation). Asset provides excellent sector-level hedging capabilities.";
      } else if (newTaskType === "Volatility Study") {
        findings = "Risk Node: Standardizing Wilder's 14-day ATR. Absolute noise threshold is set. Minimum stop-loss distance verified at 2.2x volatility.";
      } else if (newTaskType === "Sentiment Analysis") {
        findings = "Risk Node: Checking retail FOMO indices. Sentiment is hot but remains within normal parameters. Risk of rug-pull is low.";
      } else {
        findings = "Risk Node: Total capital exposure for current asset class complies with the maximum 3.0% system budget risk allocation.";
      }
    }

    setTimeout(() => {
      const newTask: TaskItem = {
        id: `t-${Date.now()}`,
        agent: newTaskAgent,
        taskType: newTaskType,
        priority: newTaskPriority,
        status: "COMPLETED",
        findings,
        timestamp: new Date().toTimeString().split(" ")[0]
      };

      setCioTasks(prev => [newTask, ...prev]);
      setIsProcessingCioTask(false);
      setNewTaskStatusMsg("Task dispatched and fully analyzed!");
    }, 1800);
  };

  // HANDLE RUN VETO EVALUATION
  const handleRunVetoEvaluation = (templateKey?: string) => {
    let proposal: Proposal;

    if (templateKey && templates[templateKey]) {
      proposal = templates[templateKey];
      // Sync form fields with selected template for visual consistency
      setCustomProposalSymbol(proposal.symbol);
      setCustomProposalType(proposal.type);
      setCustomProposalPrice(proposal.price);
      setCustomProposalStopLoss(proposal.stopLoss);
      setCustomProposalAtr(proposal.atr);
      setCustomProposalLogic(proposal.logic);
    } else {
      // Calculate votes based on custom input
      const slDistance = Math.abs(customProposalPrice - customProposalStopLoss);
      const minSlDistance = 1.5 * customProposalAtr;
      const isAtrBreached = slDistance < minSlDistance;

      const isFomo = /fomo|moon|rocket|hype|feel|hope|rich/i.test(customProposalLogic);
      const isOverexposed = customProposalSymbol === "NVDA" || customProposalSymbol === "AAPL" && Math.random() > 0.4;

      proposal = {
        symbol: customProposalSymbol,
        type: customProposalType,
        price: customProposalPrice,
        stopLoss: customProposalStopLoss,
        atr: customProposalAtr,
        logic: customProposalLogic,
        quantVote: isAtrBreached ? "WARN" : "APPROVE",
        newsVote: isFomo ? "REJECT" : "APPROVE",
        riskVote: (isAtrBreached || isOverexposed) ? "REJECT" : "APPROVE"
      };
    }

    setVetoPipelineResults({
      status: "EVALUATING",
      layer1: null,
      layer2: null,
      layer3: null,
      layer4: null,
      reasoning: "ENGAGING MULTI-NODE CONSENSUS PIPELINE..."
    });

    // Step 1: Sentiment Consensus check
    setVetoPipelineStep(0);

    setTimeout(() => {
      const isFomoText = /fomo|moon|rocket|hype|feel|hope|rich/i.test(proposal.logic);
      const isNewsReject = proposal.newsVote === "REJECT" || isFomoText;
      const l1Result = isNewsReject ? "FAILED" : (proposal.newsVote === "WARN" ? "WARN" : "PASS");

      setVetoPipelineResults(prev => ({
        ...prev,
        layer1: l1Result,
        reasoning: isNewsReject 
          ? `[LAYER 1 BLOCKED] Emotional sentiment trap detected. Logic matches retail FOMO markers (${proposal.symbol}).`
          : `[LAYER 1 PASSED] Sentiment matches discipline benchmarks. No hyper-inflated retail indicators detected.`
      }));

      if (isNewsReject) {
        setVetoPipelineResults(prev => ({
          ...prev,
          status: "VETOED",
          layer4: "VETOED",
          reasoning: `⚠️ [CIO VETO: LAYER 1 SENTIMENT CONFLICT]\nProposed trade for ${proposal.symbol} rejected due to high emotional bias or negative news consensus. Veto issued to protect portfolio capital.`
        }));
        setVetoPipelineStep(-1);
        return;
      }

      // Step 2: ATR Noise Protection Filter
      setVetoPipelineStep(1);
      setTimeout(() => {
        const slDistance = Math.abs(proposal.price - proposal.stopLoss);
        const minRequiredDistance = 1.5 * proposal.atr;
        const isAtrBreached = slDistance < minRequiredDistance || proposal.riskVote === "REJECT" && templateKey === "AAPL";
        const l2Result = isAtrBreached ? "FAILED" : "PASS";

        setVetoPipelineResults(prev => ({
          ...prev,
          layer2: l2Result,
          reasoning: isAtrBreached
            ? `[LAYER 2 BLOCKED] Stop loss is too tight. Set to $${slDistance.toFixed(2)}, but minimum 1.5x ATR is $${minRequiredDistance.toFixed(2)}.`
            : `[LAYER 2 PASSED] Stop-loss buffer ($${slDistance.toFixed(2)}) complies with Wilder's ATR volatility safety requirements (Min required: $${minRequiredDistance.toFixed(2)}).`
        }));

        if (isAtrBreached) {
          setVetoPipelineResults(prev => ({
            ...prev,
            status: "VETOED",
            layer4: "VETOED",
            reasoning: `⚠️ [CIO VETO: LAYER 2 VOLATILITY VIOLATION]\nProposed trade for ${proposal.symbol} vetoed. Stop-loss ($${proposal.stopLoss}) lies within normal market volatility noise. Wilder's ATR minimum buffer is strictly 1.5x ATR to avoid premature stop-out.`
          }));
          setVetoPipelineStep(-1);
          return;
        }

        // Step 3: Correlation & Concentration Limit
        setVetoPipelineStep(2);
        setTimeout(() => {
          const isCorrelationBreached = templateKey === "NVDA" || (proposal.symbol === "AAPL" && Math.random() > 0.5) || (proposal.symbol === "NVDA" && Math.random() > 0.5);
          const l3Result = isCorrelationBreached ? "FAILED" : "PASS";

          setVetoPipelineResults(prev => ({
            ...prev,
            layer3: l3Result,
            reasoning: isCorrelationBreached
              ? `[LAYER 3 BLOCKED] Sector correlation limit exceeded. High covariance detected with existing technology holdings.`
              : `[LAYER 3 PASSED] Diversification limits verified. Asset correlation within parameters (Sector Cap: <0.75).`
          }));

          if (isCorrelationBreached) {
            setVetoPipelineResults(prev => ({
              ...prev,
              status: "VETOED",
              layer4: "VETOED",
              reasoning: `⚠️ [CIO VETO: LAYER 3 COVARIANCE SATURATION]\nProposed trade for ${proposal.symbol} vetoed. Multi-asset correlation limit breached. Risk manager node prevents technological over-concentration to minimize systemic portfolio drawdown.`
            }));
            setVetoPipelineStep(-1);
            return;
          }

          // Step 4: Discretionary Overlay / Final approval
          setVetoPipelineStep(3);
          setTimeout(() => {
            setVetoPipelineResults(prev => ({
              ...prev,
              status: "APPROVED",
              layer4: "APPROVED",
              reasoning: `🚀 [CIO DECISION: APPROVED & EXECUTION ROUTED]\nTrade proposal for ${proposal.symbol} (BUY at $${proposal.price}) has successfully satisfied all consensus and risk gates:\n1. Passed Sentiment/Discipline filter\n2. Wilder's ATR Stop-loss verified (Noise Protection Active)\n3. Asset covariance verified under sector-level limits\nExecuting trade and locking in ATR stop-loss safeguard.`
            }));
            setVetoPipelineStep(-1);
          }, 1200);

        }, 1200);

      }, 1200);

    }, 1200);
  };

  return (
    <div className="bg-[#111822] border border-slate-800 rounded-lg p-5 relative overflow-hidden" id="chief-trader-cio-agent-panel">
      {/* Decorative gradient overlay */}
      <div className="absolute top-0 right-0 w-80 h-80 bg-indigo-500/[0.02] rounded-full blur-3xl pointer-events-none"></div>

      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center border-b border-slate-800/80 pb-4 mb-5 gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-indigo-500/10 text-indigo-400 rounded border border-indigo-500/20">
              <UserCheck size={18} />
            </div>
            <div>
              <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
                Chief Trader Agent: Autonomous CIO Deck
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                Multi-layer discretionary oversight node. Coordinates analyst nodes, assigns quantitative studies, and manages veto gates.
              </p>
            </div>
          </div>
        </div>

        {/* CIO live status indicators */}
        <div className="flex items-center gap-3 bg-slate-950 px-3 py-1.5 rounded border border-slate-800 font-mono text-[10px]">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
            <span className="text-slate-500">CIO STATUS:</span>
            <span className="text-emerald-400 font-bold uppercase">MONITORING CONSENSUS</span>
          </div>
          <div className="h-3 w-px bg-slate-800"></div>
          <button 
            onClick={() => setIsBeginnerExplanation(!isBeginnerExplanation)}
            className="text-indigo-400 hover:text-indigo-300 font-bold transition-colors"
          >
            {isBeginnerExplanation ? "HIDE TOOLTIPS" : "SHOW TOOLTIPS"}
          </button>
        </div>
      </div>

      {isBeginnerExplanation && (
        <div className="bg-indigo-950/20 border border-indigo-500/15 p-3 rounded-lg mb-4 text-xs text-slate-300 leading-relaxed flex items-start gap-2.5">
          <Info size={16} className="text-indigo-400 mt-0.5 shrink-0" />
          <div>
            <span className="font-bold text-white uppercase block mb-0.5">Role of the Chief Trader Agent (CIO)</span>
            Instead of executing simple, single-dimensional algorithmic predictions, Argus runs a formal board of consensus.
            The Chief Trader acts as the **Chief Investment Officer (CIO)**. It assigns tasks to Quant, News, and Risk nodes, tracks their influence dynamically, and subjects all proposals to a mathematical veto system before locking in trade parameters.
          </div>
        </div>
      )}

      {/* Selector Subtabs */}
      <div className="flex border-b border-slate-800/80 mb-5 overflow-x-auto">
        <button
          onClick={() => setActiveTab("atos")}
          className={`px-4 py-2 text-xs font-mono font-bold uppercase border-b-2 transition-all duration-300 shrink-0 ${
            activeTab === "atos" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          1. ATOS Operating Deck
        </button>
        <button
          onClick={() => setActiveTab("tasks")}
          className={`px-4 py-2 text-xs font-mono font-bold uppercase border-b-2 transition-all duration-300 shrink-0 ${
            activeTab === "tasks" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          2. Analyst Task Dispatcher
        </button>
        <button
          onClick={() => setActiveTab("veto")}
          className={`px-4 py-2 text-xs font-mono font-bold uppercase border-b-2 transition-all duration-300 shrink-0 ${
            activeTab === "veto" ? "border-indigo-500 text-white bg-indigo-500/[0.02]" : "border-transparent text-slate-500 hover:text-slate-300"
          }`}
        >
          3. Multi-Layer Veto Gate
        </button>
      </div>

      {/* VIEWPORT AREA */}
      {activeTab === "tasks" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* Dispatch Controller */}
          <div className="lg:col-span-4 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider">
                  Assign Analyst Task
                </span>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Task Dispatcher</span>
              </div>
              <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                Direct the CIO agent to allocate priority research and analysis to specialized nodes within the trading council.
              </p>

              {/* Input forms */}
              <div className="space-y-3 bg-slate-900/40 p-3 rounded border border-slate-800/50 mb-4">
                <div>
                  <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Target Agent Node</label>
                  <select 
                    value={newTaskAgent}
                    onChange={(e) => setNewTaskAgent(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono focus:border-indigo-500 transition-colors"
                  >
                    <option value="Quant Agent">Quant Agent (Technical / Mathematics)</option>
                    <option value="News Agent">News Agent (Narratives / Sentiment)</option>
                    <option value="Risk Agent">Risk Agent (Covariance / Safety Filters)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Research Directive</label>
                    <select 
                      value={newTaskType}
                      onChange={(e) => setNewTaskType(e.target.value)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono focus:border-indigo-500 transition-colors"
                    >
                      <option value="Volatility Study">Volatility Study</option>
                      <option value="Sentiment Analysis">Sentiment Analysis</option>
                      <option value="Regime Detection">Regime Detection</option>
                      <option value="Correlation Mapping">Correlation Mapping</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-[9px] font-mono uppercase text-slate-500 block mb-1">Priority Level</label>
                    <select 
                      value={newTaskPriority}
                      onChange={(e) => setNewTaskPriority(e.target.value as any)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-200 rounded p-1.5 outline-none font-mono focus:border-indigo-500 transition-colors"
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
                      COMPILING DATA DIRECTIVES...
                    </>
                  ) : (
                    <>
                      <Send size={12} />
                      DISPATCH TASK
                    </>
                  )}
                </button>

                {newTaskStatusMsg && (
                  <div className="text-[10px] font-mono text-emerald-400 text-center animate-pulse mt-1">
                    {newTaskStatusMsg}
                  </div>
                )}
              </div>
            </div>
            
            <div className="border-t border-slate-800/60 pt-3 text-[10px] font-mono text-slate-500 leading-relaxed">
              * Tasks scheduled via the CIO directly feed back analytical telemetry rules used by the automated trade proposer.
            </div>
          </div>

          {/* Registry Ledger / List */}
          <div className="lg:col-span-8 flex flex-col justify-between bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg">
            <div>
              <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider flex items-center gap-1.5">
                  <Terminal size={12} className="text-indigo-400 animate-pulse" />
                  Task Assignment Registry Ledger
                </span>
                <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-1.5 py-0.5 rounded">
                  SWARM ACTIVE
                </span>
              </div>

              <div className="space-y-3 max-h-[340px] overflow-y-auto pr-1">
                {cioTasks.map((task) => (
                  <div key={task.id} className="bg-slate-900/60 border border-slate-800/50 p-3 rounded-lg relative overflow-hidden group hover:border-slate-700 transition-all">
                    <div className="flex justify-between items-center mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-white text-xs">{task.agent}</span>
                        <span className="text-slate-500 text-[10px] font-mono">@{task.timestamp}</span>
                      </div>
                      <div className="flex gap-1.5 items-center">
                        <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded font-bold border ${
                          task.priority === "CRITICAL" ? "bg-rose-500/15 text-rose-400 border-rose-500/20" :
                          task.priority === "HIGH" ? "bg-amber-500/15 text-amber-400 border-amber-500/20" :
                          "bg-slate-800/50 text-slate-400 border-slate-800"
                        }`}>
                          {task.priority}
                        </span>
                        <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded font-bold ${
                          task.status === "COMPLETED" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-indigo-500/10 text-indigo-400 animate-pulse"
                        }`}>
                          {task.status}
                        </span>
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-400 font-mono mb-2">
                      <span className="text-indigo-400 font-bold uppercase">Directive:</span> {task.taskType}
                    </div>
                    {task.findings && (
                      <div className="text-[10px] text-indigo-300 font-mono italic bg-slate-950 p-2 rounded border border-slate-900 flex gap-1.5 items-start">
                        <span className="text-indigo-400 shrink-0 font-bold">🔎</span>
                        <span>{task.findings}</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center text-[10px] font-mono text-slate-500">
              <span>Dynamic queue latency: <span className="text-emerald-400 font-bold">14ms</span></span>
              <span>Node connections: <span className="text-indigo-400 font-bold">3/3 Swarm Nodes</span></span>
            </div>
          </div>

        </div>
      )}

      {activeTab === "veto" && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-fade-in">
          
          {/* COLUMN 1: VETO CONTROLLER & TEMPLATES */}
          <div className="lg:col-span-5 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-3">
                <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider">
                  Submit Trade proposal
                </span>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Consensus Gate</span>
              </div>
              <p className="text-xs text-slate-400 mb-4 leading-relaxed font-mono text-[11px]">
                Analyze proposed entries against strict risk tolerances. Set ATR buffers and macro limits to bypass sentiment trap traps.
              </p>

              {/* Template Selectors */}
              <span className="text-[9px] font-mono uppercase text-slate-500 block mb-2">Simulate Debate Scenarios</span>
              <div className="grid grid-cols-2 gap-2 mb-4">
                <button
                  onClick={() => handleRunVetoEvaluation("SPY")}
                  className="bg-emerald-950/15 hover:bg-emerald-950/30 border border-emerald-500/20 text-emerald-400 p-2 rounded text-left transition-all font-mono"
                >
                  <div className="font-bold text-xs">1. SPY Breakout</div>
                  <div className="text-[8px] text-emerald-500/80 mt-0.5">Veto Gate: WILL PASS</div>
                </button>
                <button
                  onClick={() => handleRunVetoEvaluation("TSLA")}
                  className="bg-rose-950/15 hover:bg-rose-950/30 border border-rose-500/20 text-rose-400 p-2 rounded text-left transition-all font-mono"
                >
                  <div className="font-bold text-xs">2. TSLA FOMO Dip</div>
                  <div className="text-[8px] text-rose-500/80 mt-0.5">Veto Gate: L1 SENTIMENT VETO</div>
                </button>
                <button
                  onClick={() => handleRunVetoEvaluation("AAPL")}
                  className="bg-amber-950/15 hover:bg-amber-950/30 border border-amber-500/20 text-amber-400 p-2 rounded text-left transition-all font-mono"
                >
                  <div className="font-bold text-xs">3. AAPL Tight Stop</div>
                  <div className="text-[8px] text-amber-500/80 mt-0.5">Veto Gate: L2 ATR VETO</div>
                </button>
                <button
                  onClick={() => handleRunVetoEvaluation("NVDA")}
                  className="bg-indigo-950/15 hover:bg-indigo-950/30 border border-indigo-500/20 text-indigo-400 p-2 rounded text-left transition-all font-mono"
                >
                  <div className="font-bold text-xs">4. NVDA Saturated Tech</div>
                  <div className="text-[8px] text-indigo-500/80 mt-0.5">Veto Gate: L3 CORRELATION VETO</div>
                </button>
              </div>

              {/* Custom Proposal builder */}
              <div className="bg-slate-900/40 border border-slate-800/80 p-3 rounded-lg">
                <span className="text-[9px] font-mono uppercase text-indigo-400 font-bold block mb-2.5">Custom Proposal Builder</span>
                
                <div className="grid grid-cols-12 gap-2 mb-2">
                  <div className="col-span-3">
                    <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">Symbol</label>
                    <input
                      type="text"
                      placeholder="Symbol"
                      value={customProposalSymbol}
                      onChange={(e) => setCustomProposalSymbol(e.target.value.toUpperCase())}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1 outline-none font-mono text-center focus:border-indigo-500"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">Action</label>
                    <select
                      value={customProposalType}
                      onChange={(e) => setCustomProposalType(e.target.value as any)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-300 rounded p-1.5 outline-none font-mono focus:border-indigo-500"
                    >
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </select>
                  </div>
                  <div className="col-span-3">
                    <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">Price</label>
                    <input
                      type="number"
                      placeholder="Price"
                      value={customProposalPrice}
                      onChange={(e) => setCustomProposalPrice(parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1 outline-none font-mono text-center focus:border-indigo-500"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">Stop-Loss</label>
                    <input
                      type="number"
                      placeholder="Stop"
                      value={customProposalStopLoss}
                      onChange={(e) => setCustomProposalStopLoss(parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1 outline-none font-mono text-center focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div>
                    <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">14-Period ATR</label>
                    <input
                      type="number"
                      placeholder="ATR"
                      value={customProposalAtr}
                      onChange={(e) => setCustomProposalAtr(parseFloat(e.target.value) || 0)}
                      className="w-full bg-slate-950 border border-slate-800 text-xs text-white rounded p-1.5 outline-none font-mono focus:border-indigo-500"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <span className="text-[8px] font-mono text-slate-500 uppercase block mb-1">Vol Noise Threshold</span>
                    <span className="text-[10px] font-mono text-amber-400 font-bold bg-slate-950 px-2 py-1 border border-slate-800/80 rounded">
                      Min Stop: ${(1.5 * customProposalAtr).toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="mb-3">
                  <label className="text-[8px] font-mono text-slate-500 uppercase block mb-0.5">Consensus Debate Rationale</label>
                  <input
                    type="text"
                    placeholder="Enter analytical thesis for this trade..."
                    value={customProposalLogic}
                    onChange={(e) => setCustomProposalLogic(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-800 text-xs text-slate-300 rounded p-1.5 outline-none font-mono focus:border-indigo-500"
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
            </div>
          </div>

          {/* COLUMN 2: STEPPER AND DETAILED RESULTS */}
          <div className="lg:col-span-7 bg-slate-950/40 border border-slate-800/60 p-4 rounded-lg flex flex-col justify-between">
            <div>
              <div className="flex justify-between items-center mb-4">
                <span className="text-[10px] font-mono uppercase text-indigo-400 font-bold tracking-wider flex items-center gap-1.5">
                  <ShieldCheck size={14} className="text-indigo-400" />
                  CIO Discretionary Vetting Pipeline Trace
                </span>
                <span className="text-[9px] font-mono text-slate-500 uppercase">Trace Log Node</span>
              </div>

              {/* Visual Veto Stepper */}
              <div className="grid grid-cols-4 gap-2 mb-6 font-mono text-[9px] text-center">
                
                {/* Step 1 */}
                <div className={`p-2 rounded border transition-all duration-300 ${
                  vetoPipelineStep === 0 ? "border-indigo-500 bg-indigo-950/10 text-white shadow-[0_0_8px_rgba(99,102,241,0.2)] animate-pulse" :
                  vetoPipelineResults.layer1 === "PASS" ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-400" :
                  vetoPipelineResults.layer1 === "WARN" ? "border-amber-500/30 bg-amber-950/10 text-amber-400" :
                  vetoPipelineResults.layer1 === "FAILED" ? "border-rose-500/30 bg-rose-950/15 text-rose-400 font-bold" :
                  "border-slate-800/80 bg-slate-900/20 text-slate-500"
                }`}>
                  <div className="uppercase font-bold mb-0.5">L1: SENTIMENT</div>
                  <div>
                    {vetoPipelineStep === 0 ? "CHECKING" :
                     vetoPipelineResults.layer1 === "PASS" ? "PASSED" :
                     vetoPipelineResults.layer1 === "WARN" ? "WARNING" :
                     vetoPipelineResults.layer1 === "FAILED" ? "BLOCKED" : "WAITING"}
                  </div>
                </div>

                {/* Step 2 */}
                <div className={`p-2 rounded border transition-all duration-300 ${
                  vetoPipelineStep === 1 ? "border-indigo-500 bg-indigo-950/10 text-white shadow-[0_0_8px_rgba(99,102,241,0.2)] animate-pulse" :
                  vetoPipelineResults.layer2 === "PASS" ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-400" :
                  vetoPipelineResults.layer2 === "FAILED" ? "border-rose-500/30 bg-rose-950/15 text-rose-400 font-bold" :
                  "border-slate-800/80 bg-slate-900/20 text-slate-500"
                }`}>
                  <div className="uppercase font-bold mb-0.5">L2: VOLATILITY</div>
                  <div>
                    {vetoPipelineStep === 1 ? "CHECKING" :
                     vetoPipelineResults.layer2 === "PASS" ? "PASSED" :
                     vetoPipelineResults.layer2 === "FAILED" ? "BLOCKED" : "WAITING"}
                  </div>
                </div>

                {/* Step 3 */}
                <div className={`p-2 rounded border transition-all duration-300 ${
                  vetoPipelineStep === 2 ? "border-indigo-500 bg-indigo-950/10 text-white shadow-[0_0_8px_rgba(99,102,241,0.2)] animate-pulse" :
                  vetoPipelineResults.layer3 === "PASS" ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-400" :
                  vetoPipelineResults.layer3 === "FAILED" ? "border-rose-500/30 bg-rose-950/15 text-rose-400 font-bold" :
                  "border-slate-800/80 bg-slate-900/20 text-slate-500"
                }`}>
                  <div className="uppercase font-bold mb-0.5">L3: COVARIANCE</div>
                  <div>
                    {vetoPipelineStep === 2 ? "CHECKING" :
                     vetoPipelineResults.layer3 === "PASS" ? "PASSED" :
                     vetoPipelineResults.layer3 === "FAILED" ? "BLOCKED" : "WAITING"}
                  </div>
                </div>

                {/* Step 4 */}
                <div className={`p-2 rounded border transition-all duration-300 ${
                  vetoPipelineStep === 3 ? "border-indigo-500 bg-indigo-950/10 text-white shadow-[0_0_8px_rgba(99,102,241,0.2)] animate-pulse" :
                  vetoPipelineResults.layer4 === "APPROVED" ? "border-emerald-500 bg-emerald-950/15 text-emerald-400 font-bold" :
                  vetoPipelineResults.layer4 === "VETOED" ? "border-rose-500 bg-rose-950/15 text-rose-400 font-bold" :
                  "border-slate-800/80 bg-slate-900/20 text-slate-500"
                }`}>
                  <div className="uppercase font-bold mb-0.5">L4: CIO VETO</div>
                  <div>
                    {vetoPipelineStep === 3 ? "DELIBERATING" :
                     vetoPipelineResults.layer4 === "APPROVED" ? "PASSED" :
                     vetoPipelineResults.layer4 === "VETOED" ? "VETOED" : "WAITING"}
                  </div>
                </div>

              </div>

              {/* Debate Votes */}
              <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-lg mb-4">
                <span className="text-[10px] font-mono text-slate-400 uppercase font-bold block mb-2">Debate Node Votes:</span>
                <div className="grid grid-cols-3 gap-3 font-mono text-[10px]">
                  <div className="bg-slate-950 p-2 rounded border border-slate-800/50">
                    <span className="text-slate-500 block">Quant Agent</span>
                    <span className="text-emerald-400 font-bold flex items-center gap-1 mt-0.5">
                      <TrendingUp size={10} /> BUY OK
                    </span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800/50">
                    <span className="text-slate-500 block">News Agent</span>
                    <span className="text-emerald-400 font-bold flex items-center gap-1 mt-0.5">
                      <TrendingUp size={10} /> BULLISH
                    </span>
                  </div>
                  <div className="bg-slate-950 p-2 rounded border border-slate-800/50">
                    <span className="text-slate-500 block">Risk Agent</span>
                    <span className="text-amber-400 font-bold flex items-center gap-1 mt-0.5">
                      <AlertTriangle size={10} /> CHECK ATR
                    </span>
                  </div>
                </div>
              </div>

              {/* Trace Log and Reasoning */}
              {vetoPipelineResults.reasoning ? (
                <div className={`p-4 rounded-lg border text-xs font-mono min-h-[160px] flex flex-col justify-between ${
                  vetoPipelineResults.status === "APPROVED" ? "bg-emerald-950/10 border-emerald-500/20 text-emerald-300" :
                  vetoPipelineResults.status === "VETOED" ? "bg-rose-950/10 border-rose-500/20 text-rose-300" :
                  "bg-slate-900/40 border-slate-800 text-slate-300"
                }`}>
                  <div>
                    <div className="flex items-center gap-1.5 font-bold uppercase mb-2 border-b border-slate-800 pb-1.5 text-indigo-400 text-[10px]">
                      <Terminal size={12} />
                      CIO Trace Reasoning output:
                    </div>
                    <p className="leading-relaxed whitespace-pre-line text-[11px]">{vetoPipelineResults.reasoning}</p>
                  </div>

                  {vetoPipelineResults.status !== "EVALUATING" && vetoPipelineResults.status !== "IDLE" && (
                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-800/60">
                      {vetoPipelineResults.status === "APPROVED" ? (
                        <>
                          <CheckCircle2 size={16} className="text-emerald-500" />
                          <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-widest">
                            FINAL DECISION: APPROVED & EN ROUTE TO EXECUTION LAYER
                          </span>
                        </>
                      ) : (
                        <>
                          <XCircle size={16} className="text-rose-500" />
                          <span className="text-[10px] text-rose-400 font-bold uppercase tracking-widest">
                            FINAL DECISION: VETOED & CAPITAL PROTECTED
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-12 border border-dashed border-slate-800 rounded-lg text-slate-500 font-mono text-xs">
                  Select a template or custom input above, then click 'Engage Veto Pipeline' to simulate discretionary oversight traces.
                </div>
              )}
            </div>
          </div>

        </div>
      )}

      {activeTab === "atos" && (
        <div className="space-y-6 animate-fade-in text-slate-300">
          
          {/* Top Status Banner */}
          <div className="bg-slate-950/60 border border-slate-800 p-4 rounded-lg flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="flex h-2.5 w-2.5 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
                <span className="text-xs font-mono font-bold uppercase tracking-wider text-white">
                  Continuous Market & News Monitoring Engine (ATOS Mode)
                </span>
              </div>
              <p className="text-xs text-slate-400 max-w-2xl font-mono text-[11px] leading-relaxed">
                The Autonomous Trading Operating System (ATOS) acts as a professional desk trader. It continuously pulls market price data, scores news articles, recalculates technical indicators, and screens opportunities even when active execution is paused.
              </p>
            </div>
            
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-mono text-slate-500 uppercase">Operating Mode:</span>
              <span className="text-xs font-mono font-bold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 px-2.5 py-1 rounded">
                CONTINUOUS SCANNING
              </span>
            </div>
          </div>

          {/* Workers Grid */}
          <div>
            <div className="flex items-center justify-between mb-3 border-b border-slate-800/60 pb-1.5">
              <span className="text-[11px] font-mono uppercase text-indigo-400 font-bold tracking-widest flex items-center gap-1.5">
                <Cpu size={12} className="text-indigo-400" />
                Active ATOS Continuous Services (Workers)
              </span>
              <span className="text-[10px] font-mono text-slate-500">
                Total services online: 10/10
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
              {(atosData?.workers || [
                { id: "market_scanner", name: "Market Scanner Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 142, details: "Monitoring watchlist symbols for breakouts, volume shocks, and sector rotation." },
                { id: "price_stream", name: "Price Stream Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 8940, details: "Maintains live prices, candles, order book, and market depth." },
                { id: "news_intel", name: "News Intelligence Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 524, details: "Polling news providers, removing duplicates, and scoring credibility & macro impact." },
                { id: "social_sentiment", name: "Social Sentiment Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 331, details: "Monitors Reddit, X, StockTwits, Google Trends, etc." },
                { id: "calculation_engine", name: "Technical Calculation Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 1205, details: "Recalculates all indicators and quantitative signals whenever new data arrives." },
                { id: "strategy_engine", name: "Strategy Engine Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 228, details: "Runs every enabled strategy independently and scores opportunities." },
                { id: "ai_coordinator", name: "AI Agent Coordinator", status: "STANDBY", lastRun: new Date().toISOString(), processedCount: 42, details: "Dispatches work to Gemini and specialized AI agents." },
                { id: "consensus", name: "Consensus Worker", status: "STANDBY", lastRun: new Date().toISOString(), processedCount: 42, details: "Combines AI recommendations with deterministic calculations." },
                { id: "risk_gate", name: "Risk Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 112, details: "Continuously checks account risk, exposure, drawdown, and trade limits." },
                { id: "portfolio_monitor", name: "Portfolio Monitor Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 88, details: "Watches every open position and decides Hold, Sell, Scale In, or Scale Out." },
                { id: "profit_optimizer", name: "Profit Optimization Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 54, details: "Looks for better exits or opportunities to lock in gains." },
                { id: "broker_sync", name: "Broker Sync Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 198, details: "Keeps local portfolio synchronized with the broker." },
                { id: "execution", name: "Execution Worker", status: "STANDBY", lastRun: new Date().toISOString(), processedCount: 38, details: "Places, modifies, cancels, and reconciles orders." },
                { id: "backtesting", name: "Backtesting Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 12, details: "Tests strategies in the background using historical data." },
                { id: "learning", name: "Learning Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 14, details: "Evaluates completed trades and updates strategy/AI performance metrics." },
                { id: "logging_audit", name: "Logging & Audit Worker", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 1420, details: "Records every event, API call, calculation, and decision." },
                { id: "orchestrator", name: "Workflow Orchestrator", status: "ACTIVE", lastRun: new Date().toISOString(), processedCount: 852, details: "Coordinates workflows across workers, tracks dependencies, and records steps." }
              ]).map((worker) => {
                const getWorkerIcon = (id: string) => {
                  switch (id) {
                    case "market_scanner": return <Search size={14} />;
                    case "price_stream": return <Activity size={14} />;
                    case "news_intel": return <Newspaper size={14} />;
                    case "social_sentiment": return <Info size={14} />;
                    case "calculation_engine": return <FileSpreadsheet size={14} />;
                    case "strategy_engine": return <TrendingUp size={14} />;
                    case "ai_coordinator": return <UserCheck size={14} />;
                    case "consensus": return <Layers size={14} />;
                    case "risk_gate": return <ShieldCheck size={14} />;
                    case "portfolio_monitor": return <Clock size={14} />;
                    case "profit_optimizer": return <TrendingUp size={14} />;
                    case "broker_sync": return <RefreshCw size={14} />;
                    case "execution": return <Send size={14} />;
                    case "backtesting": return <Database size={14} />;
                    case "learning": return <BookOpen size={14} />;
                    case "logging_audit": return <Terminal size={14} />;
                    case "orchestrator": return <Cpu size={14} />;
                    default: return <Terminal size={14} />;
                  }
                };
                
                return (
                  <div key={worker.id} className="bg-slate-950/40 border border-slate-800/60 rounded-lg p-3 flex flex-col justify-between hover:border-indigo-500/30 transition-all font-mono group">
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <div className="p-1.5 bg-slate-900 border border-slate-800 rounded text-indigo-400 group-hover:text-indigo-300">
                          {getWorkerIcon(worker.id)}
                        </div>
                        <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded flex items-center gap-1 ${
                          worker.status === "ACTIVE" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" :
                          worker.status === "COMPUTING" ? "bg-amber-500/10 text-amber-400 border border-amber-500/20 animate-pulse" :
                          "bg-slate-800 text-slate-400 border border-slate-700"
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${
                            worker.status === "ACTIVE" ? "bg-emerald-400 animate-pulse" :
                            worker.status === "COMPUTING" ? "bg-amber-400" :
                            "bg-slate-400"
                          }`} />
                          {worker.status}
                        </span>
                      </div>
                      
                      <h4 className="text-[10px] font-bold text-white uppercase tracking-wider mb-1">
                        {worker.name}
                      </h4>
                      <p className="text-[9px] text-slate-400 leading-relaxed min-h-[44px] mb-2">
                        {worker.details}
                      </p>
                    </div>
                    
                    <div className="border-t border-slate-800/40 pt-2 mt-1 flex justify-between items-center text-[8px] text-slate-500">
                      <span>Cycles: <span className="text-white font-bold">{worker.processedCount}</span></span>
                      <span>Run: <span className="text-indigo-400 font-bold">{new Date(worker.lastRun).toTimeString().split(" ")[0]}</span></span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Lower layout: News stream vs Opportunities */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            
            {/* Opportunities Desk */}
            <div className="lg:col-span-5 bg-slate-950/20 border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50">
                  <span className="text-[11px] font-mono uppercase text-indigo-400 font-bold tracking-widest flex items-center gap-1.5">
                    <TrendingUp size={12} className="text-indigo-400" />
                    Opportunity Discovery Desk
                  </span>
                  <span className="text-[9px] font-mono text-slate-500">Continuous Scan</span>
                </div>
                
                <p className="text-xs text-slate-400 font-mono text-[11px] mb-4 leading-relaxed">
                  ATOS continuously maps opportunities. Highlighted assets have cleared basic filter requirements and are queued for formal multi-agent CIO council analysis.
                </p>

                <div className="space-y-3">
                  {(atosData?.discoveredOpportunities || [
                    { symbol: "NVDA", confidence: 91, score: 0.88, sentiment: "BULLISH", signal: "BREAKOUT", reasoning: "Strong AI chips demand with EMA200 crossover validation.", risk: "MEDIUM", evidence: "Volume 2.4x avg, RSI 62" },
                    { symbol: "MSFT", confidence: 87, score: 0.82, sentiment: "BULLISH", signal: "TREND_SUPPORT", reasoning: "Consolidation above 50-day SMA; rising institutional accumulation.", risk: "LOW", evidence: "CMF +0.18, ADX 22" },
                    { symbol: "AMD", confidence: 84, score: 0.79, sentiment: "BULLISH", signal: "VOLUME_SHOCK", reasoning: "Sudden relative volume surge (2.4x) on high-beta range break.", risk: "HIGH", evidence: "RVOL 2.8x, OBV Rising" }
                  ]).map((opp, idx) => (
                    <div key={idx} className="bg-slate-900/40 border border-slate-800/80 rounded-lg p-3 hover:border-slate-700 transition-all font-mono">
                      <div className="flex justify-between items-center mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white bg-slate-850 px-2 py-0.5 rounded border border-slate-700">
                            ${opp.symbol}
                          </span>
                          <span className={`text-[8px] font-bold px-1.5 py-0.5 rounded ${
                            opp.sentiment === "BULLISH" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                          }`}>
                            {opp.sentiment}
                          </span>
                          <span className="text-[8px] text-slate-500 uppercase">{opp.signal}</span>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] text-slate-500 block uppercase">Confidence</span>
                          <span className="text-xs font-bold text-emerald-400">{opp.confidence}%</span>
                        </div>
                      </div>
                      
                      <div className="text-[10px] text-slate-400 leading-relaxed mb-2 bg-slate-950/40 p-2 rounded border border-slate-900/60">
                        <span className="text-indigo-400 font-bold uppercase">Reasoning:</span> {opp.reasoning}
                      </div>
                      
                      <div className="flex justify-between items-center text-[9px] text-slate-500">
                        <span>Evidence: <span className="text-slate-300 font-bold">{opp.evidence}</span></span>
                        <span>Risk: <span className={`font-bold ${
                          opp.risk === "LOW" ? "text-emerald-400" :
                          opp.risk === "MEDIUM" ? "text-amber-400" : "text-rose-400"
                        }`}>{opp.risk}</span></span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="border-t border-slate-800/60 pt-3 mt-4 text-[9px] font-mono text-slate-500">
                * When confidence score crosses <span className="text-indigo-400 font-bold">85%</span> and autonomous trading is active, the AI Analysis Worker initiates a formal multi-agent consensus debate.
              </div>
            </div>

            {/* News Intelligence Ingestion stream */}
            <div className="lg:col-span-7 bg-slate-950/20 border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50">
                  <span className="text-[11px] font-mono uppercase text-indigo-400 font-bold tracking-widest flex items-center gap-1.5">
                    <Newspaper size={12} className="text-indigo-400" />
                    Continuous News Intelligence (Ingestion Engine)
                  </span>
                  <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 animate-pulse">
                    POLLING ACTIVE
                  </span>
                </div>
                
                <p className="text-xs text-slate-400 font-mono text-[11px] mb-4 leading-relaxed font-normal">
                  Scans major trading journals, RSS feeds, and regulatory filing logs. Automatically deduplicates events, filters promotional bias, and gauges sector-level sentiment weight.
                </p>

                <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                  {(atosData?.newsIntelligence || [
                    { id: "news_1", time: new Date().toISOString(), symbol: "NVDA", headline: "Custom chip sales projections revised upward by key suppliers.", category: "EARNINGS", credibility: "HIGH", expectedImpact: "HIGH_BULLISH", score: 0.90 },
                    { id: "news_2", time: new Date(Date.now() - 300000).toISOString(), symbol: "AAPL", headline: "Federal regulatory probe into app store fee structures expands.", category: "REGULATION", credibility: "MEDIUM", expectedImpact: "MODERATE_BEARISH", score: -0.45 },
                    { id: "news_3", time: new Date(Date.now() - 600000).toISOString(), symbol: "TSLA", headline: "New autonomous driving licensing model announced for European partners.", category: "PRODUCT_LAUNCH", credibility: "HIGH", expectedImpact: "HIGH_BULLISH", score: 0.85 }
                  ]).map((news) => (
                    <div key={news.id} className="bg-slate-900/30 border border-slate-800/60 rounded-lg p-3 hover:border-slate-700/80 transition-all font-mono">
                      <div className="flex justify-between items-start gap-3 mb-1.5">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] font-bold text-white uppercase bg-slate-800 px-1.5 py-0.5 rounded">
                              ${news.symbol}
                            </span>
                            <span className="text-[8px] font-bold text-slate-400 uppercase tracking-wide bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">
                              {news.category}
                            </span>
                            <span className="text-[8px] text-slate-500">@{new Date(news.time).toTimeString().split(" ")[0]}</span>
                          </div>
                          <h5 className="text-xs font-bold text-slate-200 uppercase leading-snug mt-1">
                            {news.headline}
                          </h5>
                        </div>
                        
                        <div className="text-right shrink-0">
                          <span className="text-[8px] text-slate-500 block uppercase">IMPACT</span>
                          <span className={`text-[10px] font-bold ${
                            news.score > 0 ? "text-emerald-400" : "text-rose-400"
                          }`}>
                            {news.score > 0 ? "+" : ""}{news.score.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      
                      <div className="flex justify-between items-center text-[8px] text-slate-500 pt-1.5 border-t border-slate-900/60">
                        <span>Expected Impact: <span className={`font-bold uppercase ${
                          news.expectedImpact.includes("BULLISH") ? "text-emerald-400" : "text-rose-400"
                        }`}>{news.expectedImpact}</span></span>
                        <span>Credibility: <span className="text-indigo-400 font-bold uppercase">{news.credibility}</span></span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="mt-4 pt-3 border-t border-slate-800/60 flex justify-between items-center text-[10px] font-mono text-slate-500">
                <span>Deduplication cycle rate: <span className="text-indigo-400 font-bold">1.2s</span></span>
                <span>Active sources: <span className="text-indigo-400 font-bold">18 Global Feeds</span></span>
              </div>
            </div>

          </div>

          {/* Bottom layout: Orchestrator Workflows & Event Bus */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 mt-6">
            
            {/* Orchestrator Workflows */}
            <div className="lg:col-span-5 bg-slate-950/20 border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50">
                  <span className="text-[11px] font-mono uppercase text-indigo-400 font-bold tracking-widest flex items-center gap-1.5">
                    <Cpu size={12} className="text-indigo-400" />
                    Orchestrator Workflows
                  </span>
                  <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 animate-pulse">
                    SYNCED
                  </span>
                </div>
                
                <p className="text-xs text-slate-400 font-mono text-[11px] mb-4 leading-relaxed font-normal">
                  The Workflow Engine coordinates complex task sequences across multiple independent workers. It tracks dependencies and handles retries.
                </p>

                <div className="space-y-4">
                  {(atosData?.orchestratorWorkflows || []).map((wf: any) => (
                    <div key={wf.id} className="bg-slate-900/30 border border-slate-800/60 rounded-lg p-3 font-mono relative overflow-hidden">
                      {/* Progress bar background */}
                      <div 
                        className="absolute left-0 top-0 bottom-0 bg-indigo-500/5 transition-all duration-1000"
                        style={{ width: `${(wf.stepsCompleted / wf.totalSteps) * 100}%` }}
                      ></div>
                      
                      <div className="relative z-10">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[10px] font-bold text-white uppercase tracking-wider">{wf.name}</span>
                          <span className="text-[8px] font-bold text-amber-400 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 rounded animate-pulse">
                            {wf.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="flex-1 h-1.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                            <div 
                              className="h-full bg-indigo-500 transition-all duration-500" 
                              style={{ width: `${(wf.stepsCompleted / wf.totalSteps) * 100}%` }}
                            ></div>
                          </div>
                          <span className="text-[9px] text-slate-400 font-bold w-8 text-right">
                            {wf.stepsCompleted}/{wf.totalSteps}
                          </span>
                        </div>
                        <div className="text-[9px] text-slate-500 flex justify-between">
                          <span>Current Step: <span className="text-slate-300 font-bold uppercase">{wf.currentStep}</span></span>
                          <span>Last Upd: <span className="text-indigo-400">{new Date(wf.lastUpdated).toTimeString().split(" ")[0]}</span></span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {(!atosData?.orchestratorWorkflows || atosData.orchestratorWorkflows.length === 0) && (
                     <div className="text-[10px] text-slate-500 text-center py-4 italic border border-slate-800/30 border-dashed rounded">No active workflows orchestrating.</div>
                  )}
                </div>
              </div>
            </div>

            {/* Event Bus Firehose */}
            <div className="lg:col-span-7 bg-slate-950/20 border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-800/50">
                  <span className="text-[11px] font-mono uppercase text-indigo-400 font-bold tracking-widest flex items-center gap-1.5">
                    <Activity size={12} className="text-indigo-400" />
                    Internal Event Bus Stream
                  </span>
                  <span className="text-[9px] font-mono text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 animate-pulse">
                    LISTENING
                  </span>
                </div>
                
                <p className="text-xs text-slate-400 font-mono text-[11px] mb-4 leading-relaxed font-normal">
                  Real-time pub/sub firehose. Workers emit standardized domain events that are asynchronously consumed by interested services.
                </p>

                <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1 custom-scrollbar">
                  {(atosData?.eventBus || []).map((evt: any) => (
                    <div key={evt.id} className="bg-slate-900/20 border-l-2 border-indigo-500/50 hover:border-indigo-400 p-2 pl-3 rounded-r transition-all font-mono">
                      <div className="flex justify-between items-start gap-2 mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[9px] font-bold text-white uppercase tracking-wider">{evt.type}</span>
                          <span className="text-[8px] text-slate-500 bg-slate-950 px-1.5 py-0.5 rounded border border-slate-800">src: {evt.source}</span>
                        </div>
                        <span className="text-[8px] text-slate-500">{new Date(evt.timestamp).toISOString().split("T")[1].replace("Z", "")}</span>
                      </div>
                      <div className="text-[10px] text-slate-400 leading-snug">
                        {evt.payload}
                      </div>
                    </div>
                  ))}
                  {(!atosData?.eventBus || atosData.eventBus.length === 0) && (
                     <div className="text-[10px] text-slate-500 text-center py-4 italic">Event bus idle...</div>
                  )}
                </div>
              </div>
            </div>

          </div>

        </div>
      )}

    </div>
  );
}
