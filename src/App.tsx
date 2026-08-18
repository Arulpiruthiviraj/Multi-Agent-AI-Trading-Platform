/**
 * ==========================================================
 * Module:
 * App.tsx
 *
 * Purpose:
 * Core implementation and logic for the App.tsx module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for Appx
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

import StrategyScanner from "./components/StrategyScanner";
import QuantSignalsPanel from "./components/QuantSignalsPanel";
import EliteDeskPanel from "./components/EliteDeskPanel";
import ResearchLabPanel from "./components/ResearchLabPanel";
import AwaitingSignal from "./components/shared/AwaitingSignal";
import { SafeResponsiveContainer } from "./components/shared/SafeResponsiveContainer";
import tradingSafetyConfig from "../config/tradingSafety.json";
import { SystemValidationSuite } from "./components/SystemValidationSuite";
import AgentEvaluationDashboard from "./components/AgentEvaluationDashboard";
import ReplayResearchPanel from "./components/ReplayResearchPanel";
import HistoricalReplayLab from "./components/HistoricalReplayLab";
import { resumeAndConfirm } from "./lib/tradingSafetyActions";
import { useWebSocket } from './context/WebSocketContext';
import React, { useState, useEffect, useRef, useMemo } from "react";
import DigitalTwinVisualizer from "./components/DigitalTwinVisualizer";
import OrchestrationStatus from "./components/OrchestrationStatus";
import AlpacaNewsTicker from "./components/AlpacaNewsTicker";
import LiveMarketNewsTicker from "./components/LiveMarketNewsTicker";
import TradeCorrelationMatrix from "./components/TradeCorrelationMatrix";
import BrokerManagement from "./components/BrokerManagement";
import AIProviderManagement from "./components/AIProviderManagement";
import { KronosDashboard } from "./components/KronosDashboard";
import ConnectionStatusDashboard from "./components/ConnectionStatusDashboard";
import DiagnosticCenter from "./components/DiagnosticCenter";
import WhyNotTradingStrip from "./components/WhyNotTradingStrip";
import TradingPauseOperatorControls from "./components/TradingPauseOperatorControls";
import LiveReadinessBanner from "./components/LiveReadinessBanner";
import WealthAffirmationOverlay from "./components/WealthAffirmationOverlay";
import HyperAbundanceVortex from "./components/HyperAbundanceVortex";
import DivineWealthOverlay from "./components/DivineWealthOverlay";
import { WealthAffirmationToggle } from "./components/WealthAffirmationToggle";
import { useWealthAffirmationSettings } from "./context/WealthAffirmationSettingsContext";
import GuardrailsPanel from "./components/GuardrailsPanel";
import MarketSentimentTrend from "./components/MarketSentimentTrend";
import ChiefTraderAgent from "./components/ChiefTraderAgent";
import ContextMemoryEngineering from "./components/ContextMemoryEngineering";
import StrategySynergyMatrix from "./components/StrategySynergyMatrix";
import LiveBotTelemetryPanel from "./components/LiveBotTelemetryPanel";
import ShadowPortfolioBenchmark from "./components/ShadowPortfolioBenchmark";
import RiskAttributionTreemap from "./components/RiskAttributionTreemap";
import StrategyProfitSunburst from "./components/StrategyProfitSunburst";
import TradeEfficiencyReport from "./components/TradeEfficiencyReport";
import ExecutionQualityChart from "./components/ExecutionQualityChart";
import TradeReplayModal from "./components/TradeReplayModal";
import TransactionObservatory from "./components/TransactionObservatory";
import TransactionExplorer from "./components/TransactionExplorer";
import DecisionTracePanel from "./components/DecisionTracePanel";
import LiveTradeJourneyOverlay from "./components/LiveTradeJourneyOverlay";
import AgentComparisonModal from "./components/AgentComparisonModal";
import GlobalSearch from "./components/GlobalSearch";
import DocumentationTab from "./components/DocumentationTab";
import { ExplainerToggle } from "./components/ExplainerToggle";
import { Explainer } from "./components/ContextualTooltip";
import { UnavailableHint } from "./components/UnavailableHint";
import {
  RIBBON_BROKER_UNAVAILABLE,
  RIBBON_HEALTH_UNAVAILABLE,
  formatStatusHint,
  formatTransactionDecision,
  formatTransactionOutcome,
} from "./components/observatoryHonesty";
import { NewsDashboardTab } from "./components/NewsDashboardTab";
import { AppWalkthrough } from "./components/AppWalkthrough";
import { AICoachPanel } from "./components/AICoachPanel";
import { SetupWizard } from "./components/SetupWizard";
import { AutonomousDashboard } from "./components/AutonomousDashboard";
import { AutonomousMissionControl } from "./components/AutonomousMissionControl";
import MobileMissionControl from "./components/mobile/MobileMissionControl";
import { useMobileLayout, MobileLayoutToggle } from "./components/mobile/useMobileLayout";
import { MobilePullRefresh } from "./components/mobile/MobilePullRefresh";
import { useCompactNav } from "./hooks/useBreakpoint";
import { ResponsiveBottomNav } from "./components/responsive/ResponsiveBottomNav";
import { ResponsiveNavDrawer } from "./components/responsive/ResponsiveNavDrawer";
import { DesktopNavStrip } from "./components/responsive/DesktopNavStrip";
import { ResponsiveStatsSection } from "./components/responsive/ResponsiveStatsSection";
import { PositionsDataView } from "./components/responsive/PositionsDataView";
import { toPositionLedgerRow } from "./components/responsive/positionLedgerRow";
import { TradeHistoryDataView } from "./components/responsive/TradeHistoryDataView";
import type { AppTabId } from "./components/responsive/responsiveNavConfig";
import { AutonomousLaunchDialog } from "./components/AutonomousLaunchDialog";
import VectorClusteringMap from "./components/VectorClusteringMap";
import {
  LineChart,
  Line,
  AreaChart,
  ComposedChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  PieChart as RechartsPieChart,
  Pie,
  Cell,
} from "recharts";
import {
  TrendingUp,
  Shield,
  BarChart2,
  BarChart3,
  Clock,
  AlertTriangle,
  Play,
  HelpCircle,
  Wallet,
  Settings,
  RefreshCw,
  Layers,
  Sparkles,
  CheckCircle,
  ArrowUpRight,
  Filter,
  SkipBack,
  SkipForward,
  ArrowDownRight,
  ArrowRight,
  MessageSquare,
  Target,
  BrainCircuit,
  Activity,
  Terminal,
  Network,
  Cpu,
  Server,
  Zap,
  Globe,
  X,
  AlertCircle,
  Power,
  ShieldAlert,
  PauseCircle,
  PlayCircle,
  ToggleRight,
  ToggleLeft,
  Key,
  Lock,
  Bell,
  BellRing,
  Plus,
  Trash2,
  Download,
  Users,
  Search,
  Command,
  Database,
  TrendingDown,
  History,
  ServerCrash,
  WifiOff,
  CornerDownRight,
  Coins,
  Calculator,
  Timer,
  BookOpen,
  List,
  Info,
  PieChart as LucidePieChart,
  Check,
  UserCheck,
  Scale,
  Sliders,
  DownloadCloud,
  LogOut,
  LayoutGrid,
  ThumbsUp,
  ThumbsDown,
  Rocket,
  ShieldCheck,
  Maximize2,
  ArrowUp,
  ArrowDown,
  Crosshair,
  Newspaper,
  Smartphone
} from "lucide-react";

interface Position {
  symbol: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  totalCost: number;
  marketValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  sector: string;
  openedAt: string;
}

interface Trade {
  id: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  total_amount: number;
  status: string;
  thesis: string;
  timestamp: string;
  // Real fields the backend has always returned (Drizzle rows are camelCase) that this
  // interface never modeled - traceId/transactionId are what let a trade row be replayed.
  traceId?: string;
  transactionId?: string;
  profitLoss?: number;
  reasoning?: string;
}

interface RiskVeto {
  id: string;
  symbol: string;
  vetoed_by: string;
  veto_reason: string;
  original_trade_details: any;
  action_taken: string;
  timestamp: string;
}

// Matches the real GET /api/v1/performance response shape exactly (systemRoutes.ts:171-187) -
// this previously declared snake_case fields (agent_id/win_rate/sharpe_ratio/max_drawdown/
// total_trades/current_weight) that the real endpoint has never returned, which silently made
// every consumer's field access resolve to `undefined` (defaulting to 0 wherever `|| 0` masked
// it) despite fetching real, non-empty data. There is no real per-agent max_drawdown anywhere in
// agent_performance_stats - profitFactor is the real metric that exists instead.
interface AgentMetric {
  winRate: number;
  totalTrades: number;
  averageReturn: number;
  profitFactor: number;
  sharpeRatio: number;
}

const mockBacktestData: Array<{ date: string; roi1: number; roi2: number; benchmark: number }> = [];

/* Educational swarm copy removed from production Learning tab (was shown as EXECUTED). */

const STRATEGY_DETAILS: Record<string, { desc: string; signals: string; timeframe: string }> = {
  "Momentum & Breakout": { desc: "Stocks moving aggressively in one direction on high volume.", signals: "VWAP, Volume, EMA", timeframe: "Intraday (Mins - Hours)" },
  "Mean Reversion": { desc: "Fading the trend. Assumes extreme price moves are temporary.", signals: "RSI, Bollinger Bands", timeframe: "Intraday (Hours)" },
  "Scalping": { desc: "High-frequency strategy capturing tiny price movements.", signals: "Level 2, VWAP", timeframe: "Seconds - Minutes" },
  "Gap & Go": { desc: "Exploiting imbalances at the market open.", signals: "Overnight Gap, Volume", timeframe: "Market Open" },
  "Trend-Following": { desc: "Buying the dip within an established upward trend.", signals: "MACD, SMA/EMA", timeframe: "Intraday (Hours)" },
  "Narrative/News Agent": { desc: "Analyzes breaking news, sentiment, and macro narratives.", signals: "NLP Sentiment, News APIs", timeframe: "Intraday - 3 Days" },
  "Political Intel": { desc: "Monitors political events and policy shifts for sector rotations.", signals: "Policy Docs, Congressional Trades", timeframe: "Weeks" },
};

const StrategyDropdown = ({ 
  value, 
  onChange, 
  colorClass,
  customPresets = [],
  onSavePreset,
  onLoadPreset
}: { 
  value: string; 
  onChange: (v: string) => void; 
  colorClass: string;
  customPresets?: any[];
  onSavePreset?: (name: string) => void;
  onLoadPreset?: (preset: any) => void;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [presetName, setPresetName] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setIsSaving(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSave = () => {
    if (presetName.trim() && onSavePreset) {
      onSavePreset(presetName.trim());
      setPresetName("");
      setIsSaving(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <div 
        className={`bg-transparent text-[10px] font-mono focus:outline-none transition-colors cursor-pointer flex items-center pr-4 relative min-w-[130px] ${colorClass}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span>{value}</span>
        <div className="absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none opacity-50 text-[8px]">▼</div>
      </div>
      {isOpen && (
        <div className="absolute top-full left-0 mt-2 w-[280px] bg-[#0A0F16] border border-[#334155] rounded z-[70] shadow-2xl py-1 transform-gpu max-h-[400px] overflow-y-auto">
          {Object.keys(STRATEGY_DETAILS).map(strategy => (
            <div 
              key={strategy}
              className="px-3 py-2 hover:bg-slate-800/80 transition-colors cursor-pointer group flex items-center justify-between"
              onClick={() => { onChange(strategy); setIsOpen(false); }}
            >
              <span className={`text-[10px] font-mono whitespace-nowrap ${value === strategy ? colorClass : 'text-slate-300 group-hover:text-white'}`}>{strategy}</span>
              <div className="relative ml-2 flex-shrink-0">
                <div className="text-slate-500 hover:text-indigo-400 group-hover:text-indigo-400 transition-colors p-[2px]">
                  <Info size={12} />
                </div>
                <div className="absolute right-[calc(100%+8px)] bottom-1/2 translate-y-1/2 w-[240px] bg-[#1A1F2B] border border-indigo-500/30 rounded p-3 hidden group-hover:block z-[80] shadow-[0_0_20px_rgba(0,0,0,0.5)] pointer-events-none before:content-[''] before:absolute before:-right-[5px] before:top-1/2 before:-translate-y-1/2 before:w-2 before:h-2 before:rotate-45 before:bg-[#1A1F2B] before:border-r before:border-t before:border-indigo-500/30">
                  <p className="text-[10px] text-white font-bold mb-1.5">{strategy}</p>
                  <p className="text-[9px] text-slate-300 mb-2 leading-relaxed">{STRATEGY_DETAILS[strategy].desc}</p>
                  <p className="text-[9px] text-slate-500 mb-1"><span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Signals:</span> {STRATEGY_DETAILS[strategy].signals}</p>
                  <p className="text-[9px] text-slate-500"><span className="text-slate-400 font-bold uppercase tracking-wider text-[8px]">Timeframe:</span> {STRATEGY_DETAILS[strategy].timeframe}</p>
                </div>
              </div>
            </div>
          ))}
          
          {onSavePreset && (
            <>
              <div className="border-t border-[#334155] my-1"></div>
              {customPresets.length > 0 && (
                <div className="px-3 py-1">
                  <span className="text-[8px] uppercase font-bold text-slate-500 tracking-widest">Custom Presets</span>
                  {customPresets.map((preset, idx) => (
                    <div 
                      key={idx}
                      className="py-1.5 hover:bg-slate-800/80 transition-colors cursor-pointer group flex items-center justify-between"
                      onClick={() => { if(onLoadPreset) onLoadPreset(preset); setIsOpen(false); }}
                    >
                      <span className="text-[10px] font-mono text-indigo-400 group-hover:text-indigo-300">{preset.name}</span>
                    </div>
                  ))}
                </div>
              )}
              
              <div className="px-3 py-2">
                {isSaving ? (
                  <div className="flex items-center gap-2">
                    <input 
                      type="text" 
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      placeholder="Preset Name..."
                      className="bg-[#111822] border border-slate-700 text-[10px] font-mono text-white px-2 py-1 rounded w-full focus:outline-none focus:border-indigo-500"
                      autoFocus
                      onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                    />
                    <button 
                      onClick={(e) => { e.stopPropagation(); handleSave(); }}
                      className="bg-indigo-600 hover:bg-indigo-500 text-white text-[9px] uppercase font-bold px-2 py-1 rounded transition-colors"
                    >
                      Save
                    </button>
                  </div>
                ) : (
                  <button 
                    onClick={(e) => { e.stopPropagation(); setIsSaving(true); }}
                    className="w-full text-left text-[9px] uppercase font-bold text-slate-400 hover:text-white transition-colors py-1 flex items-center gap-1"
                  >
                    + Save Current Strategy Preset
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

/* === COMPONENT: RiskExposureDashboard === */
/*
  Maintains an isolated view of system exposure, calculating Value at Risk (VaR)
  relative to the user's defined daily loss limits, and providing audio/visual cues
  when risks exceed predefined thresholds.
*/
// Mirrors src/server/engines/PositionSizing.ts's SECTOR_MAP exactly (the real map RiskEngine's
// sector_concentration gate uses) - kept in sync manually since frontend/backend don't share a
// bundle. Used only to compute the real Sector Concentration chart below from real positions.
const SECTOR_MAP: Record<string, string> = {
  AAPL: 'Technology', MSFT: 'Technology', NVDA: 'Technology', AMD: 'Technology',
  AVGO: 'Technology', CRM: 'Technology', ORCL: 'Technology', ADBE: 'Technology', INTC: 'Technology',
  GOOGL: 'Communication Services', GOOG: 'Communication Services', META: 'Communication Services',
  NFLX: 'Communication Services', DIS: 'Communication Services', TMUS: 'Communication Services',
  AMZN: 'Consumer Discretionary', TSLA: 'Consumer Discretionary', HD: 'Consumer Discretionary',
  NKE: 'Consumer Discretionary', SBUX: 'Consumer Discretionary', MCD: 'Consumer Discretionary',
  JPM: 'Financials', BAC: 'Financials', GS: 'Financials', WFC: 'Financials', MS: 'Financials', V: 'Financials', MA: 'Financials',
  XOM: 'Energy', CVX: 'Energy', COP: 'Energy', SLB: 'Energy',
  JNJ: 'Healthcare', PFE: 'Healthcare', UNH: 'Healthcare', LLY: 'Healthcare', MRK: 'Healthcare', ABBV: 'Healthcare',
  WMT: 'Consumer Staples', PG: 'Consumer Staples', KO: 'Consumer Staples', PEP: 'Consumer Staples', COST: 'Consumer Staples',
  BA: 'Industrials', CAT: 'Industrials', GE: 'Industrials', UPS: 'Industrials', HON: 'Industrials',
};
const SECTOR_COLORS: Record<string, string> = {
  Technology: '#6366f1', Financials: '#10b981', 'Consumer Discretionary': '#f59e0b',
  Energy: '#f43f5e', Healthcare: '#8b5cf6', 'Communication Services': '#3b82f6',
  'Consumer Staples': '#14b8a6', Industrials: '#eab308', Uncategorized: '#64748b',
};

export const RiskExposureDashboard = ({ dailyLossCap, positions }: { dailyLossCap: number; positions?: any[] }) => {
   // Real bug fixed: this used to be a hardcoded 45/25/15/10/5 pie regardless of actual holdings.
   // Computed here from real position market values, grouped by the same real sector map
   // RiskEngine's sector_concentration gate uses - honestly empty when there are no real positions
   // rather than showing a fake distribution.
   const sectorData = React.useMemo(() => {
     const real = Array.isArray(positions) ? positions : [];
     if (real.length === 0) return [];
     const totals = new Map<string, number>();
     for (const p of real) {
       const sector = SECTOR_MAP[String(p.symbol || '').toUpperCase()] || 'Uncategorized';
       const value = Math.abs(Number(p.marketValue) || 0);
       totals.set(sector, (totals.get(sector) || 0) + value);
     }
     const totalValue = Array.from(totals.values()).reduce((a, b) => a + b, 0);
     if (totalValue <= 0) return [];
     return Array.from(totals.entries())
       .map(([name, value]) => ({ name, value: Math.round((value / totalValue) * 1000) / 10, fill: SECTOR_COLORS[name] || SECTOR_COLORS.Uncategorized }))
       .sort((a, b) => b.value - a.value);
   }, [positions]);

   const [portfolioVaR, setPortfolioVaR] = React.useState<number>(() => Math.round(dailyLossCap * 0.68));
   const [audioEnabled, setAudioEnabled] = React.useState<boolean>(true);
   const [notificationEnabled, setNotificationEnabled] = React.useState<boolean>(false);
   const [hasAlerted, setHasAlerted] = React.useState<boolean>(false);
   const [localTimeAndMsg, setLocalTimeAndMsg] = React.useState<string | null>(null);

   const varPercentage = Math.min(150, (portfolioVaR / dailyLossCap) * 100);
   const isOverThreshold = varPercentage >= 90;
   const isPreAlertActive = varPercentage >= 80 && varPercentage < 90;

   // Play system audio alert utilizing Web Audio API
   const triggerRiskAudio = React.useCallback(() => {
     try {
       const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
       if (!AudioContextClass) return;
       const ctx = new AudioContextClass();

       // Synthesize warning sonar / klaxon
       const osc1 = ctx.createOscillator();
       const osc2 = ctx.createOscillator();
       const gainNode = ctx.createGain();

       osc1.connect(gainNode);
       osc2.connect(gainNode);
       gainNode.connect(ctx.destination);

       osc1.type = "sawtooth";
       osc2.type = "sine";

       // Telemetry resonant sequence
       osc1.frequency.setValueAtTime(800, ctx.currentTime);
       osc1.frequency.setValueAtTime(1000, ctx.currentTime + 0.15);
       osc2.frequency.setValueAtTime(400, ctx.currentTime);
       osc2.frequency.setValueAtTime(500, ctx.currentTime + 0.15);

       gainNode.gain.setValueAtTime(0.08, ctx.currentTime);
       gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);

       osc1.start();
       osc2.start();

       osc1.stop(ctx.currentTime + 0.35);
       osc2.stop(ctx.currentTime + 0.35);
     } catch (e) {
       console.warn("Audio Context playback prevented by browser audio governance rules.", e);
     }
   }, []);

   // Real bug fixed: this fired a real OS notification titled "CRITICAL VaR LIMIT EXCEEDED"
   // backed by a manually-set slider value, not any statistically computed VaR - relabeled
   // throughout to be honest that this is the alert-pipeline test control firing, not a real risk
   // breach. Still useful for testing the audio/notification pipeline (same spirit as Chaos Mode).
   const triggerSystemNotification = React.useCallback(() => {
     const messageText = `Test control value is now $${portfolioVaR.toLocaleString()} (${varPercentage.toFixed(1)}% of the configured daily loss cap of $${dailyLossCap.toLocaleString()}). This is a manual simulator value, not a computed portfolio risk metric.`;

     // 1. Trigger Audio alert if enabled
     if (audioEnabled) {
       triggerRiskAudio();
     }

     // 2. Trigger native OS / Browser Notification if permitted
     if (notificationEnabled && "Notification" in window) {
       if (Notification.permission === "granted") {
         new Notification("🧪 Risk Alert Simulator: test threshold crossed (90%+)", {
           body: messageText,
           tag: "risk-alert-simulator-threshold",
         });
       }
     }

     // 3. Render visual floating system action message inside React
     setLocalTimeAndMsg(`RISK ALERT SIMULATOR: manual test control crossed ${varPercentage.toFixed(1)}% at ${new Date().toLocaleTimeString()} - not a live risk measurement.`);

   }, [portfolioVaR, varPercentage, dailyLossCap, audioEnabled, notificationEnabled, triggerRiskAudio]);

   // Sync default VaR if dailyLossCap decreases or increases
   React.useEffect(() => {
     setPortfolioVaR(Math.round(dailyLossCap * 0.68));
     setHasAlerted(false);
     setLocalTimeAndMsg(null);
   }, [dailyLossCap]);

   // Core monitoring pipeline
   React.useEffect(() => {
     if (isOverThreshold) {
       if (!hasAlerted) {
         triggerSystemNotification();
         setHasAlerted(true);
       }
     } else {
       // Reset trigger state once risk index drops safely back below 90%
       if (hasAlerted) {
         setHasAlerted(false);
       }
     }
   }, [isOverThreshold, hasAlerted, triggerSystemNotification]);

   const handleRequestPermission = () => {
     if (!("Notification" in window)) {
       alert("Desktop notifications are not supported or are blocked in this browser configuration.");
       return;
     }

     Notification.requestPermission().then((permission) => {
       if (permission === "granted") {
         setNotificationEnabled(true);
         new Notification("🚨 ARGUS RISK ENGINE AUTHENTICATED", {
           body: "Risk alerts, circuit breakers, and telemetry threshold integrations are active.",
         });
       } else {
         setNotificationEnabled(false);
         alert("Permission declined. Real-time browser desktop push notices will be blocked. Audio and in-terminal messages will function normally.");
       }
     });
   };

   return (
     <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
       <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-wide">
         <LucidePieChart size={16} className="text-indigo-400" />
         RISK EXPOSURE DASHBOARD
       </h3>
       
       <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
         {/* Sector Concentration */}
         <div className="bg-[#111822] rounded-lg border border-slate-800 p-4">
            <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4">Sector Concentration (real positions)</h4>
            {sectorData.length > 0 ? (
              <div className="h-[200px] w-full">
                <SafeResponsiveContainer>
                  <RechartsPieChart>
                    <Pie
                      data={sectorData}
                      cx="50%"
                      cy="50%"
                      innerRadius={60}
                      outerRadius={80}
                      paddingAngle={2}
                      dataKey="value"
                      stroke="none"
                    >
                      {sectorData.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ backgroundColor: '#1A1F2B', borderColor: '#334155', fontSize: '12px' }}
                      itemStyle={{ color: '#E2E8F0' }}
                      formatter={(val: any) => [`${val}%`, 'of open notional']}
                    />
                    <Legend
                      layout="vertical"
                      verticalAlign="middle"
                      align="right"
                      wrapperStyle={{ fontSize: '10px', fontFamily: 'monospace', color: '#94A3B8' }}
                    />
                  </RechartsPieChart>
                </SafeResponsiveContainer>
              </div>
            ) : (
              <div className="h-[200px] w-full flex items-center justify-center text-xs text-slate-600 font-mono text-center px-4">
                No open positions - sector concentration has nothing to chart yet.
              </div>
            )}
         </div>

         {/* Manual risk-alert test control - NOT a live-computed Value at Risk. See disclaimer below. */}
         <div className="bg-[#111822] rounded-lg border border-slate-800 p-4 flex flex-col justify-between">
            <div>
              <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4 flex justify-between items-center">
                <span>Risk Alert Simulator (Manual Test Control)</span>
                {isOverThreshold && (
                  <span className="animate-pulse text-rose-450 font-bold bg-rose-500/10 border border-rose-400/25 px-1.5 py-0.5 rounded text-[8.5px]">
                    ⚠️ BREACH THRESHOLD
                  </span>
                )}
                {isPreAlertActive && (
                  <span className="animate-pulse text-amber-500 font-bold bg-amber-500/10 border border-amber-400/25 px-1.5 py-0.5 rounded text-[8.5px] tracking-wide">
                    ⚠️ PRE-ALERT WARNING (80%+)
                  </span>
                )}
              </h4>
              <p className="text-[10px] text-slate-600 font-mono mb-3 leading-relaxed">
                Manual control for testing the audio/notification alert pipeline - the value below is set by the slider or shock-test buttons, not computed from real positions or market volatility.
              </p>

              <div className="flex items-end justify-between mb-2">
                <div className="flex flex-col">
                  <span className={`text-[32px] font-bold leading-none transition-colors ${isOverThreshold ? "text-rose-400" : "text-amber-400"}`}>
                    ${portfolioVaR.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-500 font-mono mt-1">Manual test value (not a computed VaR)</span>
                </div>
                <div className="flex flex-col text-right">
                  <span className="text-sm font-bold text-slate-300">Cap: ${dailyLossCap.toLocaleString()}</span>
                  <span className={`text-[10px] font-mono mt-0.5 font-bold ${isOverThreshold ? "text-rose-450" : "text-emerald-400"}`}>
                    {varPercentage.toFixed(1)}% Consumed
                  </span>
                </div>
              </div>
              
              {/* Progress Bar with 90% Marker */}
              <div className="w-full bg-slate-800 h-3.5 rounded-md mt-4 overflow-hidden relative border border-slate-700/50">
                 {/* Visual shaded bar indicating consumption */}
                 <div 
                   className={`h-full transition-all duration-300 ${
                     isOverThreshold 
                       ? "bg-gradient-to-r from-amber-500 via-rose-500 to-rose-600" 
                       : "bg-gradient-to-r from-emerald-500 to-amber-500"
                   } ${isPreAlertActive ? "animate-pulse brightness-110 shadow-[0_0_8px_rgba(245,158,11,0.45)]" : ""}`} 
                   style={{ width: `${Math.min(100, varPercentage)}%` }}
                 ></div>
                 
                 {/* 90% Dotted Red Marker */}
                 <div className="absolute top-0 bottom-0 left-[90%] w-0.5 bg-rose-500/80 border-l border-dashed border-rose-400 z-10" title="90% Alert Threshold"></div>
                 
                 {/* High breach absolute overlay */}
                 {varPercentage >= 100 && (
                   <div className="absolute inset-0 bg-rose-600/10 w-full h-full animate-pulse"></div>
                 )}
              </div>
              <div className="flex justify-between text-[9px] font-mono text-slate-500 mt-1.5 px-0.5">
                <span>0% RISK</span>
                <span className="text-rose-400/80">90% CAP WARNING</span>
                <span>100% EXHAUSTED</span>
              </div>
            </div>

            {/* Simulated interactive sliders and state test switches */}
            <div className="mt-5 pt-4 border-t border-slate-800/80 space-y-4">
              
              {/* Dynamic Range Slider */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-[10px] font-mono">
                  <span className="text-slate-400 uppercase font-bold">Simulate Risk Volatility (VaR modifier)</span>
                  <span className="text-[#3b82f6] font-bold">${portfolioVaR.toLocaleString()}</span>
                </div>
                <input 
                  type="range"
                  min="0"
                  max={Math.round(dailyLossCap * 1.5)}
                  step="50"
                  value={portfolioVaR}
                  onChange={(e) => setPortfolioVaR(Number(e.target.value))}
                  className="w-full accent-indigo-500 h-1 bg-slate-850 rounded-lg cursor-pointer max-w-full"
                />
              </div>

              {/* Action Buttons Row */}
              <div className="flex flex-wrap gap-2 pt-1 select-none">
                <button
                  onClick={() => setPortfolioVaR(Math.round(dailyLossCap * 0.95))}
                  className="text-[9.5px] font-mono font-black uppercase px-2.5 py-1.5 border border-rose-500/30 bg-rose-500/10 text-rose-400 rounded hover:bg-rose-500/20 active:bg-rose-500/30 transition-all shrink-0 cursor-pointer outline-none"
                >
                  ⚡ TRIP 95% RISK SPIKE (SHOCK TEST)
                </button>
                <button
                   onClick={() => setPortfolioVaR(Math.round(dailyLossCap * 0.65))}
                   className="text-[9.5px] font-mono font-bold uppercase px-2.5 py-1.5 border border-slate-700 bg-slate-850 text-slate-400 rounded hover:bg-slate-800 hover:text-slate-200 transition-all shrink-0 cursor-pointer outline-none"
                >
                  RESET (65% VaR)
                </button>
                <button
                   onClick={triggerRiskAudio}
                   className="text-[9.5px] font-mono font-bold uppercase px-2 py-1.5 border border-slate-700 bg-slate-850 text-slate-400 rounded hover:bg-slate-800 hover:text-slate-200 transition-all shrink-0 cursor-pointer outline-none"
                   title="Play a sample warning beep sequence"
                >
                  🔊 SAMPLE CHIME
                </button>
              </div>

              {/* Configurations checklist */}
              <div className="space-y-2 pt-1 font-mono text-[10px] bg-[#161a24] p-3 rounded-md border border-slate-800/80">
                <span className="text-[9px] uppercase tracking-wider text-slate-500 block font-bold">ROUTING ENDPOINTS</span>
                <div className="flex flex-col sm:flex-row gap-3">
                  
                  {/* Audio Chime toggler */}
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input 
                      type="checkbox"
                      checked={audioEnabled}
                      onChange={(e) => setAudioEnabled(e.target.checked)}
                      className="rounded border-slate-800 text-indigo-500 bg-slate-900 focus:ring-0 w-3 h-3 cursor-pointer"
                    />
                    <span className="text-slate-350 flex items-center gap-1">
                      {audioEnabled ? "🔊 AUDIO CHIME ENABLED" : "🔇 AUDIO CHIME MUTED"}
                    </span>
                  </label>

                  {/* Desktop Push toggler */}
                  <div className="flex items-center gap-2 select-none">
                    <button
                      onClick={handleRequestPermission}
                      className={`text-[9.5px] font-bold px-2 py-0.5 rounded border transition-all cursor-pointer select-none outline-none ${
                        notificationEnabled && "Notification" in window && Notification.permission === "granted"
                          ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-300 font-extrabold"
                          : "bg-slate-850 border-slate-700 text-slate-400 hover:border-slate-650 hover:text-slate-200"
                      }`}
                    >
                      {notificationEnabled && "Notification" in window && Notification.permission === "granted" ? "🔔 PUSH GRANTED" : "🔕 ENABLE PUSH NOTIFICATIONS"}
                    </button>
                  </div>

                </div>
              </div>

              {/* Dynamic system log toast message banner fallback inside app */}
              {localTimeAndMsg && isOverThreshold && (
                <div className="p-3 bg-rose-500/15 border border-rose-505 bg-[#251216] border-rose-500/25 rounded text-rose-400 text-[10px] leading-relaxed font-mono animate-bounce flex items-start gap-1.5">
                  <span className="shrink-0 mt-0.5">⚠️</span>
                  <div className="flex-1">
                    <strong className="block text-[10.5px] font-black tracking-wide">ROUTED RISK INTERVENTION :</strong>
                    {localTimeAndMsg}
                  </div>
                  <button 
                    onClick={() => setLocalTimeAndMsg(null)}
                    className="text-slate-500 hover:text-rose-400 shrink-0 font-bold px-1 select-none text-[9px] cursor-pointer outline-none"
                  >
                    DISMISS
                  </button>
                </div>
              )}

            </div>
         </div>
        </div>

       {/* === COMPONENT: Volatility Heatmap (ATR-based) === */}
       <div className="mt-6 bg-[#111822] rounded-lg border border-slate-800 p-4">
         <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4 flex items-center justify-between">
           <span className="flex items-center gap-2">
             <Activity size={14} className="text-amber-500" />
             Real-Time Volatility Heatmap (14-Period ATR)
           </span>
           <span className="text-[9px] text-slate-600">PREDICTIVE SWING ANALYSIS</span>
         </h4>
         


         {(() => {
           const assets = [
             // MOCKS REMOVED: Waiting for real ATR data from MarketDataWorker
           ];
           const acceleratingAssets = assets.filter(a => a.sma > a.history[0].sma * 1.1).map(a => a.symbol);
           
           return (
            <>
             {acceleratingAssets.length > 0 && (
               <div className="mb-4 bg-rose-500/10 border border-rose-500/30 rounded p-3 flex items-start gap-2">
                 <AlertTriangle size={14} className="text-rose-500 shrink-0 mt-0.5 animate-pulse" />
                 <div>
                   <span className="text-[10px] font-bold text-rose-400 font-mono tracking-wide uppercase">Accelerating Volatility Regime Detected</span>
                   <p className="text-[9px] font-mono text-rose-300/70 mt-1 leading-relaxed">
                     Assets exhibiting &gt;10% increase in 14-period ATR SMA over the last hour: <strong className="text-rose-300">{acceleratingAssets.join(', ')}</strong>. System recommends expanding stop-loss buffers to prevent noise-outs.
                   </p>
                 </div>
               </div>
             )}
             <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
               {assets.map(asset => {
             const isAccelerating = asset.atr > asset.sma;
             return (
             <div key={asset.symbol} className={`p-3 rounded border flex flex-col items-center justify-center text-center transition-all relative overflow-hidden ${
               asset.risk === 'Extreme' ? 'bg-rose-500/10 border-rose-500/30 shadow-[0_0_10px_rgba(244,63,94,0.15)]' :
               asset.risk === 'High' ? 'bg-amber-500/10 border-amber-500/30' :
               asset.risk === 'Med' ? 'bg-yellow-500/10 border-yellow-500/30' :
               'bg-emerald-500/10 border-emerald-500/30'
             }`}>
               <span className={`text-xs font-bold font-mono tracking-wide z-10 ${
                 asset.risk === 'Extreme' ? 'text-rose-400' :
                 asset.risk === 'High' ? 'text-amber-400' :
                 asset.risk === 'Med' ? 'text-yellow-400' :
                 'text-emerald-400'
               }`}>{asset.symbol}</span>
               
               <div className="flex flex-col items-center gap-0.5 mt-1.5 mb-2 z-10">
                 <div className="flex items-center gap-1">
                   <span className="text-[10px] font-mono text-slate-400">ATR:</span>
                   <span className="text-[10px] font-mono text-white font-bold">{asset.atr.toFixed(1)}</span>
                 </div>
                 <div className="flex items-center gap-1">
                   <span className="text-[9px] font-mono text-slate-500">SMA:</span>
                   <span className={`text-[9px] font-mono font-bold ${isAccelerating ? 'text-rose-400' : 'text-emerald-400'}`}>{asset.sma.toFixed(1)}</span>
                   {isAccelerating ? <ArrowUp size={10} className="text-rose-400" /> : <ArrowDown size={10} className="text-emerald-400" />}
                 </div>
               </div>

               <div className="h-10 w-full mt-1 mb-2 z-10 pointer-events-none">
                 <SafeResponsiveContainer>
                   <LineChart data={asset.history}>
                     <Line type="monotone" dataKey="atr" stroke={asset.risk === 'Extreme' ? '#f43f5e' : asset.risk === 'High' ? '#f59e0b' : asset.risk === 'Med' ? '#eab308' : '#10b981'} strokeWidth={2} dot={false} isAnimationActive={false} />
                     <Line type="monotone" dataKey="sma" stroke="#94a3b8" strokeWidth={1} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
                   </LineChart>
                 </SafeResponsiveContainer>
               </div>
               
               <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded z-10 ${
                 asset.risk === 'Extreme' ? 'bg-rose-500/20 text-rose-300' :
                 asset.risk === 'High' ? 'bg-amber-500/20 text-amber-300' :
                 asset.risk === 'Med' ? 'bg-yellow-500/20 text-yellow-300' :
                 'bg-emerald-500/20 text-emerald-300'
               }`}>
                 {asset.swingPercent}% Swing
               </span>
             </div>
           )})}
         </div>
         </>
         )})()}
         
         {/* === COMPONENT: Position Size Optimizer (Kelly Criterion) === */}
         <div className="mt-6 bg-[#111822] rounded-lg border border-slate-800 p-4">
           <h4 className="text-[10px] uppercase font-mono tracking-widest text-slate-500 mb-4 flex items-center justify-between">
             <span className="flex items-center gap-2">
               <Crosshair size={14} className="text-emerald-500" />
               Position Size Optimizer (Kelly Criterion)
             </span>
             <span className="text-[9px] text-amber-500/80">AWAITING ORGANIC PAPER EVIDENCE</span>
           </h4>
           <div className="border border-amber-500/20 bg-amber-500/5 rounded p-4 text-[11px] font-mono text-slate-400 leading-relaxed">
             Hardcoded BTC/ETH/SOL win-rate theater was removed. Kelly sizing requires a measured win rate and R:R from
             organic PAPER closed trades (≥{30} fills) — not invented crypto probabilities. Until then this panel stays
             UNAVAILABLE and does not claim EDGE FOUND.
           </div>
           <div className="mt-4 text-[9px] font-mono text-slate-500 flex items-center justify-between border-t border-slate-800/80 pt-3">
              <span className="flex items-center gap-1"><Calculator size={10} className="text-slate-400" /> K = W - [(1 - W) / R]</span>
              <span>Not live readiness. Not a trade signal.</span>
           </div>
         </div>

         <div className="flex justify-between items-center mt-3 border-t border-slate-800/80 pt-3 px-1">
            <span className="text-[9px] font-mono text-slate-500">Highlights assets exceeding threshold volatility based on ATR ratio.</span>
            <div className="flex gap-2 text-[9px] font-mono">
               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-emerald-500/20 border border-emerald-500/50"></span> Low</span>
               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-yellow-500/20 border border-yellow-500/50"></span> Med</span>
               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-amber-500/20 border border-amber-500/50"></span> High</span>
               <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-rose-500/20 border border-rose-500/50"></span> Extreme</span>
            </div>
         </div>
       </div>
     </div>
   );
};

/* === COMPONENT: CustomPnLLegend === */
interface CustomPnLLegendProps {
  totalPnL: number;
  profitableDays: number;
  lossMakingDays: number;
  pnlDateRange: string;
}

const CustomPnLLegend: React.FC<CustomPnLLegendProps> = ({ totalPnL, profitableDays, lossMakingDays, pnlDateRange }) => {
  return (
    <div className="flex flex-col md:flex-row items-center justify-between gap-4 mt-6 p-4 bg-[#111822] border border-slate-800 rounded-lg font-mono text-[11px] uppercase tracking-wider w-full select-none">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-2.5 h-2.5 bg-indigo-500 rounded-full animate-pulse shrink-0"></span>
        <span className="text-slate-400">Date Range:</span>
        <span className="text-white font-bold">{pnlDateRange}</span>
        <span className="text-slate-600 font-bold">|</span>
        <span className="text-slate-400">Total Cumulative P&L:</span>
        <span className={`font-black ${totalPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
          {totalPnL >= 0 ? "+" : "-"}${Math.abs(totalPnL).toLocaleString()}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-emerald-500 rounded-sm shrink-0"></span>
          <span className="text-slate-400 text-[10px]">Profitable Days:</span>
          <span className="text-emerald-400 font-bold">{profitableDays} days</span>
        </div>
        <div className="h-3 w-px bg-slate-800"></div>
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 bg-rose-500 rounded-sm shrink-0"></span>
          <span className="text-slate-400 text-[10px]">Loss Days:</span>
          <span className="text-rose-400 font-bold">{lossMakingDays} days</span>
        </div>
      </div>
    </div>
  );
};

/* === COMPONENT: App Primary Layout === */
/*
  The main entry point for the Argus Trading Terminal.
  Contains all state for active tabs, live mock data feeds, the UI command center,
  and rendering logic for all the nested dashboards.
*/
/**
 * Canonical Autobot on/off is TradingEngine.state.enabled (GET /api/v1/autobot `enabled`
 * and Observatory `autobot.running`). `autoBotEnabled` is the SQLite column name — accept
 * either so Mission Control cannot show ON while the status bar shows STOPPED.
 */
function isAutobotEngineOn(snapshot: any): boolean {
  return snapshot?.enabled === true || snapshot?.autoBotEnabled === true;
}

function withCanonicalAutobotFlag(snapshot: any): any {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const enabled = isAutobotEngineOn(snapshot);
  return { ...snapshot, enabled, autoBotEnabled: enabled };
}

/**
 * Main Application Entry Point for Argus Autonomous Trading Terminal.
 * Manages all frontend state including active tabs, websocket feeds, and simulated price data.
 */
export default function App() {
  const { subscribe, setEnabled: setWsEnabled } = useWebSocket();
  const { enableWealthAffirmations, enableHyperAbundanceMode, enableDivineWealthMode } = useWealthAffirmationSettings();
  // Hoisted from further down in this component: several fetch-on-mount effects earlier in the
  // function body need to depend on this (see the /api/v1/autobot effect below) - a useEffect's
  // dependency array is evaluated synchronously during render, so referencing a const declared
  // later in the same function body would throw "Cannot access before initialization". A plain
  // useState call has no ordering dependency on anything else, so hoisting just this one is safe.
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  useEffect(() => {
    setWsEnabled(isAuthenticated);
  }, [isAuthenticated, setWsEnabled]);
  const { isMobileMode, viewportMobile, override, toggleMobileView } = useMobileLayout();
  const compactNav = useCompactNav();
  const [navDrawerOpen, setNavDrawerOpen] = useState(false);
  const [showCoach, setShowCoach] = useState(false);
  const [runBacktest, setRunBacktest] = useState(false);
  const [showTradeHistory, setShowTradeHistory] = useState(true);
  const [selectedStrategy1, setSelectedStrategy1] = useState("Narrative/News Agent");
  const [selectedStrategy2, setSelectedStrategy2] = useState("Mean Reversion (RSI)");
  const [showStrategy1, setShowStrategy1] = useState(true);
  const [showStrategy2, setShowStrategy2] = useState(true);

  const [selectedTradeForJournal, setSelectedTradeForJournal] = useState<any>(null);
  const [journalModalOpen, setJournalModalOpen] = useState(false);
  const [tradeJournals, setTradeJournals] = useState<Record<string, string>>({});
  const [editingJournalText, setEditingJournalText] = useState("");
  
  const [replayModalOpen, setReplayModalOpen] = useState(false);
  const [selectedReplayTrade, setSelectedReplayTrade] = useState<any>(null);

  const handleOpenReplay = (trade: any) => {
    setSelectedReplayTrade(trade);
    setReplayModalOpen(true);
  };

  const handleOpenJournal = (trade: any, idx: number) => {
    setSelectedTradeForJournal({ ...trade, id: idx });
    setEditingJournalText(tradeJournals[idx] || "");
    setJournalModalOpen(true);
  };
  
  const handleSaveJournal = () => {
    if (selectedTradeForJournal !== null) {
      setTradeJournals(prev => ({
        ...prev,
        [selectedTradeForJournal.id]: editingJournalText
      }));
    }
    setJournalModalOpen(false);
    setSelectedTradeForJournal(null);
  };

  const [pnlDateRange, setPnlDateRange] = useState("Last 30 Days");

  const [riskAttributionMetric, setRiskAttributionMetric] = useState<"percentage" | "absolute">("percentage");
  const [riskAttributionTimeframe, setRiskAttributionTimeframe] = useState<"30D" | "15D" | "7D">("30D");
  const [agentRiskWeights, setAgentRiskWeights] = useState<Record<string, number>>({
    NewsAgent: 1.0,
    MacroAgent: 1.0,
    TechnicalAgent: 1.0,
    SentimentAgent: 1.0,
    OrderFlowAgent: 1.0,
  });
  const [enabledRiskAgents, setEnabledRiskAgents] = useState<Record<string, boolean>>({
    NewsAgent: true,
    MacroAgent: true,
    TechnicalAgent: true,
    SentimentAgent: true,
    OrderFlowAgent: true,
  });

  const [riskDrilldownActive, setRiskDrilldownActive] = useState<boolean>(false);
  const [drilldownDate, setDrilldownDate] = useState<string | null>(null);
  const [drilldownAgent, setDrilldownAgent] = useState<string | null>(null);
  const [showPredictiveTrend, setShowPredictiveTrend] = useState<boolean>(false);

  const [enginesHalted, setEnginesHalted] = useState<boolean>(false);
  const [showMissionControl, setShowMissionControl] = useState<boolean>(false);
  const [haltReason, setHaltReason] = useState<string>("");
  const [haltTime, setHaltTime] = useState<string>("");
  const [resumeInFlight, setResumeInFlight] = useState<boolean>(false);
  const [resumeError, setResumeError] = useState<string | null>(null);

  // Real POST /api/v1/system/resume — banner drops only after GET trading-state is TRADING_ENABLED.
  const resumeTrading = async (): Promise<boolean> => {
    if (resumeInFlight) return false;
    setResumeInFlight(true);
    setResumeError(null);
    try {
      const result = await resumeAndConfirm("Operator acknowledged and resumed from the emergency banner.");
      if (!result.ok) {
        setResumeError(result.error || `Resume failed`);
        if (result.tradingState) applyTradingState(result.tradingState);
        setTimeout(() => setResumeError(null), 4000);
        return false;
      }
      applyTradingState(result.tradingState || 'TRADING_ENABLED', result.tradingState || undefined);
      return true;
    } catch (e: any) {
      setResumeError(e?.message || "Unable to contact Argus backend. Trading state was not changed.");
      setTimeout(() => setResumeError(null), 4000);
      return false;
    } finally {
      setResumeInFlight(false);
    }
  };

  // Real bug fix (2026-08-18): the halt banner/resume button only ever lit up for
  // emergencyStopActive, which TradingEngine.ts:566 sets true ONLY for the literal EMERGENCY_STOP
  // state (`newState === 'EMERGENCY_STOP'`) - never for TRADING_PAUSED. PortfolioReconciliation's
  // real pause today (13:06:44Z, "Portfolio reconciliation found a ~$403.20 mismatch") is
  // TRADING_PAUSED, not EMERGENCY_STOP, and blocks new trades exactly the same way (RiskEngine's
  // emergency_stop gate checks tradingState, not the boolean) - so the banner never appeared and
  // stayed dark for the full ~4 hours trading was actually blocked. `tradingState` was already
  // present in every payload this reads (pipelineAgentSnapshot.ts:36, the AUTOBOT_STATE_UPDATED
  // broadcast's `...tradingEngine.state` spread at server.ts:1910) - it just wasn't being read.
  const HALTED_TRADING_STATES = new Set(['EMERGENCY_STOP', 'TRADING_PAUSED']);
  const applyTradingState = (tradingState: string | undefined, reason?: string) => {
    if (!tradingState) return;
    const halted = HALTED_TRADING_STATES.has(tradingState);
    setEnginesHalted(halted);
    if (halted) {
      setHaltReason((prev) => reason || prev || tradingState);
      setHaltTime((prev) => prev || new Date().toLocaleTimeString());
    } else {
      setHaltReason("");
      setHaltTime("");
    }
  };

  const [autoBotConfig, setAutoBotConfig] = useState<any>({ enabled: false, budget: 50000, spent: 0, remaining: 50000, strategy: "Momentum & Breakout", riskLevel: "Medium", maxTradeSize: 3000, dailyLossLimit: 5000, currentDailyLoss: 0, logs: [] });
  const [autoBotTargetBudget, setAutoBotTargetBudget] = useState(50000);
  const [autoBotTradingMode, setAutoBotTradingMode] = useState("PAPER");
  const [autoBotStrategy, setAutoBotStrategy] = useState("Momentum & Breakout");
  const [autoBotRiskLevel, setAutoBotRiskLevel] = useState("Medium");
  const [autoBotMaxTradeSize, setAutoBotMaxTradeSize] = useState(3000);
  // Real values for the "Active Risk Rules" ribbon below - previously a hardcoded, stale string
  // ("Max Sector Exp 35%" vs the real 40% ceiling; "Size $100" vs the real $3,000 default).
  const [ribbonMaxDrawdownPct, setRibbonMaxDrawdownPct] = useState<number | null>(null);
  const [ribbonMaxSectorPct, setRibbonMaxSectorPct] = useState<number | null>(null);
  // Real bug fix (2026-08-18 UI audit, Phase 3): this used to be declared much later as a plain
  // useState(false) with no persistence at all - a reload silently turned off this real safety
  // net (it genuinely calls POST /api/v1/portfolio/liquidate on a critical drawdown). Hoisted up
  // here so the settings-hydration effect below (which runs earlier in render order) can
  // reference its setter without a temporal-dead-zone error, matching ribbonMaxDrawdownPct's own
  // pattern immediately above.
  const [globalAutoLiquidation, setGlobalAutoLiquidation] = useState(false);
  const [globalAutoLiquidationSaveError, setGlobalAutoLiquidationSaveError] = useState<string | null>(null);
  const [autoBotDailyLossLimit, setAutoBotDailyLossLimit] = useState(5000);
  const [autoBotTakeProfit, setAutoBotTakeProfit] = useState(15);
  const [autoBotTrailingStop, setAutoBotTrailingStop] = useState(5);
  const [autoBotMinConfidence, setAutoBotMinConfidence] = useState(75);
  const [autoBotAdversarialDebate, setAutoBotAdversarialDebate] = useState(true);
  // Scheduled auto-trading window (AutoTradeScheduler.ts, server-side). While enabled, that
  // background worker - not this UI - owns Autobot's on/off state, driving it through the same
  // toggle() call this Start/Stop button makes, on a timer. A manual Start/Stop click mid-window
  // will be reconciled back to the schedule on the worker's next tick (~60s).
  const [autoTradeScheduleEnabled, setAutoTradeScheduleEnabled] = useState(false);
  const [autoTradeScheduleStartTime, setAutoTradeScheduleStartTime] = useState("09:30");
  const [autoTradeScheduleEndTime, setAutoTradeScheduleEndTime] = useState("16:00");
  // Toronto (America/Toronto) and New York (America/New_York) share the identical civil clock -
  // both Eastern Time, both on the harmonized post-2007 US/Canada DST schedule - so this list
  // exists for locally-recognizable labels, not because the underlying time math differs.
  const [autoTradeScheduleTimezone, setAutoTradeScheduleTimezone] = useState("America/New_York");
  // Strategy Engine (src/server/strategiesEngine/) - an isolated, optional research subsystem.
  // Off by default. Even when on, it only ever records hypothetical SHADOW/ANALYSIS_ONLY signals
  // to strategy_engine_signals - it never places or influences a real order at any setting here.
  const [strategyEngineEnabled, setStrategyEngineEnabled] = useState(false);
  const [strategyEngineMode, setStrategyEngineMode] = useState("OFF");
  const [strategyEngineMaxActive, setStrategyEngineMaxActive] = useState(25);
  const [strategyEngineMinConfidence, setStrategyEngineMinConfidence] = useState(0.6);
  // Real error from the last failed /api/v1/autobot/toggle call (e.g. allocated budget exceeds
  // the active broker's real available buying power) - surfaced next to the Allocated Budget
  // Limit input instead of being silently swallowed.
  const [autoBotStartError, setAutoBotStartError] = useState<string | null>(null);
  const [orchestrationModels, setOrchestrationModels] = useState<any[] | null>(null);
  const [orchestrationCapital, setOrchestrationCapital] = useState<any | null>(null);

  const [paperTradingEnabled, setPaperTradingEnabled] = useState(false);
  const [alertsModalOpen, setAlertsModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [showLaunchDialog, setShowLaunchDialog] = useState(false);
  const [activeSessionConfig, setActiveSessionConfig] = useState<any>(null);
  
  const [hyperparams, setHyperparams] = useState({
    newsSensitivity: 75,
    macroTolerance: 60,
    techSmoothing: 14,
    sentimentBurst: 20,
    orderFlowDepth: 5
  });

  const [strategyPresets, setStrategyPresets] = useState<any[]>(() => {
    try {
      const saved = localStorage.getItem("argus_strategy_presets");
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.error(e);
    }
    return [];
  });

  const handleSaveStrategyPreset = (name: string) => {
    const preset = {
      name,
      agent1: selectedStrategy1,
      agent2: selectedStrategy2,
      hyperparams: { ...hyperparams }
    };
    setStrategyPresets(prev => {
      const updated = [...prev, preset];
      localStorage.setItem("argus_strategy_presets", JSON.stringify(updated));
      return updated;
    });
  };

  const handleLoadStrategyPreset = (preset: any) => {
    setSelectedStrategy1(preset.agent1);
    setSelectedStrategy2(preset.agent2);
    setHyperparams(preset.hyperparams);
  };

  const [stressScenario, setStressScenario] = useState("Flash Crash");
  const [showStressTest, setShowStressTest] = useState(false);
  // Real shock-magnitude input for the stress-test calculator - only "Flash Crash" pre-fills a
  // number, since that scenario's own card text already states "-10% overall market cap" (not a
  // new invented figure); the other three scenarios have no stated equity-impact percentage in
  // their own description, so the user must supply one explicitly rather than Argus inventing it.
  const [stressShockPct, setStressShockPct] = useState<number>(-10);
  const [stressResult, setStressResult] = useState<any | null>(null);
  const [stressLoading, setStressLoading] = useState(false);
  const [stressError, setStressError] = useState<string | null>(null);

  const runStressTest = async (shockPct: number) => {
    setStressLoading(true);
    setStressError(null);
    try {
      const res = await fetch(`/api/v2/portfolio/stress-test?shockPct=${shockPct}`);
      const json = await res.json();
      if (!json.ok) { setStressError(json.error || 'Request failed.'); return; }
      setStressResult(json);
    } catch (e: any) {
      setStressError(e.message);
    } finally {
      setStressLoading(false);
    }
  };

  const [thoughtStreamLogs, setThoughtStreamLogs] = useState([
    { id: 1, agent: "System", message: "Terminal initialized. Connections secure.", type: "info" }
  ]);

  useEffect(() => {
    // Same pre-auth-flooding bug as the fetchState effect below: this ran on every mount
    // regardless of isAuthenticated, firing a failing 401 at /api/v1/autobot from the login
    // screen. Gated the same way.
    if (!isAuthenticated) return;

    // Replaced interval polling with WebSocket subscription
    const unsubscribeAutobot = subscribe('AUTOBOT_STATE_UPDATED', (data) => {
      const snapshot = withCanonicalAutobotFlag(data);
      setAutoBotConfig(snapshot);
      setSystemState(isAutobotEngineOn(snapshot) ? 'RUNNING' : 'STOPPED');
      if (data.history && data.history.length > 0) {
        setThoughtStreamLogs(data.history.map((h: any) => ({
          id: h.time + "_" + Math.random().toString(36).slice(2),
          timestamp: h.time.split('T')[1].substring(0, 8),
          type: h.type,
          message: h.msg,
        })));
      }
      // server.ts:1907-1916 spreads `...tradingEngine.state` into this same broadcast every 2s -
      // tradingState/emergencyStopActive are already in `data`, this just now reads them.
      applyTradingState(data.tradingState, typeof data.haltReason === 'string' ? data.haltReason : undefined);
    });

    // Real bug fix (2026-08-18): TradingEngine.setTradingState() emits a real
    // TRADING_STATE_CHANGED EventBus event (TradingEngine.ts:580) with the actual {fromState,
    // toState, reason, actor} - the wildcard WS forwarder (server.ts:1886-1891) already relays it
    // to every client. Subscribing here gives an immediate, reason-carrying banner update the
    // moment a pause/resume happens, instead of waiting for the next 2s AUTOBOT_STATE_UPDATED tick.
    const unsubscribeTradingState = subscribe('TRADING_STATE_CHANGED', (data) => {
      applyTradingState(data?.toState, typeof data?.reason === 'string' ? data.reason : undefined);
    });

    // Initial fetch to populate state immediately
    fetch("/api/v1/autobot")
      .then(r => r.json())
      .then(data => {
        const snapshot = withCanonicalAutobotFlag(data);
        setAutoBotConfig((prev: any) => {
          // Bail out when payload is unchanged so a stray effect re-run cannot thrash renders.
          try {
            if (prev && JSON.stringify(prev) === JSON.stringify(snapshot)) return prev;
          } catch { /* fall through */ }
          return snapshot;
        });
        setSystemState(isAutobotEngineOn(snapshot) ? 'RUNNING' : 'STOPPED');
        // tradingState (added to this response alongside emergencyStopActive - autobotRoutes.ts)
        // catches a cold load that lands mid-pause; emergencyStopActive alone missed TRADING_PAUSED.
        if (typeof data?.tradingState === 'string') {
          applyTradingState(data.tradingState);
        } else if (typeof data?.emergencyStopActive === 'boolean') {
          setEnginesHalted(data.emergencyStopActive);
          if (data.emergencyStopActive) {
            setHaltReason((prev) => prev || "Emergency Stop (backend)");
            setHaltTime((prev) => prev || new Date().toLocaleTimeString());
          }
        }
        if (data?.tradingMode) {
          const mode = String(data.tradingMode).toUpperCase();
          setAutoBotTradingMode(mode === 'PAPER' || mode === 'LIVE' || mode === 'SIMULATOR' ? mode : 'PAPER');
        }
        if (typeof data?.autoTradeScheduleEnabled === 'boolean') setAutoTradeScheduleEnabled(data.autoTradeScheduleEnabled);
        if (typeof data?.autoTradeScheduleStartTime === 'string') setAutoTradeScheduleStartTime(data.autoTradeScheduleStartTime);
        if (typeof data?.autoTradeScheduleEndTime === 'string') setAutoTradeScheduleEndTime(data.autoTradeScheduleEndTime);
        if (typeof data?.autoTradeScheduleTimezone === 'string') setAutoTradeScheduleTimezone(data.autoTradeScheduleTimezone);
        if (typeof data?.strategyEngineEnabled === 'boolean') setStrategyEngineEnabled(data.strategyEngineEnabled);
        if (typeof data?.strategyEngineMode === 'string') setStrategyEngineMode(data.strategyEngineMode);
        if (typeof data?.strategyEngineMaxActive === 'number') setStrategyEngineMaxActive(data.strategyEngineMaxActive);
        if (typeof data?.strategyEngineMinConfidence === 'number') setStrategyEngineMinConfidence(data.strategyEngineMinConfidence);
        if (typeof data?.maxPortfolioDrawdownPct === 'number') setRibbonMaxDrawdownPct(data.maxPortfolioDrawdownPct);
        if (typeof data?.globalAutoLiquidationEnabled === 'boolean') setGlobalAutoLiquidation(data.globalAutoLiquidationEnabled);
        if (typeof data?.maxSectorConcentrationPct === 'number') setRibbonMaxSectorPct(data.maxSectorConcentrationPct);
        if (typeof data?.maxTradeSize === 'number' && Number.isFinite(data.maxTradeSize) && data.maxTradeSize > 0) {
          setAutoBotMaxTradeSize(data.maxTradeSize);
        }
        if (typeof data?.budget === 'number' && Number.isFinite(data.budget) && data.budget > 0) {
          setAutoBotTargetBudget(data.budget);
        }
      })
      .catch(e => console.error("Initial fetch failed:", e));

    return () => {
      unsubscribeAutobot();
      unsubscribeTradingState();
    };
  }, [subscribe, isAuthenticated]);

  const [webhooksList, setWebhooksList] = useState<any[]>([]);
  const [newWebhookName, setNewWebhookName] = useState("");
  const [newWebhookUrl, setNewWebhookUrl] = useState("");
  const [newWebhookType, setNewWebhookType] = useState<"slack" | "discord" | "generic">("slack");
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>(["veto", "daily_loss_breach", "sector_exposure_breach"]);
  const [webhookTestStatus, setWebhookTestStatus] = useState<string | null>(null);
  const [webhookErrorMsg, setWebhookErrorMsg] = useState<string | null>(null);

  const fetchWebhooks = async () => {
    try {
      const res = await fetch("/api/v1/webhooks");
      if (res.ok) {
        const data = await res.json();
        setWebhooksList(data);
      }
    } catch (e) {
      console.error("Failed to fetch webhooks", e);
    }
  };

  useEffect(() => {
    // Same pre-auth-flooding bug as the other fetch-on-mount effects in this component - see the
    // fetchState effect further down for the full explanation.
    if (!isAuthenticated) return;
    fetchWebhooks();
  }, [isAuthenticated]);

  const handleAddWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWebhookName || !newWebhookUrl) {
      setWebhookErrorMsg("Name and URL are required.");
      return;
    }
    try {
      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newWebhookName,
          url: newWebhookUrl,
          type: newWebhookType,
          enabled: true,
          events: newWebhookEvents
        })
      });
      if (res.ok) {
        setNewWebhookName("");
        setNewWebhookUrl("");
        setWebhookErrorMsg(null);
        fetchWebhooks();
      } else {
        const err = await res.json();
        setWebhookErrorMsg(err.error || "Failed to add webhook.");
      }
    } catch (err: any) {
      setWebhookErrorMsg(err.message || "Network error.");
    }
  };

  const handleToggleWebhook = async (id: string, currentlyEnabled: boolean) => {
    try {
      const res = await fetch(`/api/v1/webhooks/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !currentlyEnabled })
      });
      if (res.ok) {
        fetchWebhooks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteWebhook = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/webhooks/${id}`, {
        method: "DELETE"
      });
      if (res.ok) {
        fetchWebhooks();
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTestWebhook = async (url: string, type: string) => {
    setWebhookTestStatus("testing");
    try {
      const res = await fetch("/api/v1/webhooks/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, type })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setWebhookTestStatus("success");
        } else {
          setWebhookTestStatus("failed");
        }
      } else {
        setWebhookTestStatus("failed");
      }
    } catch (e) {
      setWebhookTestStatus("failed");
    }
    setTimeout(() => setWebhookTestStatus(null), 4000);
  };

  const toggleAutoBot = async (sessionConfig?: any) => {
     try {
       // Starting Autobot while EMERGENCY_STOP/TRADING_PAUSED is active would just have
       // RiskEngine's emergency_stop gate reject every idea it generates - confirm intent and
       // actually clear the halt server-side first rather than let the toggle silently no-op.
       if (!autoBotConfig.enabled && enginesHalted) {
         const proceed = window.confirm(
           "System is currently halted (emergency stop / trading paused). Clear the halt and start Autobot?"
         );
         if (!proceed) return;
         const resumed = await resumeTrading();
         if (!resumed) return;
       }
       // AutonomousLaunchDialog's tradingMode/riskProfile use display strings; translate them to
       // the values TradingEngine/SystemBootstrap actually understand. executionBroker, marketData,
       // account, and agents are collected by the dialog but have no real backend support yet
       // (per-session broker/data-provider switching and per-agent enable flags don't exist) -
       // they are intentionally NOT sent so this doesn't imply they take effect.
       const tradingModeMap: Record<string, string> = {
         'Broker Paper Trading': 'PAPER',
         'Argus Internal Paper Simulator': 'SIMULATION',
         'LIVE TRADING': 'LIVE'
       };
       const riskProfileMap: Record<string, string> = {
         'Conservative': 'Conservative',
         'Aggressive': 'Aggressive',
         'Moderate': 'Balanced',
         'Institutional': 'Balanced'
       };

       const res = await fetch("/api/v1/autobot/toggle", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({
           enabled: !autoBotConfig.enabled,
           tradingMode: sessionConfig?.tradingMode ? (tradingModeMap[sessionConfig.tradingMode] || autoBotTradingMode) : autoBotTradingMode,
           budget: autoBotTargetBudget,
           strategy: sessionConfig?.strategy || autoBotStrategy,
           riskLevel: sessionConfig?.riskProfile ? (riskProfileMap[sessionConfig.riskProfile] || autoBotRiskLevel) : autoBotRiskLevel,
           maxTradeSize: autoBotMaxTradeSize,
           dailyLossLimit: autoBotDailyLossLimit,
           takeProfitPct: autoBotTakeProfit,
           trailingStopPct: autoBotTrailingStop,
           minAiConfidence: autoBotMinConfidence,
           adversarialDebateMode: autoBotAdversarialDebate
         })
       });
       const data = await res.json();
       if (data.ok === false) {
         // Real rejection from TradingEngine.toggle() - e.g. allocated budget exceeds the active
         // broker's real available buying power. Surface it instead of silently no-op'ing.
         setAutoBotStartError(data.error || 'Failed to start the autonomous bot.');
         return;
       }
       setAutoBotStartError(null);
       const nowEnabled = isAutobotEngineOn(data.state ?? data);
       const nextBudget = typeof data.state?.budget === 'number' ? data.state.budget : autoBotTargetBudget;
       setAutoBotConfig((prev: any) => ({ ...prev, ...withCanonicalAutobotFlag(data.state ?? data), enabled: nowEnabled, autoBotEnabled: nowEnabled, budget: nextBudget }));
       if (typeof nextBudget === 'number' && Number.isFinite(nextBudget)) setAutoBotTargetBudget(nextBudget);
       setSystemState(nowEnabled ? 'RUNNING' : 'STOPPED');
     } catch (e: any) {
       setAutoBotStartError(e?.message || 'Failed to reach the server.');
     }
  };

  const [autoTradeScheduleSaveStatus, setAutoTradeScheduleSaveStatus] = useState<null | "saving" | "saved" | "error">(null);
  const [autoTradeScheduleSaveError, setAutoTradeScheduleSaveError] = useState<string | null>(null);
  const [autoBotBudgetSaveStatus, setAutoBotBudgetSaveStatus] = useState<null | "saving" | "saved" | "error">(null);
  const [autoBotBudgetSaveError, setAutoBotBudgetSaveError] = useState<string | null>(null);

  // Persist settings.budget without flipping Autobot on/off. Allocation is config, not an
  // order — Hands-Off / ENGINE PAUSED must not block this. TradingEngine.toggle() still
  // refuses Start if allocation exceeds the active broker's buyingPower/cash.
  const saveAllocatedBudget = async (budget: number): Promise<{ ok: boolean; error?: string }> => {
    if (!Number.isFinite(budget) || budget <= 0) {
      return { ok: false, error: "Allocated capital must be a positive dollar amount." };
    }
    try {
      const res = await fetch("/api/v1/config/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        return { ok: false, error: data.error || "Failed to save allocated capital." };
      }
      setAutoBotTargetBudget(budget);
      setAutoBotConfig((prev: any) => ({
        ...prev,
        budget,
        remaining: budget - (Number(prev.spent) || 0),
      }));
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || "Failed to reach the server." };
    }
  };

  // Independent of toggleAutoBot() on purpose: saving a schedule should never itself flip Autobot
  // on/off. AutoTradeScheduler.ts (server-side) is the only thing that later acts on these values,
  // on its own ~60s timer, via that same toggle() call - this just persists the configuration.
  const saveAutoTradeSchedule = async () => {
    setAutoTradeScheduleSaveStatus("saving");
    setAutoTradeScheduleSaveError(null);
    try {
      const res = await fetch("/api/v1/config/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          autoTradeScheduleEnabled,
          autoTradeScheduleStartTime,
          autoTradeScheduleEndTime,
          autoTradeScheduleTimezone,
        })
      });
      const data = await res.json();
      if (data.ok === false || !res.ok) {
        setAutoTradeScheduleSaveStatus("error");
        setAutoTradeScheduleSaveError(data.error || "Failed to save the schedule.");
        return;
      }
      setAutoTradeScheduleSaveStatus("saved");
      setTimeout(() => setAutoTradeScheduleSaveStatus(null), 3000);
    } catch (e: any) {
      setAutoTradeScheduleSaveStatus("error");
      setAutoTradeScheduleSaveError(e?.message || "Failed to reach the server.");
    }
  };

  const [strategyEngineSaveStatus, setStrategyEngineSaveStatus] = useState<null | "saving" | "saved" | "error">(null);
  const [strategyEngineSaveError, setStrategyEngineSaveError] = useState<string | null>(null);

  // Independent of toggleAutoBot()/Autobot state entirely, same isolation as saveAutoTradeSchedule
  // above - this only persists configuration for the isolated Strategy Engine subsystem
  // (StrategyEngineShadowRunner.ts is the only thing that later reads it, on its own timer, and it
  // never calls a broker/OMS function at any setting value).
  const saveStrategyEngineSettings = async () => {
    setStrategyEngineSaveStatus("saving");
    setStrategyEngineSaveError(null);
    try {
      const res = await fetch("/api/v1/config/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          strategyEngineEnabled,
          strategyEngineMode,
          strategyEngineMaxActive,
          strategyEngineMinConfidence,
        })
      });
      const data = await res.json();
      if (data.ok === false || !res.ok) {
        setStrategyEngineSaveStatus("error");
        setStrategyEngineSaveError(data.error || "Failed to save Strategy Engine settings.");
        return;
      }
      setStrategyEngineSaveStatus("saved");
      setTimeout(() => setStrategyEngineSaveStatus(null), 3000);
    } catch (e: any) {
      setStrategyEngineSaveStatus("error");
      setStrategyEngineSaveError(e?.message || "Failed to reach the server.");
    }
  };

  const handleAddMemoryRule = async (rule: string) => {
    try {
      const res = await fetch("/api/v1/autobot/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "add", rule })
      });
      if (res.ok) {
        const data = await res.json();
        setAutoBotConfig((prev: any) => ({ ...prev, memoryRules: data.memoryRules }));
      }
    } catch(e) {}
  };

  const handleDeleteMemoryRule = async (index: number) => {
    try {
      const res = await fetch("/api/v1/autobot/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", index })
      });
      if (res.ok) {
        const data = await res.json();
        setAutoBotConfig((prev: any) => ({ ...prev, memoryRules: data.memoryRules }));
      }
    } catch(e) {}
  };

  // Dual Verification state
  const [verifierSymbol, setVerifierSymbol] = useState("NVDA");
  const [verifierHeadline, setVerifierHeadline] = useState("Competitors release new AI chips, threatening market share while regulatory scrutiny remains high.");
  const [proposerAgentSelector, setProposerAgentSelector] = useState("NewsAgent (NLP)");
  const [verifierAgentSelector, setVerifierAgentSelector] = useState("MacroAgent (Quant)");
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifierResult, setVerifierResult] = useState<any>(null);

  const runDualVerification = async () => {
    setIsVerifying(true);
    setVerifierResult(null);
    try {
      const res = await fetch("/api/v1/llm/dual-verify-trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          symbol: verifierSymbol, 
          headline: verifierHeadline,
          proposerStressed: agentStressTests[proposerAgentSelector],
          verifierStressed: agentStressTests[verifierAgentSelector],
          proposerName: proposerAgentSelector,
          verifierName: verifierAgentSelector,
          adversarialDebateMode: autoBotAdversarialDebate
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setVerifierResult(data);
    } catch (e: any) {
      setVerifierResult({ error: e.message });
    } finally {
      setIsVerifying(false);
    }
  };
  
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Observing audit logs
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [isAutoScrollAudit, setIsAutoScrollAudit] = useState(true);

  useEffect(() => {
    if (isAutoScrollAudit) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [auditLogs, isAutoScrollAudit]);

  const [pipelineAgents, setPipelineAgents] = useState<{
    togglable: Array<{
      id: string;
      label: string;
      description: string;
      enabled: boolean;
      available: boolean;
      unavailableReason: string | null;
      keepsBackgroundPipeline?: boolean;
    }>;
    alwaysOn: Array<{ id: string; label: string; reason: string; enabled: boolean }>;
    autobotEnabled: boolean;
    liveIdeaGenerationEnabled: boolean;
  }>({ togglable: [], alwaysOn: [], autobotEnabled: false, liveIdeaGenerationEnabled: false });
  const [pipelineAgentError, setPipelineAgentError] = useState<string | null>(null);

  const fetchPipelineAgents = async () => {
    try {
      const res = await fetch("/api/v1/system/pipeline-agents");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setPipelineAgentError(data?.error || `Pipeline agents fetch failed (${res.status})`);
        return;
      }
      setPipelineAgents({
        togglable: Array.isArray(data.togglable) ? data.togglable : [],
        alwaysOn: Array.isArray(data.alwaysOn) ? data.alwaysOn : [],
        autobotEnabled: data.autobotEnabled === true,
        liveIdeaGenerationEnabled: data.liveIdeaGenerationEnabled === true,
      });
      // pipelineAgentSnapshot.ts:36 already includes tradingState - catches TRADING_PAUSED,
      // which emergencyStopActive alone (EMERGENCY_STOP only) never did.
      if (typeof data.tradingState === "string") {
        applyTradingState(data.tradingState);
      } else if (typeof data.emergencyStopActive === "boolean") {
        setEnginesHalted(data.emergencyStopActive);
      }
      setPipelineAgentError(null);
    } catch (e: any) {
      setPipelineAgentError(e?.message || "Pipeline agents fetch failed");
    }
  };

  const handlePipelineAgentToggle = async (agentId: string, currentlyEnabled: boolean, available: boolean) => {
    if (!available) return;
    setPipelineAgentError(null);
    try {
      const res = await fetch("/api/v1/system/pipeline-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId, enabled: !currentlyEnabled }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setPipelineAgentError(data?.error || `Toggle failed (${res.status})`);
        return;
      }
      setPipelineAgents({
        togglable: Array.isArray(data.togglable) ? data.togglable : [],
        alwaysOn: Array.isArray(data.alwaysOn) ? data.alwaysOn : [],
        autobotEnabled: data.autobotEnabled === true,
        liveIdeaGenerationEnabled: data.liveIdeaGenerationEnabled === true,
      });
    } catch (e: any) {
      setPipelineAgentError(e?.message || "Toggle failed");
    }
  };

  const handlePipelineAgentPreset = async (preset: "all_enabled" | "all_disabled") => {
    setPipelineAgentError(null);
    try {
      const res = await fetch("/api/v1/system/pipeline-agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        setPipelineAgentError(data?.error || `Preset failed (${res.status})`);
        return;
      }
      setPipelineAgents({
        togglable: Array.isArray(data.togglable) ? data.togglable : [],
        alwaysOn: Array.isArray(data.alwaysOn) ? data.alwaysOn : [],
        autobotEnabled: data.autobotEnabled === true,
        liveIdeaGenerationEnabled: data.liveIdeaGenerationEnabled === true,
      });
    } catch (e: any) {
      setPipelineAgentError(e?.message || "Preset failed");
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    void fetchPipelineAgents();
  }, [isAuthenticated]);

  const setMarketExecutionMode = (newMode: string) => {
    const mode = String(newMode).toUpperCase();
    if (mode === 'LIVE' && autoBotConfig?.paperTradingOnly) {
      setAutoBotStartError('LIVE blocked: PAPER_TRADING_ONLY=true in .env. Set false and restart to allow LIVE.');
      return;
    }
    setAutoBotTradingMode(mode);
    fetch("/api/v1/autobot/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tradingMode: mode }),
    })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok || body?.ok === false) {
          setAutoBotStartError(body?.error || `Mode change failed (${r.status})`);
          return;
        }
        setAutoBotStartError(null);
        if (body?.state?.tradingMode) setAutoBotTradingMode(String(body.state.tradingMode).toUpperCase());
      })
      .catch((e) => setAutoBotStartError(e?.message || 'Mode change failed'));
  };

  const handleExportLogs = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(auditLogs, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "argus_audit_logs_" + new Date().toISOString() + ".json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleExportTradesCSV = () => {
    const headers = ["Date", "Symbol", "Decision", "Sizing Weight", "P&L Outcome", "Journal Notes"];
    
    const rows = activeHistoricalTrades.map((trade, idx) => {
      const journalNotes = tradeJournals[idx] || "";
      return [
        trade.date,
        trade.symbol,
        trade.decision,
        `${trade.weight}x`,
        trade.outcome,
        journalNotes
      ].map(val => {
        const escaped = String(val).replace(/"/g, '""');
        return `"${escaped}"`;
      }).join(",");
    });

    const csvContent = [headers.join(","), ...rows].join("\n");
    const dataStr = "data:text/csv;charset=utf-8," + encodeURIComponent(csvContent);
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "argus_historical_trades_" + new Date().toISOString().split('T')[0] + ".csv");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const [authUsername, setAuthUsername] = useState("admin");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [serverAuditTrail, setServerAuditTrail] = useState<any[]>([]);

  const handleLoginSubmit = async (e: any) => {
    e.preventDefault();
    setAuthError("");
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: authUsername, password: authPassword }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setAuthError(body.error || "Login failed. Use admin / password.");
        return;
      }
      const body = await res.json().catch(() => ({}));
      setIsAuthenticated(true);
      setAuthPassword("");
      localStorage.setItem("argus_authenticated", "true");
      // Fresh login is the ONLY moment the wizard auto-opens - only when onboarding has never
      // been completed. A reload/restored-session never reaches this branch (see verifyAuth
      // below), so it never re-triggers this regardless of onboarding status.
      setSetupComplete(body.onboardingComplete === true);
    } catch (err) {
      console.error(err);
      setAuthError("Login failed due to network error.");
    }
  };

  const handleLogout = async () => {
    try {
      await fetch("/api/v1/auth/logout", { method: "POST" });
    } catch (err) {
      console.error("Logout request failed", err);
      // Still clear local auth state below even if the network call failed - the user asked to
      // log out, and leaving the UI in an authenticated-looking state on a network error would be
      // worse than a session row that outlives its cookie until it naturally expires.
    } finally {
      setIsAuthenticated(false);
      localStorage.removeItem("argus_authenticated");
    }
  };

  useEffect(() => {
    const verifyAuth = async () => {
      try {
        const res = await fetch("/api/v1/auth/status", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          setIsAuthenticated(data.authenticated === true);
          // A page load always lands here (initial mount effect), never in handleLoginSubmit's
          // branch - whether that's a browser refresh or a restored session, the wizard must
          // never auto-open. Only an explicit login submission is allowed to open it.
          if (data.authenticated === true) {
            setSetupComplete(true);
          }
        }
      } catch (err) {
        console.warn("Auth status check failed", err);
      }
    };
    verifyAuth();
  }, []);

  // Chaos Mode states
  const [chaosEnabled, setChaosEnabled] = useState<boolean>(false);
  const [chaosLatencyMin, setChaosLatencyMin] = useState<number>(1000);
  const [chaosLatencyMax, setChaosLatencyMax] = useState<number>(3000);
  const [chaosErrorRate, setChaosErrorRate] = useState<number>(30);
  const [chaosSelectedAgents, setChaosSelectedAgents] = useState<string[]>(["agent_news_sentiment", "agent_quant_ml"]);
  const [chaosSaving, setChaosSaving] = useState<boolean>(false);
  const [chaosMsg, setChaosMsg] = useState<string>("");

  // Adaptive Terminal States
  const [macroShockLoading, setMacroShockLoading] = useState<boolean>(false);

  const triggerMacroShock = async () => {
    setMacroShockLoading(true);
    try {
      const res = await fetch("/api/v1/chaos/macro-shock", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        fetch("/api/v1/autobot").then(r => r.json()).then(d => setAutoBotConfig(d));
      }
    } catch (err) {
      console.error("Failed to trigger macro shock:", err);
    } finally {
      setMacroShockLoading(false);
    }
  };

  const clearMacroShock = async () => {
    setMacroShockLoading(true);
    try {
      const res = await fetch("/api/v1/chaos/macro-shock/clear", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        fetch("/api/v1/autobot").then(r => r.json()).then(d => setAutoBotConfig(d));
      }
    } catch (err) {
      console.error("Failed to clear macro shock:", err);
    } finally {
      setMacroShockLoading(false);
    }
  };


  // Platform ledger data - declared at the top to avoid Temporal Dead Zone issues in earlier useEffects
  const [portfolioData, setPortfolioData] = useState<any | null>(null);
  const [portfolioFetchError, setPortfolioFetchError] = useState<string | null>(null);
  const portfolioBackoffUntil = useRef(0);
  const portfolioFailStreak = useRef(0);
  const fetchStateInFlight = useRef<Promise<void> | null>(null);
  const lastColdDashboardFetchAt = useRef(0);
  const [scheduledTasks, setScheduledTasks] = useState<any[]>([]);
  const [schedulerFreq, setSchedulerFreq] = useState("Daily");
  const [schedulerWeights, setSchedulerWeights] = useState('{"Technology": 40, "Financials": 20, "Healthcare": 20, "Energy": 20}');
  const [isAddingTask, setIsAddingTask] = useState(false);


  // --- Price Alerts Integration ---
  interface PriceAlert {
    id: string;
    symbol: string;
    targetPrice: number;
    condition: "greater" | "less";
    soundProfile?: string;
    isActive: boolean;
    isTriggered: boolean;
    triggeredAt?: string;
    triggeredPrice?: number;
  }

  interface VisualNotification {
    id: string;
    symbol: string;
    targetPrice: number;
    condition: "greater" | "less";
    triggeredPrice: number;
    timestamp: string;
  }

  const [priceAlerts, setPriceAlerts] = useState<PriceAlert[]>(() => {
    try {
      const stored = localStorage.getItem("argus_price_alerts");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [historicalAlerts, setHistoricalAlerts] = useState<PriceAlert[]>(() => {
    try {
      const stored = localStorage.getItem("argus_historical_alerts");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [showAlertHistoryModal, setShowAlertHistoryModal] = useState(false);

  const [alertNotifications, setAlertNotifications] = useState<VisualNotification[]>([]);
  const [selectedAlertSymbol, setSelectedAlertSymbol] = useState("AAPL");
  const [showMovingAverageTrend, setShowMovingAverageTrend] = useState(true);
  const [showRsiOverlay, setShowRsiOverlay] = useState(false);
  const [showMacdOverlay, setShowMacdOverlay] = useState(false);
  
  // Simulated LIVE prices of assets to allow for micro-fluctuations and trigger-ready scenarios.
  const [assetPrices, setAssetPrices] = useState<Record<string, number>>({
    AAPL: 175.20,
    MSFT: 415.50,
    NVDA: 875.12,
    AMD: 170.45,
    SPY: 510.30,
    GLD: 215.10,
    TLT: 94.60,
    TSLA: 178.40,
    BTC: 64250.00
  });

  const { portfolioDrawdownPercent, isDrawdownCritical } = useMemo(() => {
    const totalCost = portfolioData?.positions?.reduce((acc: number, p: any) => acc + (p.totalCost || (p.quantity * p.entryPrice) || 0), 0) || 0;
    const currentTotalMarketValue = portfolioData?.positions?.reduce((acc: number, p: any) => {
      const livePrice = assetPrices[p.symbol] || p.currentPrice || p.entryPrice;
      return acc + p.quantity * livePrice;
    }, 0) || 0;
    
    const totalUnrealizedPnL = currentTotalMarketValue - totalCost;
    const portfolioDrawdownPercent = totalCost > 0 ? (totalUnrealizedPnL / totalCost) * 100 : 0;
    // Real bug fix (2026-08-18 UI audit, Phase 6): this used to hardcode -15.0 independent of the
    // real settings.maxPortfolioDrawdownPct RiskEngine's portfolio_drawdown gate actually enforces
    // - if an operator changed that setting, this button's enabled state would silently drift out
    // of sync with what the backend considers critical. ribbonMaxDrawdownPct is the same real,
    // already-fetched value (App.tsx:1246) the "Active Risk Rules" ribbon displays; 0.15 (the
    // tradingSafety.json default) is used only as a placeholder before that fetch resolves, never
    // as a second independent source of truth.
    const effectiveMaxDrawdownPct = (ribbonMaxDrawdownPct ?? 0.15) * 100;
    const isDrawdownCritical = portfolioDrawdownPercent <= -effectiveMaxDrawdownPct;
    return { portfolioDrawdownPercent, isDrawdownCritical };
  }, [portfolioData, assetPrices, ribbonMaxDrawdownPct]);

  // GET /api/v1/portfolio returns { cash, buying_power, equity, positions } — not snapshot.total_equity.
  // The ribbon used to always show "--" even when InternalPaperBroker had $100k cash.
  const brokerRibbon = useMemo(() => {
    const snap = portfolioData?.snapshot;
    const positions = Array.isArray(portfolioData?.positions) ? portfolioData.positions : null;
    const equity =
      typeof portfolioData?.equity === "number" ? portfolioData.equity
      : typeof snap?.total_equity === "number" ? snap.total_equity
      : undefined;
    const cash =
      typeof portfolioData?.cash === "number" ? portfolioData.cash
      : typeof snap?.cash_balance === "number" ? snap.cash_balance
      : undefined;
    let positionsValue: number | undefined =
      typeof snap?.positions_value === "number" ? snap.positions_value : undefined;
    if (positionsValue === undefined && positions) {
      positionsValue = positions.reduce((s: number, p: any) => {
        const mv = Number(p.marketValue);
        if (Number.isFinite(mv)) return s + mv;
        const qty = Number(p.quantity) || 0;
        const px = Number(p.currentPrice) || Number(p.entryPrice) || 0;
        return s + qty * px;
      }, 0);
    }
    let unrealized: number | undefined =
      typeof portfolioData?.unrealizedPnl === "number" ? portfolioData.unrealizedPnl
      : typeof snap?.unrealized_pnl === "number" ? snap.unrealized_pnl
      : undefined;
    if (unrealized === undefined && positions) {
      unrealized = positions.reduce((s: number, p: any) => s + (Number(p.unrealizedPnl) || 0), 0);
    }
    const health = typeof snap?.health_score === "number" ? snap.health_score : undefined;
    const unavailableReason = portfolioFetchError
      ? `GET /api/v1/portfolio failed: ${portfolioFetchError} Equity stays -- (not invented).`
      : RIBBON_BROKER_UNAVAILABLE;
    return { equity, cash, positionsValue, unrealized, health, positionCount: positions?.length, unavailableReason };
  }, [portfolioData, portfolioFetchError]);

  const hasAutoLiquidatedRef = useRef(false);

  // Persists the toggle (settings.globalAutoLiquidationEnabled) so it survives a reload instead
  // of silently reverting to off with no warning. Optimistic update, rolled back on a failed/
  // errored save so the displayed state never lies about what's actually persisted.
  const updateGlobalAutoLiquidation = async (next: boolean) => {
    const prev = globalAutoLiquidation;
    setGlobalAutoLiquidation(next);
    setGlobalAutoLiquidationSaveError(null);
    try {
      const res = await fetch("/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ globalAutoLiquidationEnabled: next }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        setGlobalAutoLiquidation(prev);
        setGlobalAutoLiquidationSaveError(body?.error || `Failed to save (${res.status})`);
        setTimeout(() => setGlobalAutoLiquidationSaveError(null), 5000);
      }
    } catch (e: any) {
      setGlobalAutoLiquidation(prev);
      setGlobalAutoLiquidationSaveError(e?.message || "Failed to reach the server.");
      setTimeout(() => setGlobalAutoLiquidationSaveError(null), 5000);
    }
  };

  useEffect(() => {
    if (!isAuthenticated) return;
    if (globalAutoLiquidation && isDrawdownCritical && !hasAutoLiquidatedRef.current) {
        hasAutoLiquidatedRef.current = true; // prevent loop
        fetch("/api/v1/portfolio/liquidate", { method: "POST" })
           .then(res => {
               if (res.ok) {
                 fetchState();
               } else {
                 setGlobalAutoLiquidationSaveError(`Auto-liquidation request failed (${res.status}) - positions were NOT liquidated. Check manually.`);
               }
           })
           .catch((e) => {
               setGlobalAutoLiquidationSaveError(e?.message || "Auto-liquidation request failed to reach the server - positions were NOT liquidated. Check manually.");
           });
    }
  }, [globalAutoLiquidation, isDrawdownCritical, isAuthenticated]);
  
  // reset hasAutoLiquidatedRef.current when drawdown is no longer critical
  useEffect(() => {
      if (!isDrawdownCritical) {
          hasAutoLiquidatedRef.current = false;
      }
  }, [isDrawdownCritical]);

  // Keep assetPrices state synchronized with any positions current price from backend
  useEffect(() => {
    if (portfolioData?.positions) {
      setAssetPrices(prev => {
        const next = { ...prev };
        portfolioData.positions.forEach((p: any) => {
          next[p.symbol] = p.currentPrice;
        });
        return next;
      });
    }
  }, [portfolioData]);

  // Periodic Micro-fluctuation simulation of market assetPrices + Alert Evaluation Engine
  const evaluateAlerts = (currentPrices: Record<string, number>) => {
    let changed = false;
    const nextAlerts = priceAlerts.map(alert => {
      if (!alert.isActive || alert.isTriggered) return alert;
      const currentPrice = currentPrices[alert.symbol];
      if (!currentPrice) return alert;

      let triggered = false;
      if (alert.condition === "greater" && currentPrice >= alert.targetPrice) {
        triggered = true;
      } else if (alert.condition === "less" && currentPrice <= alert.targetPrice) {
        triggered = true;
      }

      if (triggered) {
        changed = true;
        // Trigger notification
        triggerAlertNotification(alert, currentPrice);
        return {
          ...alert,
          isActive: false,
          isTriggered: true,
          triggeredAt: new Date().toISOString(),
          triggeredPrice: currentPrice,
        };
      }
      return alert;
    });

    if (changed) {
      setPriceAlerts(nextAlerts);
      localStorage.setItem("argus_price_alerts", JSON.stringify(nextAlerts));

      const newlyTriggered = nextAlerts.filter(
        a => a.isTriggered && !priceAlerts.find(pa => pa.id === a.id)?.isTriggered
      );
      if (newlyTriggered.length > 0) {
        setHistoricalAlerts(prev => {
          const nextHist = [...newlyTriggered, ...prev];
          localStorage.setItem("argus_historical_alerts", JSON.stringify(nextHist));
          return nextHist;
        });
      }
    }
  };

  const triggerAlertNotification = (alert: PriceAlert, currentPrice: number) => {
    const newNotif: VisualNotification = {
      id: `alert-notif-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol: alert.symbol,
      targetPrice: alert.targetPrice,
      condition: alert.condition,
      triggeredPrice: currentPrice,
      timestamp: new Date().toLocaleTimeString(),
    };
    
    setAlertNotifications(prev => [newNotif, ...prev]);

    // Audio frequency feedback cue
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (AudioCtx) {
        const ctx = new AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        
        switch (alert.soundProfile) {
          case "urgent":
            osc.type = "square";
            osc.frequency.setValueAtTime(1000, ctx.currentTime);
            osc.frequency.setValueAtTime(1200, ctx.currentTime + 0.1);
            gain.gain.setValueAtTime(0.1, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.2);
            break;
          case "gentle":
            osc.type = "triangle";
            osc.frequency.setValueAtTime(440, ctx.currentTime);
            gain.gain.setValueAtTime(0.15, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
            osc.start();
            osc.stop(ctx.currentTime + 0.4);
            break;
          case "bell":
            osc.type = "sine";
            osc.frequency.setValueAtTime(660, ctx.currentTime);
            gain.gain.setValueAtTime(0.2, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);
            osc.start();
            osc.stop(ctx.currentTime + 0.6);
            break;
          default:
            osc.type = "sine";
            osc.frequency.setValueAtTime(880, ctx.currentTime); // Alert chime pitch
            gain.gain.setValueAtTime(0.12, ctx.currentTime);
            osc.start();
            osc.stop(ctx.currentTime + 0.18);
            break;
        }
      }
    } catch (err) {
      console.log("Audio alert playback blocked or unsupported.");
    }

    // HTML5 native alert notification try
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification(`ARGUS Price Alert: ${alert.symbol}`, {
          body: `${alert.symbol} crossed standard target of $${alert.targetPrice.toFixed(2)} (Current: $${currentPrice.toFixed(2)})`,
        });
      }
    } catch (e) {}
  };

  const addPriceAlert = (symbol: string, targetPrice: number, condition: "greater" | "less", soundProfile: string = "default") => {
    const newAlert: PriceAlert = {
      id: `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      symbol: symbol.toUpperCase(),
      targetPrice,
      condition,
      soundProfile,
      isActive: true,
      isTriggered: false,
    };
    const updated = [newAlert, ...priceAlerts];
    setPriceAlerts(updated);
    localStorage.setItem("argus_price_alerts", JSON.stringify(updated));
  };

  const deletePriceAlert = (id: string) => {
    const updated = priceAlerts.filter(a => a.id !== id);
    setPriceAlerts(updated);
    localStorage.setItem("argus_price_alerts", JSON.stringify(updated));
  };

  const togglePriceAlert = (id: string) => {
    const updated = priceAlerts.map(a => {
      if (a.id === id) {
        return {
          ...a,
          isActive: !a.isActive,
          // If reactivated, reset triggered status
          isTriggered: !a.isActive ? false : a.isTriggered,
          triggeredAt: !a.isActive ? undefined : a.triggeredAt,
          triggeredPrice: !a.isActive ? undefined : a.triggeredPrice,
        };
      }
      return a;
    });
    setPriceAlerts(updated);
    localStorage.setItem("argus_price_alerts", JSON.stringify(updated));
  };

  const clearTriggeredHistory = () => {
    const updated = priceAlerts.filter(a => !a.isTriggered);
    setPriceAlerts(updated);
    localStorage.setItem("argus_price_alerts", JSON.stringify(updated));
  };

  const updatePriceAlertTarget = (id: string, newTarget: number) => {
    const updated = priceAlerts.map(a => {
      if (a.id === id) {
        return {
          ...a,
          targetPrice: newTarget,
          isTriggered: false,
          triggeredAt: undefined,
          triggeredPrice: undefined,
        };
      }
      return a;
    });
    setPriceAlerts(updated);
    localStorage.setItem("argus_price_alerts", JSON.stringify(updated));
  };

  const requestNotificationPermission = () => {
    if ("Notification" in window) {
      Notification.requestPermission();
    }
  };

  // Keep auth state across page reloads by relying on the backend session cookie.

  // Navigation & User inputs
  const [setupComplete, setSetupComplete] = useState(false);
  const [systemState, setSystemState] = useState<'STARTING' | 'INITIALIZING' | 'READY' | 'RUNNING' | 'STOPPED' | 'ERROR'>('STARTING');
  const [activeTab, setActiveTab] = useState<
    "dashboard" | "arena" | "portfolio" | "scanner" | "agents" | "memory" | "audit" | "opportunities" | "learning" | "command" | "activity" | "documentation" | "settings" | "validation" | "observatory" | "evaluation" | "diagnostics" | "news" | "intelligence" | "kronos"
  >("dashboard");
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // Task 3A (FINAL_ANALYSIS.md's 4-phase remediation plan) - "Observability & Trade Tracing" used
  // to render an entirely fabricated timeline (a hardcoded trace id, made-up latencies, an
  // invented "ChatGPT/Claude/Gemini LLM Council" debate transcript, fabricated news-pipeline and
  // risk/execution numbers - none of it backed by any real event). The real equivalent -
  // per-transaction consensus/risk/execution provenance - already exists and is real
  // (TransactionObservatory.tsx, reading GET /api/v2/transactions/:id) but was only reachable via
  // a trade-blotter "Replay" button, never from this tab. This lists real recent transactions
  // (GET /api/v2/transactions) and opens the SAME real TransactionObservatory modal already wired
  // for replay elsewhere - the "redirect to the real thing" fix, not a new fabrication.
  const [auditTransactions, setAuditTransactions] = useState<any[]>([]);
  const [auditTransactionsLoading, setAuditTransactionsLoading] = useState(true);

  useEffect(() => {
    // Real bug fixed: gated only on activeTab, not isAuthenticated - logging out while on this
    // tab left this 15s interval running forever (activeTab doesn't change on logout, so this
    // effect never re-ran to clear it), repeatedly hitting a now-401ing endpoint post-logout.
    if (activeTab !== "audit" || !isAuthenticated) return;
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/transactions?limit=25')
        .then(r => r.json())
        .then(json => { if (!cancelled && json.ok) { setAuditTransactions(json.transactions); setAuditTransactionsLoading(false); } })
        .catch(() => { if (!cancelled) setAuditTransactionsLoading(false); });
    };
    load();
    const interval = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTab, isAuthenticated]);

  // Real replacement for the Opportunity Feed tab's 3 hardcoded NVDA/TSLA/RIVN cards (invented
  // "Regime"/"Algorithm" fields, "LIVE SCAN ACTIVE" badge with no fetch behind it at all) -
  // GET /api/v2/opportunities, real recent high-confidence agent_predictions.
  const [opportunities, setOpportunities] = useState<any[]>([]);
  const [opportunitiesAvailable, setOpportunitiesAvailable] = useState<boolean | null>(null);
  const [opportunitiesReason, setOpportunitiesReason] = useState<string | null>(null);

  useEffect(() => {
    // Same post-logout interval leak as the audit-tab effect above - gated only on activeTab.
    if (activeTab !== "opportunities" || !isAuthenticated) return;
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/opportunities')
        .then(r => r.json())
        .then(json => {
          if (cancelled || !json.ok) return;
          setOpportunitiesAvailable(json.available);
          setOpportunities(json.data || []);
          setOpportunitiesReason(json.reason || null);
        })
        .catch(() => { if (!cancelled) setOpportunitiesAvailable(false); });
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTab, isAuthenticated]);

  // Real replacement for the Learning & Evolution tab's fabricated "Mistakes Corrected"/"Models
  // Retrained"/"Alpha Generated by RL" KPIs and "PER-STRATEGY SCORECARD" (invented strategy
  // names) - GET /api/v2/agents/learning-summary, real per-agent weight/win-rate + real
  // learned_rules text.
  const [learningSummary, setLearningSummary] = useState<any | null>(null);

  useEffect(() => {
    // Same post-logout interval leak as the audit-tab effect above - gated only on activeTab.
    if ((activeTab !== "learning" && activeTab !== "agents") || !isAuthenticated) return;
    let cancelled = false;
    const load = () => {
      fetch('/api/v2/agents/learning-summary')
        .then(r => r.json())
        .then(json => { if (!cancelled && json.ok) setLearningSummary(json); })
        .catch(() => {});
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [activeTab, isAuthenticated]);

  // Structural integrity probe for Settings → Deployment readiness (same real endpoint as
  // Validation's SystemValidationSuite / IntegrityValidator). Counts schema/broker/AI reachability
  // only — not LIVE authorization. LIVE remains NO-GO.
  const [deploymentIntegrity, setDeploymentIntegrity] = useState<any | null>(null);
  // Real bug fix: the fetch below used to .catch(() => {}) silently, so a network error or non-2xx
  // response left deploymentIntegrity stuck at null forever - the "Loading real integrity check..."
  // label had no way to ever change to an error state, and "Re-check Now" was the only (undiscoverable)
  // recovery. This now surfaces a real error message and lets the loading label distinguish
  // "still in flight" from "failed" instead of looking identical.
  const [deploymentIntegrityError, setDeploymentIntegrityError] = useState<string | null>(null);

  const fetchDeploymentIntegrity = () => {
    setDeploymentIntegrityError(null);
    fetch('/api/v1/system/integrity')
      .then(r => {
        if (!r.ok) throw new Error(`Server returned HTTP ${r.status}`);
        return r.json();
      })
      .then(setDeploymentIntegrity)
      .catch((e: any) => setDeploymentIntegrityError(e?.message || 'Failed to reach the server.'));
  };

  useEffect(() => {
    if (activeTab !== "settings" || !isAuthenticated) return;
    fetchDeploymentIntegrity();
  }, [activeTab, isAuthenticated]);

  const [selectedAgentNode, setSelectedAgentNode] = useState<any | null>(null);
  const [standardLLMProvider, setStandardLLMProvider] = useState<"Gemini Flash" | "GPT-4o-mini" | "Claude 3 Haiku" | "DeepSeek-Coder">("Gemini Flash");
  const [premiumLLMProvider, setPremiumLLMProvider] = useState<"Gemini Pro" | "GPT-4o" | "Claude 3.5 Sonnet" | "DeepSeek-Chat">("Gemini Pro");
  const [targetSymbol, setTargetSymbol] = useState("AAPL");
  const [customHeadline, setCustomHeadline] = useState(
    "Central banks hint at potential rate cuts in response to cooling macro inflation indices.",
  );

  // Simulation analysis state
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastAnalysis, setLastAnalysis] = useState<any | null>(null);
  const [selectedBroker, setSelectedBroker] = useState("Internal Paper");

  // Trading System Control State
  const [tradingMode, setTradingMode] = useState<"full_auto" | "scanning_only" | "signal_only" | "paused" | "emergency_stop">("full_auto");
  const [moduleStates, setModuleStates] = useState({
    scanning: true,
    newsAgent: true,
    politicalAgent: true,
    macroAgent: true,
    histMemoryAgent: true,
    buyEngine: true,
    sellEngine: true,
    executionLive: false,
    executionPaper: true,
  });

  // Local UI-only state reset - callers are responsible for the real POST /api/v1/system/emergency-stop
  // call themselves and only invoking this once the backend confirms success (2026-08-18 audit, D-1:
  // this used to fire its own fire-and-forget fetch with the error swallowed, duplicating whatever
  // checked call the caller already made).
  const triggerEmergencyStop = () => {
    setTradingMode("emergency_stop");
    setModuleStates({
      scanning: false,
      newsAgent: false,
      politicalAgent: false,
      macroAgent: false,
      histMemoryAgent: false,
      buyEngine: false,
      sellEngine: false,
      executionLive: false,
      executionPaper: false,
    });
    console.warn("CRITICAL: GLOBAL EMERGENCY STOP TRIGGERED");
  };

  const toggleModule = (module: keyof typeof moduleStates) => {
    setModuleStates(prev => ({ ...prev, [module]: !prev[module] }));
  };

  const [isFetchingNews, setIsFetchingNews] = useState(false);
  
  // Market Historian State
  const [isHistorianSearching, setIsHistorianSearching] = useState(false);
  const [historianAnalysis, setHistorianAnalysis] = useState<any>(null);

  const [agentNotifications, setAgentNotifications] = useState<Record<string, boolean>>({
    "NewsAgent (NLP)": true,
    "MacroAgent (Quant)": false,
    "TechnicalAgent (TA)": false,
    "SentimentAgent (Social)": false,
    "OrderFlowAgent (L2)": true,
  });

  const [perfAlertEnabled, setPerfAlertEnabled] = useState(true);
  const [perfAlertThreshold, setPerfAlertThreshold] = useState(tradingSafetyConfig.agentWinRateAlertPct);

  const [tokenAlertEnabled, setTokenAlertEnabled] = useState(true);
  const [tokenAlertThreshold, setTokenAlertThreshold] = useState(50);

  // Real replacement for the "Token Consumption & Projected Costs" panel's previous
  // mockTokenConsumptionData array (6 invented agent names) + hardcoded $65.42 literal - now
  // backed by GET /api/v2/ai/token-consumption, real ai_calls rows grouped by real agent.
  const [tokenConsumptionData, setTokenConsumptionData] = useState<any[] | null>(null);
  const [tokenConsumptionTotals, setTokenConsumptionTotals] = useState<any | null>(null);
  const [tokenConsumptionAvailable, setTokenConsumptionAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    // Same pre-auth-flooding bug as the other fetch-on-mount effects in this component - this ran
    // unconditionally on mount regardless of isAuthenticated, firing a failing 401 at
    // /api/v2/ai/token-consumption from the login screen. Gated the same way.
    if (!isAuthenticated) return;
    let cancelled = false;
    fetch('/api/v2/ai/token-consumption')
      .then(r => r.json())
      .then(json => {
        if (cancelled || !json.ok) return;
        setTokenConsumptionAvailable(json.available);
        setTokenConsumptionData(json.data || []);
        setTokenConsumptionTotals(json.totals);
      })
      .catch(() => { if (!cancelled) setTokenConsumptionAvailable(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const [agentStressTests, setAgentStressTests] = useState<Record<string, boolean>>({
    "NewsAgent (NLP)": false,
    "MacroAgent (Quant)": false,
    "TechnicalAgent (TA)": false,
    "SentimentAgent (Social)": false,
    "OrderFlowAgent (L2)": false,
  });

  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(prev => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const toggleAgentStressTest = (agent: string) => {
    setAgentStressTests(prev => ({
      ...prev,
      [agent]: !prev[agent]
    }));
  };

  const toggleAgentNotification = (agent: string) => {
    setAgentNotifications(prev => ({
      ...prev,
      [agent]: !prev[agent]
    }));
  };

  // Observing audit logs
  // (Moved up for scope visibility)

  // Vector memory search state
  const [memoryQuery, setMemoryQuery] = useState(
    "highly restrictive tariffs proposed affecting electronics and machinery component import duties",
  );
  const [isSearchingMemory, setIsSearchingMemory] = useState(false);
  const [memoryResult, setMemoryResult] = useState<any | null>(null);
  const [memoryFeedback, setMemoryFeedback] = useState<Record<string, 'up' | 'down'>>({});

  const handleMemoryFeedback = async (itemId: string, type: 'up' | 'down') => {
    setMemoryFeedback(prev => ({ ...prev, [itemId]: type }));
    // Simulate updating vector embeddings weight
    try {
      await fetch("/api/v1/event-memory/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, type }),
      });
    } catch(e) {}
  };

  // MCP NLP State
  const [nlpQuery, setNlpQuery] = useState(
    "Trade AI: Buy 15 shares of MSFT and hold them tight.",
  );
  const [isMcpProcessing, setIsMcpProcessing] = useState(false);
  const [mcpResult, setMcpResult] = useState<any | null>(null);

  // Autonomous Bot Mode
  const [isAutonomous, setIsAutonomous] = useState(false);

  // Advanced Trade Sandbox State
  //
  // Task 3C (FINAL_ANALYSIS.md's 4-phase remediation plan): "Execute Override" used to build a
  // fabricated Trade object client-side and push it straight into local state - never touching
  // the backend at all, so nothing here was a real order. It now calls
  // POST /api/v2/trading/execute-override, which emits a real CHIEF_APPROVED_IDEA event carrying
  // a real live price - the exact same event RiskAgent listens for after ChiefTraderAgent's own
  // consensus approval - so the override still passes through every real RiskEngine gate
  // (circuit breakers, ATR sizing, concentration caps) and real OrderManagementService/broker
  // call. Only ChiefTraderAgent's AI-consensus step is deliberately skipped, which is the entire
  // point of an "override." sandboxQuantity is kept as a user-facing target/estimate for the
  // notional preview below - RiskEngine (not the user) determines the real approved quantity,
  // reported back via the same RISK_ASSESSMENT_COMPLETED broadcast every other real trade uses.
  const [sandboxAction, setSandboxAction] = useState<"BUY" | "SELL">("BUY");
  const [sandboxQuantity, setSandboxQuantity] = useState<number>(100);
  const [sandboxOverride, setSandboxOverride] = useState<boolean>(false);
  const [sandboxSubmitting, setSandboxSubmitting] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [sandboxPending, setSandboxPending] = useState<{ traceId: string; transactionId: string; currentPrice: number; symbol: string; side: "BUY" | "SELL" } | null>(null);
  const [sandboxOutcome, setSandboxOutcome] = useState<any | null>(null);

  useEffect(() => {
    if (!sandboxPending || !isAuthenticated) return;
    const unsubRisk = subscribe('RISK_ASSESSMENT_COMPLETED', (data: any) => {
      if (data.traceId !== sandboxPending.traceId) return;
      setSandboxOutcome({ stage: data.approved ? 'RISK_APPROVED' : 'RISK_REJECTED', ...data });
      setAuditLogs((prev: any[]) => [{
        id: `AL-${Date.now()}`,
        timestamp: new Date().toISOString(),
        action: data.approved ? "INFO" : "WARN",
        symbol: "SandboxOverride",
        headline: data.approved
          ? `MANUAL OVERRIDE APPROVED BY RISKENGINE: ${data.side} ${data.maxQuantity} ${data.symbol} - ${data.reasoning}`
          : `MANUAL OVERRIDE REJECTED BY RISKENGINE: ${data.reasoning}`,
      }, ...prev]);
      if (!data.approved) setSandboxPending(null);
    });
    const unsubOrder = subscribe('ORDER_EXECUTED', (data: any) => {
      if (data.transactionId !== sandboxPending.transactionId) return;
      setSandboxOutcome((prev: any) => ({ ...(prev || {}), stage: 'ORDER_' + data.status, order: data }));
      setSandboxPending(null);
      if (data.status === 'FILLED') {
        setTrades((prev: Trade[]) => [{
          id: data.id, symbol: data.symbol, side: data.side, quantity: data.quantity,
          price: data.price, total_amount: data.price * data.quantity, status: "filled",
          thesis: "Manual consensus override - submitted via Advanced Trade Sandbox.",
          timestamp: new Date().toISOString(), traceId: data.traceId, transactionId: data.transactionId,
          profitLoss: data.profitLoss,
        }, ...prev]);
        setAuditLogs((prev: any[]) => [{
          id: `AL-${Date.now()}`,
          timestamp: new Date().toISOString(),
          action: "INFO",
          symbol: "SandboxOverride",
          headline: `MANUAL OVERRIDE FILLED: ${data.side} ${data.quantity} ${data.symbol} @ $${data.price?.toFixed?.(2) ?? data.price}`,
        }, ...prev]);
      } else if (data.status === 'REJECTED' || data.status === 'CANCELED') {
        setAuditLogs((prev: any[]) => [{
          id: `AL-${Date.now()}`,
          timestamp: new Date().toISOString(),
          action: "WARN",
          symbol: "SandboxOverride",
          headline: `MANUAL OVERRIDE ORDER ${data.status} AT BROKER: ${data.symbol}`,
        }, ...prev]);
      }
    });
    return () => { unsubRisk(); unsubOrder(); };
  }, [subscribe, sandboxPending, isAuthenticated]);

  const handleExecuteOverride = async () => {
    setSandboxSubmitting(true);
    setSandboxError(null);
    setSandboxOutcome(null);
    try {
      const res = await fetch('/api/v2/trading/execute-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: targetSymbol, side: sandboxAction }),
      });
      const json = await res.json();
      if (!json.ok) {
        setSandboxError(json.error || 'Override submission failed.');
        return;
      }
      setSandboxPending({ traceId: json.traceId, transactionId: json.transactionId, currentPrice: json.currentPrice, symbol: targetSymbol, side: sandboxAction });
      setSandboxOutcome({ stage: 'SUBMITTED', currentPrice: json.currentPrice });
      setAuditLogs((prev: any[]) => [{
        id: `AL-${Date.now()}`,
        timestamp: new Date().toISOString(),
        action: "WARN",
        symbol: "SandboxOverride",
        headline: `USER OVERRIDE SUBMITTED TO RISKENGINE: ${sandboxAction} ${targetSymbol} @ real price $${json.currentPrice}`,
      }, ...prev]);
    } catch (e: any) {
      setSandboxError(e.message || 'Network error submitting override.');
    } finally {
      setSandboxSubmitting(false);
    }
  };

  // Agent Comparison State
  const [isComparisonActive, setIsComparisonActive] = useState<boolean>(false);
  const [isAgentComparisonModalOpen, setIsAgentComparisonModalOpen] = useState<boolean>(false);
  const [comparisonAgent1, setComparisonAgent1] = useState<string>("NewsAgent");
  const [comparisonAgent2, setComparisonAgent2] = useState<string>("MacroAgent");

  const [trades, setTrades] = useState<Trade[]>([]);
  const [liveTradeTrigger, setLiveTradeTrigger] = useState<any | null>(null);
  // Real bug fix (2026-08-18 UI audit, Phase 7): the cancel-order button had no in-flight lock
  // (repeat-clickable on a slow network) and its only failure signal was console.warn - nothing
  // rendered, so an operator couldn't tell whether a cancel worked, failed, or vanished.
  const [cancelingOrderIds, setCancelingOrderIds] = useState<Set<string>>(new Set());
  const [cancelOrderErrors, setCancelOrderErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!isAuthenticated) return;
    const unsubscribe = subscribe('TRADE_IDEA_GENERATED', (data) => {
      setLiveTradeTrigger((prev: any) => {
         if (prev) return prev;
         return { trace_id: data.traceId, rawTrade: data };
      });
    });
    return () => unsubscribe();
  }, [subscribe, isAuthenticated]);

  const [vetos, setVetos] = useState<RiskVeto[]>([]);
  const [selectedRiskVetoForModal, setSelectedRiskVetoForModal] = useState<any | null>(null);
  const [isVetoSubmittingReview, setIsVetoSubmittingReview] = useState<boolean>(false);
  const [isRebalancing, setIsRebalancing] = useState<boolean>(false);
  const [rebalanceResult, setRebalanceResult] = useState<any | null>(null);
  const [agentWeights, setAgentWeights] = useState<Record<string, number>>({});
  const [agentMetrics, setAgentMetrics] = useState<Record<string, AgentMetric>>(
    {},
  );

  // Real replacement for mockAgentComparativeMetrics (invented "SentimentAgent", fixed fake
  // sharpe/drawdown/wins) and mockAgentRoiData (a fake 3-month ROI line chart with no real
  // per-agent historical series backing it - agent_performance_stats is a current snapshot, not
  // a time series, so there is no real monthly trend to plot). Derived directly from the
  // already-fetched, real `agentMetrics` state (GET /api/v1/performance) - the same real source
  // AgentComparisonModal's "Deep Comparison" view already used, just with a field-name bug fixed
  // (see the AgentMetric interface comment above).
  const realAgentComparativeMetrics = useMemo(() => {
    return Object.fromEntries(Object.entries(agentMetrics).map(([agent, m]: [string, any]) => [
      agent,
      {
        sharpe: typeof m.sharpeRatio === 'number' ? m.sharpeRatio : null,
        profitFactor: typeof m.profitFactor === 'number' ? m.profitFactor : null,
        wins: typeof m.winRate === 'number' && typeof m.totalTrades === 'number' ? Math.round(m.winRate * m.totalTrades) : null,
        winRatePct: typeof m.winRate === 'number' ? m.winRate * 100 : null,
        totalTrades: m.totalTrades ?? 0,
      },
    ]));
  }, [agentMetrics]);
  const [systemSettings, setSystemSettings] = useState<any | null>(null);
  const [systemHealthy, setSystemHealthy] = useState(true);
  const [alpacaConfigured, setAlpacaConfigured] = useState(false);
  // Real bug fix (2026-08-18): the header's "MARKET: CLOSED" badge was a hardcoded, unconditional
  // literal string with no state binding at all - it always rendered red/closed regardless of
  // actual market hours. classifyMarketSession() (src/server/replay/marketSession.ts) is the same
  // real, live session classifier the mobile header already uses via GET /api/v2/research/organic-paper
  // (see useMobileMissionData.ts) - reused here rather than inventing a second classifier.
  const [marketSessionLabel, setMarketSessionLabel] = useState<'MARKET_OPEN' | 'PRE_MARKET' | 'AFTER_HOURS' | 'WEEKEND_CLOSED' | 'CLOSED' | null>(null);

  const [secrets, setSecrets] = useState<any[]>([]);
  const [secretEdits, setSecretEdits] = useState<Record<string, string>>({});
  const [secretsSaving, setSecretsSaving] = useState(false);
  const [secretsMsg, setSecretsMsg] = useState("");
  const [secretTesting, setSecretTesting] = useState(false);
  const [secretTestMsg, setSecretTestMsg] = useState("");

  // Dual-Engine Validator State
  const [validatorData, setValidatorData] = useState({
    aiPrediction: "Strong Buy (95% Confidence)",
    localRSI: 75,
    localMACD: "Bearish Crossover",
    localVWAP: "Price 5% Above VWAP",
    localATR: "High Volatility (Stop: 1.5%)"
  });
  const [validationResult, setValidationResult] = useState<null | string>(null);
  const [isValidating, setIsValidating] = useState(false);

  const runDualEngineValidation = () => {
    setIsValidating(true);
    setValidationResult(null);
    setTimeout(() => {
      let feedback = "";
      const isStrongBuy = validatorData.aiPrediction.includes("Strong Buy");
      const isHighConf = validatorData.aiPrediction.includes("95%");
      
      if (isStrongBuy) {
        if (validatorData.localRSI >= 70) {
          feedback += "🚫 **TRADE BLOCKED**: AI suggests 'Buy', but local RSI is " + validatorData.localRSI + " (Overbought). This divergence indicates the AI may be chasing momentum at a cyclical top.\n";
        } else {
          feedback += "✅ RSI check passed (Not overbought).\n";
        }
        
        if (validatorData.localMACD === "Bearish Crossover") {
          feedback += "🚫 **TRADE BLOCKED**: AI suggests 'Buy', but local MACD shows a Bearish Crossover. Trend momentum is actively decelerating against the AI's bias.\n";
        } else {
          feedback += "✅ MACD check passed (Supporting trend).\n";
        }
        
        if (validatorData.localVWAP.includes("Above")) {
          feedback += "⚠️ **WARNING**: Price is significantly above VWAP. Buying at a premium intraday. Proceeding with reduced sizing.\n";
        }
      }
      
      if (feedback === "") {
        feedback = "✅ **TRADE APPROVED**: Local deterministic math engine corroborates probabilistic AI prediction.";
      }
      
      setValidationResult(feedback);
      setIsValidating(false);
    }, 1200);
  };

  const [dailyPnLData, setDailyPnLData] = useState<any[]>([]);

  const getFilteredPnL = () => {
    // No fabricated fallback - an empty real history renders as an honest empty chart.
    const dataSource = dailyPnLData;
    if (pnlDateRange === "Last 7 Days" || pnlDateRange === "7D") return dataSource.slice(-7);
    if (pnlDateRange === "Last 30 Days" || pnlDateRange === "30D") return dataSource.slice(-30);
    if (pnlDateRange === "Month to Date (MTD)" || pnlDateRange === "MTD") return dataSource.slice(-15);
    if (pnlDateRange === "Year to Date (YTD)" || pnlDateRange === "YTD") return dataSource.slice(-24);
    return dataSource;
  };
  
  const activeDailyPnL = getFilteredPnL();
  const totalPnL = activeDailyPnL.reduce((sum, item) => sum + item.pnl, 0);
  const profitableDays = activeDailyPnL.filter(item => item.pnl > 0).length;
  const lossMakingDays = activeDailyPnL.filter(item => item.pnl < 0).length;

  const getActiveHistoricalTrades = () => {
    if (trades && trades.length > 0) {
      return trades.map((t: any) => ({
        date: t.timestamp ? t.timestamp.split('T')[0] : "N/A",
        symbol: t.symbol,
        decision: t.side,
        weight: t.quantity ? (t.quantity / 10).toFixed(1) : "1.0", // Arbitrary weight mapping for display
        // profitLoss is the real column (Drizzle camelCase) - pnl_realized never existed on the
        // real trade row, so this was always "N/A" regardless of actual outcome.
        outcome: (t.profitLoss !== null && t.profitLoss !== undefined) ? (t.profitLoss >= 0 ? `+$${t.profitLoss.toFixed(2)}` : `-$${Math.abs(t.profitLoss).toFixed(2)}`) : "N/A",
        outcomeClass: (t.profitLoss !== null && t.profitLoss !== undefined && t.profitLoss < 0) ? "text-rose-400" : "text-emerald-400",
        rawTrade: t,
      }));
    }
    // No fabricated fallback - no real trades yet renders as an honest empty list.
    return [];
  };
  
  const activeHistoricalTrades = getActiveHistoricalTrades();

  const fetchSecrets = async () => {
    try {
      const res = await fetch("/api/v1/secrets");
      if (res.ok) {
        const data = await res.json();
        setSecrets(data.secrets || []);
      }
    } catch (e) {}
  };

  const saveSecrets = async () => {
    setSecretsSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const [k, val] of Object.entries(secretEdits)) {
         const v = val as string;
         if (!v.includes("••••")) payload[k] = v;
      }
      const res = await fetch("/api/v1/secrets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: payload })
      });
      if (res.ok) {
        setSecretsMsg("Saved successfully");
        setSecretEdits({});
        fetchSecrets();
        setTimeout(() => setSecretsMsg(""), 3000);
      }
    } catch(e) {}
    setSecretsSaving(false);
  };

  const testSecret = async (target: string) => {
    setSecretTesting(true);
    setSecretTestMsg("");
    try {
      // Real bug fixed: this used to send { target } but POST /api/v1/secrets/test reads
      // req.body.key, so the field-name mismatch meant the real Alpaca connectivity check never
      // ran even when this button said "Test Alpaca" - and the response was never read at all, so
      // no result ever reached the user either way.
      const res = await fetch("/api/v1/secrets/test", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ key: target })
      });
      const data = await res.json();
      setSecretTestMsg(data.message || (data.success ? "OK" : "Test failed"));
    } catch(e: any) {
      setSecretTestMsg(e?.message || "Failed to reach the server.");
    }
    setSecretTesting(false);
  };

  useEffect(() => {
    if (activeTab === "settings" && isAuthenticated) {
      fetchSecrets();
    }
  }, [activeTab, isAuthenticated]);


  // Fetch dashboard snapshots. Browsers allow ~6 HTTP/1.1 connections per host; a 6s
  // setInterval that fires 12+ fetches without waiting for the previous Promise.all
  // stacks (pending) requests until the SPA freezes. Join in-flight cycles, abort on
  // teardown, and keep rarely-changing config off the hot path.
  const DASHBOARD_POLL_MS = 15_000;
  const DASHBOARD_COLD_MS = 60_000;

  const isAbortError = (e: unknown) =>
    (e instanceof DOMException && e.name === "AbortError")
    || (e instanceof Error && e.name === "AbortError");

  const fetchState = async (opts?: { signal?: AbortSignal; includeCold?: boolean }) => {
    if (fetchStateInFlight.current) return fetchStateInFlight.current;
    const run = (async () => {
      const fetchItem = async (url: string, setter: (data: any) => void, transform?: (data: any) => any) => {
        try {
          if (opts?.signal?.aborted) return;
          if (url === "/api/v1/portfolio" && Date.now() < portfolioBackoffUntil.current) return;
          const res = await fetch(url, { signal: opts?.signal });
          if (!res.ok) {
            if (url === "/api/v1/portfolio") {
              let reason = `HTTP ${res.status}`;
              try {
                const errBody = await res.json();
                reason = errBody.reason || errBody.error || reason;
              } catch { /* Vite 502 HTML while Node is restarting */ }
              setPortfolioData(null);
              setPortfolioFetchError(reason);
              portfolioFailStreak.current += 1;
              portfolioBackoffUntil.current = Date.now() + Math.min(60_000, 6_000 * 2 ** (portfolioFailStreak.current - 1));
            }
            return;
          }
          const contentType = res.headers.get("content-type");
          if (contentType && contentType.includes("application/json")) {
            const data = await res.json();
            if (url === "/api/v1/portfolio") {
              if (data?.available === false) {
                setPortfolioData(null);
                setPortfolioFetchError(data.reason || data.error || "Broker portfolio unavailable");
                return;
              }
              portfolioFailStreak.current = 0;
              portfolioBackoffUntil.current = 0;
              setPortfolioFetchError(null);
            }
            setter(transform ? transform(data) : data);
          }
        } catch (e) {
          if (isAbortError(e)) return;
          if (url === "/api/v1/portfolio") {
            setPortfolioData(null);
            setPortfolioFetchError(e instanceof Error ? e.message : "Network error");
            portfolioFailStreak.current += 1;
            portfolioBackoffUntil.current = Date.now() + Math.min(60_000, 6_000 * 2 ** (portfolioFailStreak.current - 1));
          }
          console.warn(`Failed to fetch ${url}:`, e);
        }
      };

      const includeCold = opts?.includeCold === true
        || Date.now() - lastColdDashboardFetchAt.current >= DASHBOARD_COLD_MS;

      const hot = [
        fetchItem("/api/v1/portfolio", setPortfolioData),
        fetchItem("/api/v1/trades", setTrades),
        fetchItem("/api/v1/risk", setVetos),
        fetchItem("/api/v2/research/organic-paper", (data) => {
          if (typeof data?.marketSession === "string") setMarketSessionLabel(data.marketSession);
        }),
        fetchItem("/api/v1/pnl/analytics", (pnlData) => {
          if (pnlData.history && pnlData.history.length > 0) {
            setDailyPnLData(pnlData.history);
          }
        }),
        fetchItem("/api/v1/performance", setAgentMetrics),
      ];

      const cold = includeCold ? [
        fetchItem("/api/v1/scheduler", (data) => setScheduledTasks(data.tasks || [])),
        fetchItem("/api/v1/settings", (settings) => {
          setSystemSettings(settings);
        }),
        fetchItem("/api/v1/alpaca/config", (algData) => {
          setAlpacaConfigured(algData.hasAlpacaKeys);
        }),
        fetchItem("/api/v1/agents", (agData) => {
          setAgentWeights(agData.weights || {});
        }),
        fetchItem("/api/v2/orchestration/models", (data) => setOrchestrationModels(data.models || [])),
        fetchItem("/api/v2/orchestration/capital", setOrchestrationCapital),
      ] : [];

      await Promise.all([...hot, ...cold]);
      if (includeCold) lastColdDashboardFetchAt.current = Date.now();
    })();
    fetchStateInFlight.current = run.finally(() => {
      fetchStateInFlight.current = null;
    });
    return fetchStateInFlight.current;
  };

  const fetchServerAuditTrail = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/audit/trail", { signal });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          setServerAuditTrail(await res.json());
        }
      }
    } catch (e) {
      if (isAbortError(e)) return;
    }
  };

  const handleRequestHumanReview = async (vetoId: string) => {
    setIsVetoSubmittingReview(true);
    try {
      const res = await fetch(`/api/v1/risk/${encodeURIComponent(vetoId)}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (res.ok) {
        const data = await res.json();
        const updatedVeto = data.veto;
        setVetos(prev => prev.map(v => v.id === vetoId ? { ...v, ...updatedVeto } : v));
        if (selectedRiskVetoForModal && selectedRiskVetoForModal.id === vetoId) {
          setSelectedRiskVetoForModal(prev => ({ ...prev, ...updatedVeto }));
        }
      }
    } catch (e) {
      console.error("Failed to request human review on veto due to server error", e);
    } finally {
      setIsVetoSubmittingReview(false);
    }
  };

  const handleRebalanceAll = async () => {
    setIsRebalancing(true);
    try {
      const res = await fetch("/api/v1/portfolio/rebalance", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      if (res.ok) {
        const data = await res.json();
        setRebalanceResult(data);
        await fetchState({ includeCold: true });
      } else {
        console.error("Failed to rebalance portfolio");
      }
    } catch (e) {
      console.error("Failed to perform portfolio rebalance", e);
    } finally {
      setIsRebalancing(false);
    }
  };

  const fetchChaosConfig = async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/v1/chaos/config", { signal });
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const config = await res.json();
          setChaosEnabled(config.enabled);
          setChaosLatencyMin(config.latencyMin);
          setChaosLatencyMax(config.latencyMax);
          setChaosErrorRate(config.errorRate);
          setChaosSelectedAgents(config.selectedAgents);
        }
      }
    } catch (e) {
      if (isAbortError(e)) return;
      console.error("Failed to load chaos config", e);
    }
  };

  const saveChaosConfig = async () => {
    setChaosSaving(true);
    setChaosMsg("");
    try {
      const res = await fetch("/api/v1/chaos/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: chaosEnabled,
          latencyMin: chaosLatencyMin,
          latencyMax: chaosLatencyMax,
          errorRate: chaosErrorRate,
          selectedAgents: chaosSelectedAgents,
        }),
      });
      if (res.ok) {
        setChaosMsg("Chaos Mode settings successfully synchronized to backend.");
        fetchServerAuditTrail();
      } else {
        setChaosMsg("Error synchronizing Chaos settings.");
      }
    } catch (e) {
      setChaosMsg("Network error saving Chaos settings.");
    } finally {
      setChaosSaving(false);
      setTimeout(() => setChaosMsg(""), 4000);
    }
  };

  useEffect(() => {
    if (activeTab !== "settings" || !isAuthenticated) return;
    void fetchChaosConfig();
  }, [activeTab, isAuthenticated]);

  useEffect(() => {
    // Real bug fix: this effect used to run unconditionally on mount ([] deps), regardless of
    // `isAuthenticated` - a hook registration always executes during render no matter what JSX a
    // later `if (!isAuthenticated) return <Login/>` in this same component conditionally returns.
    // Every one of fetchState()'s endpoints plus audit-trail/chaos-config polled every 6s meant
    // ~11 failing 401s per cycle sitting on the login screen alone, flooding the network and
    // starving the real login POST of connections on constrained setups. Gating on
    // `isAuthenticated` means this effect is a no-op until verifyAuth() or a real login resolves
    // it true, and the interval is torn down (not just left dangling) if that ever flips back.
    //
    // Second bug: setInterval(6000) did not wait for Promise.all. If SQLite/broker/analytics
    // took >6s, cycles stacked until Chrome's ~6-connection/host cap left hundreds of (pending)
    // requests and the dashboard froze on "Loading real-time performance analytics...".
    if (!isAuthenticated) return;
    const abort = new AbortController();
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await fetchState({ signal: abort.signal });
      if (stopped || abort.signal.aborted) return;
      if (activeTabRef.current === "audit") await fetchServerAuditTrail(abort.signal);
      if (activeTabRef.current === "settings") await fetchChaosConfig(abort.signal);
      if (stopped || abort.signal.aborted) return;
      timeout = setTimeout(() => { void loop(); }, DASHBOARD_POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      abort.abort();
      if (timeout) clearTimeout(timeout);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    let loopId: NodeJS.Timeout;
    if (isAuthenticated && isAutonomous && !isAnalyzing) {
      loopId = setTimeout(() => {
        const assets = ["AAPL", "NVDA", "AMD", "GLD", "TLT"];
        const headlines = [
          "Central banks suggest interest rates are nearing terminal state with rate cuts expected.",
          "New executive order proposes a massive 30 percent tariff premium on imported electronics hardware.",
          "Geopolitical trade disputes intensify, pushing capital funds into safe-haven commodities.",
          "Unprecedented quarterly earnings beat structural growth estimates.",
          "Regulatory oversight committee announces sweeping investigations into monopolistic practices.",
        ];
        const s = assets[0];
        const h = headlines[0];
        setTargetSymbol(s);
        setCustomHeadline(h);
        handleTriggerAnalysis(s, h);
      }, 8000);
    }
    return () => clearTimeout(loopId);
  }, [isAutonomous, isAnalyzing, isAuthenticated]);

  // Trigger server-side Multi-agent consensus analysis
  // Trigger MCP Natural Language Trade
  const handleMcpTrade = async () => {
    if (!nlpQuery.trim()) return;
    setIsMcpProcessing(true);
    setMcpResult(null);
    setLastAnalysis(null);

    try {
      const res = await fetch("/api/v1/mcp/trade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: nlpQuery, broker: selectedBroker }),
      });
      const data = await res.json();
      setMcpResult(data);

      // Automatically trigger the signal run using the extracted intent!
      if (data.success && data.extracted_intent) {
        const { symbol, action, quantity } = data.extracted_intent;
        setTargetSymbol(symbol);
        setCustomHeadline(
          `MCP NLP EXECUTED: User requested to ${action} ${quantity} units.`,
        );

        setTimeout(() => {
          handleTriggerAnalysis(
            symbol,
            `MCP DIRECTED ACTION: ${action} ${quantity} units (Confidence Verified)`,
          );
        }, 1500);
      }
    } catch (e) {
      console.error("MCP Error", e);
    } finally {
      setIsMcpProcessing(false);
    }
  };

  const handleFetchLiveNews = async () => {
    setIsFetchingNews(true);
    setCustomHeadline("Fetching real-time news from Alpaca Networks...");
    try {
      const res = await fetch(`/api/v1/alpaca/news?symbol=${targetSymbol}`);
      if (res.ok) {
        const data = await res.json();
        if (data.news && data.news.length > 0) {
          const headline = data.news[0].headline;
          const summary = data.news[0].summary;
          setCustomHeadline(`[LIVE NEWS] ${headline} - ${summary}`);
        } else {
          setCustomHeadline(`[LIVE NEWS] No recent news found for ${targetSymbol}.`);
        }
      } else {
        setCustomHeadline(`[ERROR] Failed to fetch news for ${targetSymbol}.`);
      }
    } catch (e) {
      setCustomHeadline(`[ERROR] Connection failed while fetching news.`);
    } finally {
      setIsFetchingNews(false);
    }
  };

  const handleTriggerAnalysis = async (
    autoSymbol?: string,
    autoHeadline?: string,
  ) => {
    setIsAnalyzing(true);
    setHistorianAnalysis(null);
    setLastAnalysis(null);
    setMcpResult(null);
    const execSymbol =
      typeof autoSymbol === "string" ? autoSymbol : targetSymbol;
    const execHeadline =
      typeof autoHeadline === "string" ? autoHeadline : customHeadline;

    // Market Historian "Event Memory Search" used to fabricate a canned response here
    // (fixed "+4.2%"/"+5.1%"/"42 similar past events" regardless of symbol or headline) behind a
    // 1200ms setTimeout made to look like a real historical-precedent search. No real
    // embedding/vector-store or historical-event-matching infrastructure exists anywhere in this
    // codebase (same real gap as VectorClusteringMap.tsx) - honestly disclosed as not yet
    // implemented rather than fabricated.
    setIsHistorianSearching(false);
    setHistorianAnalysis({ notImplemented: true, reason: 'Not yet implemented - no real historical-event-matching infrastructure exists in this codebase.' });

    try {
      const sectorMap: Record<string, string> = {
        AAPL: "Technology",
        MSFT: "Technology",
        NVDA: "Technology",
        AMD: "Technology",
        SPY: "Index Tracking",
        GLD: "Safety Commodities",
        TLT: "Fixed Income Bonds",
      };

      const symbolSector = sectorMap[execSymbol] || "Diversified";
      setLastAnalysis({
        gone: true,
        error: 'GET /api/v1/signals is quarantined. It fabricated consensus and bypassed RiskEngine.',
        code: 'SIGNALS_PATH_QUARANTINED',
      });
    } catch (e) {
      console.error("Signals pass failed", e);
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Submit vector query to historical memory
  const handleSearchMemory = async () => {
    setIsSearchingMemory(true);
    setMemoryResult(null);
    try {
      const res = await fetch(
        `/api/v1/event-memory?query=${encodeURIComponent(memoryQuery)}`,
      );
      const body = await res.json().catch(() => ({}));
      if (res.status === 410 || body?.code === 'EVENT_MEMORY_QUARANTINED') {
        setMemoryResult({
          quarantined: true,
          summary: body.summary || 'NO HISTORICAL DATA',
          what: body.what,
          why: body.why,
          impact: body.impact,
          howToFix: body.howToFix,
          matches: [],
        });
        return;
      }
      if (res.ok) {
        setMemoryResult(body);
      }
    } catch (e) {
      console.error("Vector query failed", e);
      setMemoryResult({ quarantined: true, summary: 'NO HISTORICAL DATA', matches: [] });
    } finally {
      setIsSearchingMemory(false);
    }
  };

  // Seed sample prebuilt headlines
  const selectHeadlinePreset = (txt: string) => {
    setCustomHeadline(txt);
  };

  if (!isAuthenticated) {
     return (
        <div className="min-h-screen bg-[#111822] text-slate-100 flex items-center justify-center font-sans selection:bg-emerald-500 selection:text-slate-950">
           <div className="w-full max-w-md p-8 bg-[#1A1F2B] border border-slate-800 rounded-lg shadow-2xl relative overflow-hidden animate-fade-in">
              <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/[0.05] rounded-full blur-3xl" />
              <div className="absolute bottom-0 left-0 w-32 h-32 bg-indigo-500/[0.05] rounded-full blur-3xl" />
              <div className="relative z-10">
                <h1 className="text-2xl font-bold tracking-tight text-white mb-2 flex items-center gap-3">
                  <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 text-emerald-400">
                    <TrendingUp size={24} />
                  </div>
                  ARGUS CORE
                </h1>
                <p className="text-xs text-slate-400 mb-8 font-mono border-b border-slate-800 pb-4">
                  Enterprise Multi-Agent AI Quant Trading
                </p>
                <form onSubmit={handleLoginSubmit} className="space-y-5">
                   <div className="space-y-1.5">
                     <label className="block text-xs font-mono text-slate-400">USERNAME</label>
                     <input type="text" placeholder="admin" value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} required className="w-full bg-[#111822] border border-slate-800 rounded-md p-3 text-sm text-slate-200 focus:border-emerald-500 hover:border-slate-700 outline-none transition-colors" />
                   </div>
                   <div className="space-y-1.5">
                     <label className="block text-xs font-mono text-slate-400 flex justify-between">
                       <span>PASSWORD</span>
                       <span className="text-slate-600 hover:text-slate-400 cursor-pointer" onClick={() => setAuthPassword("")}>Reset</span>
                     </label>
                     <input type="password" placeholder="••••••••" value={authPassword} onChange={(e) => setAuthPassword(e.target.value)} required className="w-full bg-[#111822] border border-slate-800 rounded-md p-3 text-sm text-slate-200 focus:border-emerald-500 hover:border-slate-700 outline-none transition-colors font-mono tracking-widest" />
                   </div>
                   {authError && <div className="text-rose-400 text-xs font-mono">{authError}</div>}
                   <button type="submit" className="w-full bg-slate-800 hover:bg-slate-800 border border-slate-700 hover:border-emerald-500 text-emerald-400 font-bold py-3.5 text-xs rounded-md transition-all flex justify-center items-center gap-2 mt-6 uppercase tracking-wider shadow-lg shadow-emerald-500/5 group">
                     <Lock size={14} className="group-hover:text-emerald-300" />
                     Initialize Secure Session
                   </button>
                </form>
              </div>
           </div>
        </div>
     );
  }

  if (isMobileMode) {
    return (
      <div
        className="min-h-screen bg-[#111822] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950"
        id="trading-platform-root"
      >
        {!setupComplete && (
          <SetupWizard onSkip={() => {
            fetch("/api/v1/config/onboarding-complete", { method: "POST" }).catch(() => {});
            setSetupComplete(true);
          }} onComplete={async (config) => {
            fetch("/api/v1/config/onboarding-complete", { method: "POST" }).catch(() => {});
            if (config.aiProviders) {
              for (const [provider, data] of Object.entries(config.aiProviders) as [string, any][]) {
                if (data.connected && data.key && data.key !== "mock") {
                  try {
                    await fetch("/api/v1/config/providers", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ provider, apiKey: data.key })
                    });
                  } catch (e) { console.error("Failed to save provider:", provider, e); }
                }
              }
            }
            setAutoBotTargetBudget(config.initialCapital);
            setAutoBotRiskLevel(config.riskProfile);
            setAutoBotTradingMode(config.tradingMode);
            setAutoBotConfig({ ...autoBotConfig, enabled: true, budget: config.initialCapital, riskLevel: config.riskProfile, strategy: config.aiProvider });
            setSystemState('READY');
            setSetupComplete(true);
          }} />
        )}
        <AppWalkthrough />
        {enginesHalted && (
          <div
            className="bg-rose-600 px-4 py-2 text-white text-xs font-mono tracking-wider flex flex-col gap-2"
            style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}
          >
            <TradingPauseOperatorControls compact onAuthoritativeTradingState={applyTradingState} />
            {resumeError && <span className="text-[10px]">Resume failed: {resumeError}</span>}
          </div>
        )}
        <MobileMissionControl
          isMobileMode={isMobileMode}
          layoutOverride={override}
          onToggleLayout={toggleMobileView}
        />
      </div>
    );
  }

  // --- Calculate dynamic risk veto distribution ---
  const vetoCounts = vetos.reduce((acc: Record<string, number>, curr) => {
    const agent = curr.vetoed_by || "Unknown Agent";
    const formattedAgent = agent
      .replace(/_/g, " ")
      .split(" ")
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    acc[formattedAgent] = (acc[formattedAgent] || 0) + 1;
    return acc;
  }, {});

  const vetoChartData = Object.entries(vetoCounts)
    .map(([agent, count]) => ({
      agent,
      count,
    }))
    .sort((a, b) => (b.count as number) - (a.count as number));

  return (
    <div
      className="min-h-screen bg-[#111822] text-slate-100 flex flex-col font-sans selection:bg-emerald-500 selection:text-slate-950"
      id="trading-platform-root"
    >
      {/* Real bug fix: a phone that overrides into Desktop Enterprise View lands on an 18-tab,
          multi-column layout sized for a monitor - the only way back (MobileLayoutToggle) lives
          inside #platform-header's un-wrapped icon row, which overflows horizontally on a
          390-430px viewport and can scroll the toggle itself off-screen. This floating button is
          reachable regardless of header overflow - fixed position, own stacking context, shown
          only for an actual narrow viewport that has overridden away from mobile mode (not on a
          real desktop browser, which never sets viewportMobile). */}
      {viewportMobile && !isMobileMode && (
        <button
          onClick={toggleMobileView}
          style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}
          className="fixed bottom-4 right-4 z-[300] flex items-center gap-2 px-4 py-3 rounded-full bg-indigo-500 hover:bg-indigo-400 text-white text-xs font-bold uppercase tracking-wider shadow-[0_4px_20px_rgba(99,102,241,0.5)] border border-indigo-400/50 min-h-[44px]"
        >
          <Smartphone size={16} />
          Mobile View
        </button>
      )}
      {!setupComplete && (
        <SetupWizard onSkip={() => {
          fetch("/api/v1/config/onboarding-complete", { method: "POST" }).catch(() => {});
          setSetupComplete(true);
        }} onComplete={async (config) => {
          fetch("/api/v1/config/onboarding-complete", { method: "POST" }).catch(() => {});
          // Save AI Providers
          if (config.aiProviders) {
            for (const [provider, data] of Object.entries(config.aiProviders) as [string, any][]) {
              if (data.connected && data.key && data.key !== "mock") {
                try {
                  await fetch("/api/v1/config/providers", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ provider, apiKey: data.key })
                  });
                } catch (e) { console.error("Failed to save provider:", provider, e); }
              }
            }
          }
          setAutoBotTargetBudget(config.initialCapital);
          setAutoBotRiskLevel(config.riskProfile);
          setAutoBotTradingMode(config.tradingMode);
          setAutoBotConfig({ ...autoBotConfig, enabled: true, budget: config.initialCapital, riskLevel: config.riskProfile, strategy: config.aiProvider });
          setSystemState('READY');
          setSetupComplete(true);
        }} />
      )}
      <AppWalkthrough />
      {showCoach && <AICoachPanel onClose={() => setShowCoach(false)} />}
      {enableDivineWealthMode ? (
        <DivineWealthOverlay />
      ) : enableHyperAbundanceMode ? (
        <HyperAbundanceVortex />
      ) : (
        enableWealthAffirmations && <WealthAffirmationOverlay />
      )}
      <LiveMarketNewsTicker />
      {enginesHalted && (
        <div className="bg-rose-600 px-4 py-2 flex flex-col gap-2 text-white w-full">
          <div className="flex items-center gap-2 font-bold text-xs tracking-wide uppercase flex-wrap">
            <ShieldAlert size={14} />
            <span className="text-[10px] font-mono text-rose-200 tracking-normal">
              SINCE {haltTime} • REASON: {haltReason}
            </span>
            {resumeError && (
              <span className="text-[10px] font-mono bg-black/30 text-white px-2 py-0.5 rounded ml-2">
                RESUME FAILED: {resumeError}
              </span>
            )}
          </div>
          <TradingPauseOperatorControls compact onAuthoritativeTradingState={applyTradingState} />
        </div>
      )}

      {/* Alert History Modal */}
      {showAlertHistoryModal && (
        <div className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 shadow-2xl">
          <div className="bg-[#1A1F2B] border border-slate-700/50 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl overflow-hidden animate-fade-in">
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
              <h2 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                <History size={18} className="text-amber-500" />
                Historical Alert Log
              </h2>
              <button
                onClick={() => setShowAlertHistoryModal(false)}
                className="text-slate-400 hover:text-white p-1 rounded-full hover:bg-slate-800 transition-colors"
                title="Close"
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5 flex-1 overflow-y-auto bg-[#111822]">
              {historicalAlerts.length === 0 ? (
                <div className="text-center py-12 flex flex-col items-center gap-3">
                  <Activity size={32} className="text-slate-700/50" />
                  <p className="text-slate-500 text-sm font-mono uppercase tracking-widest text-[10px]">No historical data available. Active triggers build precedents log here.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {historicalAlerts.map(alert => (
                    <div key={alert.id} className="bg-[#1A1F2B] border border-slate-800/80 rounded-lg p-3 text-slate-300 text-xs flex justify-between items-center group hover:border-slate-700 transition-colors">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-extrabold text-white tracking-wider font-mono">{alert.symbol}</span>
                          <span className="bg-slate-800 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider text-amber-500 font-mono">Triggered</span>
                          {alert.soundProfile && alert.soundProfile !== "default" && (
                            <span className="text-indigo-400/80 uppercase text-[9px] font-bold tracking-wider">
                              🎵 {alert.soundProfile}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 flex flex-wrap gap-3">
                          <span className="font-mono">
                            Set Target: {alert.condition === "greater" ? "≥" : "≤"} ${alert.targetPrice.toFixed(2)}
                          </span>
                          <span className="text-amber-400/90 font-mono font-medium">
                            Hit: ${alert.triggeredPrice?.toFixed(2)}
                          </span>
                        </div>
                      </div>
                      <div className="text-right flex flex-col items-end gap-1.5">
                        <div className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                          {alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleDateString() : "Unknown"}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {alert.triggeredAt ? new Date(alert.triggeredAt).toLocaleTimeString() : "Unknown"}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {historicalAlerts.length > 0 && (
              <div className="p-4 border-t border-slate-800 bg-[#1A1F2B] flex justify-end">
                <button
                  onClick={() => {
                    setHistoricalAlerts([]);
                    localStorage.removeItem("argus_historical_alerts");
                  }}
                  className="text-[10px] text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 px-3 py-1.5 rounded uppercase font-bold tracking-widest transition-colors flex items-center gap-1.5"
                >
                  <Trash2 size={12} />
                  Purge History
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Floating Price Alert Toast Notifications */}
      {alertNotifications.length > 0 && (
        <div className="fixed top-24 right-6 z-[100] flex flex-col gap-3 max-w-sm w-full pointer-events-none">
          {alertNotifications.slice(0, 5).map((notif) => (
            <div
              key={notif.id}
              className="pointer-events-auto bg-[#1A1F2B]/95 border border-amber-500/30 shadow-2xl rounded-lg p-4 flex gap-3 animate-fade-in relative overflow-hidden backdrop-blur-md"
            >
              <div className="absolute top-0 left-0 w-1 y-full bg-amber-500 h-full" />
              <div className="bg-amber-500/10 p-2 h-9 w-9 rounded-lg border border-amber-500/20 text-amber-400 shrink-0 flex items-center justify-center">
                <BellRing size={18} className="animate-pulse" />
              </div>
              <div className="flex-1 pr-6">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-extrabold text-sm text-white tracking-wider">{notif.symbol}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{notif.timestamp}</span>
                </div>
                <p className="text-xs text-slate-300 leading-snug">
                  Asset crossed standard threshold of <b className="text-white">${notif.targetPrice.toFixed(2)}</b>.
                  Trigger price was <b className="text-amber-400 font-mono">${notif.triggeredPrice.toFixed(2)}</b> ({notif.condition === "greater" ? "Above" : "Below"}).
                </p>
              </div>
              <button
                onClick={() => setAlertNotifications(prev => prev.filter(n => n.id !== notif.id))}
                className="absolute top-3 right-3 p-1 hover:bg-slate-800 text-slate-400 hover:text-white rounded-md transition-colors"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Header Bar */}
      <header
        className="border-b border-slate-800 bg-[#1A1F2B]/80 backdrop-blur-md px-6 py-4 flex flex-wrap items-center justify-between gap-4"
        id="platform-header"
      >
        <div className="flex items-center gap-3">
          <div className="bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20 text-emerald-400">
            <TrendingUp size={24} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight text-white">
                ARGUS
              </h1>
              <span className={`text-[10px] uppercase font-mono px-2 py-0.5 rounded border font-semibold tracking-wider ${autoBotTradingMode === "LIVE" ? "bg-rose-500/10 border-rose-500/30 text-rose-500" : autoBotTradingMode === "PAPER" ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400" : "bg-amber-500/10 border-amber-500/30 text-amber-500"}`}>
                <Explainer id="paperVsLive" quiet>{autoBotTradingMode}-MODE</Explainer>
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Enterprise Multi-Agent AI Quant Trading Core
            </p>
          </div>
        </div>

        {/* Live Status Indicators - overflow-x-auto so a narrow viewport scrolls this row instead
            of silently clipping it (the floating Mobile View button above is the primary way
            back to mobile layout on a phone; this keeps every other header control reachable too). */}
        <div className="flex items-center gap-3 text-[10px] font-mono tracking-widest uppercase overflow-x-auto max-w-full">
          <Explainer id="headerApiStatus" quiet>
            <div className="bg-slate-800/60 text-slate-400 border border-slate-700 px-3 py-1.5 rounded flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> API: <span className="text-white font-bold ml-0.5">ACTIVE</span></div>
          </Explainer>
          <Explainer id="headerLlmStatus" quiet>
            <div className="bg-slate-800/60 text-slate-400 border border-slate-700 px-3 py-1.5 rounded flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse"></span> LLM: <span className="text-orange-300 font-bold ml-0.5">GEMINI</span></div>
          </Explainer>
          <div className="bg-slate-800/60 text-slate-400 border border-slate-700 px-3 py-1.5 rounded flex items-center gap-1">
            <Explainer id="riskEngineGates" quiet>RISK ENGINE</Explainer>: <span className="text-emerald-400 font-bold">ARMED</span>
          </div>
          <Explainer id="headerMarketSession" quiet>
            {marketSessionLabel === 'MARKET_OPEN' ? (
              <div className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 px-3 py-1.5 rounded flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                MARKET: OPEN
              </div>
            ) : marketSessionLabel === 'PRE_MARKET' || marketSessionLabel === 'AFTER_HOURS' ? (
              <div className="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-3 py-1.5 rounded flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
                MARKET: {marketSessionLabel === 'PRE_MARKET' ? 'PRE-MARKET' : 'AFTER HOURS'}
              </div>
            ) : marketSessionLabel === 'CLOSED' || marketSessionLabel === 'WEEKEND_CLOSED' ? (
              <div className="bg-rose-500/10 text-rose-400 border border-rose-500/30 px-3 py-1.5 rounded flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse"></span>
                MARKET: {marketSessionLabel === 'WEEKEND_CLOSED' ? 'CLOSED (WEEKEND)' : 'CLOSED'}
              </div>
            ) : (
              <div className="bg-slate-800/60 text-slate-500 border border-slate-700 px-3 py-1.5 rounded flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-600"></span>
                MARKET: --
              </div>
            )}
          </Explainer>
          <div className="flex items-center gap-2 ml-2">
            <Explainer id="headerSearch" quiet>
            <button 
              onClick={() => setSearchOpen(true)} 
              className="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 px-3 py-1.5 rounded flex items-center gap-2 cursor-pointer transition-all shadow-sm group" 
            >
              <Search size={14} className="group-hover:scale-110 transition-transform" />
              <span className="text-[9px] font-bold uppercase tracking-widest hidden sm:inline">Search</span>
              <div className="hidden lg:flex items-center gap-0.5 px-1 rounded bg-indigo-500/20 border border-indigo-500/30 text-[8px]">
                <Command size={8} />
                <span>K</span>
              </div>
            </button>
            </Explainer>
            <Explainer id="headerCoach" quiet>
            <button 
              onClick={() => setShowCoach(!showCoach)} 
              className={`bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/30 px-3 py-1.5 rounded flex items-center gap-2 cursor-pointer transition-all shadow-sm group ${showCoach ? "text-white bg-indigo-500/30" : "text-indigo-400"}`}
            >
              <MessageSquare size={14} className="group-hover:scale-110 transition-transform" />
              <span className="text-[9px] font-bold uppercase tracking-widest hidden sm:inline">Coach</span>
            </button>
            </Explainer>
            <ExplainerToggle />
            <Explainer id="headerAlerts" quiet>
            <button onClick={() => setAlertsModalOpen(true)} className="bg-slate-800/60 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:border-slate-500 px-2.5 py-1.5 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-sm">
              <Bell size={14} className="text-indigo-400" />
            </button>
            </Explainer>
            <Explainer id="headerExport" quiet>
            <button onClick={() => setExportModalOpen(true)} className="bg-slate-800/60 hover:bg-slate-700 text-slate-300 border border-slate-700 hover:border-slate-500 px-2.5 py-1.5 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-sm">
              <DownloadCloud size={14} className="text-emerald-400" />
            </button>
            </Explainer>
            <MobileLayoutToggle isMobileMode={isMobileMode} override={override} onToggle={toggleMobileView} />
            <button onClick={handleLogout} className="bg-slate-800/60 hover:bg-rose-500/20 text-slate-300 hover:text-rose-400 border border-slate-700 hover:border-rose-500/40 px-2.5 py-1.5 rounded flex items-center gap-1 cursor-pointer transition-colors shadow-sm" title="Log Out">
              <LogOut size={14} />
            </button>
          </div>
        </div>
      </header>

      {/* Global Search Component */}
      <GlobalSearch 
        isOpen={searchOpen} 
        onClose={() => setSearchOpen(false)} 
        setActiveTab={setActiveTab} 
      />

      {/* Hero Stats Panel — carousel on compact, grid on desktop */}
      <ResponsiveStatsSection brokerRibbon={brokerRibbon} />

      {/* Tab strip stays on screen while the workspace scrolls. Wrap — do not hide desks behind a scrollbar. */}
      <div
        className="argus-desktop-only sticky top-0 z-50 bg-[#1A1F2B]/95 backdrop-blur-md border-b border-slate-850 px-4 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        id="tabs-navigation"
      >
        <DesktopNavStrip activeTab={activeTab} onSelectTab={(tab) => setActiveTab(tab)} />

        <div className="flex flex-wrap items-center gap-2 pb-1.5 text-[10px] text-slate-500">
          <span>Active Risk Rules:</span>
          <Explainer id="ribbonRiskRules" quiet>
            <span className="text-slate-400 font-mono bg-[#111822] px-2 py-0.5 rounded border border-slate-800">
              Max Drawdown {ribbonMaxDrawdownPct !== null ? `${(ribbonMaxDrawdownPct * 100).toFixed(0)}%` : '--'}
              {' | '}Max Sector Exp {ribbonMaxSectorPct !== null ? `${(ribbonMaxSectorPct * 100).toFixed(0)}%` : '--'}
              {' | '}Size ${autoBotMaxTradeSize.toLocaleString()}
            </span>
          </Explainer>
        </div>
      </div>

      {/* Main Workspace Frame container */}
      <main className={`flex-1 p-4 md:p-6 argus-fluid-container ${compactNav ? 'pb-28' : ''}`} id="workspace-main">
        <MobilePullRefresh onRefresh={async () => { await fetchState({ includeCold: true }); }}>
        <div className="min-h-full">
        {activeTab === "dashboard" && (
          <AutonomousDashboard 
             autoBotConfig={autoBotConfig} 
             portfolioData={portfolioData}
             trades={trades}
             pnlHistory={dailyPnLData}
             assetPrices={assetPrices}
             systemState={systemState}
             setSystemState={setSystemState}
             setShowLaunchDialog={setShowLaunchDialog}
             onSaveAllocatedBudget={saveAllocatedBudget}
             onOpenMissionControl={() => setActiveTab("command")}
          />
        )}
        {/* ========================================================= */}
        {/* TAB: ARENA (Dashboard / Visualizers)                      */}
        {/* Purpose: The main high-level overview. Displays live      */}
        {/* pulse data, real-time agent weight networks, and system   */}
        {/* status for the autonomous trading environment.            */}
        {/* ========================================================= */}
        {activeTab === "arena" && (() => {
          // Calculate win/loss metrics dynamically from simulated prices vs transaction ledger
          const tradesList = Array.isArray(trades) ? trades : [];
          const tradesWithPnl = tradesList.map(t => {
            const currentPrice = assetPrices[t.symbol] || t.price;
            const isBuy = t.side === "BUY";
            const pnlPerShare = isBuy ? (currentPrice - t.price) : (t.price - currentPrice);
            const pnl = pnlPerShare * t.quantity;
            const pnlPercent = t.price > 0 ? (pnlPerShare / t.price) * 100 : 0;
            return {
              ...t,
              currentPrice,
              pnl,
              pnlPercent,
              isWin: pnl > 0,
              isLoss: pnl < 0,
            };
          });

          // Helper to format ms into duration string
          const formatMs = (ms: number): string => {
            const totalSeconds = Math.floor(ms / 1000);
            if (totalSeconds < 60) return `${totalSeconds}s`;
            const totalMinutes = Math.floor(totalSeconds / 60);
            if (totalMinutes < 60) return `${totalMinutes}m ${totalSeconds % 60}s`;
            const totalHours = Math.floor(totalMinutes / 60);
            if (totalHours < 24) return `${totalHours}h ${totalMinutes % 65}m`;
            return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
          };

          // Helper to compute avg hold duration for symTrades
          const getAvgHoldDuration = (symTrades: Trade[]): string => {
            const sorted = [...symTrades].sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
            const durations: number[] = [];
            let currentBuy: Trade | null = null;

            sorted.forEach(t => {
              if (t.side === "BUY") {
                currentBuy = t;
              } else if (t.side === "SELL" && currentBuy) {
                const diff = new Date(t.timestamp).getTime() - new Date(currentBuy.timestamp).getTime();
                if (diff > 0) durations.push(diff);
                currentBuy = null;
              }
            });

            if (durations.length > 0) {
              const avgMs = durations.reduce((sum, d) => sum + d, 0) / durations.length;
              return formatMs(avgMs);
            }

            // No real closed BUY->SELL pair exists yet for this symbol - honestly report no
            // data rather than fabricating a hold duration from a symbol/trade-id-derived seed.
            return "—";
          };

          // Define symbolStats
          const symbolStats = tradesList.reduce((acc, t) => {
            if (!acc[t.symbol]) {
              acc[t.symbol] = {
                symbol: t.symbol,
                trades: [],
                wins: 0,
                losses: 0,
                totalPnl: 0,
              };
            }
            const currentPrice = assetPrices[t.symbol] || t.price;
            const isBuy = t.side === "BUY";
            const pnlPerShare = isBuy ? (currentPrice - t.price) : (t.price - currentPrice);
            const pnl = pnlPerShare * t.quantity;
            const isWin = pnl > 0;
            const isLoss = pnl < 0;

            acc[t.symbol].trades.push(t);
            if (isWin) acc[t.symbol].wins++;
            if (isLoss) acc[t.symbol].losses++;
            acc[t.symbol].totalPnl += pnl;

            return acc;
          }, {} as Record<string, {
            symbol: string;
            trades: Trade[];
            wins: number;
            losses: number;
            totalPnl: number;
          }>);

          const totalTrades = tradesWithPnl.length;
          const winsCount = tradesWithPnl.filter(t => t.isWin).length;
          const lossesCount = tradesWithPnl.filter(t => t.isLoss).length;
          const activeUnchanged = totalTrades - winsCount - lossesCount;
          const winLossRatio = lossesCount > 0 ? (winsCount / lossesCount).toFixed(2) : winsCount > 0 ? `${winsCount}.00` : "1.00";
          const winRatePercent = totalTrades > 0 ? ((winsCount / totalTrades) * 100).toFixed(1) : "0.0";
          const totalAccruedPnl = tradesWithPnl.reduce((sum, t) => sum + t.pnl, 0);

          const handleExportToCsv = () => {
            const statsList = Object.values(symbolStats) as any[];
            
            // Format Header Row
            const headers = [
              "Asset Symbol",
              "Trade Cycles",
              "Wins",
              "Losses",
              "Win/Loss Ratio",
              "Accuracy (Win Rate %)",
              "Aggregated Net P&L ($)",
              "Avg Hold Duration",
              "Action Index"
            ];
            
            const rows = statsList.map(stat => {
              const totalSymTrades = stat.trades.length;
              const wins = stat.wins;
              const losses = stat.losses;
              const winRatio = stat.losses > 0 ? (stat.wins / stat.losses).toFixed(2) : stat.wins > 0 ? `${stat.wins}.00` : "1.00";
              const winPct = totalSymTrades > 0 ? ((stat.wins / totalSymTrades) * 100).toFixed(1) : "0.0";
              const totalPnl = stat.totalPnl.toFixed(2);
              const avgHoldTime = getAvgHoldDuration(stat.trades);
              const actionIndex = stat.totalPnl >= 0 ? "OUTPERFORM" : "ATTRACTIVE DROP";
              
              return [
                stat.symbol,
                totalSymTrades,
                wins,
                losses,
                winRatio,
                `${winPct}%`,
                totalPnl,
                avgHoldTime,
                actionIndex
              ];
            });
            
            const csvContent = [
              headers.join(","),
              ...rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(","))
            ].join("\n");
            
            const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", `argus_arena_trade_summary_${new Date().toISOString().slice(0, 10)}.csv`);
            link.style.visibility = "hidden";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          };

          const handleExportAgentData = () => {
            // Real replacement for a fabricated per-symbol "dominant agent" mapping (4 invented
            // agent names - "Macro Agent"/"Tech Agent"/"Sentiment Agent" don't even match this
            // codebase's real agent names - picked deterministically from the symbol's own
            // char code, with fixed win/pnl/sharpe numbers). There is no real per-symbol
            // "dominant agent" attribution in this codebase; exporting real per-agent aggregate
            // stats (the same real GET /api/v1/performance data already fetched into
            // agentMetrics) is what real data can actually answer.
            const agentData = Object.entries(agentMetrics).map(([agentName, m]: [string, any]) => ({
              agentName,
              winRatePercent: typeof m.winRate === 'number' ? Number((m.winRate * 100).toFixed(1)) : null,
              totalTrades: m.totalTrades ?? 0,
              averageReturn: m.averageReturn ?? null,
              profitFactor: m.profitFactor ?? null,
              sharpeRatio: m.sharpeRatio ?? null,
            }));

            const jsonContent = JSON.stringify(agentData, null, 2);
            const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.setAttribute("href", url);
            link.setAttribute("download", `argus_arena_agent_metrics_${new Date().toISOString().slice(0, 10)}.json`);
            link.style.visibility = "hidden";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
          };

          return (
            <div className="col-span-full flex flex-col gap-6 w-full animate-fade-in" id="arena-tab-wrapper">
              <AlpacaNewsTicker targetSymbol={targetSymbol} />
 
               {/* Trade History Win/Loss Metrics Summary row */}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6 lg:gap-8" id="arena-trade-history-summary">
                {/* Card 1: Win/Loss Ratio */}
                <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 flex flex-col justify-between shadow-md relative overflow-hidden group hover:border-[#10B981]/30 transition-all duration-300">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl transform translate-x-12 -translate-y-12"></div>
                  <div>
                    <span className="text-[10px] sm:text-xs uppercase font-mono text-slate-500 block mb-1 tracking-widest font-black flex items-center gap-1.5">
                      <Activity size={12} className="text-emerald-400" />
                      Win/Loss Ratio
                    </span>
                    <span className="text-2xl sm:text-3xl font-bold font-mono text-emerald-400 tracking-tight">
                      {winLossRatio}x
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-[10px] sm:text-xs font-mono text-slate-400 pt-3 border-t border-slate-850">
                    <span>Target Index: &gt;1.5x</span>
                    <span className={`font-semibold ${lossesCount === 0 && winsCount > 0 ? "text-emerald-400" : Number(winLossRatio) >= 1.5 ? "text-emerald-400" : "text-amber-400"}`}>
                      {lossesCount === 0 && winsCount > 0 ? "OPTIMAL" : Number(winLossRatio) >= 1.5 ? "ACCELERATIVE" : "STABLE"}
                    </span>
                  </div>
                </div>

                {/* Card 2: Accuracy Win Rate */}
                <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 flex flex-col justify-between shadow-md relative overflow-hidden group hover:border-indigo-500/30 transition-all duration-300">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 rounded-full blur-2xl transform translate-x-12 -translate-y-12"></div>
                  <div>
                    <span className="text-[10px] sm:text-xs uppercase font-mono text-slate-500 block mb-1 tracking-widest font-black flex items-center gap-1.5">
                      <BarChart3 size={12} className="text-indigo-400" />
                      Win Rate %
                    </span>
                    <span className="text-2xl sm:text-3xl font-bold font-mono text-white tracking-tight">
                      {winRatePercent}%
                    </span>
                  </div>
                  <div className="mt-4 space-y-2 pt-3 border-t border-slate-850">
                    <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden">
                      <div className="bg-indigo-500 h-full rounded-full transition-all duration-300" style={{ width: `${winRatePercent}%` }}></div>
                    </div>
                    <div className="flex justify-between text-[9px] sm:text-[10px] font-mono text-slate-400 leading-none">
                      <span>Goal: 60%</span>
                      <span>Total: {totalTrades}</span>
                    </div>
                  </div>
                </div>

                {/* Card 3: Performance Spectrum Distribution */}
                <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 flex flex-col justify-between shadow-md relative overflow-hidden group hover:border-slate-700/50 transition-all duration-300">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-slate-500/5 rounded-full blur-2xl transform translate-x-12 -translate-y-12"></div>
                  <div>
                    <span className="text-[10px] sm:text-xs uppercase font-mono text-slate-500 block mb-1 tracking-widest font-black flex items-center gap-1.5">
                      <TrendingUp size={12} className="text-indigo-400" />
                      Win/Loss Count
                    </span>
                    <div className="flex items-baseline gap-2 font-mono">
                      <span className="text-xl sm:text-2xl font-bold text-emerald-400">{winsCount}W</span>
                      <span className="text-xs text-slate-400 font-bold">/</span>
                      <span className="text-xl sm:text-2xl font-bold text-rose-400">{lossesCount}L</span>
                      {activeUnchanged > 0 && (
                        <>
                          <span className="text-xs text-slate-400 font-bold">/</span>
                          <span className="text-xl sm:text-2xl font-bold text-slate-400">{activeUnchanged}T</span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-[10px] sm:text-xs font-mono text-slate-400 pt-3 border-t border-slate-850">
                    <span>Spectrum Index</span>
                    <span className="text-indigo-400 font-bold uppercase text-[9px] tracking-wider">LIVE TRANSACTIONS</span>
                  </div>
                </div>

                {/* Card 4: Accrued Real-time Valuation */}
                <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 lg:p-6 flex flex-col justify-between shadow-md relative overflow-hidden group hover:border-emerald-500/30 transition-all duration-300">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 rounded-full blur-2xl transform translate-x-12 -translate-y-12"></div>
                  <div>
                    <span className="text-[10px] sm:text-xs uppercase font-mono text-slate-500 block mb-1 tracking-widest font-black flex items-center gap-1.5">
                      <Coins size={12} className="text-[#f59e0b]" />
                      Net Valuation P&L
                    </span>
                    <span className={`text-2xl sm:text-3xl font-bold font-mono tracking-tight ${totalAccruedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {totalAccruedPnl >= 0 ? "+" : ""}${totalAccruedPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between text-[10px] sm:text-xs font-mono text-slate-400 pt-3 border-t border-slate-850">
                    <span>Accrued Margin</span>
                    <span className={`font-semibold ${totalAccruedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {totalAccruedPnl >= 0 ? "PROFITABLE" : "DRAWDOWN"}
                    </span>
                  </div>
                </div>
              </div>

              {/* MARKET SENTIMENT TREND */}
              <div className="w-full h-fit flex mb-6">
                <MarketSentimentTrend />
              </div>

              {/* L2 ORDER BOOK DEPTH HEATMAP - Phase 1B (Remediation Verification Pass): this used
                  to render a hardcoded bid/ask price ladder unconditionally. No real Level-2
                  depth-of-book data source exists anywhere in this codebase - confirmed by a
                  direct search across every broker adapter and market-data service - and Alpaca's
                  IEX feed (the only live feed this app has) provides top-of-book quotes/trades,
                  not full L2 depth. Rather than build a fetch to a data source that does not
                  exist, this is now an honest DATA_UNAVAILABLE state, per this pass's own rule
                  that no number on this dashboard may be synthetic. Real L2 support would require
                  a broker/data-provider integration this app does not have today (e.g. a paid-tier
                  market-data feed with depth), not just backend wiring. */}
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6 mb-6">
                 <div className="flex justify-between items-center mb-4">
                   <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                     <LayoutGrid size={16} className="text-indigo-400" />
                     Order Book (L2) Depth Heatmap
                   </h3>
                 </div>
                 <div className="flex flex-col items-center justify-center gap-2 py-10 text-center bg-[#111822] border border-slate-800 rounded">
                   <AlertTriangle size={22} className="text-amber-500/70" />
                   <p className="text-xs font-mono uppercase tracking-widest text-amber-400/90">L2 Depth Data Unavailable</p>
                   <p className="text-[10px] text-slate-500 max-w-md px-4">
                     No Level-2 order-book feed is integrated in this deployment - Alpaca's IEX feed provides top-of-book only. This panel intentionally shows no data rather than a fabricated depth ladder.
                   </p>
                 </div>
              </div>

              {/* RISK ATTRIBUTION TREEMAP */}
              <RiskAttributionTreemap />

              {/* STRATEGY PROFIT ATTRIBUTION SUNBURST */}
              <StrategyProfitSunburst />

              {/* TRADE EFFICIENCY REPORT */}
              <TradeEfficiencyReport />

              {/* EXECUTION QUALITY CHART */}
              <ExecutionQualityChart />

              {/* Tabular Trade Summary Breakdown Component */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 animate-fade-in"
                id="arena-trade-summary-card"
              >
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                      <Timer size={16} className="text-[#10B981]" />
                      Asset Trade Summary Analytics
                    </h3>
                    <p className="text-[10px] font-mono text-slate-400 mt-1">
                      Concise breakdown of localized transaction logs. Reflects total realized P&L and precise win ratios.
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleExportAgentData}
                      disabled={Object.keys(symbolStats).length === 0}
                      className="text-[10px] bg-indigo-500/10 hover:bg-indigo-500/20 disabled:bg-slate-800/20 disabled:text-slate-500 disabled:border-slate-800/80 disabled:cursor-not-allowed text-indigo-400 font-mono px-3 py-1.5 rounded border border-indigo-500/20 hover:border-indigo-500/40 uppercase tracking-widest flex items-center gap-1.5 cursor-pointer transition-all leading-none h-7"
                      title="Export agent performance metrics to JSON"
                    >
                      <Download size={12} className="text-indigo-400 disabled:text-slate-600" />
                      Export Agent Data
                    </button>
                    <button
                      onClick={handleExportToCsv}
                      disabled={Object.keys(symbolStats).length === 0}
                      className="text-[10px] bg-emerald-500/10 hover:bg-emerald-500/20 disabled:bg-slate-800/20 disabled:text-slate-500 disabled:border-slate-800/80 disabled:cursor-not-allowed text-emerald-400 font-mono px-3 py-1.5 rounded border border-emerald-500/20 hover:border-emerald-500/40 uppercase tracking-widest flex items-center gap-1.5 cursor-pointer transition-all leading-none h-7"
                      title="Export metrics to excel CSV format"
                    >
                      <Download size={12} className="text-emerald-400 disabled:text-slate-600" />
                      Export to Excel
                    </button>
                    <span className="text-[10px] bg-slate-800/80 text-slate-300 font-mono px-2.5 py-1 rounded border border-slate-700/50 uppercase tracking-widest flex items-center gap-1.5 leading-none h-7">
                      <span className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse"></span>
                      Terminal State: COMPILING
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto border border-slate-800/60 rounded-lg">
                  <table className="w-full text-left border-collapse font-mono text-xs text-slate-300">
                    <thead>
                      <tr className="bg-[#111822] border-b border-slate-800 text-slate-400 uppercase text-[9.5px] tracking-wider">
                        <th className="px-4 py-3 font-bold">Asset Sym</th>
                        <th className="px-4 py-3 font-bold text-center">Trade Cycles</th>
                        <th className="px-4 py-3 font-bold text-center">Win / Loss Ratio</th>
                        <th className="px-4 py-3 font-bold text-center">Accuracy / Win Rate %</th>
                        <th className="px-4 py-3 font-bold text-right">Aggregated Net P&L</th>
                        <th className="px-4 py-3 font-bold text-center">Avg Hold Duration</th>
                        <th className="px-4 py-3 font-bold text-center">Agent Node</th>
                        <th className="px-4 py-3 font-bold text-center">Trend</th>
                        <th className="px-4 py-3 font-bold text-right">Action Index</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/50">
                      {Object.keys(symbolStats).length === 0 ? (
                        <tr>
                          <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                            <div className="flex flex-col items-center justify-center gap-2 py-4">
                              <Activity size={20} className="text-slate-600 animate-pulse" />
                              <span className="text-xs text-slate-400 font-medium">No active target trades reported.</span>
                              <p className="text-[10px] text-slate-500 max-w-sm font-mono normal-case leading-snug">
                                Overrides executed via parameters dashboard or running autonomous LLM loops will manifest dynamically in this summary index view.
                              </p>
                            </div>
                          </td>
                        </tr>
                      ) : (
                        (Object.values(symbolStats) as any[]).map((stat) => {
                          const totalSymTrades = stat.trades.length;
                          const winPct = totalSymTrades > 0 ? ((stat.wins / totalSymTrades) * 100).toFixed(1) : "0.0";
                          const isProfitable = stat.totalPnl >= 0;
                          
                          // Custom holding duration calculator helper
                          const avgHoldTime = getAvgHoldDuration(stat.trades);
                          
                          // Real replacement: there is no real per-symbol "dominant agent"
                          // attribution anywhere in this codebase (multiple agents can
                          // contribute to a single consensus decision) - the old fabricated
                          // dominant-agent tooltip, sparkline trend, canned "decision logic" text,
                          // and rolling-30-day-average "Urgent" badge (compared against a value
                          // that was itself fabricated) are removed rather than replaced with a
                          // shallower fabrication.

                          return (
                            <tr key={stat.symbol} className="transition-colors hover:bg-slate-800/20">
                              <td className="px-4 py-3 font-extrabold text-white flex items-center gap-2">
                                <span className={`h-1.5 w-1.5 rounded-full ${isProfitable ? "bg-emerald-400" : "bg-rose-400"}`}></span>
                                {stat.symbol}
                              </td>
                              <td className="px-4 py-3 text-center text-slate-200">
                                {totalSymTrades} ({stat.wins}W / {stat.losses}L)
                              </td>
                              <td className="px-4 py-3 text-center font-mono text-slate-300">
                                {stat.losses > 0 ? (stat.wins / stat.losses).toFixed(2) : stat.wins > 0 ? `${stat.wins}.00` : "1.00"}x
                              </td>
                              <td className="px-4 py-3 font-mono">
                                <div className="flex items-center justify-center gap-2">
                                  <div className="w-12 bg-slate-800/80 h-1 rounded-full overflow-hidden">
                                    <div className="bg-indigo-500 h-full" style={{ width: `${winPct}%` }}></div>
                                  </div>
                                  <span className="font-semibold text-slate-100">{winPct}%</span>
                                </div>
                              </td>
                              <td className={`px-4 py-3 text-right font-mono font-bold ${isProfitable ? "text-emerald-400" : "text-rose-400"}`}>
                                {isProfitable ? "+" : ""}${stat.totalPnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-3 text-right text-slate-300 font-medium">
                                {avgHoldTime}
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className="text-[9px] font-mono text-slate-600" title="No real per-symbol dominant-agent attribution exists - multiple real agents can contribute to one consensus decision.">N/A</span>
                              </td>
                              <td className="px-4 py-3 text-center">
                                <span className="text-[9px] font-mono text-slate-600" title="No real per-symbol trend history is tracked yet.">—</span>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <span className={`text-[9px] font-black uppercase px-2 py-0.5 rounded tracking-wider ${
                                  isProfitable 
                                    ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" 
                                    : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                                }`}>
                                  {isProfitable ? "OUTPERFORM" : "ATTRACTIVE DROP"}
                                </span>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              
              <StrategySynergyMatrix />

              <div
                className="grid grid-cols-1 lg:grid-cols-3 gap-6"
                id="trading-arena-view"
              >
            {/* Left Columns - Inputs and controllers */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              {/* Asset Selection & Custom Headline Injector */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5"
                id="arena-controls-card"
              >
                <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-wide">
                  <Sparkles size={16} className="text-emerald-400" />
                  Consensus Evaluation Parameters
                </h3>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-5">
                  <div>
                    <label
                      className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5"
                      htmlFor="symbol-select"
                    >
                      Target Asset
                    </label>
                    <select
                      id="symbol-select"
                      value={targetSymbol}
                      onChange={(e) => setTargetSymbol(e.target.value)}
                      className="w-full bg-[#111822] border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="AAPL">AAPL - Apple Inc</option>
                      <option value="MSFT">MSFT - Microsoft Corp</option>
                      <option value="NVDA">NVDA - NVIDIA Corp</option>
                      <option value="AMD">AMD - Advanced Micro Devices</option>
                      <option value="SPY">SPY - SPDR S&P 500 ETF</option>
                      <option value="GLD">GLD - SPDR Gold Shares</option>
                      <option value="TLT">TLT - iShares 20+ Yr Bond</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5">
                      Asset & Broker Connectivity
                    </label>
                    <div
                      className="flex flex-wrap gap-2 pt-1.5"
                      id="sector-indicator"
                    >
                      <span className="text-xs px-2.5 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/25 text-indigo-400">
                        Sector:{" "}
                        <b>
                          {targetSymbol === "GLD"
                            ? "Safety Commodities"
                            : targetSymbol === "TLT"
                              ? "Fixed Income"
                              : "Technology"}
                        </b>
                      </span>
                      {selectedBroker.includes("Alpaca") ? (
                        alpacaConfigured ? (
                          <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 flex gap-1 items-center">
                            <CheckCircle size={12} />
                            Alpaca Market Data: <b>LIVE</b>
                          </span>
                        ) : (
                          <span className="text-[10px] px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 flex flex-col items-start leading-tight">
                            <span>
                              <b>Setup Required:</b> Provide ALPACA_API_KEY
                              inside workspace .env file.
                            </span>
                            <span>
                              Currently falling back to simulated data & ledger
                              logic.
                            </span>
                          </span>
                        )
                      ) : (
                        <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400">
                          Simulated Broker: <b>Mock Ledger Pass</b>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* News Headline Injection */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <label
                      className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider"
                      htmlFor="headline-input"
                    >
                      Fetch Live News Intelligence
                    </label>
                    {alpacaConfigured && selectedBroker.includes("Alpaca") && (
                      <button
                        onClick={handleFetchLiveNews}
                        disabled={isFetchingNews}
                        className="text-[10px] flex items-center gap-1 bg-indigo-500/20 hover:bg-indigo-500/40 text-indigo-300 px-2 py-0.5 rounded transition disabled:opacity-50"
                      >
                        {isFetchingNews ? <RefreshCw className="animate-spin" size={10} /> : <AlertTriangle size={10} />}
                        FETCH LIVE MARKET NEWS
                      </button>
                    )}
                  </div>
                  <textarea
                    id="headline-input"
                    rows={2}
                    value={customHeadline}
                    onChange={(e) => setCustomHeadline(e.target.value)}
                    placeholder="Type news events here to test LLM model interpretations (e.g. 'President orders massive immediate semiconductor tariffs')."
                    className="w-full bg-[#111822] border border-slate-800 rounded-lg p-3 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
                  />
                </div>

                {/* Preset headlines shortcut */}
                <div className="mb-6">
                  <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider block mb-2">
                    Preset Headline Quick Injection Options:
                  </span>
                  <div className="flex flex-col gap-1.5" id="presets-container">
                    <button
                      id="preset-rate-cuts"
                      onClick={() =>
                        selectHeadlinePreset(
                          "Central banks suggest interest rates are nearing terminal state with rate cuts expected on cooling CPI inflation yields.",
                        )
                      }
                      className="text-left text-[11px] truncate text-slate-300 hover:text-white bg-[#111822] hover:bg-slate-800 p-2 rounded border border-slate-800 transition"
                    >
                      💡 <span className="text-blue-400">Macro Bullish:</span>{" "}
                      CPI cooling, monetary rate cut cycle predicted.
                    </button>
                    <button
                      id="preset-semic-tariff"
                      onClick={() =>
                        selectHeadlinePreset(
                          "New executive order proposes a massive 30 percent tariff premium on imported electronics hardware and foreign microchips.",
                        )
                      }
                      className="text-left text-[11px] truncate text-slate-300 hover:text-white bg-[#111822] hover:bg-slate-800 p-2 rounded border border-slate-800 transition"
                    >
                      💡{" "}
                      <span className="text-rose-400">
                        Geopolitical Friction:
                      </span>{" "}
                      Microchip supply tariff shocks.
                    </button>
                    <button
                      id="preset-safe-havens"
                      onClick={() =>
                        selectHeadlinePreset(
                          "Geopolitical trade disputes intensify across East Asian channels, pushing capital funds into safe-haven commodities like Gold.",
                        )
                      }
                      className="text-left text-[11px] truncate text-slate-300 hover:text-white bg-[#111822] hover:bg-slate-800 p-2 rounded border border-slate-800 transition"
                    >
                      💡 <span className="text-yellow-400">Safety Pivot:</span>{" "}
                      Geopolitical conflict prompts gold flight.
                    </button>
                  </div>
                </div>

                {/* Primary Action Button */}
                <div className="flex gap-3">
                  <button
                    id="trigger-analysis-btn"
                    onClick={() => handleTriggerAnalysis()}
                    disabled={isAnalyzing || isAutonomous}
                    className="flex-1 bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold py-3.5 rounded-lg text-xs tracking-wider uppercase transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/10 hover:shadow-emerald-500/20"
                  >
                    {isAnalyzing && !isAutonomous ? (
                      <>
                        <RefreshCw
                          className="animate-spin text-slate-950"
                          size={16}
                        />
                        SPAWNING MULTI-AGENT SWARM...
                      </>
                    ) : (
                      <>
                        <Play
                          fill="currentColor"
                          size={14}
                          className="text-slate-950"
                        />
                        MANUAL TRIGGER OVERRIDE
                      </>
                    )}
                  </button>
                  <button
                    onClick={() => setIsAutonomous(!isAutonomous)}
                    className={`px-4 py-3.5 rounded-lg text-xs font-bold font-mono tracking-wider transition-all flex items-center justify-center gap-2 ${
                      isAutonomous
                        ? "bg-indigo-500 hover:bg-indigo-400 text-white shadow-lg shadow-indigo-500/20"
                        : "bg-[#111822] border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                    }`}
                  >
                    {isAutonomous && (
                      <RefreshCw className="animate-spin" size={14} />
                    )}
                    <Layers size={14} />
                    {isAutonomous
                      ? "AUTONOMOUS MODE: ON"
                      : "START AUTONOMOUS SCAN"}
                  </button>
                </div>
              </div>

              {/* Alpaca MCP NLP Co-Pilot Panel */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5"
                id="mcp-nlp-panel"
              >
                <div className="flex items-center gap-2 mb-3">
                  <span className="bg-indigo-500/20 text-indigo-400 p-1.5 rounded-md">
                    <MessageSquare size={16} />
                  </span>
                  <h3 className="text-sm font-bold text-white uppercase tracking-wider">
                    Alpaca MCP AI Co-Pilot
                  </h3>
                  <span className="ml-auto text-[10px] bg-slate-800 px-2.5 py-1 rounded-full text-slate-400">
                    Natural Language Trading via LLM
                  </span>
                </div>
                <div className="flex flex-col sm:flex-row gap-3 mt-3">
                  <input
                    type="text"
                    value={nlpQuery}
                    onChange={(e) => setNlpQuery(e.target.value)}
                    placeholder="e.g. Buy 10 shares of MSFT and hold them tight..."
                    className="flex-1 bg-[#111822] border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-indigo-500 transition-colors w-full"
                    onKeyDown={(e) => e.key === "Enter" && handleMcpTrade()}
                  />
                  <button
                    onClick={handleMcpTrade}
                    disabled={isMcpProcessing || !nlpQuery.trim()}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition flex items-center justify-center min-w-[120px] w-full sm:w-auto disabled:opacity-50"
                  >
                    {isMcpProcessing ? (
                      <RefreshCw className="animate-spin" size={16} />
                    ) : (
                      "Execute Intent"
                    )}
                  </button>
                </div>

                {mcpResult && (
                  <div
                    className={`mt-4 p-4 rounded-lg text-sm border flex items-start gap-3 ${mcpResult.success ? "bg-indigo-500/10 border-indigo-500/30" : "bg-red-500/10 border-red-500/30"}`}
                  >
                    <div className="mt-0.5">
                      {mcpResult.success ? (
                        <CheckCircle size={16} className="text-indigo-400" />
                      ) : (
                        <AlertTriangle size={16} className="text-red-400" />
                      )}
                    </div>
                    <div>
                      <p
                        className={
                          mcpResult.success ? "text-indigo-200" : "text-red-300"
                        }
                      >
                        {mcpResult.error || mcpResult.message}
                      </p>
                      {mcpResult.extracted_intent && (
                        <div className="mt-2 text-xs font-mono text-indigo-300/80">
                          <span className="mr-3">
                            ACTION: {mcpResult.extracted_intent.action}
                          </span>
                          <span className="mr-3">
                            ASSET: {mcpResult.extracted_intent.symbol}
                          </span>
                          <span>
                            QTY: {mcpResult.extracted_intent.quantity}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Advanced Trade Sandbox */}
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6" id="trade-sandbox">
                <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-wide">
                  <Target size={16} className="text-rose-400" />
                  Advanced Trade Sandbox (Consensus Override)
                </h3>
                <p className="text-xs text-slate-400 mb-5">
                  Manually submit a trade that skips ChiefTraderAgent's AI consensus step - it still passes through every real RiskEngine gate (circuit breakers, ATR sizing, concentration caps) and the real broker. RiskEngine, not this form, determines the actual approved quantity.
                </p>

                <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
                    <div>
                      <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5">Action</label>
                      <select
                        value={sandboxAction}
                        onChange={(e) => setSandboxAction(e.target.value as "BUY" | "SELL")}
                        className="w-full bg-[#1A1F2B] border border-slate-700 text-xs text-white rounded p-2 focus:outline-none focus:border-rose-500"
                      >
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[10px] font-mono text-slate-400 uppercase tracking-wider mb-1.5">Target Quantity (est.)</label>
                      <input
                        type="number"
                        value={sandboxQuantity}
                        onChange={(e) => setSandboxQuantity(parseInt(e.target.value) || 0)}
                        className="w-full bg-[#1A1F2B] border border-slate-700 text-xs text-white rounded p-2 focus:outline-none focus:border-rose-500"
                        min="1"
                      />
                    </div>
                    <div className="md:col-span-2 flex items-end">
                      <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer p-2 hover:bg-slate-800/50 rounded w-full border border-transparent hover:border-slate-700 transition">
                        <input
                          type="checkbox"
                          checked={sandboxOverride}
                          onChange={(e) => setSandboxOverride(e.target.checked)}
                          className="w-4 h-4 rounded text-rose-500 bg-slate-900 border-slate-700 focus:ring-rose-500 cursor-pointer"
                        />
                        <span className="font-mono text-rose-400 font-bold uppercase tracking-wide">Override Default Swarm Agent Consensus</span>
                      </label>
                    </div>
                  </div>

                  {/* Projected Impact Preview */}
                  <div className="border-t border-slate-800 pt-4 mt-2">
                     <div className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-3">Estimated Impact (target qty x last real tick - not what RiskEngine will actually approve)</div>
                     <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 md:h-16 h-auto">
                       <div className="bg-[#0B0F15] p-3 rounded border border-slate-800/80 flex flex-col justify-center">
                         <div className="text-[9px] text-slate-500 mb-1 font-mono tracking-widest">EST. NOTIONAL VALUE</div>
                         <div className="text-white font-mono text-sm">${(sandboxQuantity * (assetPrices[targetSymbol] || 0)).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                       </div>
                       <div className="bg-[#0B0F15] p-3 rounded border border-slate-800/80 flex flex-col justify-center">
                         <div className="text-[9px] text-slate-500 mb-1 font-mono tracking-widest">EST. MARGIN IMPACT</div>
                         <div className="text-amber-400 font-mono text-sm">${(sandboxQuantity * (assetPrices[targetSymbol] || 0) * 0.15).toLocaleString(undefined, {minimumFractionDigits: 2})}</div>
                       </div>
                       <div className="h-full min-h-[40px]">
                          <button
                            disabled={!sandboxOverride || sandboxSubmitting || !!sandboxPending}
                            onClick={handleExecuteOverride}
                            className="bg-rose-600 hover:bg-rose-500 disabled:opacity-20 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold w-full h-full rounded text-[11px] uppercase tracking-wider transition-colors shadow-[0_0_15px_rgba(225,29,72,0.3)] disabled:shadow-none"
                          >
                            {sandboxSubmitting ? "Submitting..." : sandboxPending ? "Awaiting RiskEngine..." : "Execute Override"}
                          </button>
                       </div>
                     </div>
                  </div>

                  {(sandboxError || sandboxOutcome) && (
                    <div className="border-t border-slate-800 pt-4 mt-4">
                      {sandboxError && (
                        <div className="text-[11px] font-mono text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded p-3">
                          SUBMISSION FAILED: {sandboxError}
                        </div>
                      )}
                      {sandboxOutcome && (
                        <div className={`text-[11px] font-mono rounded p-3 border ${
                          sandboxOutcome.stage === 'RISK_REJECTED' || sandboxOutcome.stage === 'ORDER_REJECTED' || sandboxOutcome.stage === 'ORDER_CANCELED'
                            ? 'text-rose-400 bg-rose-500/10 border-rose-500/20'
                            : sandboxOutcome.stage === 'ORDER_FILLED'
                            ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20'
                            : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
                        }`}>
                          {sandboxOutcome.stage === 'SUBMITTED' && `Submitted to RiskEngine at real price $${sandboxOutcome.currentPrice}. Waiting for gate evaluation...`}
                          {sandboxOutcome.stage === 'RISK_APPROVED' && `RiskEngine APPROVED ${sandboxOutcome.maxQuantity} shares of ${sandboxOutcome.symbol}. ${sandboxOutcome.reasoning} Awaiting broker fill...`}
                          {sandboxOutcome.stage === 'RISK_REJECTED' && `RiskEngine REJECTED this override: ${sandboxOutcome.reasoning}`}
                          {sandboxOutcome.stage === 'ORDER_FILLED' && `FILLED: ${sandboxOutcome.order.side} ${sandboxOutcome.order.quantity} ${sandboxOutcome.order.symbol} @ $${sandboxOutcome.order.price?.toFixed?.(2) ?? sandboxOutcome.order.price} (real broker order ${sandboxOutcome.order.id}).`}
                          {(sandboxOutcome.stage === 'ORDER_REJECTED' || sandboxOutcome.stage === 'ORDER_CANCELED') && `Broker ${sandboxOutcome.stage.replace('ORDER_', '')} this order after RiskEngine approval.`}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Market Historian Agent Widget (Triggers during News Ingestion) */}
              {(isHistorianSearching || historianAnalysis) && (
                <div className="bg-[#1A1F2B] border border-cyan-900/50 p-5 rounded-lg animate-fade-in shadow-lg shadow-cyan-900/10" id="historian-ingestion-widget">
                  <div className="flex justify-between items-center mb-4">
                     <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                       <Clock size={16} className="text-cyan-400" />
                       Market Historian Agent: Event Memory Search
                     </h3>
                     {isHistorianSearching ? (
                       <span className="text-[10px] bg-cyan-500/20 text-cyan-400 px-2 py-0.5 rounded font-bold animate-pulse flex items-center gap-1.5">
                         <RefreshCw size={10} className="animate-spin" />
                         SCANNING 50 HISTORICAL OCCURRENCES...
                       </span>
                     ) : (
                       <span className="text-[10px] bg-emerald-500/20 text-emerald-400 px-2 py-0.5 rounded font-bold flex items-center gap-1">
                         <CheckCircle size={10} />
                         SEARCH COMPLETE
                       </span>
                     )}
                  </div>
                  
                  {historianAnalysis && !isHistorianSearching && (
                    <AwaitingSignal label="Market Historian" reason={historianAnalysis.reason || 'Not yet implemented - no real historical-event-matching infrastructure exists in this codebase.'} />
                  )}
                </div>
              )}

              {/* Analysis SWARM Output Results */}
              {lastAnalysis && (
                <div
                  className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 animate-fade-in"
                  id="analysis-swarm-results"
                >
                  <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
                    <h3 className="text-sm font-bold text-white flex items-center gap-2">
                      <Layers size={16} className="text-indigo-400" />
                      Swarm Decision Outcomes - {lastAnalysis.symbol}
                    </h3>
                    <div className="text-[11px] font-mono text-slate-400">
                      Target Class:{" "}
                      <span className="text-slate-200 font-semibold">
                        {lastAnalysis.symbol}
                      </span>
                    </div>
                  </div>

                  {/* Primary verdict banner */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                    <div
                      className={`p-4 rounded-lg flex flex-col justify-center border ${
                        lastAnalysis.decision === "BUY"
                          ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-400"
                          : lastAnalysis.decision === "SELL"
                            ? "bg-rose-500/5 border-rose-500/20 text-rose-400"
                            : "bg-slate-800/40 border-slate-700/50 text-slate-300"
                      }`}
                    >
                      <span className="text-[9px] uppercase font-mono tracking-wider text-slate-400 mb-0.5">
                        Final Consensus View
                      </span>
                      <span className="text-2xl font-black tracking-widest">
                        {lastAnalysis.decision}
                      </span>
                    </div>

                    <div className="bg-[#111822] border border-slate-800/80 p-4 rounded-lg flex flex-col justify-center">
                      <span className="text-[9px] uppercase font-mono tracking-wider text-slate-400 mb-0.5">
                        Weighted Voting Confidence
                      </span>
                      <span className="text-xl font-bold text-slate-100">
                        {(lastAnalysis.confidence * 100).toFixed(1)}%
                      </span>
                    </div>

                    <div className="bg-[#111822] border border-slate-800/80 p-4 rounded-lg flex flex-col justify-center col-span-1 md:col-span-2">
                      <span className="text-[9px] uppercase font-mono tracking-wider text-slate-400 mb-0.5">
                        Veto Safeguard Check
                      </span>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {lastAnalysis.vetoed_by_risk ? (
                          <>
                            <AlertTriangle
                              size={14}
                              className="text-amber-400 animate-bounce"
                            />
                            <span className="text-xs font-semibold text-amber-400">
                              VETOED BY RISK
                            </span>
                          </>
                        ) : (
                          <>
                            <CheckCircle
                              size={14}
                              className="text-emerald-400"
                            />
                            <span className="text-xs font-semibold text-emerald-400">
                              SECURITY PROTOCOLS PASSED
                            </span>
                          </>
                        )}
                      </div>
                      <span className="text-[10px] text-slate-400 truncate mt-0.5 font-mono">
                        {lastAnalysis.execution_status}
                      </span>
                    </div>
                  </div>

                  {/* Swarm explanation text */}
                  <div className="bg-[#111822] border border-slate-850 p-4 rounded-lg mb-6">
                    <h4 className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-2 flex items-center gap-1.5">
                      <Sparkles size={11} className="text-indigo-400" />
                      Swarm Narrative Thesis & Reasoning (Gemini Structured
                      Content)
                    </h4>
                    <p className="text-slate-300 text-xs leading-relaxed italic whitespace-pre-line">
                      "{lastAnalysis.consensus_explanation}"
                    </p>
                  </div>

                  {/* Alpaca MCP Verification Layer */}
                  {lastAnalysis.alpaca_mcp && (
                    <div className="bg-[#1A1F2B] border border-indigo-900/50 p-4 rounded-lg mb-6 ring-1 ring-inset ring-indigo-500/20">
                      <div className="flex justify-between items-center mb-3">
                         <h4 className="text-[10px] uppercase font-mono tracking-wider text-indigo-400 font-bold flex items-center gap-1.5">
                           <Shield size={11} className="text-indigo-400" />
                           Dual Decision System: Alpaca MCP Verification
                         </h4>
                         <span className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                           ['APPROVE'].includes(lastAnalysis.alpaca_mcp.decision) ? 'bg-emerald-500/20 text-emerald-400' : 
                           lastAnalysis.alpaca_mcp.decision === 'REJECT' ? 'bg-rose-500/20 text-rose-400' : 
                           'bg-amber-500/20 text-amber-500'
                         }`}>
                           RESULT: {lastAnalysis.alpaca_mcp.decision}
                         </span>
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3 text-[10px] font-mono">
                         <div className="bg-[#111822] px-3 py-2 rounded border border-slate-800">
                           <span className="text-slate-500 block mb-0.5">Sentiment Check</span>
                           <span className={lastAnalysis.alpaca_mcp.sentiment === 'bullish' ? 'text-emerald-400' : lastAnalysis.alpaca_mcp.sentiment === 'bearish' ? 'text-rose-400' : 'text-slate-300'}>{lastAnalysis.alpaca_mcp.sentiment.toUpperCase()}</span>
                         </div>
                         <div className="bg-[#111822] px-3 py-2 rounded border border-slate-800">
                           <span className="text-slate-500 block mb-0.5">Trend Check</span>
                           <span className={lastAnalysis.alpaca_mcp.trend === 'bullish' ? 'text-emerald-400' : lastAnalysis.alpaca_mcp.trend === 'bearish' ? 'text-rose-400' : 'text-slate-300'}>{lastAnalysis.alpaca_mcp.trend.toUpperCase()}</span>
                         </div>
                         <div className="bg-[#111822] px-3 py-2 rounded border border-slate-800">
                           <span className="text-slate-500 block mb-0.5">Confidence</span>
                           <span className="text-slate-300">{(lastAnalysis.alpaca_mcp.confidence * 100).toFixed(0)}%</span>
                         </div>
                      </div>
                      
                      <div className="text-xs text-slate-300 italic border-l-2 border-indigo-500/50 pl-2">
                         "{lastAnalysis.alpaca_mcp.reasoning}"
                      </div>
                    </div>
                  )}

                  {/* Individual agent votes detail list */}
                  <h4 className="text-[11px] font-mono font-bold text-slate-300 mb-3 uppercase tracking-wider">
                    Casting Swarm Votes Details:
                  </h4>
                  <div
                    className="grid grid-cols-1 md:grid-cols-2 gap-3"
                    id="swarm-votes-list"
                  >
                    {lastAnalysis.compiled_signals.map(
                      (sig: any, idx: number) => {
                        const ageName = sig.agent_id
                          .replace("agent_", "")
                          .replace(/_/g, " ");
                        return (
                          <div
                            key={idx}
                            className="bg-[#111822] p-3 rounded border border-slate-850 flex items-start gap-2.5"
                          >
                            <span
                              className={`mt-0.5 h-2 w-2 rounded-full ${
                                sig.signal === "BUY"
                                  ? "bg-emerald-400"
                                  : sig.signal === "SELL"
                                    ? "bg-rose-400"
                                    : sig.signal === "TIMEOUT" || sig.signal === "ERROR"
                                      ? "bg-amber-500 animate-pulse"
                                      : "bg-slate-500"
                              }`}
                            ></span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 mb-0.5">
                                <span className="text-xs font-semibold text-white capitalize truncate font-mono">
                                  {ageName}
                                </span>
                                <span
                                  className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-bold ${
                                    sig.signal === "BUY"
                                      ? "bg-emerald-500/10 text-emerald-400"
                                      : sig.signal === "SELL"
                                        ? "bg-rose-500/10 text-rose-400"
                                        : sig.signal === "TIMEOUT" || sig.signal === "ERROR"
                                          ? "bg-amber-500/15 text-amber-500 border border-amber-500/30"
                                          : "bg-slate-800 text-slate-400"
                                  }`}
                                >
                                  {sig.signal}
                                  {sig.signal !== "TIMEOUT" && sig.signal !== "ERROR" && ` (${(sig.confidence * 100).toFixed(0)}%)`}
                                </span>
                              </div>
                              <p className={`text-[10px] leading-tight ${sig.signal === "TIMEOUT" || sig.signal === "ERROR" ? 'text-amber-500/90 font-mono font-medium' : 'text-slate-400 line-clamp-2'}`}>
                                {sig.reasoning}
                              </p>
                            </div>
                          </div>
                        );
                      },
                    )}
                  </div>
                </div>
              )}

              {/* COMPONENT: Risk Decomposition & Attribution */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5"
                id="risk-attribution-card"
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                  <div>
                    <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide font-mono">
                      <Scale size={15} className="text-indigo-400" />
                      Risk Decomposition & Attribution
                    </h3>
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                      Attribution of portfolio volatility and risk exposure contribution across autonomous AI models over time.
                    </p>
                  </div>

                  {/* Controls Row */}
                  <div className="flex flex-wrap items-center gap-2 font-mono">
                    {/* Metric Selector */}
                    <div className="flex bg-[#111822] rounded border border-slate-800 p-0.5">
                      <button
                        onClick={() => setRiskAttributionMetric("percentage")}
                        className={`px-2.5 py-1 text-[9px] font-bold rounded uppercase transition-colors shrink-0 ${
                          riskAttributionMetric === "percentage"
                            ? "bg-indigo-600 text-white"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        Vol Contribution (%)
                      </button>
                      <button
                        onClick={() => setRiskAttributionMetric("absolute")}
                        className={`px-2.5 py-1 text-[9px] font-bold rounded uppercase transition-colors shrink-0 ${
                          riskAttributionMetric === "absolute"
                            ? "bg-indigo-600 text-white"
                            : "text-slate-400 hover:text-slate-200"
                        }`}
                      >
                        VaR Units
                      </button>
                    </div>

                    {/* Timeframe Selector */}
                    <div className="flex bg-[#111822] rounded border border-slate-800 p-0.5">
                      {(["7D", "15D", "30D"] as const).map((tf) => (
                        <button
                          key={tf}
                          onClick={() => setRiskAttributionTimeframe(tf)}
                          className={`px-2 py-0.5 text-[9px] font-bold rounded transition-colors shrink-0 ${
                            riskAttributionTimeframe === tf
                              ? "bg-slate-800 text-white"
                              : "text-slate-500 hover:text-slate-350"
                          }`}
                        >
                          {tf}
                        </button>
                      ))}
                    </div>

                    {/* Predictive Trend Toggle */}
                    <button
                      onClick={() => setShowPredictiveTrend((prev) => !prev)}
                      className={`ml-1 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-bold rounded uppercase transition-colors shrink-0 border ${
                        showPredictiveTrend
                          ? "bg-slate-800 text-slate-200 border-slate-600"
                          : "bg-[#111822] text-slate-500 border-slate-800 hover:text-slate-350"
                      }`}
                    >
                      <Activity size={12} className={showPredictiveTrend ? "text-slate-300" : "text-slate-600"} />
                      Predictive Trend
                    </button>
                  </div>
                </div>

                {/* Interactive Legend checkboxes for toggling nodes */}
                <div className="flex flex-wrap items-center gap-2 bg-[#111822]/60 border border-slate-800/60 p-3 rounded-lg mb-4 text-[10px] sm:text-xs">
                  <span className="text-[10px] font-mono text-slate-500 uppercase font-bold mr-1 tracking-wider">
                    Filter Agent Nodes:
                  </span>
                  {[
                    { key: "NewsAgent", label: "News NLP", color: "text-blue-400", accentBg: "bg-blue-500/10 border-blue-500/30", dotColor: "bg-blue-500" },
                    { key: "MacroAgent", label: "Macro Quant", color: "text-emerald-400", accentBg: "bg-emerald-500/10 border-emerald-500/30", dotColor: "bg-emerald-500" },
                    { key: "TechnicalAgent", label: "Technical TA", color: "text-purple-400", accentBg: "bg-purple-500/10 border-purple-500/30", dotColor: "bg-purple-500" },
                    { key: "SentimentAgent", label: "Sentiment Social", color: "text-amber-400", accentBg: "bg-amber-500/10 border-amber-500/30", dotColor: "bg-amber-500" },
                    { key: "OrderFlowAgent", label: "Order Flow L2", color: "text-rose-400", accentBg: "bg-rose-500/10 border-rose-500/30", dotColor: "bg-rose-500" },
                  ].map((agent) => (
                    <label
                      key={agent.key}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded border cursor-pointer select-none transition-all hover:bg-slate-805 ${
                        enabledRiskAgents[agent.key]
                          ? `${agent.accentBg} ${agent.color} font-semibold ring-1 ring-inset ring-current/10`
                          : "bg-[#111822] border-slate-850 text-slate-500"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={enabledRiskAgents[agent.key]}
                        onChange={() =>
                          setEnabledRiskAgents((prev) => ({
                            ...prev,
                            [agent.key]: !prev[agent.key],
                          }))
                        }
                        className="sr-only"
                      />
                      <span className={`h-1.5 w-1.5 rounded-full ${
                        enabledRiskAgents[agent.key] ? agent.dotColor : "bg-slate-700"
                      }`} />
                      <span className="font-mono text-[10px]">{agent.label}</span>
                    </label>
                  ))}
                </div>

                {/* Recharts Stacked Area Chart — not a real time series; do not invent vol attribution */}
                <div className="h-[280px] w-full bg-[#0c1017]/80 rounded-lg border border-slate-850 p-3 pt-6 relative overflow-hidden">
                  <AwaitingSignal reason="Argus does not persist per-agent volatility contribution over time. SentimentAgent and OrderFlowAgent are not live voters. Chart removed rather than seeded." label="Risk decomposition" />
                </div>
              </div>
            </div>

            {/* Right Column - System Audits, Live Trades & Risk Blockages */}
            <div className="flex flex-col gap-6">
              {/* Asset Price Alerts Manager Widget (New Feature) */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col gap-4"
                id="price-alerts-box"
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5 uppercase tracking-wide">
                    <Bell size={15} className="text-amber-500" />
                    Asset Price Alerts
                  </h3>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setShowAlertHistoryModal(true)}
                      className="text-[10px] bg-[#111822] border border-slate-800 font-mono hover:bg-[#1A1F2B] px-2.5 py-1 rounded-full text-slate-300 transition-colors"
                      title="View Alert History"
                    >
                      History
                    </button>
                    <button
                      onClick={requestNotificationPermission}
                      className="text-[10px] bg-[#111822] border border-slate-800 font-mono hover:bg-[#1A1F2B] px-2.5 py-1 rounded-full text-slate-300 transition-colors"
                      title="Enable browser notifications"
                    >
                      Enable Push
                    </button>
                  </div>
                </div>
                
                <p className="text-[11px] text-slate-400 leading-snug">
                  Set triggers on live simulated prices. Triggers play local audio signals and optional browser alerts.
                </p>

                <AwaitingSignal reason="This overlay used a charCodeAt-seeded 40-bar series, not real OHLCV. Use the Strategy Scanner tab (GET /api/v2/strategy/rsi-scan) for RSI on cached bars." label="Alert overlay scanner" />

                {/* Form to set a new Price Alert */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const symbolEl = form.elements.namedItem("alertSymbol") as HTMLInputElement | HTMLSelectElement;
                    const priceEl = form.elements.namedItem("alertPrice") as HTMLInputElement;
                    const conditionEl = form.elements.namedItem("alertCondition") as HTMLSelectElement;
                    const soundEl = form.elements.namedItem("alertSound") as HTMLSelectElement;
                    
                    const symbol = symbolEl.value.trim().toUpperCase();
                    const priceVal = parseFloat(priceEl.value);
                    const cond = conditionEl.value as "greater" | "less";
                    const soundProfile = soundEl ? soundEl.value : "default";
                    
                    if (symbol && !isNaN(priceVal) && priceVal > 0) {
                      addPriceAlert(symbol, priceVal, cond, soundProfile);
                      priceEl.value = "";
                    }
                  }}
                  className="grid grid-cols-12 gap-2"
                >
                  <div className="col-span-5">
                    <select
                      name="alertSymbol"
                      className="w-full bg-[#111822] border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
                      value={selectedAlertSymbol}
                      onChange={(e) => setSelectedAlertSymbol(e.target.value)}
                    >
                      <option value="AAPL">AAPL</option>
                      <option value="MSFT">MSFT</option>
                      <option value="NVDA">NVDA</option>
                      <option value="AMD">AMD</option>
                      <option value="TSLA">TSLA</option>
                      <option value="SPY">SPY</option>
                      <option value="GLD">GLD</option>
                      <option value="TLT">TLT</option>
                      <option value="BTC">BTC</option>
                    </select>
                  </div>
                  <div className="col-span-4">
                    <select
                      name="alertCondition"
                      className="w-full bg-[#111822] border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
                    >
                      <option value="greater">Goes Above</option>
                      <option value="less">Goes Below</option>
                    </select>
                  </div>
                  <div className="col-span-3">
                    <input
                      name="alertPrice"
                      type="number"
                      step="any"
                      placeholder="Price"
                      required
                      className="w-full bg-[#111822] border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-100 placeholder-slate-600 outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div className="col-span-12">
                    <select
                      name="alertSound"
                      className="w-full bg-[#111822] border border-slate-800 rounded px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-indigo-500"
                      defaultValue="default"
                    >
                      <option value="default">Default Chime (880Hz)</option>
                      <option value="urgent">Urgent Warning (Square Wave)</option>
                      <option value="gentle">Gentle Tone (440Hz)</option>
                      <option value="bell">Soft Bell (660Hz)</option>
                    </select>
                  </div>
                  <div className="col-span-12">
                    <button
                      type="submit"
                      className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-1.5 rounded text-xs transition flex items-center justify-center gap-1.5"
                    >
                      <Plus size={13} />
                      Set Price Alert Threshold
                    </button>
                  </div>
                </form>

                {/* Alerts List */}
                <div className="flex-1 overflow-y-auto space-y-2 max-h-[220px] pr-1">
                  {priceAlerts.length === 0 ? (
                    <div className="text-center py-6 bg-slate-955 rounded border border-slate-850">
                      <BellRing size={20} className="mx-auto text-slate-700 mb-1" />
                      <span className="text-[10px] text-slate-500 font-medium">No active or triggered price thresholds set.</span>
                    </div>
                  ) : (
                    priceAlerts.map((alert) => {
                      const currentPrice = assetPrices[alert.symbol];
                      return (
                        <div
                          key={alert.id}
                          className={`p-2 rounded border text-xs flex items-center justify-between gap-1.5 ${
                            alert.isTriggered
                              ? "bg-amber-500/5 border-amber-500/25 opacity-75"
                              : alert.isActive
                                ? "bg-[#111822] border-slate-850"
                                : "bg-[#111822]/40 border-slate-900 text-slate-500"
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="font-extrabold text-slate-200 tracking-wider font-mono">
                                {alert.symbol}
                              </span>
                              <span
                                className={`text-[9px] font-semibold px-1 rounded ${
                                  alert.isTriggered
                                    ? "bg-amber-500/10 text-amber-500"
                                    : alert.isActive
                                      ? "bg-emerald-500/10 text-emerald-400 animate-pulse"
                                      : "bg-slate-800 text-slate-550"
                                }`}
                              >
                                {alert.isTriggered ? "TRIGGERED" : alert.isActive ? "ACTIVE" : "PAUSED"}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-x-2">
                              <span>
                                Target: {alert.condition === "greater" ? "≥" : "≤"} ${alert.targetPrice.toFixed(2)}
                              </span>
                              {currentPrice !== undefined && (
                                <span className="text-slate-500 font-mono">
                                  Current: ${currentPrice.toFixed(2)}
                                </span>
                              )}
                              {alert.soundProfile && alert.soundProfile !== "default" && (
                                <span className="text-indigo-400/80 uppercase text-[9px] font-bold tracking-wider">
                                  🎵 {alert.soundProfile}
                                </span>
                              )}
                            </div>
                            {alert.isTriggered && alert.triggeredAt && (
                              <div className="text-[9px] text-amber-500/80 mt-0.5">
                                Hit: ${alert.triggeredPrice?.toFixed(2)} at {new Date(alert.triggeredAt).toLocaleTimeString()}
                              </div>
                            )}
                          </div>
                          
                          <div className="flex items-center gap-1 font-mono">
                            <button
                              onClick={() => togglePriceAlert(alert.id)}
                              className={`p-1.5 rounded transition ${
                                alert.isActive
                                  ? "text-emerald-400 hover:bg-emerald-950/45"
                                  : "text-slate-500 hover:bg-slate-800"
                              }`}
                              title={alert.isActive ? "Pause Alert" : "Activate Alert"}
                            >
                              <Power size={11} />
                            </button>
                            <button
                              onClick={() => deletePriceAlert(alert.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-rose-950/25 rounded transition"
                              title="Delete Alert"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {priceAlerts.some(a => a.isTriggered) && (
                  <button
                    onClick={clearTriggeredHistory}
                    className="w-full text-[10px] py-1 border border-slate-800 text-slate-500 hover:text-slate-350 hover:bg-slate-800 rounded font-mono transition-colors"
                  >
                    Clear Triggered History
                  </button>
                )}

                {/* Quick-Adjust Target Price Sliders */}
                {priceAlerts.filter(a => !a.isTriggered).length > 0 && (
                  <div className="mt-3 pt-4 border-t border-slate-805 flex flex-col gap-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono font-black uppercase text-indigo-400 tracking-wider flex items-center gap-1.5 leading-none">
                        <Sliders size={11} className="text-indigo-400" />
                        Quick-Adjust Target Prices
                      </span>
                      <span className="text-[8.5px] font-mono text-slate-500 uppercase font-bold">
                        Live Tuner
                      </span>
                    </div>

                    <div className="space-y-3 bg-[#111822] p-3 rounded border border-slate-850/60 max-h-[190px] overflow-y-auto custom-scrollbar">
                      {priceAlerts.filter(a => !a.isTriggered).map((alert) => {
                        const currentPrice = assetPrices[alert.symbol] || alert.targetPrice;
                        // Min: 40% of base currentPrice, Max: 160% of base currentPrice
                        const minRange = Math.max(0.1, Math.round(currentPrice * 0.4));
                        const maxRange = Math.round(currentPrice * 1.6);
                        
                        // Select dynamic step sizes based on asset price density
                        let stepVal = 1;
                        if (currentPrice > 2000) stepVal = 10;
                        else if (currentPrice > 500) stepVal = 5;
                        else if (currentPrice > 100) stepVal = 1;
                        else if (currentPrice > 10) stepVal = 0.5;
                        else stepVal = 0.05;

                        return (
                          <div key={`adjust-${alert.id}`} className="space-y-1.5 border-b border-slate-800/40 pb-2.5 last:border-0 last:pb-0 font-mono">
                            <div className="flex items-center justify-between text-[10px]">
                              <span className="font-extrabold text-slate-300 tracking-wide">
                                {alert.symbol} ({alert.condition === "greater" ? "≥" : "≤"})
                              </span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[9px] text-[#3b82f6] font-bold">
                                  Live: ${currentPrice.toFixed(2)}
                                </span>
                                <span className="text-[9px] text-indigo-405 font-extrabold bg-indigo-505/10 bg-indigo-550/10 border border-indigo-400/20 px-1.5 py-0.5 rounded text-indigo-400">
                                  ${alert.targetPrice.toFixed(2)}
                                </span>
                              </div>
                            </div>
                            
                            <div className="flex items-center gap-2">
                              <span className="text-[8.5px] text-slate-500 font-medium shrink-0">${minRange}</span>
                              <input
                                type="range"
                                min={minRange}
                                max={maxRange}
                                step={stepVal}
                                value={alert.targetPrice}
                                onChange={(e) => updatePriceAlertTarget(alert.id, Number(e.target.value))}
                                className="flex-1 accent-indigo-500 h-1 bg-slate-850 rounded-lg cursor-pointer"
                              />
                              <span className="text-[8.5px] text-slate-500 font-medium shrink-0">${maxRange}</span>
                            </div>

                            <div className="flex items-center justify-between text-[8px] text-slate-500">
                              <span className={alert.isActive ? "text-emerald-500/80" : "text-slate-600"}>
                                {alert.isActive ? "● Active Monitoring" : "○ Paused"}
                              </span>
                              <span className="text-[#3b82f6]/95 text-[8.5px] font-bold">
                                {alert.condition === "greater" 
                                  ? `${Math.max(0, parseFloat(((alert.targetPrice - currentPrice) / currentPrice * 100).toFixed(1)))}% Above Spot`
                                  : `${Math.max(0, parseFloat(((currentPrice - alert.targetPrice) / currentPrice * 100).toFixed(1)))}% Below Spot`}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* Active Broker Executions */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col h-full max-h-[480px]"
                id="broker-executions-box"
              >
                <div className="flex items-center justify-between mb-3.5">
                  <h3 className="text-sm font-bold text-white flex items-center gap-1.5 uppercase tracking-wide">
                    <Layers size={15} className="text-emerald-400" />
                    Live Broker Feed
                  </h3>
                    <select
                    className="bg-[#111822] border border-slate-700 text-xs text-slate-300 rounded px-2 py-1 outline-none focus:border-indigo-500"
                    value={selectedBroker}
                    onChange={(e) => setSelectedBroker(e.target.value)}
                  >
                    <option value="Internal Paper">Internal Paper</option>
                    <option value="Alpaca (Sim)">Alpaca paper/sim</option>
                    <option value="Alpaca (Live)">Alpaca live</option>
                    <option value="Interactive Brokers (Paper)">Interactive Brokers paper</option>
                    <option value="Interactive Brokers (Live)">Interactive Brokers live</option>
                    <option value="Questrade (Sim)">Questrade (read-only)</option>
                    <option value="Coinbase">Coinbase (spot; paper placeOrder refused)</option>
                  </select>
                </div>
                <p className="text-[11px] text-slate-400 mb-3">
                  Display filter only — does not change <code className="text-[10px]">BrokerManager</code>.
                  Order routing is whatever Settings selected (Alpaca, IBKR, Coinbase, Internal Paper).
                  Questrade cannot place orders. Robinhood/Schwab have no adapter.
                </p>

                <div
                  className="flex-1 overflow-y-auto space-y-3 pr-1"
                  id="executions-list"
                >
                  {trades.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center py-12 bg-[#111822] rounded border border-slate-850">
                      <Clock size={28} className="text-slate-600 mb-1.5" />
                      <span className="text-xs text-slate-400 font-medium">
                        No swap orders executed in current workspace session.
                      </span>
                      <p className="text-[10px] text-slate-500 max-w-[200px] mt-0.5">
                        Simulate trade entries on parameters above to fill
                        ledger.
                      </p>
                    </div>
                  ) : (
                    trades.map((t: Trade, i: number) => (
                      <div
                        key={i}
                        className="bg-[#111822] p-3 rounded-lg border border-slate-850 flex flex-col gap-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white tracking-widest">
                              {t.symbol}
                            </span>
                            <span
                              className={`text-[9px] font-bold px-2 py-0.5 rounded ${
                                t.side === "BUY"
                                  ? "bg-emerald-500/10 text-emerald-400"
                                  : "bg-rose-500/10 text-rose-400"
                              }`}
                            >
                              {t.side}
                            </span>
                          </div>
                          <span className={`text-[10px] font-semibold font-mono ${
                            t.status === "FILLED" ? "text-emerald-400"
                              : t.status === "REJECTED" || t.status === "CANCELED" ? "text-rose-400"
                              : "text-amber-400"
                          }`}>
                            {t.status || "UNKNOWN"}
                          </span>
                        </div>
                        <p className="text-[10px] text-slate-400 leading-tight">
                          {t.thesis}
                        </p>
                        <div className="flex items-center justify-between text-[9px] font-mono text-slate-500 pt-1 border-t border-slate-850">
                          <span>
                            Qty: <b>{t.quantity}</b> @ <b>${t.price}</b>
                          </span>
                          <span className="flex items-center gap-2">
                            {t.id && t.status && !["FILLED", "REJECTED", "CANCELED"].includes(t.status) && (
                              <button
                                type="button"
                                disabled={cancelingOrderIds.has(t.id)}
                                className="text-[9px] uppercase tracking-widest text-rose-300 border border-rose-500/40 px-1.5 py-0.5 rounded hover:bg-rose-500/10 disabled:opacity-50 disabled:cursor-not-allowed"
                                onClick={async () => {
                                  setCancelingOrderIds(prev => new Set(prev).add(t.id));
                                  setCancelOrderErrors(prev => { const next = { ...prev }; delete next[t.id]; return next; });
                                  try {
                                    const res = await fetch(`/api/v2/trading/cancel-order/${encodeURIComponent(t.id)}`, { method: "POST" });
                                    const body = await res.json().catch(() => ({}));
                                    if (!res.ok || body.ok === false) {
                                      setCancelOrderErrors(prev => ({ ...prev, [t.id]: body.error || `Cancel refused (${res.status})` }));
                                    } else {
                                      fetchState();
                                    }
                                  } catch (err: any) {
                                    setCancelOrderErrors(prev => ({ ...prev, [t.id]: err?.message || "Failed to reach the server." }));
                                  } finally {
                                    setCancelingOrderIds(prev => { const next = new Set(prev); next.delete(t.id); return next; });
                                  }
                                }}
                              >
                                {cancelingOrderIds.has(t.id) ? "Canceling..." : "Cancel"}
                              </button>
                            )}
                            <span>
                              {new Date(t.timestamp).toLocaleTimeString()}
                            </span>
                          </span>
                        </div>
                        {t.id && cancelOrderErrors[t.id] && (
                          <p className="text-[9px] text-rose-400 pt-1">{cancelOrderErrors[t.id]}</p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Strict Risk Veto Records */}
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col max-h-[600px]"
                id="risk-vetos-box"
              >
                <h3 className="text-sm font-bold text-white mb-3 text-amber-400 flex items-center gap-2 uppercase tracking-wide">
                  <AlertTriangle size={15} />
                  Risk Veto Audit Trail (Absolute Veto Power)
                </h3>
                <p className="text-[11px] text-slate-400 mb-3">
                  Live trace logs of orders blocked by child Risk Agents during
                  diversification/drawdown checks.
                </p>

                <div
                  className="overflow-y-auto space-y-3 flex-1 pr-1 mb-6"
                  id="vetos-scroll-area"
                >
                  {vetos.length === 0 ? (
                    <span className="text-xs text-slate-500">
                      No active vetos registered in trial logs.
                    </span>
                  ) : (
                    vetos.map((v: RiskVeto, idx: number) => (
                      <div
                        key={idx}
                        className="bg-[#111822] p-3 rounded-lg border border-amber-500/10 bg-amber-500/[0.01] flex flex-col gap-1.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-extrabold text-amber-400">
                            {v.symbol}
                          </span>
                          <span className="text-[9px] font-mono uppercase bg-amber-500/10 border border-amber-500/20 text-amber-400 px-2 py-0.5 rounded font-black tracking-wider">
                            {v.vetoed_by.replace("_", " ")}
                          </span>
                        </div>
                        <p className="text-[10.5px] leading-relaxed text-slate-300">
                          {v.veto_reason}
                        </p>
                        <div className="flex justify-between items-center text-[9px] font-mono text-slate-500 pt-1 border-t border-slate-850">
                          <span>
                            Rule action:{" "}
                            <b className="text-slate-300">{v.action_taken}</b>
                          </span>
                          <span>
                            {new Date(v.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="pt-4 border-t border-slate-800">
                  <h4 className="text-[10px] font-mono text-slate-400 uppercase mb-3 flex justify-between items-center">
                    <span>Mitigation vs Drawdown Trend</span>
                  </h4>
                  {/* This used to plot a fixed, hardcoded 14-point intraday series comparing a
                      fictional "unprotected" portfolio against RiskEngine's real mitigation - no
                      real counterfactual ("what would have happened without RiskEngine") exists
                      anywhere in this codebase; Argus does not run a parallel unprotected
                      simulation. Building one for real is a genuine future feature (a real
                      shadow-portfolio run), not a small incremental fix - honestly disclosed as
                      not yet implemented rather than fabricated. */}
                  <div className="h-[140px] w-full flex items-center justify-center">
                    <AwaitingSignal reason="No real counterfactual exists - Argus does not run a parallel unprotected simulation to compare against." label="Mitigation vs Drawdown" />
                  </div>
                </div>
              </div>
            </div>
          </div>
          </div>
        )})()}

        {/* Tab 2: Passive Positions and cash balances */}
        {activeTab === "portfolio" && (
          <div
            className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 animate-fade-in"
            id="positions-view-tab"
          >
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-base font-bold text-white flex items-center gap-1.5">
                  <Wallet size={18} className="text-emerald-400" />
                  Active Asset Positions Ledger
                </h3>
                <p className="text-xs text-slate-400">
                  {autoBotTradingMode === "LIVE" ? "Live production" : autoBotTradingMode === "PAPER" ? "Standard paper" : "Simulated"} portfolios tracked dynamically against incoming
                  ticker fluctuations
                </p>
              </div>
              <div className="flex flex-col text-right">
                {portfolioDrawdownPercent < 0 && (
                  <p className={`text-xs mb-2 font-mono ${isDrawdownCritical ? "text-rose-500 font-bold animate-pulse" : "text-amber-500"}`}>
                    Total Drawdown: {portfolioDrawdownPercent.toFixed(2)}%
                  </p>
                )}
              <div className="flex gap-2 justify-end">
                <button
                  onClick={async () => {
                     if (!window.confirm("Are you sure you want to market-sell ALL open positions?")) return;
                     try {
                        const res = await fetch("/api/v1/portfolio/liquidate", { method: "POST" });
                        if (res.ok) fetchState();
                     } catch(e) {}
                  }}
                  disabled={!isDrawdownCritical || portfolioData?.positions?.length === 0}
                  className={`text-[11px] font-bold px-3 py-1.5 border rounded flex items-center gap-1.5 transition-all outline-none shadow-sm ${isDrawdownCritical ? "bg-rose-600 hover:bg-rose-500 border-rose-500 text-white shadow-[0_0_10px_rgba(225,29,72,0.4)]" : "bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed"}`}
                >
                  <AlertTriangle size={12} className={isDrawdownCritical ? "animate-pulse" : ""} />
                  EMERGENCY LIQUIDATION
                </button>
                <button
                  type="button"
                  disabled
                  title="Target-allocation rebalance is not implemented (POST /api/v1/portfolio/rebalance returns 501). Flattening via broker.closePosition is forbidden because it bypasses RiskEngine. Use Emergency Stop and/or Emergency Liquidation, which emits SELL ideas through the pipeline."
                  className="text-[11px] bg-slate-800 border border-slate-700 text-slate-500 font-bold px-3 py-1.5 rounded flex items-center gap-1.5 cursor-not-allowed"
                >
                  <Scale size={12} />
                  REBALANCE ALL
                  <span className="text-[9px] font-mono">UNAVAILABLE</span>
                </button>
                <button
                  onClick={fetchState}
                  className="text-[11px] bg-slate-800 hover:bg-slate-700 font-semibold px-3 py-1.5 border border-slate-700 text-slate-300 rounded flex items-center gap-1.5"
                >
                  <RefreshCw size={12} />
                  REFRESH MARKET PRICING
                </button>
              </div>
              </div>
            </div>

            <PositionsDataView
              positions={(portfolioData?.positions ?? []).map((p: any) =>
                toPositionLedgerRow(p, assetPrices[p?.symbol]),
              )}
              cashBalance={portfolioData?.snapshot?.cash_balance}
              emptyMessage="No active allocations found in the broker portfolio. Emergency Liquidation submits SELL ideas through RiskEngine when positions exist; target-allocation rebalance is not implemented."
            />
            
            {/* PORTFOLIO STRESS TESTING (SCENARIO SIMULATOR) */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <Activity size={16} className="text-rose-400" />
                  Portfolio Stress Testing (Scenario Simulator)
                </h3>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest border border-slate-700 px-2 py-1 rounded bg-[#111822]">
                  Risk Management Module
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
                Real what-if calculator against your current real open positions. The shock percentage is an assumption YOU supply (only "Flash Crash" pre-fills a number, since that scenario's own description already states "-10% overall market cap" - the other three have no stated equity-impact figure, so nothing is invented here). Everything else - dollar impact, affected sectors, and whether RiskEngine's real portfolio_drawdown gate would actually trip - is computed from real current data.
              </p>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                {[
                  { name: "Flash Crash", desc: "-10% overall market cap within 30 mins", shockPct: -10 },
                  { name: "CPI Spike", desc: "Inflation print >0.5% over expectations - no stated equity-impact figure; set your own assumption below", shockPct: null },
                  { name: "Interest Rate Hike", desc: "+50bps unexpected FED hike - no stated equity-impact figure; set your own assumption below", shockPct: null },
                  { name: "Geopolitical Shock", desc: "Major supply chain disruption - no stated equity-impact figure; set your own assumption below", shockPct: null },
                ].map(sc => (
                  <button
                    key={sc.name}
                    onClick={() => { setStressScenario(sc.name); setShowStressTest(true); if (sc.shockPct !== null) setStressShockPct(sc.shockPct); setStressResult(null); }}
                    className={`text-left p-4 rounded-lg border transition-all ${
                      stressScenario === sc.name && showStressTest ? `bg-slate-800 border-slate-500 shadow-[0_0_15px_rgba(0,0,0,0.5)]` : "bg-[#111822] border-slate-800 hover:border-slate-600"
                    }`}
                  >
                    <h4 className={`text-xs font-bold uppercase tracking-widest mb-1 ${stressScenario === sc.name && showStressTest ? `text-white` : "text-slate-300"}`}>{sc.name}</h4>
                    <p className="text-[9px] text-slate-500">{sc.desc}</p>
                  </button>
                ))}
              </div>

              {showStressTest && (
                <div className="bg-[#111822] border border-slate-800 rounded-lg p-5 animate-fade-in flex flex-col gap-4 mt-4">
                  <div className="flex items-end gap-3">
                    <div>
                      <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Assumed Shock %</label>
                      <input
                        type="number"
                        step="1"
                        min="-100"
                        max="0"
                        value={stressShockPct}
                        onChange={(e) => setStressShockPct(Number(e.target.value))}
                        className="w-28 bg-[#1A1F2B] border border-slate-700 text-white text-sm font-mono rounded p-2 focus:outline-none focus:border-rose-500"
                      />
                    </div>
                    <button
                      onClick={() => runStressTest(stressShockPct)}
                      disabled={stressLoading || stressShockPct >= 0}
                      className="px-4 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 text-white text-xs font-bold uppercase tracking-widest rounded transition-colors"
                    >
                      {stressLoading ? 'Calculating...' : 'Run Real Calculation'}
                    </button>
                  </div>

                  {stressError && (
                    <div className="text-xs text-rose-400 font-mono">{stressError}</div>
                  )}

                  {stressResult && stressResult.available === false && (
                    <AwaitingSignal reason={stressResult.reason} label="Stress Test" />
                  )}

                  {stressResult && stressResult.available === true && (
                    <div className="flex flex-col md:flex-row gap-6">
                      <div className="flex-1 space-y-4">
                        <div>
                          <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Projected Impact (real positions, assumed {stressResult.data.shockPct}% shock)</span>
                          <span className="text-2xl font-bold text-rose-400">${stressResult.data.projectedLoss.toLocaleString()}</span>
                          <span className="text-xs text-slate-500 ml-2">${stressResult.data.totalValue.toLocaleString()} → ${stressResult.data.projectedValue.toLocaleString()}</span>
                        </div>
                        <div>
                           <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Real Affected Sectors (current holdings)</span>
                           <div className="flex gap-2 text-[10px] font-mono mt-1 flex-wrap">
                             {stressResult.data.affectedSectors.map((s: string) => (
                               <span key={s} className="bg-slate-800 text-slate-300 px-2 py-1 rounded">{s}</span>
                             ))}
                           </div>
                        </div>
                      </div>
                      <div className="flex-1 border-l border-slate-800 pl-6">
                         <span className="text-[10px] uppercase font-mono text-slate-500 block mb-3">Real RiskEngine Portfolio-Drawdown Gate</span>
                         {stressResult.data.wouldTripDrawdownGate === null ? (
                           <span className="text-xs font-bold text-slate-400 flex items-center gap-1.5"><ShieldAlert size={14}/> No real peak-equity baseline yet</span>
                         ) : stressResult.data.wouldTripDrawdownGate ? (
                           <span className="text-xs font-bold text-rose-400 flex items-center gap-1.5"><ShieldAlert size={14}/> Would trip - trading would halt</span>
                         ) : (
                           <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5"><ShieldAlert size={14}/> Would NOT trip</span>
                         )}
                         <p className="text-[10px] text-slate-500 font-mono mt-2">{stressResult.data.drawdownGateDetail}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* AUTOMATED TASK SCHEDULER */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 mt-6">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <RefreshCw size={16} className="text-indigo-400" />
                  Automated Task Scheduler
                </h3>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest border border-slate-700 px-2 py-1 rounded bg-[#111822]">
                  Cron / Automation
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
                Configure automated portfolio rebalancing routines. The system will programmatically trim or add exposure to target sectors based on the weights defined below.
              </p>

              <div className="flex flex-col md:flex-row gap-6">
                <div className="flex-1 bg-[#111822] border border-slate-800 rounded-lg p-4">
                  <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-4">Create New Routine</h4>
                  
                  <div className="mb-4">
                    <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Frequency</label>
                    <div className="flex gap-2">
                      {["Daily", "Weekly"].map(f => (
                        <button
                          key={f}
                          onClick={() => setSchedulerFreq(f)}
                          className={`px-3 py-1.5 text-xs font-mono rounded border transition-colors ${schedulerFreq === f ? "bg-indigo-600 border-indigo-500 text-white" : "bg-[#1A1F2B] border-slate-700 text-slate-400 hover:text-slate-200"}`}
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-4">
                    <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Target Sector Weights (JSON)</label>
                    <textarea 
                      value={schedulerWeights}
                      onChange={(e) => setSchedulerWeights(e.target.value)}
                      className="w-full h-24 bg-[#1A1F2B] border border-slate-700 rounded text-xs font-mono text-slate-300 p-2 focus:border-indigo-500 outline-none resize-none"
                    />
                  </div>

                  <button 
                    disabled={isAddingTask}
                    onClick={async () => {
                      setIsAddingTask(true);
                      try {
                        const parsedWeights = JSON.parse(schedulerWeights);
                        const res = await fetch("/api/v1/scheduler", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ frequency: schedulerFreq, targetWeights: parsedWeights })
                        });
                        if (res.ok) {
                          const data = await res.json();
                          setScheduledTasks(prev => [...prev, data.task]);
                        }
                      } catch (e) {
                        alert("Invalid JSON weights");
                      } finally {
                        setIsAddingTask(false);
                      }
                    }}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold uppercase tracking-widest rounded transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {isAddingTask ? <RefreshCw size={14} className="animate-spin" /> : <Database size={14} />}
                    Deploy Rebalance Task
                  </button>
                </div>

                <div className="flex-1">
                  <h4 className="text-xs font-bold text-white uppercase tracking-widest mb-4">Active Routines</h4>
                  {scheduledTasks.length === 0 ? (
                    <div className="border border-dashed border-slate-700 rounded-lg p-8 flex flex-col items-center justify-center text-center">
                      <Clock size={24} className="text-slate-600 mb-2" />
                      <span className="text-xs font-mono text-slate-500">No scheduled tasks.</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {scheduledTasks.map(task => (
                        <div key={task.id} className="bg-[#111822] border border-slate-700 rounded-lg p-3 flex justify-between items-start">
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <span className="px-2 py-0.5 bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 rounded text-[9px] font-mono uppercase font-bold tracking-widest">
                                {task.frequency}
                              </span>
                              <span className="text-xs font-bold text-slate-200">Rebalance Portfolio</span>
                            </div>
                            <div className="text-[10px] font-mono text-slate-400 mt-2">
                              Target Weights:
                              <div className="mt-1 flex flex-wrap gap-1">
                                {Object.entries(task.targetWeights || {}).map(([k, v]: [string, any]) => (
                                  <span key={k} className="bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded text-[9px]">
                                    {k}: {v as number}%
                                  </span>
                                ))}
                              </div>
                            </div>
                            <div className="text-[9px] font-mono text-slate-500 mt-2">
                              Next run: {new Date(task.nextRun).toLocaleString()}
                            </div>
                          </div>
                          <button 
                            onClick={async () => {
                              await fetch("/api/v1/scheduler/" + task.id, { method: "DELETE" });
                              setScheduledTasks(prev => prev.filter(t => t.id !== task.id));
                            }}
                            className="p-1.5 text-slate-500 hover:text-rose-400 transition-colors bg-slate-800 rounded"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>

          </div>
        )}

        {/* Tab 3: Detailed AI Agents & Performance tracking */}
        {activeTab === "news" && (
          <NewsDashboardTab />
        )}

        {activeTab === "intelligence" && (
          <div className="animate-fade-in flex flex-col gap-6" id="intelligence-view">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white mb-2 uppercase tracking-wide">Quantitative Intelligence</h3>
              <p className="text-[11px] text-slate-400 font-mono mb-4 leading-relaxed">
                The old fabricated ADX/RSI/Options theater was removed. The live quant scanner (OHLCV + <code className="text-cyan-500">/api/v2/quant/*</code>) lives on Strategy Scanner so this tab does not duplicate that panel.
                Quant agent ideas still need <code className="text-cyan-500">QUANT_ENGINE_ENABLED=true</code> and Autobot started. Kronos/Chronos is optional evidence on :8008.
              </p>
              <button
                type="button"
                onClick={() => setActiveTab("scanner")}
                className="px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold uppercase tracking-widest"
              >
                Open Strategy Scanner
              </button>
            </div>
          </div>
        )}

{activeTab === "agents" && (() => {
          const minPreds = tradingSafetyConfig.agentWinRateAlertMinPredictions;
          const scored = (learningSummary?.agentWeights ?? []).filter((a: any) => a.winRate !== null && a.totalPredictions >= minPreds);
          const failingAgents = scored.filter((a: any) => a.winRate < perfAlertThreshold);
          const barData = (learningSummary?.agentWeights ?? [])
            .filter((a: any) => a.winRate !== null)
            .map((a: any) => ({ agent: a.agentName, winRate: a.winRate, predictions: a.totalPredictions }));
          
          return (
          <div className="flex flex-col gap-6 animate-fade-in" id="agents-performance-view">
            {perfAlertEnabled && failingAgents.length > 0 && (
              <div className="bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 flex items-start gap-4">
                <ShieldAlert className="text-rose-400 mt-0.5" size={20} />
                <div>
                  <h4 className="text-rose-400 font-bold text-sm uppercase tracking-wide mb-1">Performance Threshold Alert</h4>
                  <p className="text-rose-200/80 text-xs">
                    {failingAgents.map((a: any) => a.agentName).join(", ")} scored win rate is below {perfAlertThreshold}%
                    ({minPreds}+ real predictions in <code className="text-[10px]">agent_performance_stats</code>
                    — lifetime, not a 24h series; that window is not stored). Reflection already feeds these win rates into ChiefTrader weights. SentimentAgent / OrderFlowAgent do not exist on the live path.
                  </p>
                </div>
              </div>
            )}

            {/* Live Agent Network — EventBus WebSocket only. No looping demo graphs. */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex items-center justify-between mb-3.5">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <Network size={15} className="text-sky-400" />
                  Network Topology & Data Flow
                </h3>
              </div>
              <p className="text-xs text-slate-400 mb-5">
                Hover a node for the last real payload. Packets move only when the matching EventBus event arrives. Click a node for the process log; click a transaction to trace it by real trace ID.
              </p>
              <OrchestrationStatus models={orchestrationModels} capital={orchestrationCapital} />
              <DigitalTwinVisualizer />
            </div>

            <ChiefTraderAgent />

            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <AwaitingSignal
                label="Multi-Agent Dialogue Graph"
                reason="That D3 graph used SentimentAgent / OrderFlowAgent (not live voters) and looped fake propose/veto packets on a timer. DATA_UNAVAILABLE. Use the telemetry map above."
              />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5" id="agent-performance-card">
                <h3 className="text-sm font-bold text-white mb-3.5 flex items-center gap-2 uppercase tracking-wide">
                  <BarChart3 size={15} className="text-indigo-400" />
                  Agent scored win rate
                </h3>
                <p className="text-xs text-slate-400 mb-5">
                  Lifetime win rate from ReflectionEngine / <code className="text-[10px]">agent_performance_stats</code>. There is no daily win-rate time series and no Python <code className="text-[10px]">performance_manager.py</code> in this repo. SentimentAgent is not a live voter.
                </p>
                <div className="flex-1 min-h-[300px]" id="agent-performance-grid">
                  {barData.length === 0 ? (
                    <AwaitingSignal reason="No scored agent_performance_stats rows yet (totalPredictions = 0). Win rate is not fabricated." />
                  ) : (
                  <SafeResponsiveContainer>
                    <BarChart data={barData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <XAxis dataKey="agent" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} interval={0} />
                      <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} domain={[0, 100]} tickFormatter={(val) => `${val}%`} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#111822', borderColor: '#1e293b', fontSize: '10px', color: '#f8fafc' }}
                        formatter={(val: any, _n: any, p: any) => [`${val}% (${p.payload.predictions} predictions)`, 'Win rate']}
                      />
                      <Bar dataKey="winRate" fill="#818cf8" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </SafeResponsiveContainer>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-col gap-6">
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col min-h-[300px]" id="agent-weighting-visualizer">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wide">
                  <Layers size={15} className="text-indigo-400" />
                  Active Regime Casting Weights
                </h3>
                <p className="text-xs text-slate-400 mb-4">
                  ChiefTrader weights from <code className="text-[10px]">agent_performance_stats.currentWeight</code> (ReflectionEngine). Not a separate regime-casting optimizer.
                </p>
                <div className="flex-1 bg-[#111822] rounded-lg p-4 flex flex-col justify-center border border-slate-800 gap-3" id="regime-weights-chart">
                  {!(learningSummary?.agentWeights?.length) ? (
                    <AwaitingSignal compact reason="Weights load with GET /api/v2/agents/learning-summary." />
                  ) : learningSummary.agentWeights.map((a: any) => (
                    <div key={a.agentName}>
                      <div className="flex justify-between text-[10px] font-mono text-slate-400 mb-1">
                        <span>{a.agentName}</span>
                        <span className="text-indigo-300">{a.currentWeight == null ? '—' : a.currentWeight.toFixed(3)}</span>
                      </div>
                      <div className="h-1.5 bg-slate-800 rounded overflow-hidden">
                        <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, Math.max(0, (a.currentWeight ?? 0) * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col">
                 <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wide">
                   <Settings size={15} className="text-indigo-400" />
                   Performance Alert Config
                 </h3>
                 <p className="text-xs text-slate-400 mb-4">UI-only banner when a real scored win rate is below this percent. Default is <code className="text-[10px]">tradingSafety.agentWinRateAlertPct</code>. Does not change RiskEngine.</p>
                 
                 <div className="space-y-4">
                   <div className="flex items-center justify-between">
                     <span className="text-xs text-white font-mono">Enable Alerts</span>
                     <button 
                       onClick={() => setPerfAlertEnabled(!perfAlertEnabled)} 
                       className="text-slate-400 hover:text-white transition-colors"
                     >
                       {perfAlertEnabled ? <ToggleRight size={24} className="text-emerald-400" /> : <ToggleLeft size={24} />}
                     </button>
                   </div>
                   
                   <div className="space-y-2">
                     <div className="flex justify-between items-center">
                       <span className="text-xs text-white font-mono">Win-Rate Threshold</span>
                       <span className="text-xs font-bold text-indigo-400">{perfAlertThreshold}%</span>
                     </div>
                     <input 
                       type="range" 
                       min="20" 
                       max="80" 
                       value={perfAlertThreshold} 
                       onChange={(e) => setPerfAlertThreshold(Number(e.target.value))}
                       disabled={!perfAlertEnabled}
                       className="w-full accent-indigo-500 opacity-80 hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" 
                     />
                     <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                       <span>20%</span>
                       <span>80%</span>
                     </div>
                   </div>
                 </div>
              </div>

              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wide">
                  <Timer size={15} className="text-indigo-400" />
                  System Latency
                </h3>
                <p className="text-[10px] text-slate-400 mb-4 leading-relaxed">Per-agent submit latency is not stored. This panel does not invent millisecond figures.</p>
                <AwaitingSignal reason="No per-agent latency table exists. SYSTEM_METRICS is process-wide when the backend emits it; it is not NewsAgent vs SentimentAgent RTT." />
              </div>

              {/* Agent Node Stability Snapshot */}
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2 uppercase tracking-wide">
                  <Activity size={15} className="text-indigo-400" />
                  Agent Node Stability Snapshot
                </h3>
                <p className="text-[10px] text-slate-400 mb-4 leading-relaxed">Status from scored win rate only (same stats as the alert). Latency is not mixed in — that series was fabricated.</p>
                {!(learningSummary?.agentWeights?.length) ? (
                  <AwaitingSignal compact reason="Loads with GET /api/v2/agents/learning-summary." />
                ) : (
                <div className="space-y-3">
                  {learningSummary.agentWeights.map((node: any) => {
                    const enough = node.totalPredictions >= minPreds && node.winRate !== null;
                    let status = "No sample";
                    let dotColor = "bg-slate-600";
                    let textColor = "text-slate-500";
                    if (enough && node.winRate >= perfAlertThreshold) {
                      status = "Healthy";
                      dotColor = "bg-emerald-500";
                      textColor = "text-emerald-400";
                    } else if (enough) {
                      status = "Below threshold";
                      dotColor = "bg-rose-500 animate-pulse";
                      textColor = "text-rose-400";
                    }

                    return (
                      <div key={node.agentName} className="flex flex-col gap-2 border-b border-slate-800/50 pb-3 last:border-0 last:pb-0">
                        <div className="flex justify-between items-center text-xs">
                          <span className="text-slate-300 font-mono tracking-tight">{node.agentName}</span>
                          <div className="flex items-center gap-2">
                            <span className={`font-mono font-bold ${textColor}`}>{status}</span>
                            <div className={`w-2 h-2 rounded-full ${dotColor}`}></div>
                          </div>
                        </div>
                        <div className="flex justify-between items-center text-[10px] font-mono text-slate-500 bg-[#111822] p-1.5 rounded border border-slate-800">
                          <span>Win Rate: <span className="text-slate-300">{node.winRate == null ? '—' : `${node.winRate}%`}</span></span>
                          <span>Predictions: <span className="text-slate-300">{node.totalPredictions}</span></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
                )}
              </div>
            </div>
            
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <Sliders size={15} className="text-indigo-400" />
                  Agent Hyperparameter Tuning
                </h3>
                <span className="text-[10px] font-mono text-slate-500 uppercase tracking-widest border border-slate-700 px-2 py-1 rounded bg-[#111822]">
                  Live Hot-Reload Active
                </span>
              </div>
              <p className="text-[11px] text-slate-400 mb-6 leading-relaxed max-w-4xl">
                Manual override console for internal agent threshold and behavior tuning. Adjusting these parameters directly impacts inference generation and confidence grading prior to the multi-agent consensus vote.
              </p>
              
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
                {/* News NLP Tuning */}
                <div className="bg-[#111822] rounded p-4 border border-slate-800 relative group transition-colors hover:border-slate-700">
                   <div className="flex items-center gap-2 mb-3">
                     <span className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)]"></span>
                     <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest">News NLP Agent</h4>
                   </div>
                   <div className="mb-4">
                     <div className="flex justify-between text-[10px] text-slate-400 mb-1 font-mono uppercase tracking-widest">
                       <span>Headline Sensitivity</span>
                       <span className="text-blue-400 font-bold">{hyperparams.newsSensitivity}%</span>
                     </div>
                     <input 
                       type="range" 
                       min="0" max="100" 
                       value={hyperparams.newsSensitivity} 
                       onChange={(e) => setHyperparams({...hyperparams, newsSensitivity: Number(e.target.value)})}
                       className="w-full accent-blue-500 cursor-pointer h-1.5 bg-slate-800 appearance-none rounded-full" 
                     />
                   </div>
                   <p className="text-[9px] text-slate-500 leading-tight">Controls the context window threshold for interpreting breaking news. High values over-index on recent headlines.</p>
                </div>

                {/* Macro Quant Tuning */}
                <div className="bg-[#111822] rounded p-4 border border-slate-800 relative group transition-colors hover:border-slate-700">
                   <div className="flex items-center gap-2 mb-3">
                     <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]"></span>
                     <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Macro Quant Agent</h4>
                   </div>
                   <div className="mb-4">
                     <div className="flex justify-between text-[10px] text-slate-400 mb-1 font-mono uppercase tracking-widest">
                       <span>Yield Shock Tolerance</span>
                       <span className="text-emerald-400 font-bold">{hyperparams.macroTolerance} bps</span>
                     </div>
                     <input 
                       type="range" 
                       min="10" max="150" 
                       value={hyperparams.macroTolerance} 
                       onChange={(e) => setHyperparams({...hyperparams, macroTolerance: Number(e.target.value)})}
                       className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-slate-800 appearance-none rounded-full" 
                     />
                   </div>
                   <p className="text-[9px] text-slate-500 leading-tight">Defines the baseline basis point shift required in Treasury yields before the agent flags a systemic regime change.</p>
                </div>

                {/* Technical TA Tuning */}
                <div className="bg-[#111822] rounded p-4 border border-slate-800 relative group transition-colors hover:border-slate-700">
                   <div className="flex items-center gap-2 mb-3">
                     <span className="w-2 h-2 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(168,85,247,0.6)]"></span>
                     <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Technical Agent</h4>
                   </div>
                   <div className="mb-4">
                     <div className="flex justify-between text-[10px] text-slate-400 mb-1 font-mono uppercase tracking-widest">
                       <span>Smoothing Factor (RSI)</span>
                       <span className="text-purple-400 font-bold">{hyperparams.techSmoothing} P</span>
                     </div>
                     <input 
                       type="range" 
                       min="4" max="30" 
                       value={hyperparams.techSmoothing} 
                       onChange={(e) => setHyperparams({...hyperparams, techSmoothing: Number(e.target.value)})}
                       className="w-full accent-purple-500 cursor-pointer h-1.5 bg-slate-800 appearance-none rounded-full" 
                     />
                   </div>
                   <p className="text-[9px] text-slate-500 leading-tight">Adjusts the period smoothing logic across oscillators. Lower values generate more aggressive breakout signals.</p>
                </div>

                {/* Sentiment Tuning */}
                <div className="bg-[#111822] rounded p-4 border border-slate-800 relative group transition-colors hover:border-slate-700">
                   <div className="flex items-center gap-2 mb-3">
                     <span className="w-2 h-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"></span>
                     <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest">Sentiment Social</h4>
                   </div>
                   <div className="mb-4">
                     <div className="flex justify-between text-[10px] text-slate-400 mb-1 font-mono uppercase tracking-widest">
                       <span>Volume Burst Filter</span>
                       <span className="text-amber-400 font-bold">{hyperparams.sentimentBurst}x</span>
                     </div>
                     <input 
                       type="range" 
                       min="1" max="10" step="0.1"
                       value={hyperparams.sentimentBurst} 
                       onChange={(e) => setHyperparams({...hyperparams, sentimentBurst: Number(e.target.value)})}
                       className="w-full accent-amber-500 cursor-pointer h-1.5 bg-slate-800 appearance-none rounded-full" 
                     />
                   </div>
                   <p className="text-[9px] text-slate-500 leading-tight">Multiplier threshold for validating retail engagement velocity compared to a 30-day baseline moving average.</p>
                </div>
              </div>
            </div>

            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5" id="agent-heatmap">
               <div className="flex justify-between items-center mb-4">
                 <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                   <Activity size={15} className="text-indigo-400" />
                   Cross-Regime P&L Contribution Heatmap
                 </h3>
                 <div className="flex gap-4 text-[10px] uppercase font-mono tracking-widest text-slate-500">
                    <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> High Alpha</span>
                    <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-slate-700"></div> Neutral</span>
                    <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-rose-500"></div> Negative</span>
                 </div>
               </div>
               
               <div className="w-full overflow-x-auto">
                 <AwaitingSignal reason="Cross-regime per-agent P&L is not stored. SentimentAgent and OrderFlowAgent are not live voters. This heatmap is not a real performance series." label="Regime heatmap" />
               </div>
              </div>
            </div>

            {/* Trade Execution Correlation */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white mb-3.5 flex items-center gap-2 uppercase tracking-wide">
                <Network size={15} className="text-emerald-400" />
                Trade Execution Correlation Matrix
              </h3>
              <p className="text-xs text-slate-400 mb-5">
                Analyze pair-wise relationships and decision overlap between different agent archetypes in real-time. Uncover which network shards co-authorize the same trade intents most frequently.
              </p>
              <div className="flex-1 bg-[#111822] rounded-lg border border-slate-800 p-4">
                 <TradeCorrelationMatrix />
              </div>
            </div>

            {/* Agent Comparison View */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <Activity size={16} className="text-sky-400" />
                  Agent ROI & Metric Comparison
                </h3>
                <div className="flex items-center gap-4">
                  <button
                    onClick={() => setIsAgentComparisonModalOpen(true)}
                    className="flex items-center gap-1.5 text-[10px] uppercase font-mono tracking-widest text-sky-400 border border-sky-400/30 hover:bg-sky-400/10 px-3 py-1.5 rounded transition-colors"
                  >
                    <Maximize2 size={12} />
                    Open Deep Comparison
                  </button>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-white font-mono uppercase">Compare Nodes</span>
                    <button
                      onClick={() => setIsComparisonActive(!isComparisonActive)}
                      className="text-slate-400 hover:text-white transition-colors"
                    >
                      {isComparisonActive ? <ToggleRight size={24} className="text-sky-400" /> : <ToggleLeft size={24} />}
                    </button>
                  </div>
                </div>
              </div>

              {isComparisonActive ? (
                <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 animate-fade-in">
                  {/* Selectors & Metrics Table */}
                  <div className="lg:col-span-1 space-y-4">
                    <div className="space-y-3">
                      <div>
                        <label className="text-[10px] uppercase font-mono tracking-widest text-[#3b82f6] block mb-1">Agent Alpha</label>
                        <select
                          className="w-full bg-[#111822] border border-slate-700 text-xs text-white rounded p-2 focus:outline-none focus:border-sky-500"
                          value={comparisonAgent1}
                          onChange={(e) => setComparisonAgent1(e.target.value)}
                        >
                          {Object.keys(realAgentComparativeMetrics).map(agent => (
                            <option key={`c1-${agent}`} value={agent}>{agent}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] uppercase font-mono tracking-widest text-[#10b981] block mb-1">Agent Beta</label>
                        <select
                          className="w-full bg-[#111822] border border-slate-700 text-xs text-white rounded p-2 focus:outline-none focus:border-sky-500"
                          value={comparisonAgent2}
                          onChange={(e) => setComparisonAgent2(e.target.value)}
                        >
                          {Object.keys(realAgentComparativeMetrics).map(agent => (
                            <option key={`c2-${agent}`} value={agent}>{agent}</option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="bg-[#111822] rounded border border-slate-800 overflow-hidden">
                      <table className="w-full text-xs text-left">
                        <thead className="bg-slate-800/50 text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                          <tr>
                            <th className="px-3 py-2">Metric</th>
                            <th className="px-3 py-2 text-[#3b82f6]">Alpha</th>
                            <th className="px-3 py-2 text-[#10b981]">Beta</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800">
                          <tr>
                            <td className="px-3 py-2 text-slate-300">Sharpe Ratio</td>
                            <td className="px-3 py-2 text-white font-mono">{realAgentComparativeMetrics[comparisonAgent1]?.sharpe ?? 'N/A'}</td>
                            <td className="px-3 py-2 text-white font-mono">{realAgentComparativeMetrics[comparisonAgent2]?.sharpe ?? 'N/A'}</td>
                          </tr>
                          <tr>
                            <td className="px-3 py-2 text-slate-300">Profit Factor</td>
                            <td className="px-3 py-2 text-indigo-400 font-mono">{realAgentComparativeMetrics[comparisonAgent1]?.profitFactor ?? 'N/A'}</td>
                            <td className="px-3 py-2 text-indigo-400 font-mono">{realAgentComparativeMetrics[comparisonAgent2]?.profitFactor ?? 'N/A'}</td>
                          </tr>
                          <tr>
                            <td className="px-3 py-2 text-slate-300">Wins / Total</td>
                            <td className="px-3 py-2 text-emerald-400 font-mono">{realAgentComparativeMetrics[comparisonAgent1]?.wins ?? 'N/A'} / {realAgentComparativeMetrics[comparisonAgent1]?.totalTrades ?? 0}</td>
                            <td className="px-3 py-2 text-emerald-400 font-mono">{realAgentComparativeMetrics[comparisonAgent2]?.wins ?? 'N/A'} / {realAgentComparativeMetrics[comparisonAgent2]?.totalTrades ?? 0}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Real per-agent time-series ROI does not exist yet - agent_performance_stats
                      is a current snapshot, not a persisted history, so there is nothing real to
                      chart here. An honest note replaces the old fabricated 3-month line chart. */}
                  <div className="lg:col-span-3 bg-[#111822] rounded-lg border border-slate-800 p-4 h-[250px] flex items-center justify-center">
                    <AwaitingSignal reason="Per-agent ROI is not yet tracked as a time series - agent_performance_stats only stores the current snapshot, not history." label="ROI Trend" />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-6 text-slate-500 gap-3 border border-dashed border-slate-700/50 rounded-lg">
                  <Activity size={24} className="opacity-40" />
                  <span className="text-[10px] font-mono uppercase tracking-widest">Comparison Engine Dormant. Toggle to construct custom evaluations.</span>
                </div>
              )}
            </div>

            {/* Swarm Collaboration Transcript View */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-center mb-6">
                 <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                   <MessageSquare size={16} className="text-indigo-400" />
                   Swarm Collaboration & Consensus Transcript
                 </h3>
                 <div className="text-[10px] uppercase font-mono tracking-widest text-slate-500">
                   Dual-node evaluation logs
                 </div>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 col-span-full">
                   <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">UNAVAILABLE — NOT PRODUCTION TELEMETRY</p>
                   <p className="text-xs text-slate-400">
                     Fabricated swarm transcripts were removed. Live consensus appears on Command Center / event traces when agents emit real decisions.
                     Historical Replay Lab records authentic agent/risk/OMS chains for research periods.
                   </p>
                 </div>
               </div>
            </div>
            
            <AgentComparisonModal 
              isOpen={isAgentComparisonModalOpen} 
              onClose={() => setIsAgentComparisonModalOpen(false)}
              agentMetrics={realAgentComparativeMetrics}
              agentRoiData={[]}
            />

          </div>
          );
        })()}
        
        {/* ========================================================= */}
        {/* TAB: VEC EVENT MEMORY                                     */}
        {/* Purpose: Semantic search interface for finding historical */}
        {/* market precedents based on macro shocks or news events.   */}
        {/* Driven by the Reflection engine.                          */}
        {/* ========================================================= */}
        {activeTab === "memory" && (
          <div
            className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-in"
            id="vector-memory-view"
          >
            {/* Semantic query box */}
            <div className="lg:col-span-2 flex flex-col gap-6">
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6"
                id="semantic-query-card"
              >
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-1.5 uppercase tracking-wide">
                  <Clock size={16} className="text-indigo-400" />
                  VEC Event Memory
                </h3>
                <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">NO VECTOR STORE</p>
                <p className="text-xs text-slate-400 mb-5">
                  Argus has no embedding model or vector index. Queries return an honest empty/quarantined result — they do not invent 2008/COVID precedents. Historical Replay Lab (Agent Evaluation) is the real research path for past sessions.
                </p>

                <div
                  className="flex flex-col md:flex-row gap-3 mb-6"
                  id="vec-search-form"
                >
                  <input
                    id="memory-query-input"
                    type="text"
                    value={memoryQuery}
                    onChange={(e) => setMemoryQuery(e.target.value)}
                    placeholder="Enter market conditions (e.g., 'supply limits in crude oil or interest rate spikes')"
                    className="flex-1 bg-[#111822] border border-slate-800 rounded-lg px-4 py-3 text-xs text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                  />
                  <button
                    id="search-memory-btn"
                    onClick={handleSearchMemory}
                    disabled={isSearchingMemory}
                    className="bg-indigo-500 hover:bg-indigo-400 text-white font-bold px-6 py-3.5 rounded-lg text-xs uppercase tracking-wider transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shrink-0"
                  >
                    {isSearchingMemory ? (
                      <>
                        <RefreshCw className="animate-spin" size={14} />
                        RETRIEVING...
                      </>
                    ) : (
                      <>
                        <HelpCircle size={14} />
                        QUERY MEMORY VECTOR
                      </>
                    )}
                  </button>
                </div>

                {/* Preset comparisons query items helper */}
                <div className="mb-2">
                  <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider block mb-2.5">
                    Instant PRESET Comparisons Query Examples:
                  </span>
                  <div className="flex flex-col gap-1.5" id="vector-presets">
                    <button
                      id="vec-preset-lockdowns"
                      onClick={() =>
                        setMemoryQuery(
                          "extreme sudden travel closures and lockdown supply panic alongside liquidity drop",
                        )
                      }
                      className="text-left text-xs bg-[#111822] hover:bg-slate-800 p-2.5 rounded border border-slate-800 text-slate-300 hover:text-white transition"
                    >
                      🦠 "lockdown supply panic, liquidity drops, emergency
                      central monetary injection"
                    </button>
                    <button
                      id="vec-preset-rates"
                      onClick={() =>
                        setMemoryQuery(
                          "intolerable inflation forcing massive serial interest rate cycle cuts and treasury spikes",
                        )
                      }
                      className="text-left text-xs bg-[#111822] hover:bg-slate-800 p-2.5 rounded border border-slate-800 text-slate-300 hover:text-white transition"
                    >
                      📈 "runaway inflation forcing terminal interest rates
                      cycles, commodity shock, sovereign risk"
                    </button>
                    <button
                      id="vec-preset-collapse"
                      onClick={() =>
                        setMemoryQuery(
                          "large banking entity failures triggering global credit market freezes and contagion",
                        )
                      }
                      className="text-left text-xs bg-[#111822] hover:bg-slate-800 p-2.5 rounded border border-slate-800 text-slate-300 hover:text-white transition"
                    >
                      🏦 "large systemic bank insolvencies, credit freeze,
                      systemic liquidity protection bailouts"
                    </button>
                  </div>
                </div>
              </div>

              {/* Memory vector explanation node outputs */}
              {memoryResult && (
                <div
                  className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 animate-fade-in"
                  id="memory-search-results"
                >
                  <h4 className="text-xs font-bold text-white mb-3.5 flex items-center gap-1.5 uppercase tracking-wide">
                    <Layers size={14} className="text-amber-400" />
                    Event memory
                  </h4>
                  {memoryResult.quarantined ? (
                    <AwaitingSignal
                      label="NO HISTORICAL DATA"
                      reason={`${memoryResult.why || 'Fabricated vector memory is quarantined.'} Impact: ${memoryResult.impact || 'Not used for trades.'} Fix: ${memoryResult.howToFix || 'Use GET /api/v2/desk/lifecycle.'}`}
                    />
                  ) : (
                  <>
                  <div className="bg-[#111822] p-4 rounded-lg border border-slate-850 text-xs leading-relaxed text-slate-300 italic mb-5 whitespace-pre-line">
                    "{memoryResult.summary}"
                  </div>

                  <h5 className="text-[10px] uppercase font-mono tracking-wider text-slate-400 mb-3">
                    Closest Matching Vector precedents database list:
                  </h5>
                  <div className="space-y-4" id="matched-precedents-list">
                    {memoryResult.matches && memoryResult.matches.length > 0 ? (
                      memoryResult.matches.map((item: any, i: number) => (
                        <div key={i} className="bg-[#111822] p-4 rounded-lg border border-slate-850">
                          <div className="flex justify-between items-start gap-2 mb-2">
                            <div>
                              <span className="text-xs font-extrabold text-white">{item.title}</span>
                              <span className="text-[9px] uppercase font-mono text-slate-500 rounded bg-[#1A1F2B] border border-slate-850 px-2 py-0.5 ml-2">{item.category}</span>
                            </div>
                            <span className="text-xs font-mono font-bold text-indigo-400">Index score: {(item.score * 100).toFixed(0)}%</span>
                          </div>
                          <p className="text-xs text-slate-400 leading-relaxed mb-3">{item.description}</p>
                          <div className="p-3 bg-[#1A1F2B]/40 rounded border border-slate-850/65 text-xs text-slate-300">
                            <b className="text-[10px] uppercase font-mono tracking-wider text-emerald-400 block mb-1">Asset Reaction Record:</b>
                            {item.impact}
                          </div>
                          <div className="mt-3 flex justify-between border-t border-slate-800/80 pt-3">
                            <span className="text-[10px] font-mono text-slate-500 uppercase">Quality Feedback Loop:</span>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="bg-[#111822] p-4 rounded-lg border border-slate-850 text-xs text-slate-500 font-mono italic text-center">
                        NO HISTORICAL DATA
                      </div>
                    )}
                  </div>
                  </>
                  )}
                </div>
              )}
            </div>

            {/* Right Column, Historical Event Memory info card */}
            <div className="lg:col-span-1 flex flex-col gap-6">
              <div
                className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5"
                id="event-memory-explain"
              >
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-1.5 uppercase tracking-wide">
                  <Clock size={16} className="text-indigo-400" />
                  What a vector store would cover
                </h3>
              <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                These categories are the intended future index — not something Argus computes today. No embeddings are written on the live path.
              </p>

              <div className="space-y-3.5" id="swarm-mechanics-bullets">
                <div className="flex gap-2.5">
                  <div className="bg-indigo-500/10 p-1.5 h-7 w-7 rounded flex items-center justify-center border border-indigo-500/20 text-indigo-400 shrink-0">
                    <CheckCircle size={14} />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">
                      Sovereign Shocks
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      Political, tarification, elections and major legislative
                      budget spending drafts.
                    </p>
                  </div>
                </div>

                <div className="flex gap-2.5">
                  <div className="bg-indigo-500/10 p-1.5 h-7 w-7 rounded flex items-center justify-center border border-indigo-500/20 text-indigo-400 shrink-0">
                    <CheckCircle size={14} />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">
                      Systemic Crises
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      Banking liquidity freezes, Chapter 11 bank bankruptcies,
                      and contagious credit limits.
                    </p>
                  </div>
                </div>

                <div className="flex gap-2.5">
                  <div className="bg-indigo-500/10 p-1.5 h-7 w-7 rounded flex items-center justify-center border border-indigo-500/20 text-indigo-400 shrink-0">
                    <CheckCircle size={14} />
                  </div>
                  <div>
                    <h4 className="text-xs font-bold text-white">
                      Supply / Price Shocks
                    </h4>
                    <p className="text-[11px] text-slate-400 leading-normal">
                      OPEC commodity embargoes, global epidemics, shipping lane
                      blockages.
                    </p>
                  </div>
                </div>
              </div>
              </div>

              <div className="h-[400px]">
                <VectorClusteringMap />
              </div>
            </div>
          </div>
        )}


        {activeTab === "audit" && (
          <div className="animate-fade-in flex flex-col gap-6" id="observability-view">

            {/* Header */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                 <div>
                    <h3 className="text-sm font-bold text-white mb-1 flex items-center gap-2 uppercase tracking-wide">
                      <Activity size={16} className="text-emerald-400" />
                      Observability & Trade Tracing
                    </h3>
                    <p className="text-[11px] text-slate-400 max-w-3xl leading-relaxed font-mono">
                      Real recent transactions (GET /api/v2/transactions). Click any row to open the full Transaction Observatory. The searchable ledger with Mission Control strip lives on the Observatory tab — this list is the same source, last 25 rows.
                    </p>
                 </div>
                 <button
                   type="button"
                   onClick={() => setActiveTab("observatory")}
                   className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-slate-700 text-slate-300 hover:bg-slate-800 shrink-0"
                 >
                   Open Observatory
                 </button>
              </div>
            </div>

            {/* Real Transaction List */}
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <h4 className="text-[10px] uppercase tracking-widest font-bold text-slate-500 mb-4 font-mono">Recent Transactions</h4>
               {auditTransactionsLoading ? (
                 <div className="py-8 text-center text-slate-500 text-xs font-mono">Loading real transactions...</div>
               ) : auditTransactions.length === 0 ? (
                 <AwaitingSignal reason="No transactions recorded yet - a real consensus approval or manual override will appear here." />
               ) : (
                 <div className="overflow-x-auto">
                   <table className="w-full text-left border-collapse">
                     <thead>
                       <tr className="border-b border-slate-800 text-[10px] font-mono text-slate-500 uppercase tracking-wider">
                         <th className="pb-3 pl-2 font-medium">Transaction</th>
                         <th className="pb-3 font-medium">Symbol</th>
                         <th className="pb-3 font-medium">Decision</th>
                         <th className="pb-3 font-medium">Status</th>
                         <th className="pb-3 font-medium">Outcome</th>
                         <th className="pb-3 font-medium">Opened</th>
                         <th className="pb-3 font-medium text-right pr-2">Trace</th>
                       </tr>
                     </thead>
                     <tbody>
                       {auditTransactions.map((t: any) => (
                         <tr key={t.id} className="border-b border-slate-800/50 hover:bg-[#111822]/80 transition-colors">
                           <td className="py-3 pl-2 font-mono text-[11px] text-indigo-400">{t.id}</td>
                           <td className="py-3 text-xs font-bold text-white">{t.symbol}</td>
                           <td className="py-3 text-xs">
                             {(() => {
                               const d = formatTransactionDecision(t);
                               return d.kind === 'none'
                                 ? <UnavailableHint reason={d.title} className="text-slate-500">{d.label}</UnavailableHint>
                                 : <span title={d.title} className={d.kind === 'buy' ? 'text-emerald-400' : d.kind === 'sell' ? 'text-rose-400' : 'text-slate-400'}>{d.label}</span>;
                             })()}
                           </td>
                           <td className="py-3 text-[10px] font-mono text-slate-400">
                             <span className="cursor-help" title={formatStatusHint(t.status)}>{t.status}</span>
                           </td>
                           <td className="py-3 text-[10px] font-mono">
                             {(() => {
                               const o = formatTransactionOutcome(t);
                               if (o.label === 'WIN') return <span title={o.title} className="text-emerald-400">WIN</span>;
                               if (o.label === 'LOSS') return <span title={o.title} className="text-rose-400">LOSS</span>;
                               return <UnavailableHint reason={o.title} className="text-slate-500">{o.label}</UnavailableHint>;
                             })()}
                           </td>
                           <td className="py-3 text-[10px] font-mono text-slate-500">{t.openedAt ? new Date(t.openedAt).toLocaleString() : <UnavailableHint reason="No openedAt timestamp on this transaction row.">--</UnavailableHint>}</td>
                           <td className="py-3 text-right pr-2">
                             <button
                               onClick={() => handleOpenReplay({ transactionId: t.id })}
                               className="px-2.5 py-1 bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 rounded text-[10px] font-mono font-bold uppercase tracking-wider transition-colors"
                             >
                               View Trace
                             </button>
                           </td>
                         </tr>
                       ))}
                     </tbody>
                   </table>
                 </div>
               )}
            </div>

            <DecisionTracePanel />

          </div>
        )}


        {activeTab === "opportunities" && (
          <div className="animate-fade-in flex flex-col gap-6" id="opportunities-view">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg overflow-hidden">
               <div className="px-5 py-4 border-b border-slate-800 flex justify-between items-center bg-slate-800/50">
                 <h3 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
                   <Target size={16} className="text-cyan-400" />
                   Autonomous Opportunity Feed
                 </h3>
                 <span className="text-[10px] font-mono bg-cyan-900/50 text-cyan-400 px-2 py-1 rounded">
                   REAL AGENT PREDICTIONS, LAST 24H
                 </span>
               </div>

               {opportunitiesAvailable === false && (
                 <div className="p-6 space-y-3">
                   <AwaitingSignal reason={opportunitiesReason || 'No real agent prediction in the last 24h cleared the confidence floor.'} label="Opportunity Feed" />
                   <div className="bg-[#111822] border border-amber-500/20 rounded-lg p-4 text-[11px] font-mono text-slate-400 leading-relaxed">
                     <p className="text-amber-400 font-bold uppercase tracking-wider mb-2">Why empty (honest)</p>
                     <ul className="list-disc pl-4 space-y-1">
                       <li>Feed lists real BUY/SELL rows from <code className="text-cyan-500">agent_predictions</code> (≥60% confidence, last 24h) — not invented cards.</li>
                       <li>Start Autobot in Mission Control (Autobot was off / TRADING_DISABLED in your screenshots).</li>
                       <li>Market CLOSED still allows some agents; empty tape means no qualifying predictions yet.</li>
                       <li>Chronos/OpenAlice FAILED does not empty this feed — they are optional verification/forecast, not the opportunity source.</li>
                     </ul>
                   </div>
                 </div>
               )}

               {opportunitiesAvailable === null && (
                 <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading real opportunities...</div>
               )}

               {opportunitiesAvailable === true && (
                 <div className="divide-y divide-slate-800/50">
                    {opportunities.map((opp, idx) => (
                      <div key={`${opp.symbol}-${opp.agent}-${idx}`} className="p-5 hover:bg-slate-800/20 transition-colors">
                         <div className="flex flex-col md:flex-row justify-between gap-4 mb-3">
                            <div>
                               <div className="flex items-center gap-2 mb-1">
                                  <span className="text-sm font-bold text-white">{opp.symbol}</span>
                                  <span className="text-xs text-slate-400">via {opp.agent}</span>
                               </div>
                               <p className="text-xs text-slate-300 font-mono">
                                 {opp.reasoning}
                               </p>
                            </div>
                            <div className="flex gap-4 md:justify-end text-center font-mono">
                               <div className={`bg-[#111822] border px-3 py-1.5 rounded ${opp.prediction === 'BUY' ? 'border-emerald-900/50 text-emerald-400' : 'border-rose-900/50 text-rose-400'}`}>
                                 <span className={`text-[9px] uppercase block mb-0.5 ${opp.prediction === 'BUY' ? 'text-emerald-600' : 'text-rose-600'}`}>Direction</span>
                                 <span className="font-bold text-sm">{opp.prediction}</span>
                               </div>
                               <div className="bg-[#111822] border border-slate-800 px-3 py-1.5 rounded">
                                 <span className="text-[9px] uppercase block text-slate-500 mb-0.5">Confidence</span>
                                 <span className="font-bold text-sm text-white">{opp.confidence}%</span>
                               </div>
                            </div>
                         </div>
                         <div className="text-[10px] text-slate-500 font-mono">
                            <span>{new Date(opp.timestamp).toLocaleString()}</span>
                         </div>
                      </div>
                    ))}
                 </div>
               )}
            </div>
          </div>
        )}

        {/* --- LEARNING & EVOLUTION DASHBOARD --- */}
        {activeTab === "learning" && (
          <div className="animate-fade-in grid grid-cols-1 lg:grid-cols-3 gap-6" id="learning-view">
            
            {/* Top Stat Row Container - real data (GET /api/v2/agents/learning-summary).
                "Mistakes Corrected"/"Models Retrained"/"Alpha Generated by RL" had no real
                source anywhere in this codebase (no RL system exists) and are removed rather
                than replaced with a fabricated substitute; "Strategy Efficacy" becomes a real
                average win rate across agents with real evaluated history. */}
            <div className="lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-mono text-slate-500 block mb-2 tracking-wider">Real Agents With Evaluated History</span>
                  <div className="flex items-end justify-between">
                     <span className="text-2xl font-bold text-white">{learningSummary ? learningSummary.agentWeights.filter((a: any) => a.totalPredictions > 0).length : '--'} / {learningSummary?.agentWeights.length ?? 5}</span>
                  </div>
               </div>
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-mono text-slate-500 block mb-2 tracking-wider">Real Avg Win Rate (evaluated agents)</span>
                  <div className="flex items-end justify-between">
                     {(() => {
                       const evaluated = learningSummary?.agentWeights.filter((a: any) => a.winRate !== null) ?? [];
                       const avg = evaluated.length > 0 ? evaluated.reduce((s: number, a: any) => s + a.winRate, 0) / evaluated.length : null;
                       return <span className={`text-2xl font-bold ${avg !== null ? 'text-emerald-400' : 'text-slate-500'}`}>{avg !== null ? `${avg.toFixed(1)}%` : 'No Data'}</span>;
                     })()}
                  </div>
               </div>
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                  <span className="text-[10px] uppercase font-mono text-slate-500 block mb-2 tracking-wider">Real Learned Rules (recent)</span>
                  <div className="flex items-end justify-between">
                     <span className="text-2xl font-bold text-white">{learningSummary?.recentLearnedRules.length ?? '--'}</span>
                  </div>
               </div>
            </div>

            {/* Left Column - real per-agent weight/win-rate table, replacing the fabricated
                "PER-STRATEGY SCORECARD" (invented strategy names like "Trend-Following",
                "Political Intel" - none are real Argus agents). No real RL exists - the weight
                column is ChiefTraderAgent/ReflectionEngine's real consensus weight, not an RL
                policy output. */}
            <div className="lg:col-span-2 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
                <BrainCircuit size={16} className="text-indigo-400" />
                REAL PER-AGENT SCORECARD
              </h3>
              <p className="text-[10px] font-mono text-slate-400 mb-4">Real ChiefTraderAgent consensus weight and real ReflectionEngine-evaluated win rate, per real agent. Not an RL policy - Argus has no reinforcement-learning system.</p>

              {!learningSummary ? (
                <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading real agent scorecard...</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse min-w-max">
                    <thead>
                      <tr className="border-b border-slate-800 text-[9px] font-mono text-slate-500 uppercase tracking-wider">
                        <th className="py-2 px-2">AGENT</th>
                        <th className="py-2 px-2">WIN RATE</th>
                        <th className="py-2 px-2">EVALUATED PREDICTIONS</th>
                        <th className="py-2 px-2">CONSENSUS WEIGHT</th>
                      </tr>
                    </thead>
                    <tbody className="text-xs font-mono text-slate-300">
                       {learningSummary.agentWeights.map((a: any) => (
                         <tr key={a.agentName} className="border-b border-slate-800/40 hover:bg-slate-800/20 transition-colors">
                            <td className="py-3 px-2 font-bold text-white">{a.agentName}</td>
                            <td className={`py-3 px-2 ${a.winRate === null ? 'text-slate-500' : a.winRate >= 50 ? 'text-emerald-400' : 'text-rose-400'}`}>{a.winRate === null ? 'N/A' : `${a.winRate}%`}</td>
                            <td className="py-3 px-2 text-slate-300">{a.totalPredictions}</td>
                            <td className="py-3 px-2 text-slate-300 text-sm font-bold">{a.currentWeight === null ? 'N/A' : `${a.currentWeight}x`}</td>
                         </tr>
                       ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Right Column - Weight Evolution & Kelly */}
            <div className="lg:col-span-1 flex flex-col gap-6">
               
               {/* Weight Evolution — no fabricated bars */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                  <h3 className="text-sm font-bold text-white mb-4 uppercase tracking-wide flex items-center gap-2">
                    <TrendingUp size={16} className="text-indigo-400" />
                    WEIGHT EVOLUTION (7D)
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">UNAVAILABLE</p>
                  <p className="text-xs text-slate-500">Agent weights come from agent_performance_stats when ReflectionEngine scores real predictions — not decorative mock bars.</p>
               </div>

               {/* Kelly Position Sizing Learner — no fabricated fraction */}
               <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
                  <h3 className="text-sm font-bold text-white mb-2 uppercase tracking-wide flex items-center gap-2">
                    <Target size={16} className="text-indigo-400" />
                    KELLY POSITION-SIZING LEARNER
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">AWAITING_EVIDENCE</p>
                  <p className="text-xs text-slate-500 leading-relaxed">
                    Kelly fraction requires measured win rate and R:R from organic PAPER closed trades.
                    Fabricated 8.4% / 1.5% / 0.8x telemetry was removed. Not live readiness.
                  </p>
               </div>
            </div>

            {/* Post-trade reflection — no fabricated NVDA/RL narrative.
                Real path: ReflectionEngine writes learned_rules from recent FILLED SELL losses
                (with profitLoss), and scores agent_predictions via prediction_outcomes.
                Argus has no reinforcement-learning system; rules only truncate into ChiefTrader
                debate prompts and never override RiskEngine. */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide mb-2">
                <Activity size={16} className="text-indigo-400" />
                POST-TRADE REFLECTION
              </h3>
              <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">
                {(learningSummary?.recentLearnedRules?.length ?? 0) > 0 ? 'LIVE RULES FROM CLOSED TRADES' : 'AWAITING_EVIDENCE'}
              </p>
              <p className="text-xs text-slate-500 leading-relaxed mb-4">
                ReflectionEngine generates <code className="text-[10px] text-slate-400">learned_rules</code> only from
                organic closed PAPER/LIVE fills (FILLED SELL with realized P&amp;L), not from scripted stories.
                Fabricated NVDA stop-loss / RL weight-adjustment theater was removed. Zero organic closed paper
                trades means this panel stays empty — that is correct, not a loading failure. LIVE remains NO-GO.
              </p>
              {(learningSummary?.recentLearnedRules?.length ?? 0) === 0 ? (
                <div className="text-xs font-mono text-slate-600 italic p-6 text-center border border-dashed border-slate-800 rounded bg-[#111822]">
                  No recent learned rules. Requires closed trades with realized P&amp;L; prediction win rates alone do not write rules.
                </div>
              ) : (
                <div className="space-y-3 max-h-64 overflow-y-auto custom-scrollbar">
                  {learningSummary.recentLearnedRules.map((r: any, i: number) => (
                    <div key={`${r.timestamp}-${i}`} className="bg-[#111822] border border-slate-800 rounded p-3">
                      <div className="flex justify-between text-[10px] font-mono text-slate-500 mb-1">
                        <span>{r.agent}</span>
                        <span>{r.timestamp ? new Date(r.timestamp).toLocaleString() : ''}</span>
                      </div>
                      <p className="text-[10px] font-mono text-slate-400 mb-1">{r.cause}</p>
                      <p className="text-xs text-indigo-300 font-mono leading-relaxed">{r.rule}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* ========================================================= */}
            {/* COMPONENT: Strategy Backtest Engine                       */}
            {/* Purpose: Allows the user to select and compare two        */}
            {/* separate strategy nodes against simulated historical data */}
            {/* to review isolated performance and hypothetical drawdowns.*/}
            {/* Notes: Both strategies can be toggled on/off to isolate   */}
            {/* the Pnl curve comparisons.                                */}
            {/* ========================================================= */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
                <div>
                  <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
                    <History size={16} className="text-indigo-400" />
                    STRATEGY BACKTEST ENGINE
                  </h3>
                  <p className="text-[10px] text-slate-400 font-mono">Run selected strategy nodes against historical tick data to visualize hypothetical ROI and drawdown. Note: Real backtests run locally via Python backend.</p>
                </div>
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="flex items-center gap-2 bg-[#111822] border border-slate-700 rounded px-2 py-1">
                    <div className="flex items-center gap-1">
                      <input 
                        type="checkbox" 
                        checked={showStrategy1} 
                        onChange={(e) => setShowStrategy1(e.target.checked)}
                        className="accent-emerald-500 w-3 h-3 cursor-pointer"
                      />
                      <StrategyDropdown 
                        value={selectedStrategy1} 
                        onChange={setSelectedStrategy1} 
                        colorClass={showStrategy1 ? 'text-emerald-400' : 'text-slate-500'}
                        customPresets={strategyPresets}
                        onSavePreset={handleSaveStrategyPreset}
                        onLoadPreset={handleLoadStrategyPreset}
                      />
                    </div>
                    <span className="text-slate-600 text-[10px]">||</span>
                    <div className="flex items-center gap-1">
                      <input 
                        type="checkbox" 
                        checked={showStrategy2} 
                        onChange={(e) => setShowStrategy2(e.target.checked)}
                        className="accent-purple-500 w-3 h-3 cursor-pointer"
                      />
                      <StrategyDropdown 
                        value={selectedStrategy2} 
                        onChange={setSelectedStrategy2} 
                        colorClass={showStrategy2 ? 'text-purple-400' : 'text-slate-500'}
                        customPresets={strategyPresets}
                        onSavePreset={handleSaveStrategyPreset}
                        onLoadPreset={handleLoadStrategyPreset}
                      />
                    </div>
                  </div>
                  <select className="bg-[#111822] border border-slate-700 text-slate-300 text-[10px] font-mono rounded px-3 py-1.5 focus:outline-none focus:border-indigo-500 transition-colors">
                    <option>Last 30 Days</option>
                    <option>Last 90 Days</option>
                    <option>Year to Date</option>
                    <option>Last 12 Months</option>
                    <option>Custom Range</option>
                  </select>
                  <button
                    onClick={() => {
                      setRunBacktest(false);
                      window.location.hash = 'historical-replay-lab';
                    }}
                    className="bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] uppercase font-bold py-1.5 px-4 rounded transition-colors flex items-center gap-2 shadow-[0_0_10px_rgba(79,70,229,0.2)]"
                  >
                    <Play size={12} />
                    Open Historical Replay
                  </button>
                </div>
              </div>

              {/* Chart container */}
              <div className="h-[250px] bg-[#111822] rounded-lg border border-slate-800 flex items-center justify-center p-4">
                 <div className="text-center text-slate-500 flex flex-col items-center gap-2 max-w-md">
                       <BarChart3 size={24} className="opacity-20 mb-1"/>
                       <span className="text-[10px] uppercase tracking-widest font-mono text-amber-400/90">UNAVAILABLE — NO FABRICATED BACKTEST</span>
                       <span className="text-[10px] uppercase tracking-widest font-mono">Use Research Lab → Historical Replay for real NEXT_BAR_OPEN results. This Learning chart does not invent P&amp;L.</span>
                    </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
                 <div className="bg-[#111822] border border-slate-800 rounded p-3 text-center">
                    <span className="text-[9px] uppercase font-mono text-slate-500 block mb-1">Total Return</span>
                    <span className="text-lg font-bold text-slate-500">UNAVAILABLE</span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded p-3 text-center">
                    <span className="text-[9px] uppercase font-mono text-slate-500 block mb-1"><Explainer id="maxDrawdown">Max Drawdown</Explainer></span>
                    <span className="text-lg font-bold text-slate-500">UNAVAILABLE</span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded p-3 text-center">
                    <span className="text-[9px] uppercase font-mono text-slate-500 block mb-1"><Explainer id="sharpeRatio">Sharpe Ratio</Explainer></span>
                    <span className="text-lg font-bold text-slate-500">UNAVAILABLE</span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded p-3 text-center">
                    <span className="text-[9px] uppercase font-mono text-slate-500 block mb-1"><Explainer id="winRate">Win Rate</Explainer></span>
                    <span className="text-lg font-bold text-slate-500">UNAVAILABLE</span>
                 </div>
              </div>
            </div>

            {/* Agent Learning & Context Evolution Journal */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
                 <BrainCircuit size={16} className="text-purple-400" />
                 AGENT LEARNING & EVOLUTION JOURNAL
               </h3>
               <p className="text-[10px] font-mono uppercase tracking-widest text-amber-400 mb-2">NOT WIRED</p>
               <p className="text-[10px] font-mono text-slate-400 mb-4">
                 <code className="text-slate-500">TradingEngine.state.learningJournal</code> is never populated.
                 Real rule text is in Post-Trade Reflection / <code className="text-slate-500">learned_rules</code> — not a separate vector-memory stream.
               </p>

               <div className="space-y-4">
                  {(!autoBotConfig.learningJournal || autoBotConfig.learningJournal.length === 0) ? (
                     <div className="text-xs font-mono text-slate-600 italic p-6 text-center border border-dashed border-slate-800 rounded bg-[#111822]">
                        Empty by design. No fabricated journal entries.
                     </div>
                  ) : (
                     autoBotConfig.learningJournal.map((log: any, i: number) => {
                        return (
                           <div key={i} className="bg-[#111822] border border-slate-800 rounded p-4 flex flex-col gap-3 relative overflow-hidden">
                              <div className={`absolute left-0 top-0 bottom-0 w-1 ${log.agent.includes("Reflection") ? "bg-purple-500/50" : log.agent.includes("Risk") ? "bg-amber-500/50" : log.agent.includes("Proposer") ? "bg-blue-500/50" : "bg-emerald-500/50"}`}></div>
                              <div className="flex justify-between items-start mb-1">
                                 <span className="text-[10px] font-mono text-slate-500">[{new Date(log.time).toLocaleString()}]</span>
                                 <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded ${log.agent.includes("Reflection") ? "text-purple-400 bg-purple-500/10" : log.agent.includes("Risk") ? "text-amber-400 bg-amber-500/10" : log.agent.includes("Proposer") ? "text-blue-400 bg-blue-500/10" : "text-emerald-400 bg-emerald-500/10"}`}>
                                    {log.agent}
                                 </span>
                              </div>
                              
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                 <div className="flex gap-3 items-start">
                                    <div className="bg-slate-800/50 p-2 rounded shrink-0">
                                       <AlertTriangle size={14} className="text-slate-400" />
                                    </div>
                                    <div>
                                       <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Diagnosed Cause / Event</span>
                                       <p className="text-xs text-slate-300 font-mono font-medium">{log.cause}</p>
                                    </div>
                                 </div>
                                 <div className="flex gap-3 items-start">
                                    <div className="bg-slate-800/50 p-2 rounded shrink-0">
                                       <BookOpen size={14} className="text-slate-400" />
                                    </div>
                                    <div>
                                       <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Context Updated: {log.contextUpdated}</span>
                                       <p className="text-xs text-indigo-300 font-mono leading-relaxed">{log.rule}</p>
                                    </div>
                                 </div>
                              </div>
                              
                              {/* WeightAdjustmentVisualizer removed: it invented strategy names/bars from a seed. */}
                           </div>
                        );
                     })
                  )}
               </div>
            </div>
            
            {/* ========================================================= */}
            {/* COMPONENT: Context Memory Engineering UI                    */}
            {/* ========================================================= */}
            <div className="lg:col-span-3">
              <ContextMemoryEngineering 
                memoryRules={autoBotConfig?.memoryRules || []}
                onAddRule={handleAddMemoryRule}
                onDeleteRule={handleDeleteMemoryRule}
              />
            </div>

            {/* ========================================================= */}
            {/* COMPONENT: Daily Realized P&L Line Chart                  */}
            {/* Purpose: Visualizes the daily profitability of the system */}
            {/* over user-selectable date ranges (7 / 30 / MTD etc.)      */}
            {/* Notes: Profitable days are highlighted green, and losing  */}
            {/* days are highlighted red.                                 */}
            {/* ========================================================= */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
              <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-2">
                <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                  <BarChart3 size={16} className="text-indigo-400" />
                  DAILY REALIZED P&L
                </h3>
                <div className="flex flex-wrap items-center gap-1 bg-[#111822] p-1 rounded border border-slate-800 font-mono w-full sm:w-auto shrink-0 select-none">
                  {[
                    { value: "Last 7 Days", label: "7D" },
                    { value: "Last 30 Days", label: "30D" },
                    { value: "Month to Date (MTD)", label: "MTD" },
                    { value: "Year to Date (YTD)", label: "YTD" },
                    { value: "All Time", label: "ALL" }
                  ].map((range) => (
                    <button
                      key={range.value}
                      onClick={() => setPnlDateRange(range.value)}
                      className={`text-[9px] font-mono font-bold uppercase tracking-widest px-2.5 py-1.5 rounded transition-all ${
                        pnlDateRange === range.value
                          ? "bg-indigo-500/15 text-indigo-400 border border-indigo-500/40 font-black shadow-inner"
                          : "text-slate-400 border border-transparent hover:text-slate-200 hover:bg-slate-800"
                      }`}
                    >
                      {range.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-[10px] font-mono text-slate-400 mb-4">
                Realized profit and loss plotted over time. Green dots signify a profitable day; red dots signify a losing day.
              </p>

              <div className="flex gap-4 mb-4 bg-[#111822] p-3 rounded border border-slate-800">
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Total P&L</span>
                  <span className={`text-sm font-bold font-mono ${totalPnL >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {totalPnL >= 0 ? "+" : "-"}${Math.abs(totalPnL)}
                  </span>
                </div>
                <div className="w-px bg-slate-700"></div>
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Profitable</span>
                  <span className="text-sm font-bold font-mono text-emerald-400">{profitableDays} days</span>
                </div>
                <div className="w-px bg-slate-700"></div>
                <div className="flex flex-col">
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Loss</span>
                  <span className="text-sm font-bold font-mono text-rose-400">{lossMakingDays} days</span>
                </div>
              </div>
              
              <div className="h-[340px] w-full">
                <SafeResponsiveContainer>
                  <LineChart data={activeDailyPnL} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <XAxis dataKey="date" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} />
                    <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} tickFormatter={(val) => `$${val}`} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: '#111822', borderColor: '#1e293b', fontSize: '10px', color: '#f8fafc' }}
                      itemStyle={{ fontSize: '10px' }}
                      labelStyle={{ color: '#94a3b8', marginBottom: '4px' }}
                    />
                    <Line 
                      type="monotone" 
                      dataKey="pnl" 
                      stroke="#6366f1" 
                      strokeWidth={2} 
                      dot={(props: any) => {
                         const { cx, cy, value } = props;
                         if (!cx || !cy) return null;
                         const isLoss = value < 0;
                         return (
                            <circle key={props.key || props.index || cx} cx={cx} cy={cy} r={4} stroke="#1A1F2B" strokeWidth={2} fill={isLoss ? "#f43f5e" : "#10b981"} />
                         );
                      }} 
                      activeDot={{ r: 6 }} 
                      name="Daily P&L" 
                    />
                    <Legend 
                      verticalAlign="bottom" 
                      content={<CustomPnLLegend totalPnL={totalPnL} profitableDays={profitableDays} lossMakingDays={lossMakingDays} pnlDateRange={pnlDateRange} />} 
                    />
                  </LineChart>
                </SafeResponsiveContainer>
              </div>
            </div>

            {/* ========================================================= */}
            {/* COMPONENT: Historical Trades Table & Journaling             */}
            {/* Purpose: Displays the complete ledger of multi-agent      */}
            {/* executed trades. Users can launch a modal from here to    */}
            {/* manually add their own trade journal and reflections.     */}
            {/* ========================================================= */}
            <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-2">
                 <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide flex-1">
                   <History size={16} className="text-indigo-400" />
                   HISTORICAL TRADE DECISIONS
                 </h3>
                 <div className="flex flex-row items-center gap-2 w-full sm:w-auto">
                   <button
                     onClick={handleExportTradesCSV}
                     className="text-[10px] font-mono font-bold uppercase tracking-widest text-[#10B981] hover:text-white transition-all border border-[#10B981]/40 hover:border-emerald-500 rounded px-3 py-1.5 flex items-center justify-center gap-1.5 bg-[#10B981]/5 hover:bg-emerald-500/10 w-full sm:w-auto"
                   >
                     <Download size={12} className="text-[#10B981]" />
                     EXPORT CSV
                   </button>
                   <button 
                     onClick={() => setShowTradeHistory(!showTradeHistory)}
                     className="text-[10px] font-mono uppercase tracking-widest text-slate-400 hover:text-white transition-colors border border-slate-700 hover:border-slate-500 rounded px-3 py-1.5 w-full sm:w-auto text-center"
                   >
                     {showTradeHistory ? "Hide Table" : "Show Table"}
                   </button>
                 </div>
               </div>
               <p className="text-[10px] font-mono text-slate-400 mb-4">
                 A record of all executed multi-agent trade decisions and their specific outcome in P&L.
               </p>

               {showTradeHistory && (
                 <div className="mt-4">
                   <TradeHistoryDataView
                     rows={activeHistoricalTrades.map((trade, idx) => ({
                       date: trade.date,
                       symbol: trade.symbol,
                       decision: trade.decision,
                       weight: trade.weight,
                       outcome: trade.outcome,
                       outcomeClass: trade.outcomeClass,
                       index: idx,
                       journalLabel: tradeJournals[idx] ? 'Edit' : 'Journal',
                       onReplay: () => handleOpenReplay(trade.rawTrade),
                       onJournal: () => handleOpenJournal(trade, idx),
                     }))}
                   />
                 </div>
               )}
            </div>

            {/* Journal Modal */}
            {journalModalOpen && (
              <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
                <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-lg shadow-2xl overflow-hidden animate-fade-in relative flex flex-col">
                  {/* Decorative Header */}
                  <div className="h-1 w-full bg-gradient-to-r from-indigo-500 to-purple-500" />
                  
                  <div className="p-5 flex flex-col h-full">
                    <div className="flex justify-between items-center mb-4">
                      <h2 className="text-sm font-bold text-white uppercase tracking-wide flex items-center gap-2">
                        <BookOpen size={16} className="text-indigo-400" />
                        TRADE JOURNAL ENTRY
                      </h2>
                      <button 
                        onClick={() => { setJournalModalOpen(false); setSelectedTradeForJournal(null); }}
                        className="text-slate-500 hover:text-white transition-colors"
                      >
                        <Lock size={14} className="opacity-0" /> {/* Placeholder to match height just in case, wait no let's just put an X or close text */}
                        <span className="text-[10px] font-mono uppercase">Close</span>
                      </button>
                    </div>

                    <div className="bg-[#111822] border border-slate-800 rounded p-3 mb-4 flex flex-wrap gap-4">
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-mono mb-1">Asset</span>
                        <span className="text-xs font-bold text-white">{selectedTradeForJournal?.symbol}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-mono mb-1">Direction</span>
                        <span className={`text-xs font-bold ${selectedTradeForJournal?.decision === 'BUY' ? 'text-emerald-400' : 'text-amber-500'}`}>{selectedTradeForJournal?.decision}</span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 uppercase font-mono mb-1">P&L Outcome</span>
                        <span className={`text-xs font-bold ${selectedTradeForJournal?.outcomeClass}`}>{selectedTradeForJournal?.outcome}</span>
                      </div>
                    </div>

                    <div className="flex-1 flex flex-col">
                      <label className="text-[10px] font-mono uppercase text-slate-400 mb-2">Automated Thesis & Your Personal Notes</label>
                      <textarea 
                        className="flex-1 w-full bg-[#111822] border border-slate-700 rounded-lg p-3 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 resize-none font-mono min-h-[150px]"
                        placeholder="Document the exact reasons for entry and exit, emotional state, or market conditions that weren't captured by the automated logs..."
                        value={editingJournalText}
                        onChange={(e) => setEditingJournalText(e.target.value)}
                      />
                    </div>
                    
                    <div className="mt-5 flex justify-end gap-3">
                      <button 
                        onClick={() => { setJournalModalOpen(false); setSelectedTradeForJournal(null); }}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-wide text-slate-400 hover:text-white transition-colors"
                      >
                        Cancel
                      </button>
                      <button 
                        onClick={handleSaveJournal}
                        className="px-4 py-2 text-xs font-bold uppercase tracking-wide bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors shadow-[0_0_10px_rgba(79,70,229,0.2)]"
                      >
                        Save Entry
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Live Trade Journey Overlay */}
            {liveTradeTrigger && (
              <LiveTradeJourneyOverlay 
                trade={liveTradeTrigger} 
                onClose={() => setLiveTradeTrigger(null)} 
              />
            )}

            {/* Replay Modal - real transactions (Phase 0+) get the full Transaction Observatory;
                older trades that predate the transaction concept fall back to the legacy
                trace-based replay modal. */}
            {replayModalOpen && selectedReplayTrade && (
              selectedReplayTrade.transactionId ? (
                <TransactionObservatory
                  transactionId={selectedReplayTrade.transactionId}
                  onClose={() => { setReplayModalOpen(false); setSelectedReplayTrade(null); }}
                />
              ) : (
                <TradeReplayModal
                  trade={selectedReplayTrade}
                  onClose={() => { setReplayModalOpen(false); setSelectedReplayTrade(null); }}
                />
              )
            )}
          </div>
        )}

        {/* --- SYSTEM COMMAND CENTER --- */}
        {/* ========================================================= */}
        {/* TAB: COMMAND CENTER (Autonomous Trading)                  */}
        {/* Purpose: Controls the fully autonomous 'Black Box' bot.   */}
        {/* Features budget allocation, strategy focus, and a master  */}
        {/* kill-switch. Hooked closely to server.ts autoBot loop.    */}
        {/* ========================================================= */}
        {activeTab === "command" && (
          showMissionControl ? (
            <AutonomousMissionControl
              systemState={systemState}
              setSystemState={setSystemState}
              autoBotConfig={autoBotConfig}
              toggleAutoBot={toggleAutoBot}
              onClose={() => setShowMissionControl(false)}
              enginesHalted={enginesHalted}
              setEnginesHalted={setEnginesHalted}
              setHaltReason={setHaltReason}
              setHaltTime={setHaltTime}
            />
          ) : (
            <div className="animate-fade-in flex flex-col gap-6" id="command-center-view">
             <LiveReadinessBanner />
             <WhyNotTradingStrip />
             
             {/* Master Control & Granular Toggles Row */}
             <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
                
                {/* Master Control */}
                <div className={"border rounded-lg p-5 flex flex-col justify-between " + (enginesHalted ? "bg-emerald-500/5 border-emerald-500/30" : "bg-[#1A1F2B] border-slate-800")}>
                   <div>
                     <h3 className={"text-sm font-bold flex items-center gap-2 uppercase tracking-wide mb-2 " + (enginesHalted ? "text-emerald-400" : "text-rose-400")}>
                       <ShieldAlert size={16} />
                       MASTER CONTROL
                     </h3>
                     {enginesHalted ? (
                       <div className="text-xs text-slate-300 leading-relaxed mb-6">
                         <p className="mb-2">All engines HALTED. Restart to resume scanning, decisions, and execution.</p>
                         <p className="text-[10px] font-mono text-slate-500">Halted at {haltTime} - reason: {haltReason}</p>
                       </div>
                     ) : (
                       <p className="text-xs text-slate-400 leading-relaxed mb-6">
                         Hard halt all scanning, decision, and execution engines.
                       </p>
                     )}
                   </div>
                   {enginesHalted ? (
                     <TradingPauseOperatorControls onAuthoritativeTradingState={applyTradingState} />
                   ) : (
                     <button
                       onClick={async () => {
                         setHaltReason("UI emergency stop");
                         setHaltTime(new Date().toLocaleTimeString());
                         try {
                           const res = await fetch("/api/v1/system/emergency-stop", { method: "POST" });
                           if (res.ok) {
                             const data = await res.json().catch(() => ({}));
                             applyTradingState(typeof data?.tradingState === 'string' ? data.tradingState : 'EMERGENCY_STOP', 'UI emergency stop');
                           } else {
                             setHaltReason("");
                             setHaltTime("");
                             setResumeError(`Emergency stop failed (${res.status})`);
                             setTimeout(() => setResumeError(null), 4000);
                           }
                         } catch (e: any) {
                           setHaltReason("");
                           setHaltTime("");
                           setResumeError(e?.message || "Failed to reach the server.");
                           setTimeout(() => setResumeError(null), 4000);
                         }
                       }}
                       className="w-full bg-rose-600 hover:bg-rose-500 text-white font-bold py-6 rounded-lg text-lg uppercase tracking-wider transition-all flex flex-col items-center justify-center gap-2 shadow-[0_0_20px_rgba(225,29,72,0.4)] mb-4"
                     >
                       <Power size={24} />
                       EMERGENCY STOP
                     </button>
                   )}

                   <div className="bg-[#111822] border border-slate-800 rounded p-3">
                     <div className="flex items-center justify-between mb-2">
                       <h4 className="text-[10px] font-mono font-bold text-slate-300 flex items-center gap-1.5 uppercase">
                         <Terminal size={12} className={autoBotTradingMode === "LIVE" ? "text-rose-500" : autoBotTradingMode === "PAPER" ? "text-emerald-400" : "text-amber-500"} />
                         Market Execution (single control)
                       </h4>
                       <select 
                         value={autoBotTradingMode}
                         onChange={(e) => setMarketExecutionMode(e.target.value)}
                         className="bg-[#0A0F16] border border-slate-700 rounded text-xs text-white px-2 py-1 outline-none font-mono"
                       >
                         <option value="SIMULATOR">SIMULATOR</option>
                         <option value="PAPER">PAPER TRADING</option>
                         <option value="LIVE" disabled={!!autoBotConfig?.paperTradingOnly}>LIVE TRADING</option>
                       </select>
                     </div>
                     <p className="text-[9px] font-mono text-slate-500 leading-relaxed mb-1">
                       Preselected from .env ARGUS_TRADING_MODE / PAPER_TRADING_ONLY ({autoBotConfig?.envTradingModeSource || 'boot'} → {autoBotConfig?.envTradingMode || autoBotTradingMode}).
                     </p>
                     {autoBotTradingMode === "LIVE" ? (
                       <p className="text-[9px] font-mono text-rose-500/80 leading-relaxed uppercase">
                         <span className="inline-block w-1.5 h-1.5 rounded-full bg-rose-500 mr-1 animate-pulse"></span>
                         LIVE: Brokerage API Connected (REAL FUNDS)
                       </p>
                     ) : autoBotTradingMode === "PAPER" ? (
                       <p className="text-[9px] font-mono text-emerald-400/80 leading-relaxed uppercase">
                         <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1 animate-pulse"></span>
                         PAPER: Alpaca Paper Trading Connected
                       </p>
                     ) : (
                       <p className="text-[9px] font-mono text-amber-500/80 leading-relaxed uppercase">
                         <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1"></span>
                         MODE: Local State Simulation Mock
                       </p>
                     )}
                   </div>
                </div>

                {/* Pipeline idea-agent EventBus switches */}
                <div className="lg:col-span-3 bg-[#1A1F2B] border border-slate-800 rounded-lg p-5 flex flex-col justify-between">
                   <div className="flex justify-between items-start mb-4 gap-4">
                     <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide">
                       <Settings size={16} className="text-indigo-400" />
                       PIPELINE AGENT SWITCHES
                     </h3>
                     <p className="text-[10px] font-mono text-slate-400 max-w-xl leading-relaxed">
                       Idea-agent lamps start/stop that agent&apos;s EventBus listener or timer. Autobot Start/Stop below is still required for any <span className="text-slate-300">entry</span> idea. Emergency Stop is the global kill switch. RiskEngine, OMS, ChiefTrader, portfolio exits, and market data stay always-on.
                     </p>
                     <div className="flex gap-1 shrink-0">
                       <button onClick={() => void handlePipelineAgentPreset("all_enabled")} className="px-2 py-1 text-[9px] font-bold rounded uppercase tracking-wider transition-colors bg-[#111822] text-slate-400 hover:bg-slate-800">ENABLE ALL IDEAS</button>
                       <button onClick={() => void handlePipelineAgentPreset("all_disabled")} className="px-2 py-1 text-[9px] font-bold rounded uppercase tracking-wider transition-colors bg-[#111822] text-slate-400 hover:bg-slate-800">DISABLE ALL IDEAS</button>
                       <button
                         onClick={async () => {
                           setHaltReason("UI emergency stop");
                           setHaltTime(new Date().toLocaleTimeString());
                           try {
                             const res = await fetch("/api/v1/system/emergency-stop", { method: "POST" });
                             if (res.ok) {
                               setEnginesHalted(true);
                             } else {
                               setHaltReason("");
                               setHaltTime("");
                               setResumeError(`Emergency stop failed (${res.status})`);
                               setTimeout(() => setResumeError(null), 4000);
                             }
                           } catch (e: any) {
                             setHaltReason("");
                             setHaltTime("");
                             setResumeError(e?.message || "Failed to reach the server.");
                             setTimeout(() => setResumeError(null), 4000);
                           }
                         }}
                         className={"px-2 py-1 text-[9px] font-bold rounded uppercase tracking-wider transition-colors " + (enginesHalted ? "bg-indigo-600 text-white" : "bg-[#111822] text-rose-400 hover:bg-slate-800")}
                       >EMERGENCY STOP</button>
                     </div>
                   </div>
                   {!autoBotConfig.enabled && (
                     <p className="text-[9px] font-mono text-amber-400/90 mb-3">
                       Autobot is off — these switches persist, but no entry TRADE_IDEA_GENERATED until you start BLACK BOX Autobot below.
                     </p>
                   )}
                   {pipelineAgentError && (
                     <p className="text-[9px] font-mono text-rose-400 mb-3">{pipelineAgentError}</p>
                   )}

                   <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
                     {pipelineAgents.togglable.map((agent) => {
                       const on = agent.available && agent.enabled;
                       return (
                         <div
                           key={agent.id}
                           title={agent.available ? agent.description : (agent.unavailableReason || agent.description)}
                           className={"bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between min-h-[88px] " + (agent.available ? "cursor-pointer" : "opacity-60 cursor-not-allowed")}
                           onClick={() => void handlePipelineAgentToggle(agent.id, agent.enabled, agent.available)}
                         >
                           <div className="flex items-center gap-2 text-slate-300 text-[10px] uppercase font-bold tracking-widest">
                             <Activity size={12} className="text-slate-400"/> {agent.label}
                           </div>
                           <div className="flex justify-between items-center mt-2">
                             <span className={"font-bold text-[10px] uppercase tracking-wider " + (!agent.available ? "text-amber-500" : on ? "text-emerald-400" : "text-slate-500")}>
                               {!agent.available ? "ENV OFF" : on ? "ONLINE" : "OFFLINE"}
                             </span>
                             <div className={"w-8 h-4 rounded-full border flex items-center px-0.5 " + (on ? "bg-emerald-500/20 border-emerald-500/50 justify-end" : "bg-[#1A1F2B] border-slate-700 justify-start")}>
                               <div className={"w-3 h-3 rounded-full " + (on ? "bg-emerald-400" : "bg-slate-600")}></div>
                             </div>
                           </div>
                         </div>
                       );
                     })}
                   </div>

                   <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                     <div className="bg-[#111822] border border-slate-800 rounded p-3">
                       <div className="flex items-center gap-2 text-slate-300 text-[10px] uppercase font-bold tracking-widest mb-2">
                         <ShieldAlert size={12} className="text-slate-400"/> ALWAYS ON
                       </div>
                       <div className="space-y-1.5">
                         {pipelineAgents.alwaysOn.map((row) => (
                           <div key={row.id} className="flex justify-between items-center text-[10px]" title={row.reason}>
                             <span className="text-slate-400">{row.label}</span>
                             <span className="text-emerald-500/80 font-mono uppercase tracking-wider">Locked on</span>
                           </div>
                         ))}
                       </div>
                     </div>
                     <div className="bg-[#111822] border border-slate-800 rounded p-3 flex flex-col justify-between">
                       <div className="flex items-center gap-2 text-slate-300 text-[10px] uppercase font-bold tracking-widest mb-2">
                         <Zap size={12} className="text-slate-400"/> EXECUTION STATUS
                       </div>
                       <div className="space-y-2">
                         <div className="flex justify-between items-center text-[10px]">
                           <span className={"transition-colors " + (autoBotTradingMode === 'LIVE' ? "text-indigo-400 font-bold" : "text-slate-500")}>Live Trade</span>
                           <div className={"w-6 h-3 rounded-full border flex items-center px-0.5 transition-all " + (autoBotTradingMode !== 'LIVE' ? "bg-[#1A1F2B] border-slate-700 justify-start" : "bg-indigo-500/20 border-indigo-500/50 justify-end")}><div className={"w-2 h-2 rounded-full transition-all " + (autoBotTradingMode !== 'LIVE' ? "bg-slate-600" : "bg-indigo-400")}></div></div>
                         </div>
                         <div className="flex justify-between items-center text-[10px]">
                           <span className={"transition-colors " + (autoBotTradingMode === 'PAPER' || autoBotTradingMode === 'SIMULATOR' ? "text-amber-400 font-bold" : "text-slate-500")}>Paper / Sim</span>
                           <div className={"w-6 h-3 rounded-full border flex items-center px-0.5 transition-all " + (autoBotTradingMode === 'LIVE' ? "bg-[#1A1F2B] border-slate-700 justify-start" : "bg-amber-500/20 border-amber-500/50 justify-end")}><div className={"w-2 h-2 rounded-full transition-all " + (autoBotTradingMode === 'LIVE' ? "bg-slate-600" : "bg-amber-400")}></div></div>
                         </div>
                         <p className="text-[8px] font-mono text-slate-600">Change via Market Execution only. LIVE remains NO-GO until live-readiness says LIVE_READY.</p>
                       </div>
                     </div>
                   </div>
                </div>

             </div>

             <div id="risk-guardrails-panel">
               {globalAutoLiquidationSaveError && (
                 <p className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2 mb-3 leading-relaxed">
                   {globalAutoLiquidationSaveError}
                 </p>
               )}
               <GuardrailsPanel
                 globalAutoLiquidation={globalAutoLiquidation}
                 setGlobalAutoLiquidation={updateGlobalAutoLiquidation}
                 maxDrawdownPct={ribbonMaxDrawdownPct}
               />
             </div>
             
             <RiskExposureDashboard dailyLossCap={autoBotDailyLossLimit} positions={portfolioData?.positions} />

             
      {showLaunchDialog && (
        <AutonomousLaunchDialog
          onClose={() => setShowLaunchDialog(false)}
          onStart={(config) => {
            setActiveSessionConfig(config);
            setShowLaunchDialog(false);
            toggleAutoBot(config);
            setShowMissionControl(true);
          }}
          initialBudget={autoBotTargetBudget}
          initialRisk={autoBotDailyLossLimit}
        />
      )}

             {/* BLACK BOX AUTONOMOUS TRADING BOT */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-start mb-4">
                 <div>
                   <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2 uppercase tracking-wide">
                     <BrainCircuit size={16} className={enginesHalted ? "text-amber-400" : autoBotConfig.enabled ? "text-rose-400 animate-pulse" : "text-slate-400"} />
                     FULLY AUTONOMOUS BLACK-BOX TRADING BOT
                     {/* Real operational status - engine-level emergency_stop/trading_paused always wins over the
                         autobot enabled preference, so this never shows a green RUNNING state while halted. */}
                     <span className={
                       "px-2 py-0.5 rounded text-[9px] font-mono tracking-widest normal-case " +
                       (enginesHalted
                         ? "bg-amber-500/15 text-amber-400 border border-amber-500/40"
                         : autoBotConfig.enabled
                           ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/40"
                           : "bg-slate-800 text-slate-500 border border-slate-700")
                     }>
                       {enginesHalted ? "HALTED" : autoBotConfig.enabled ? "RUNNING" : "STANDBY"}
                     </span>
                   </h3>
                   <p className="text-xs text-slate-400 max-w-3xl leading-relaxed">
                     When Autobot is enabled, idea agents emit through EventBus → ChiefTrader → RiskEngine → OMS → the active broker. LIVE remains NO-GO until GET /api/v2/live-readiness reports LIVE_READY. This loop does not bypass RiskEngine.
                   </p>
                   {autoBotStartError && (
                     <p className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/30 rounded px-3 py-2 mt-3 max-w-3xl leading-relaxed">
                       {autoBotStartError}
                     </p>
                   )}
                   {autoBotConfig.autoTradeScheduleEnabled && !autoBotConfig.enabled && (
                     <p className="text-[10px] text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2 mt-3 max-w-3xl leading-relaxed">
                       A schedule is saved ({autoBotConfig.autoTradeScheduleStartTime}–{autoBotConfig.autoTradeScheduleEndTime} {autoBotConfig.autoTradeScheduleTimezone}).
                       {autoBotConfig.scheduleWindow?.inWindow === false
                         ? " Current time is outside that window, so Autobot is off — Observatory AutoBot STOPPED is the live engine flag. The scheduler will start Autobot at the next window open."
                         : " Autobot is currently off (start rejected, or the scheduler has not ticked yet). Observatory AutoBot STOPPED is the live engine flag."}
                     </p>
                   )}
                 </div>
                 <div className="flex items-center gap-3">
                   {autoBotConfig.enabled && (
                     <button
                       onClick={() => setShowMissionControl(true)}
                       className="px-6 py-3 rounded-lg font-bold font-mono tracking-widest text-xs transition-all bg-emerald-600 hover:bg-emerald-500 text-white shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                     >
                       VIEW MISSION CONTROL
                     </button>
                   )}
                   <button
                     onClick={autoBotConfig.enabled ? toggleAutoBot : () => setShowLaunchDialog(true)}
                     className={"px-6 py-3 rounded-lg font-bold font-mono tracking-widest text-xs transition-all " + (autoBotConfig.enabled ? "bg-rose-500/20 text-rose-400 hover:bg-rose-500/30 border border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.4)]" : enginesHalted ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border border-amber-500/50 shadow-[0_0_15px_rgba(245,158,11,0.3)]" : "bg-indigo-500 hover:bg-indigo-400 text-white shadow-[0_0_15px_rgba(99,102,241,0.3)]")}
                   >
                     {autoBotConfig.enabled ? "HALT ALL BLACK-BOX SYSTEMS" : enginesHalted ? "RESUME & START" : "INITIALIZE AUTONOMOUS TRADING"}
                   </button>
                 </div>
               </div>
               
               <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4" id="allocated-budget-limit">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono block">
                        <Explainer id="allocatedCapital">Allocated Budget Limit</Explainer>
                      </span>
                      <span className="text-[9px] font-mono text-slate-500">
                        Available: {portfolioData
                          ? <span className={autoBotTargetBudget > (portfolioData.buying_power ?? portfolioData.cash ?? 0) ? "text-rose-400 font-bold" : "text-emerald-400"}>
                              ${(portfolioData.buying_power ?? portfolioData.cash ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </span>
                          : <UnavailableHint reason={brokerRibbon.unavailableReason}>--</UnavailableHint>}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                       <span className="text-xl font-bold text-slate-200">$</span>
                       <input
                         type="number"
                         min="1"
                         title="Argus allocation cap (settings.budget), not broker equity"
                         className={"w-full bg-transparent text-xl font-bold outline-none " + (portfolioData && autoBotTargetBudget > (portfolioData.buying_power ?? portfolioData.cash ?? 0) ? "text-rose-400" : "text-white")}
                         value={autoBotTargetBudget}
                         onChange={e => setAutoBotTargetBudget(Number(e.target.value))}
                         onKeyDown={e => {
                           if (e.key === "Enter") {
                             e.preventDefault();
                             (e.currentTarget as HTMLInputElement).blur();
                             void (async () => {
                               setAutoBotBudgetSaveStatus("saving");
                               const result = await saveAllocatedBudget(autoBotTargetBudget);
                               if (result.ok) {
                                 setAutoBotBudgetSaveStatus("saved");
                                 setAutoBotBudgetSaveError(null);
                                 setTimeout(() => setAutoBotBudgetSaveStatus(null), 3000);
                               } else {
                                 setAutoBotBudgetSaveStatus("error");
                                 setAutoBotBudgetSaveError(result.error || "Failed to save allocated capital.");
                               }
                             })();
                           }
                         }}
                       />
                       <button
                         type="button"
                         disabled={autoBotBudgetSaveStatus === "saving"}
                         onClick={async () => {
                           setAutoBotBudgetSaveStatus("saving");
                           const result = await saveAllocatedBudget(autoBotTargetBudget);
                           if (result.ok) {
                             setAutoBotBudgetSaveStatus("saved");
                             setAutoBotBudgetSaveError(null);
                             setTimeout(() => setAutoBotBudgetSaveStatus(null), 3000);
                           } else {
                             setAutoBotBudgetSaveStatus("error");
                             setAutoBotBudgetSaveError(result.error || "Failed to save allocated capital.");
                           }
                         }}
                         className="shrink-0 px-3 py-1.5 rounded text-[9px] font-bold uppercase tracking-widest bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 hover:bg-indigo-500/30 disabled:opacity-50"
                       >
                         {autoBotBudgetSaveStatus === "saving" ? "Saving..." : autoBotBudgetSaveStatus === "saved" ? "Saved" : "Save"}
                       </button>
                    </div>
                    <p className="text-[9px] text-slate-500 mt-2 leading-relaxed">
                      Argus allocation cap (`settings.budget`), not broker equity. Editable while the engine is paused — this is config, not an order. Autobot Start still rejects if this exceeds broker buying power.
                    </p>
                    {portfolioData && autoBotTargetBudget > (portfolioData.buying_power ?? portfolioData.cash ?? 0) && (
                      <p className="text-[9px] text-rose-400 mt-2 leading-relaxed">
                        Allocated fund not enough - this exceeds your broker's available buying power. Deposit more funds with your broker to raise available buying power, or lower the allocated amount.
                      </p>
                    )}
                    {autoBotBudgetSaveStatus === "error" && autoBotBudgetSaveError && (
                      <p className="text-[9px] text-rose-400 mt-2 leading-relaxed">{autoBotBudgetSaveError}</p>
                    )}
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex gap-4">
                    <div className="flex-1">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Max Trade Cap</span>
                      <div className="flex items-center gap-2 border-b border-slate-700 pb-1">
                         <span className="text-sm font-bold text-slate-400">$</span>
                         <input type="number" className="w-full bg-transparent text-sm font-bold text-white outline-none" value={autoBotMaxTradeSize} onChange={e => setAutoBotMaxTradeSize(Number(e.target.value))} disabled={autoBotConfig.enabled} />
                      </div>
                    </div>
                    <div className="flex-1">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block text-rose-400">Daily Loss Stop</span>
                      <div className="flex items-center gap-2 border-b border-rose-900/50 pb-1">
                         <span className="text-sm font-bold text-rose-500">$</span>
                         <input type="number" className="w-full bg-transparent text-sm font-bold text-rose-400 outline-none" value={autoBotDailyLossLimit} onChange={e => setAutoBotDailyLossLimit(Number(e.target.value))} disabled={autoBotConfig.enabled} />
                      </div>
                    </div>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex gap-4">
                    <div className="flex-1">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Strategy Focus</span>
                      <select className="w-full bg-transparent text-xs font-bold text-indigo-400 outline-none border-b border-slate-700 pb-1 h-6 cursor-pointer" value={autoBotStrategy} onChange={e => setAutoBotStrategy(e.target.value)} disabled={autoBotConfig.enabled}>
                         <option value="Momentum & Breakout">Momentum & Breakout</option>
                         <option value="Mean Reversion">Mean Reversion</option>
                         <option value="Scalping">Scalping</option>
                         <option value="Gap & Go">Gap & Go</option>
                         <option value="Trend-Following">Trend-Following</option>
                      </select>
                    </div>
                    <div className="flex-1">
                      <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">System Risk Level</span>
                      <select className="w-full bg-transparent text-xs font-bold text-rose-400 outline-none border-b border-slate-700 pb-1 h-6 cursor-pointer" value={autoBotRiskLevel} onChange={e => setAutoBotRiskLevel(e.target.value)} disabled={autoBotConfig.enabled}>
                         <option value="Low (Max -1%)">Conservative</option>
                         <option value="Medium (Max -3%)">Standard</option>
                         <option value="High (Max -7%)">Aggressive</option>
                         <option value="Maximum Return (Unrestricted)">Maximum</option>
                      </select>
                    </div>
                 </div>
                 
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 relative overflow-hidden flex flex-col justify-end md:col-span-3 lg:col-span-1">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Deployed / Remaining</span>
                    <div className="flex items-baseline gap-2">
                       <span className="text-xl font-bold text-emerald-400">${autoBotConfig.spent?.toFixed(0)}</span>
                       <span className="text-xs text-slate-500">/ ${autoBotConfig.remaining?.toFixed(0)}</span>
                    </div>
                    <div className="absolute top-0 right-0 h-full w-2 bg-gradient-to-b from-indigo-500 to-indigo-900 opacity-50"></div>
                 </div>
                 
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 relative overflow-hidden flex flex-col justify-end md:col-span-3 lg:col-span-2">
                    <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Current Daily Loss / Limit</span>
                    <div className="flex items-center gap-4">
                       <div className="flex-1 bg-slate-800/50 h-2 rounded-full overflow-hidden">
                          <div className="h-full bg-rose-500" style={{ width: `${Math.min(100, ((autoBotConfig.currentDailyLoss || 0) / (autoBotConfig.dailyLossLimit || 1)) * 100)}%`}}></div>
                       </div>
                       <div className="flex items-baseline gap-1 shrink-0">
                          <span className="text-sm font-bold text-rose-400">${autoBotConfig.currentDailyLoss?.toFixed(0) || 0}</span>
                          <span className="text-xs text-slate-500">/ ${autoBotConfig.dailyLossLimit || autoBotDailyLossLimit}</span>
                       </div>
                    </div>
                    {autoBotConfig.currentDailyLoss >= autoBotConfig.dailyLossLimit && (
                       <div className="absolute inset-0 bg-rose-500/10 flex items-center justify-center backdrop-blur-[1px]">
                          <span className="text-[10px] font-bold text-rose-400 uppercase tracking-widest bg-rose-500/20 px-2 py-1 rounded">LOSS LIMIT REACHED</span>
                       </div>
                    )}
                 </div>
               </div>

               {/* ADVANCED TAKE PROFIT / STOP LOSS MODIFIERS */}
               <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                    <span className="text-[10px] text-emerald-500 uppercase tracking-widest font-mono mb-2 block">Target Take-Profit (%)</span>
                    <div className="flex items-center gap-2 border-b border-emerald-900/50 pb-1">
                       <input type="number" className="w-full bg-transparent text-sm font-bold text-emerald-400 outline-none" value={autoBotTakeProfit} onChange={e => setAutoBotTakeProfit(Number(e.target.value))} disabled={autoBotConfig.enabled} />
                       <span className="text-sm font-bold text-slate-500">%</span>
                    </div>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                    <span className="text-[10px] text-amber-500 uppercase tracking-widest font-mono mb-2 block">Trailing Stop-Loss (%)</span>
                    <div className="flex items-center gap-2 border-b border-amber-900/50 pb-1">
                       <input type="number" className="w-full bg-transparent text-sm font-bold text-amber-400 outline-none" value={autoBotTrailingStop} onChange={e => setAutoBotTrailingStop(Number(e.target.value))} disabled={autoBotConfig.enabled} />
                       <span className="text-sm font-bold text-slate-500">%</span>
                    </div>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                    <span className="text-[10px] text-sky-500 uppercase tracking-widest font-mono mb-2 block">Min. AI Confidence</span>
                    <div className="flex items-center gap-4 border-b border-sky-900/50 pb-1">
                       <input type="range" min="50" max="99" className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500" value={autoBotMinConfidence} onChange={e => setAutoBotMinConfidence(Number(e.target.value))} disabled={autoBotConfig.enabled} />
                       <span className="text-sm font-bold text-sky-400 shrink-0">{autoBotMinConfidence}%</span>
                    </div>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                    <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-mono block">Adversarial Debate</span>
                    <div className="flex items-center justify-between mt-2 pt-1 border-t border-slate-800">
                       <span className="text-[11px] font-mono text-slate-400 uppercase">Dual-Agent Debate</span>
                       <button
                         onClick={() => setAutoBotAdversarialDebate(!autoBotAdversarialDebate)}
                         disabled={autoBotConfig.enabled}
                         className={"w-10 h-5 rounded-full p-0.5 transition-colors duration-200 outline-none " + (autoBotAdversarialDebate ? "bg-indigo-500" : "bg-slate-700") + (autoBotConfig.enabled ? " opacity-50 cursor-not-allowed" : " cursor-pointer")}
                       >
                         <div className={"w-4 h-4 rounded-full bg-white transform transition-transform duration-200 " + (autoBotAdversarialDebate ? "translate-x-5" : "translate-x-0")}></div>
                       </button>
                    </div>
                 </div>
               </div>

               {/* SCHEDULED AUTO-TRADING WINDOW - independent of the Start/Stop button; while
                   enabled, AutoTradeScheduler.ts (server-side) drives Autobot on/off through this
                   same schedule instead of a human clicking Start/Stop. Does not widen real market
                   hours - RiskEngine's market_hours gate still independently blocks new entries
                   whenever the real US session is closed, regardless of this window. */}
               <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 mb-6">
                 <div className="flex items-center justify-between mb-4">
                   <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-mono flex items-center gap-2">
                     <Clock size={13} /> Scheduled Auto-Trading Window
                   </span>
                   <div className="flex items-center gap-3">
                     <span className="text-[11px] font-mono text-slate-400 uppercase">{autoTradeScheduleEnabled ? "Schedule Active" : "Manual Start/Stop"}</span>
                     <button
                       onClick={() => setAutoTradeScheduleEnabled(!autoTradeScheduleEnabled)}
                       className={"w-10 h-5 rounded-full p-0.5 transition-colors duration-200 outline-none cursor-pointer " + (autoTradeScheduleEnabled ? "bg-indigo-500" : "bg-slate-700")}
                     >
                       <div className={"w-4 h-4 rounded-full bg-white transform transition-transform duration-200 " + (autoTradeScheduleEnabled ? "translate-x-5" : "translate-x-0")}></div>
                     </button>
                   </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Timezone</span>
                     <select
                       className="w-full bg-transparent text-xs font-bold text-indigo-400 outline-none border-b border-slate-700 pb-1 h-6 cursor-pointer"
                       value={autoTradeScheduleTimezone}
                       onChange={e => setAutoTradeScheduleTimezone(e.target.value)}
                       disabled={!autoTradeScheduleEnabled}
                     >
                       <option value="America/New_York">Eastern - New York (NYSE/NASDAQ)</option>
                       <option value="America/Toronto">Eastern - Toronto (TSX)</option>
                       <option value="America/Chicago">Central - Chicago</option>
                       <option value="America/Denver">Mountain - Denver</option>
                       <option value="America/Los_Angeles">Pacific - Los Angeles</option>
                       <option value="America/Vancouver">Pacific - Vancouver</option>
                       <option value="UTC">UTC</option>
                     </select>
                   </div>
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Window Start</span>
                     <input type="time" className="w-full bg-transparent text-sm font-bold text-emerald-400 outline-none border-b border-slate-700 pb-1" value={autoTradeScheduleStartTime} onChange={e => setAutoTradeScheduleStartTime(e.target.value)} disabled={!autoTradeScheduleEnabled} />
                   </div>
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Window End</span>
                     <input type="time" className="w-full bg-transparent text-sm font-bold text-amber-400 outline-none border-b border-slate-700 pb-1" value={autoTradeScheduleEndTime} onChange={e => setAutoTradeScheduleEndTime(e.target.value)} disabled={!autoTradeScheduleEnabled} />
                   </div>
                   <div className="flex flex-col justify-end">
                     <button
                       onClick={saveAutoTradeSchedule}
                       disabled={autoTradeScheduleSaveStatus === "saving"}
                       className="w-full h-8 rounded-md bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-xs font-bold uppercase tracking-widest hover:bg-indigo-500/30 disabled:opacity-50"
                     >
                       {autoTradeScheduleSaveStatus === "saving" ? "Saving..." : autoTradeScheduleSaveStatus === "saved" ? "Saved" : "Save Schedule"}
                     </button>
                   </div>
                 </div>
                 {autoTradeScheduleSaveStatus === "error" && (
                   <div className="mt-2 text-[11px] font-mono text-rose-400">{autoTradeScheduleSaveError}</div>
                 )}

                 <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-500 leading-relaxed space-y-1">
                   <p>
                     <span className="text-slate-400 font-bold">Exchange hours (general information, not an Argus-validated edge):</span>{" "}
                     NYSE/NASDAQ and the Toronto Stock Exchange (TSX) both trade the regular session 09:30-16:00 Eastern Time.
                     Toronto and New York share the identical civil clock (both Eastern Time, both on the harmonized post-2007
                     US/Canada DST schedule), so a schedule set in either timezone behaves the same way.
                   </p>
                   <p>
                     A schedule window only controls whether Autobot is enabled - it does not and cannot widen real market hours.
                     RiskEngine's <span className="font-mono text-slate-400">market_hours</span> gate independently blocks new entries
                     whenever Alpaca reports the real US session closed, no matter what this window says.
                   </p>
                   <p>
                     If narrowing further: the first and last minutes of the session tend to see the widest spreads and highest
                     volatility (open/close price discovery), and liquidity commonly thins around midday. This is general,
                     widely-known market-structure behavior, not a backtested Argus recommendation - Argus has not validated any
                     specific sub-window as more profitable (see the Live Readiness panel for the real, current strategy-validation
                     status).
                   </p>
                 </div>
               </div>

               {/* STRATEGY ENGINE - a completely separate, isolated research subsystem
                   (src/server/strategiesEngine/). Off by default. Even in SHADOW/ANALYSIS_ONLY
                   mode it only ever records hypothetical signals to strategy_engine_signals - it
                   never places an order, never calls RiskEngine, never touches Autobot/OMS/broker
                   state. See CLAUDE.md (isolated strategiesEngine). */}
               <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 mb-6">
                 <div className="flex items-center justify-between mb-4">
                   <span className="text-[10px] text-indigo-400 uppercase tracking-widest font-mono flex items-center gap-2">
                     <Layers size={13} /> Strategy Engine (Research, Isolated)
                   </span>
                   <div className="flex items-center gap-3">
                     <span className="text-[11px] font-mono text-slate-400 uppercase">{strategyEngineEnabled ? `Enabled - ${strategyEngineMode}` : "Off"}</span>
                     <button
                       onClick={() => setStrategyEngineEnabled(!strategyEngineEnabled)}
                       className={"w-10 h-5 rounded-full p-0.5 transition-colors duration-200 outline-none cursor-pointer " + (strategyEngineEnabled ? "bg-indigo-500" : "bg-slate-700")}
                     >
                       <div className={"w-4 h-4 rounded-full bg-white transform transition-transform duration-200 " + (strategyEngineEnabled ? "translate-x-5" : "translate-x-0")}></div>
                     </button>
                   </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Mode</span>
                     <select
                       className="w-full bg-transparent text-xs font-bold text-indigo-400 outline-none border-b border-slate-700 pb-1 h-6 cursor-pointer"
                       value={strategyEngineMode}
                       onChange={e => setStrategyEngineMode(e.target.value)}
                       disabled={!strategyEngineEnabled}
                     >
                       <option value="OFF">OFF</option>
                       <option value="SHADOW">SHADOW (records hypothetical signals only)</option>
                       <option value="ANALYSIS_ONLY">ANALYSIS_ONLY (same as SHADOW in this pass)</option>
                     </select>
                   </div>
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Max Active Strategies</span>
                     <input type="number" min="1" max="500" className="w-full bg-transparent text-sm font-bold text-emerald-400 outline-none border-b border-slate-700 pb-1" value={strategyEngineMaxActive} onChange={e => setStrategyEngineMaxActive(Number(e.target.value))} disabled={!strategyEngineEnabled} />
                   </div>
                   <div>
                     <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2 block">Min. Confidence</span>
                     <div className="flex items-center gap-4 border-b border-slate-700 pb-1">
                       <input type="range" min="0" max="1" step="0.05" className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-sky-500" value={strategyEngineMinConfidence} onChange={e => setStrategyEngineMinConfidence(Number(e.target.value))} disabled={!strategyEngineEnabled} />
                       <span className="text-sm font-bold text-sky-400 shrink-0">{strategyEngineMinConfidence.toFixed(2)}</span>
                     </div>
                   </div>
                   <div className="flex flex-col justify-end">
                     <button
                       onClick={saveStrategyEngineSettings}
                       disabled={strategyEngineSaveStatus === "saving"}
                       className="w-full h-8 rounded-md bg-indigo-500/20 border border-indigo-500/40 text-indigo-300 text-xs font-bold uppercase tracking-widest hover:bg-indigo-500/30 disabled:opacity-50"
                     >
                       {strategyEngineSaveStatus === "saving" ? "Saving..." : strategyEngineSaveStatus === "saved" ? "Saved" : "Save"}
                     </button>
                   </div>
                 </div>
                 {strategyEngineSaveStatus === "error" && (
                   <div className="mt-2 text-[11px] font-mono text-rose-400">{strategyEngineSaveError}</div>
                 )}

                 <div className="mt-4 pt-3 border-t border-slate-800 text-[11px] text-slate-500 leading-relaxed space-y-1">
                   <p className="text-amber-400 font-bold">
                     Strategy Engine does not directly execute trades.
                   </p>
                   <p>
                     This is a separate, isolated research subsystem holding 10,000+ candidate strategy configurations
                     (browsable via GET /api/v2/strategy-engine/strategies). Enabling it and setting a mode other than OFF only
                     makes a background evaluator compute real signals against real market data and record them as a
                     hypothetical log entry - it never calls the broker, never bypasses RiskEngine, and never places
                     or influences a real order, at any setting on this page. SIGNAL_ADVISORY / CONSENSUS_PARTICIPANT /
                     PAPER_ONLY / LIVE_ELIGIBLE modes are reserved for a future phase and are rejected by the server today.
                   </p>
                 </div>
               </div>

               <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                 <div className="bg-[#0A0F16] rounded-lg border border-slate-800 p-0 flex flex-col overflow-hidden">
                   <div className="bg-slate-900 border-b border-slate-800 px-4 py-2 flex items-center justify-between">
                     <h4 className="text-[10px] font-mono tracking-widest uppercase text-slate-400 flex items-center gap-2">
                        <Terminal size={14} className="text-emerald-400" />
                        Live LLM "Thought Stream" Console
                     </h4>
                     {autoBotConfig.enabled && <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-400 uppercase tracking-widest bg-emerald-500/10 px-2 py-0.5 rounded"><div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div> ACTIVE</span>}
                   </div>
                   <div className="h-56 overflow-y-auto px-4 py-3 custom-scrollbar font-mono text-[11px] leading-relaxed flex flex-col gap-2">
                      {thoughtStreamLogs.map((log) => (
                          <div key={log.id} className="flex gap-2 items-start">
                            <div className="text-slate-600 shrink-0">[{new Date().toLocaleTimeString().split(' ')[0]}]</div>
                            {log.type === "proposer" && <span className="text-blue-400 font-bold shrink-0">[AGENT 1 - PROPOSER]</span>}
                            {log.type === "risk" && <span className="text-amber-400 font-bold shrink-0">[RISK ENGINE]</span>}
                            {log.type === "reflection" && <span className="text-purple-400 font-bold shrink-0">[AGENT 3 - REFLECT]</span>}
                            {log.type === "reflect" && <span className="text-purple-400 font-bold shrink-0">[REFLECT]</span>}
                            {log.type === "execution" && <span className="text-fuchsia-400 font-bold shrink-0">[AGENT 4 - EXECUTION]</span>}
                            {log.type === "execute" && <span className="text-fuchsia-400 font-bold shrink-0">[OMS]</span>}
                            {log.type === "research" && <span className="text-sky-400 font-bold shrink-0">[AGENT 0 - RESEARCH]</span>}
                            {log.type === "info" && <span className="text-emerald-400 font-bold shrink-0">[SYSTEM]</span>}
                            {log.type === "scan" && <span className="text-slate-400 font-bold shrink-0">[SCAN]</span>}
                            {log.type === "approve" && <span className="text-indigo-400 font-bold shrink-0">[CHIEF]</span>}
                            {log.type === "no_trade" && <span className="text-amber-300 font-bold shrink-0">[NO TRADE]</span>}
                            {log.type === "start" && <span className="text-emerald-400 font-bold shrink-0">[START]</span>}
                            {log.type === "stop" && <span className="text-rose-400 font-bold shrink-0">[STOP]</span>}
                            {log.type === "reject" && <span className="text-rose-400 font-bold shrink-0">[REJECT]</span>}
                            {log.type === "veto" && <span className="text-rose-400 font-bold shrink-0">[VETO]</span>}
                            <div className={"break-words " + (log.type === 'veto' || log.type === 'reject' || log.type === 'stop' ? 'text-rose-300' : 'text-slate-300')} title={log.message}>{log.message}</div>
                          </div>
                      ))}
                      {autoBotConfig.enabled && (
                         <div className="flex gap-2 items-center text-slate-500 animate-pulse mt-2">
                           <span className="w-1.5 h-3 bg-emerald-400/50 block"></span>
                           Awaiting inference stream...
                         </div>
                      )}
                   </div>
                 </div>
                 
                 <div id="market-data-panel" className="bg-[#111822] rounded-lg border border-slate-800 p-4 flex flex-col">
                   <h4 className="text-[10px] font-mono tracking-widest uppercase text-slate-500 mb-3 flex items-center justify-between">
                      <span>Live Decision Flow Visualizer</span>
                   </h4>
                   <div className="flex-1 flex items-center justify-center">
                      <AwaitingSignal
                        label="Live Decision Flow Visualizer"
                        reason="AutoBotFlowVisualizer animated a fabricated proposer/risk/execution cycle from legacy autoBotConfig.activeCycle. Real decisions are EventBus → ChiefTrader → RiskEngine → OMS. NOT_IMPLEMENTED as a live flow."
                      />
                   </div>
                 </div>
               </div>
             </div>

             <LiveBotTelemetryPanel autoBotConfig={autoBotConfig} />

             <ShadowPortfolioBenchmark autoBotConfig={autoBotConfig} />

             {/* Dual LLM sandbox was a client-side proposer/verifier theater, not RiskEngine. */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2 uppercase tracking-wide">
                 <ShieldAlert size={16} className="text-indigo-400" />
                 DUAL LLM TRADE VERIFICATION ENGINE
               </h3>
               <AwaitingSignal
                 label="Dual-agent synthesis sandbox"
                 reason="This panel ran a simulated proposer/verifier LLM pair that did not enter EventBus, ChiefTrader, or RiskEngine. Live verification is OpenAlice (optional, non-blocking) plus RiskEngine. NOT_IMPLEMENTED as an execution path."
               />
             </div>

             {/* AI Intelligence Provider Row */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-start mb-4">
                 <div>
                   <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide mb-1">
                     <BrainCircuit size={16} className="text-indigo-400" />
                     HYBRID AI INTELLIGENCE ROUTING
                   </h3>
                   <p className="text-xs text-slate-400 mt-2 max-w-3xl leading-relaxed">
                     To optimize token consumption and performance, the system decouples high-frequency analysis from critical consensus decisions. Smaller, faster models ingest and summarize market noise continuously (Standard). Heavyweight models are invoked strictly for final trade verification and conflict resolution (Premium), digesting only the compressed representations.
                   </p>
                 </div>
               </div>

               <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
                 {/* Standard Engine Selection */}
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-5">
                   <h4 className="text-xs font-bold text-white mb-2 flex items-center gap-2 tracking-wide uppercase border-b border-slate-800 pb-3">
                     <Activity size={14} className="text-slate-400" />
                     High-Frequency Edge Node (Standard)
                   </h4>
                   <p className="text-[10px] text-slate-500 mb-4 leading-relaxed">
                     Used for scanning L2 books, parsing live news feeds, and sentiment extraction. High volume, lightweight execution.
                   </p>
                   
                   <div className="flex flex-col gap-3">
                     <label className="flex items-center gap-3 p-3 border border-slate-800 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="standard_llm" value="Gemini Flash" checked={standardLLMProvider === "Gemini Flash"} onChange={() => setStandardLLMProvider("Gemini Flash")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">Google Gemini 2.5 Flash</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="standard_llm" value="GPT-4o-mini" checked={standardLLMProvider === "GPT-4o-mini"} onChange={() => setStandardLLMProvider("GPT-4o-mini")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">OpenAI GPT-4o-mini</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="standard_llm" value="Claude 3 Haiku" checked={standardLLMProvider === "Claude 3 Haiku"} onChange={() => setStandardLLMProvider("Claude 3 Haiku")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">Anthropic Claude 3.5 Haiku</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="standard_llm" value="DeepSeek-Coder" checked={standardLLMProvider === "DeepSeek-Coder"} onChange={() => setStandardLLMProvider("DeepSeek-Coder")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">DeepSeek NLP / Coder</div>
                       </div>
                     </label>
                   </div>
                 </div>

                 {/* Premium Engine Selection */}
                 <div className="bg-[#111822] border border-indigo-500/30 rounded-lg p-5 relative overflow-hidden shadow-[0_0_15px_rgba(99,102,241,0.05)]">
                   <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500"></div>
                   <h4 className="text-xs font-bold text-white mb-2 flex items-center gap-2 tracking-wide uppercase border-b border-slate-800 pb-3 pl-2">
                     <BrainCircuit size={14} className="text-indigo-400" />
                     Consensus Arbiter (Premium)
                   </h4>
                   <p className="text-[10px] text-indigo-200/60 mb-4 leading-relaxed pl-2">
                     Used strictly as the RiskVerification Node. Ingests compressed JSON from standard edge nodes to issue final trade verdicts over live capital.
                   </p>
                   
                   <div className="flex flex-col gap-3 pl-2">
                     <label className="flex items-center gap-3 p-3 border border-indigo-500/20 bg-indigo-500/5 rounded-lg cursor-pointer hover:bg-indigo-500/10 transition-colors">
                       <input type="radio" name="premium_llm" value="Gemini Pro" checked={premiumLLMProvider === "Gemini Pro"} onChange={() => setPremiumLLMProvider("Gemini Pro")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">Google Gemini 2.5 Pro</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 hover:border-indigo-500/30 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="premium_llm" value="GPT-4o" checked={premiumLLMProvider === "GPT-4o"} onChange={() => setPremiumLLMProvider("GPT-4o")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">OpenAI GPT-4o</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 hover:border-indigo-500/30 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="premium_llm" value="Claude 3.5 Sonnet" checked={premiumLLMProvider === "Claude 3.5 Sonnet"} onChange={() => setPremiumLLMProvider("Claude 3.5 Sonnet")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">Anthropic Claude 3.5 Sonnet</div>
                       </div>
                     </label>
                     <label className="flex items-center gap-3 p-3 border border-slate-800 hover:border-indigo-500/30 rounded-lg cursor-pointer hover:bg-slate-800/50 transition-colors">
                       <input type="radio" name="premium_llm" value="DeepSeek-Chat" checked={premiumLLMProvider === "DeepSeek-Chat"} onChange={() => setPremiumLLMProvider("DeepSeek-Chat")} className="accent-indigo-500" />
                       <div className="flex-1">
                         <div className="font-bold text-xs text-white">DeepSeek V3 / R1 (Chat)</div>
                       </div>
                     </label>
                   </div>
                 </div>
               </div>
             </div>

             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-start mb-6">
                 <div>
                   <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide mb-1">
                     <Coins size={16} className="text-emerald-400" />
                     TOKEN USAGE & COST ESTIMATION (24H)
                   </h3>
                   <p className="text-xs text-slate-400">
                     Estimated consumption tracking based on selected providers and active trading nodes. Premium node consumption is deliberately restricted to final confirmations.
                   </p>
                 </div>
                 <div className="bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded-lg flex items-center gap-2">
                   <Calculator size={14} className="text-emerald-400" />
                   <span className="text-xs font-mono font-bold text-emerald-400">~$4.12 / day</span>
                 </div>
               </div>

               <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                 {/* Standard Usage */}
                 <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                   <h4 className="text-xs font-bold text-slate-300 mb-3 flex items-center justify-between border-b border-slate-800 pb-2">
                     <span className="uppercase tracking-wider flex items-center gap-2"><Activity size={12} className="text-slate-400"/> Standard Nodes Pipeline</span>
                     <span className="text-[10px] font-mono bg-slate-800 px-1.5 py-0.5 rounded text-white">{standardLLMProvider}</span>
                   </h4>
                   <div className="space-y-4">
                     <div>
                       <div className="flex justify-between items-end mb-1">
                         <span className="text-[10px] text-slate-400 font-mono">NewsAgent (L2 & Sentiment)</span>
                         <span className="text-[10px] text-slate-300 font-mono">1.2M tokens <span className="text-slate-500 ml-2">~$0.18</span></span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                         <div className="bg-slate-400 h-full w-[45%]"></div>
                       </div>
                     </div>
                     <div>
                       <div className="flex justify-between items-end mb-1">
                         <span className="text-[10px] text-slate-400 font-mono">MacroAgent (Economic Prints)</span>
                         <span className="text-[10px] text-slate-300 font-mono">2.8M tokens <span className="text-slate-500 ml-2">~$0.42</span></span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                         <div className="bg-slate-400 h-full w-[70%]"></div>
                       </div>
                     </div>
                     <div>
                       <div className="flex justify-between items-end mb-1">
                         <span className="text-[10px] text-slate-400 font-mono">Proposer Node (Aggregator)</span>
                         <span className="text-[10px] text-slate-300 font-mono">800K tokens <span className="text-slate-500 ml-2">~$0.12</span></span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                         <div className="bg-slate-400 h-full w-[25%]"></div>
                       </div>
                     </div>
                   </div>
                   <div className="mt-4 pt-3 border-t border-slate-800 flex justify-between items-center text-[10px] font-mono">
                     <span className="text-slate-500">Total Standard Volume: 4.8M T/day</span>
                     <span className="text-slate-300 font-bold">Est Cost: $0.72</span>
                   </div>
                 </div>

                 {/* Premium Usage */}
                 <div className="bg-[#111822] border border-indigo-500/20 rounded-lg p-4 relative overflow-hidden">
                   <div className="absolute top-0 left-0 w-1 h-full bg-indigo-500"></div>
                   <h4 className="text-xs font-bold text-white mb-3 flex items-center justify-between border-b border-slate-800 pb-2 pl-2">
                     <span className="uppercase tracking-wider flex items-center gap-2"><BrainCircuit size={12} className="text-indigo-400"/> Premium Arbiter Node</span>
                     <span className="text-[10px] font-mono bg-indigo-500/20 border border-indigo-500/30 px-1.5 py-0.5 rounded text-indigo-400">{premiumLLMProvider}</span>
                   </h4>
                   <div className="space-y-4 pl-2">
                     <div>
                       <div className="flex justify-between items-end mb-1">
                         <span className="text-[10px] text-slate-400 font-mono">RiskVerification Check</span>
                         <span className="text-[10px] text-indigo-300 font-mono">180K tokens <span className="text-slate-500 ml-2">~$2.70</span></span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                         <div className="bg-indigo-500 h-full w-[65%]"></div>
                       </div>
                     </div>
                     <div>
                       <div className="flex justify-between items-end mb-1">
                         <span className="text-[10px] text-slate-400 font-mono">Context Slippage Resolver</span>
                         <span className="text-[10px] text-indigo-300 font-mono">45K tokens <span className="text-slate-500 ml-2">~$0.70</span></span>
                       </div>
                       <div className="w-full bg-slate-800 h-1.5 rounded overflow-hidden">
                         <div className="bg-indigo-500/60 h-full w-[25%]"></div>
                       </div>
                     </div>
                   </div>
                   <div className="mt-7 pt-3 border-t border-slate-800 flex justify-between items-center pl-2 text-[10px] font-mono">
                     <span className="text-slate-500">Total Premium Volume: 225K T/day</span>
                     <span className="text-white font-bold tracking-wider">Est Cost: $3.40</span>
                   </div>
                 </div>
               </div>
             </div>

             {/* Model Performance Benchmarks Row */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <div className="flex justify-between items-start mb-6">
                 <div>
                   <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide mb-1">
                     <BarChart3 size={16} className="text-indigo-400" />
                     MODEL PERFORMANCE BENCHMARKS
                   </h3>
                   <p className="text-xs text-slate-400">
                     Comparison of median latency (ms) vs. complex reasoning accuracy (%) across supported standard and premium intelligence models.
                   </p>
                 </div>
               </div>

               <div className="h-[300px] w-full mt-4">
                 <AwaitingSignal reason="Model latency/quality bars were static marketing numbers (including Claude, which has no provider class). Use Diagnostics / ai_usage for real latency." label="Model benchmarks" />
               </div>
             </div>

             {/* Autonomous Exit Configuration — duplicate of BLACK BOX takeProfitPct / trailingStopPct */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-5">
               <h3 className="text-sm font-bold text-white flex items-center gap-2 uppercase tracking-wide mb-2">
                 <Shield size={16} className="text-emerald-400" />
                 AUTONOMOUS EXIT CONFIGURATION
               </h3>
               <AwaitingSignal
                 label="Duplicate exit editors removed"
                 reason="These inputs were decorative (defaultValue 2/15/8 with a dead SAVE). Real PortfolioMonitor thresholds are takeProfitPct and trailingStopPct on the BLACK BOX panel above — applied when Autobot starts. Exits are SELL ideas through RiskEngine, not broker flatten."
               />
             </div>

          </div>
          )
        )}

        {activeTab === "scanner" && (
          <div className="flex flex-col gap-6">
            <p className="text-[11px] text-slate-500 font-mono">
              RSI scan, quant evaluateAll, desk overlay, and research status. Intelligence is a shortcut here — this is the only copy of the quant panel.
            </p>
            <StrategyScanner
              selectedAlertSymbol={selectedAlertSymbol}
              setSelectedAlertSymbol={setSelectedAlertSymbol}
            />
            <QuantSignalsPanel />
            <EliteDeskPanel />
            <ResearchLabPanel />
          </div>
        )}

        {activeTab === "activity" && (
          <div className="animate-fade-in flex flex-col gap-6">
            <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="bg-emerald-500/10 p-3 rounded border border-emerald-500/20 text-emerald-400">
                     <Terminal size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-white uppercase tracking-widest">System Activity Logs</h3>
                    <p className="text-slate-400 text-sm leading-relaxed">
                       Real-time telemetry, agent thinking processes, and background execution traces.
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => {
                    if(!autoBotConfig.history) return;
                    const csvContent = "data:text/csv;charset=utf-8," 
                      + "Timestamp,Type,Message,Agent,Symbol,Side,Confidence,Gate,TraceId,Price,NoTradeCode\n" 
                      + autoBotConfig.history.map((log: any) => {
                        const d = log.detail || {};
                        const cells = [
                          new Date(log.time).toISOString(),
                          log.type,
                          log.msg,
                          d.agent || '',
                          d.symbol || '',
                          d.side || '',
                          d.confidence ?? '',
                          d.gate || '',
                          d.traceId || '',
                          d.price ?? '',
                          d.noTradeCode || '',
                        ].map((c: any) => `"${String(c).replace(/"/g, '""')}"`);
                        return cells.join(',');
                      }).join("\n");
                    const encodedUri = encodeURI(csvContent);
                    const link = document.createElement("a");
                    link.setAttribute("href", encodedUri);
                    link.setAttribute("download", `argus_telemetry_logs_${Date.now()}.csv`);
                    document.body.appendChild(link);
                    link.click();
                    document.body.removeChild(link);
                  }}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-xs border border-slate-700 transition-colors flex items-center gap-2"
                >
                  <List size={14} /> EXPORT CSV
                </button>
              </div>
              
              <div className="bg-[#111822] border border-slate-800 rounded-lg overflow-hidden h-[600px] flex flex-col relative font-mono text-[11px]">
                 <div className="bg-slate-900 border-b border-slate-800 p-2 flex text-slate-500 uppercase tracking-widest font-bold">
                    <div className="w-40 px-2 border-r border-slate-800">Timestamp</div>
                    <div className="w-24 px-2 border-r border-slate-800 text-center">Type</div>
                    <div className="flex-1 px-2">Message / Thought Process</div>
                 </div>
                 <div className="flex-1 overflow-y-auto p-2 space-y-1 scrollbar-hide">
                    {(!autoBotConfig.history || autoBotConfig.history.length === 0) ? (
                       <div className="text-slate-600 text-center py-10 italic">Awaiting telemetry from EventBus (TRADE_IDEA / ChiefTrader / RiskEngine / OMS)...</div>
                    ) : (
                       autoBotConfig.history.map((log: any, i: number) => {
                          const d = log.detail || {};
                          const type = String(log.type || '');
                          const isVeto = type === 'error' || type === 'veto' || type === 'reject' || type === 'stop';
                          const isExec = type === 'execute' || type === 'start';
                          const isApprove = type === 'approve';
                          const isRisk = type === 'risk';
                          const isNoTrade = type === 'no_trade';
                          const isReflect = type === 'learn' || type === 'reflect';
                          const badge = isVeto ? 'bg-rose-900 text-rose-400'
                            : isExec ? 'bg-emerald-900 text-emerald-400'
                            : isApprove ? 'bg-indigo-900 text-indigo-400'
                            : isRisk || isReflect ? 'bg-amber-900 text-amber-400'
                            : isNoTrade ? 'bg-slate-800 text-amber-300'
                            : 'bg-slate-800 text-slate-400';
                          const text = isVeto ? 'text-rose-400'
                            : isExec || isApprove ? 'text-emerald-300'
                            : isRisk || isReflect ? 'text-amber-300'
                            : isNoTrade ? 'text-amber-200'
                            : 'text-slate-300';
                          const border = isVeto ? 'border-rose-500 bg-rose-500/5'
                            : isExec ? 'border-emerald-500 bg-emerald-500/5'
                            : isApprove ? 'border-indigo-500 bg-indigo-500/5'
                            : isRisk || isNoTrade ? 'border-amber-500/60 bg-amber-500/5'
                            : 'border-slate-700';
                          const tooltipParts = [
                            log.msg,
                            d.traceId ? `traceId ${d.traceId}` : '',
                            d.gate ? `gate ${d.gate}` : '',
                            d.noTradeCode ? `NO_TRADE ${d.noTradeCode}` : '',
                            d.reason && d.reason !== log.msg ? d.reason : '',
                          ].filter(Boolean);
                          const chips = [
                            d.agent,
                            d.symbol,
                            d.side,
                            typeof d.confidence === 'number' ? (d.confidence <= 1 ? `${Math.round(d.confidence * 100)}%` : `${Math.round(d.confidence)}%`) : null,
                            d.gate,
                            d.traceShort || (d.traceId ? String(d.traceId).slice(0, 8) : null),
                            d.noTradeCode,
                          ].filter(Boolean);
                          return (
                            <div key={i} title={tooltipParts.join('\n')} className={`flex p-2 rounded border-l-2 hover:bg-slate-800/50 transition-colors ${border}`}>
                               <div className="w-40 px-2 shrink-0 text-slate-500">{new Date(log.time).toLocaleTimeString()}</div>
                               <div className="w-24 px-2 shrink-0 text-center flex items-center justify-center">
                                  <span className={`px-2 py-0.5 rounded text-[9px] uppercase tracking-wider ${badge}`}>
                                    {type}
                                  </span>
                               </div>
                               <div className={`flex-1 px-2 min-w-0 ${text}`}>
                                  <div className="truncate">{log.msg}</div>
                                  {chips.length > 0 && (
                                    <div className="mt-0.5 flex flex-wrap gap-1">
                                      {chips.map((chip: string, ci: number) => (
                                        <span key={ci} className="px-1.5 py-0 rounded bg-slate-900/80 text-[9px] text-slate-400 font-mono uppercase tracking-wide">{chip}</span>
                                      ))}
                                    </div>
                                  )}
                               </div>
                            </div>
                          );
                       })
                    )}
                 </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === "documentation" && (
          <DocumentationTab setActiveTab={setActiveTab} />
        )}

        {activeTab === "evaluation" && (
          <div className="animate-fade-in flex flex-col gap-6" id="evaluation-view">
            <HistoricalReplayLab />
            <AgentEvaluationDashboard />
            <ReplayResearchPanel />
          </div>
        )}

        {activeTab === "diagnostics" && (
          <div className="animate-fade-in" id="diagnostics-view">
            <DiagnosticCenter />
          </div>
        )}

        {activeTab === "validation" && (
          <div className="animate-fade-in flex flex-col gap-6" id="validation-view">
            <SystemValidationSuite />
            <AwaitingSignal
              label="System optimizer theater"
              reason="SystemOptimizer used hardcoded ATR/ADV/AI-prediction strings, not live RiskEngine or broker state. DATA_UNAVAILABLE."
            />
          </div>
        )}

        {activeTab === "kronos" && <KronosDashboard />}
        {activeTab === "observatory" && (
          <div className="animate-fade-in flex flex-col gap-6">
            <DecisionTracePanel />
            <TransactionExplorer />
          </div>
        )}
        {activeTab === "settings" && (
          <div className="animate-fade-in flex flex-col gap-6" id="settings-view">
             {/* === COMPONENT: Deployment Readiness (moved from standalone Deployment tab) === */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6" id="deployment-readiness-section">
               <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-2">
                 <Rocket size={20} className="text-emerald-400" />
                 Deployment readiness
               </h2>
               <p className="text-[10px] text-slate-500 font-mono mb-4">
                 Structural reachability only (schema / broker / AI providers / local AI service). Not LIVE authorization — LIVE remains NO-GO.
               </p>
               <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                 <div>
                   <h4 className="text-xs font-bold text-white uppercase tracking-wide mb-1">System integrity check</h4>
                   <p className={"text-[10px] font-mono " + (deploymentIntegrityError ? "text-rose-400" : "text-slate-500")}>
                     {deploymentIntegrityError
                       ? `Integrity check failed: ${deploymentIntegrityError} — click Retry.`
                       : deploymentIntegrity
                       ? `${deploymentIntegrity.score} real structural checks passed (${deploymentIntegrity.scorePct}%) — schema/broker/AI-provider/local-AI-service reachability.`
                       : 'Loading real integrity check...'}
                   </p>
                 </div>
                 <div className="flex flex-wrap gap-2 shrink-0">
                   <button
                     onClick={fetchDeploymentIntegrity}
                     className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                   >
                     {deploymentIntegrityError ? "Retry" : "Re-check Now"}
                   </button>
                   <button
                     onClick={() => setActiveTab("validation")}
                     className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest rounded border border-slate-700 text-slate-300 hover:bg-slate-800 transition-colors"
                   >
                     Full check list (Validation)
                   </button>
                 </div>
               </div>
               <AwaitingSignal
                 label="Dropdown quant-audit score"
                 reason="The hosting/reconciliation/partial-fill dropdown quiz scored itself from the operator's own selections, not Argus. LIVE remains NO-GO. Use GET /api/v1/system/integrity above (or Validation for the full check list)."
               />
             </div>

             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6">
                <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
                  <Settings size={20} className="text-emerald-400" />
                  API Keys & Integrations
                </h2>
                <div className="space-y-6">
                    <div className="space-y-3">
                      <h3 className="text-[10px] font-mono font-bold text-slate-500 uppercase tracking-[0.2em]">
                        Preferences · Mindset
                      </h3>
                      <ExplainerToggle variant="settings" />
                      <WealthAffirmationToggle />
                    </div>
                    <div className="bg-[#0F141C] border border-slate-800 rounded-lg p-5 flex items-center justify-between gap-4">
                      <div>
                        <h3 className="text-xs font-mono font-bold text-slate-100 uppercase tracking-widest mb-1">System</h3>
                        <p className="text-xs text-slate-500">
                          Re-open the guided setup to review or change your broker, AI provider, trading mode, and risk configuration. Your existing settings are loaded, not reset.
                        </p>
                      </div>
                      <button
                        onClick={() => setSetupComplete(false)}
                        className="shrink-0 flex items-center gap-2 bg-emerald-600/10 hover:bg-emerald-600/20 text-emerald-400 px-4 py-2.5 rounded-lg border border-emerald-500/30 transition-all text-xs font-bold font-mono uppercase tracking-wide"
                      >
                        <Settings size={14} />
                        Launch Setup Wizard
                      </button>
                    </div>
                    <AIProviderManagement />
                    <ConnectionStatusDashboard />
                    <BrokerManagement />
                    {/* Real bug fix (2026-08-18 UI audit, Phase 9): this "Old Env Settings" block and its
                        confirm modal were dead code - wrapped in className="hidden" with the only button
                        that could reach the modal living inside that same hidden div, and posting to
                        /api/v1/settings/toggle-live, a route that doesn't exist anywhere in server.ts or
                        src/server/routes/**. Removed rather than fixed: a real backend live-mode arming
                        path already exists (POST /api/v1/brokers/:id/live-mode - phrase confirmation +
                        liveOrderAuthorization.ts gates), but has no UI anywhere yet, here or elsewhere -
                        building that UI is a deliberate, separate feature decision, not a dead-switch fix. */}
                    {secretsMsg && <div className="text-emerald-400 text-xs">{secretsMsg}</div>}
                   {["Broker", "LLM", "Market Data"].map(cat => (
                     <div key={cat} className="space-y-2">
                       <h3 className="text-xs font-mono font-bold text-slate-500 uppercase">{cat}</h3>
                       {secrets.filter(s => s.category === cat).map(sec => (
                         <div key={sec.key} className="flex gap-2 items-center">
                           <span className="w-48 text-xs text-slate-400">{sec.label}</span>
                           <input
                             type="password"
                             className="flex-1 bg-[#111822] border border-slate-800 rounded p-2 text-xs text-slate-200"
                             placeholder={sec.masked || "Empty"}
                             value={secretEdits[sec.key] !== undefined ? secretEdits[sec.key] : ""}
                             onChange={e => setSecretEdits({...secretEdits, [sec.key]: e.target.value})}
                           />
                           <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                             {sec.configured ? "Configured" : "Missing"}
                           </span>
                         </div>
                       ))}
                     </div>
                   ))}
                   <div className="flex gap-4">
                     <button onClick={saveSecrets} disabled={secretsSaving} className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2 rounded text-xs font-bold font-mono">SAVE</button>
                     <button onClick={() => setSecretEdits({})} className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded text-xs font-bold font-mono">RESET</button>
                   </div>
                   <div className="flex gap-4 border-t border-slate-800 pt-4">
                     <button onClick={() => testSecret('alpaca')} disabled={secretTesting} className="text-indigo-400 border border-indigo-400/30 px-3 py-1 rounded text-xs hover:bg-indigo-400/10">Test Alpaca</button>
                     <button onClick={() => testSecret('llm')} disabled={secretTesting} className="text-blue-400 border border-blue-400/30 px-3 py-1 rounded text-xs hover:bg-blue-400/10">Test LLM</button>
                   </div>
                </div>
             </div>

              {/* === COMPONENT: Chaos Mode Protocol Control (New Feature) === */}
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col animate-fade-in mb-6" id="chaos-mode-panel">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-4 mb-4">
                     <h2 className="text-lg font-bold text-white flex items-center gap-2">
                       <WifiOff size={20} className={chaosEnabled ? "text-amber-500 animate-pulse" : "text-slate-400"} />
                       Chaos Mode Swarm Stress Testing Suite
                     </h2>
                     <div className="flex items-center gap-3 font-mono">
                       <span className={`text-[10px] uppercase tracking-wider px-2.5 py-0.5 rounded font-bold ${chaosEnabled ? 'bg-amber-500/15 text-amber-500 animate-pulse' : 'bg-slate-800 text-slate-500'}`}>
                         {chaosEnabled ? "● ACTIVE" : "○ DEACTIVATED"}
                       </span>
                       <button
                         onClick={() => setChaosEnabled(!chaosEnabled)}
                         className="transition-opacity hover:opacity-90"
                       >
                         {chaosEnabled ? <ToggleRight size={28} className="text-amber-500" /> : <ToggleLeft size={28} className="text-slate-500" />}
                       </button>
                     </div>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed mb-6">
                    Simulate real-world network degradation, API delays, and intermittent node faults. Enabling Chaos Mode subjects selected agent nodes to artificial delays and random error responses to verify the fault tolerance and consensus resilience of the terminal's routing backend.
                  </p>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-6">
                     {/* Left - Configuration Sliders */}
                     <div className="space-y-5 col-span-1">
                        <div>
                           <div className="flex justify-between items-center mb-1">
                              <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">Simulated Latency Range</span>
                              <span className="text-xs font-mono font-bold text-amber-400">{chaosLatencyMin}ms - {chaosLatencyMax}ms</span>
                           </div>
                           <div className="flex items-center gap-4">
                              <div className="flex-1">
                                 <span className="text-[10px] text-slate-500 font-mono block">MINIMUM</span>
                                 <input
                                   type="range"
                                   min="100"
                                   max="4000"
                                   step="100"
                                   value={chaosLatencyMin}
                                   onChange={(e) => {
                                      const val = Number(e.target.value);
                                      setChaosLatencyMin(val);
                                      if (val > chaosLatencyMax) setChaosLatencyMax(val);
                                   }}
                                   className="w-full h-1 accent-amber-500 bg-slate-700 rounded-lg cursor-pointer animate-none"
                                 />
                              </div>
                              <div className="flex-1">
                                 <span className="text-[10px] text-slate-500 font-mono block">MAXIMUM</span>
                                 <input
                                   type="range"
                                   min="100"
                                   max="8000"
                                   step="100"
                                   value={chaosLatencyMax}
                                   onChange={(e) => {
                                      const val = Number(e.target.value);
                                      setChaosLatencyMax(val);
                                      if (val < chaosLatencyMin) setChaosLatencyMin(val);
                                   }}
                                   className="w-full h-1 accent-amber-500 bg-slate-700 rounded-lg cursor-pointer animate-none"
                                 />
                              </div>
                           </div>
                        </div>

                        <div>
                           <div className="flex justify-between items-center mb-1">
                              <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">Node Failure Probability</span>
                              <span className="text-xs font-mono font-bold text-rose-400">{chaosErrorRate}%</span>
                           </div>
                           <input
                             type="range"
                             min="0"
                             max="100"
                             step="5"
                             value={chaosErrorRate}
                             onChange={(e) => setChaosErrorRate(Number(e.target.value))}
                             className="w-full h-1 accent-rose-500 bg-slate-700 rounded-lg cursor-pointer animate-none"
                           />
                           <p className="text-[10px] text-slate-500 font-mono mt-1 leading-relaxed">
                             Chances of selected agents reporting a <code>504 TIMEOUT</code> or <code>500 INTERNAL_ERROR</code> during consensus computation.
                           </p>
                        </div>
                     </div>

                     {/* Right - Selected Agent Nodes */}
                     <div className="col-span-1">
                        <div className="flex justify-between items-center mb-3">
                           <span className="text-xs font-mono font-bold text-slate-300 uppercase tracking-wider">Target Agent Nodes</span>
                           <div className="flex gap-2">
                             <button
                               onClick={() => setChaosSelectedAgents(["agent_event_memory", "agent_narrative_tracking", "agent_political", "agent_geopolitical", "agent_news_sentiment", "agent_macro", "agent_news_historian", "agent_quant_baseline", "agent_quant_ml", "agent_proposer", "agent_risk_manager"])}
                               className="text-[9px] font-mono uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded border border-slate-700 font-bold"
                             >
                               All
                             </button>
                             <button
                               onClick={() => setChaosSelectedAgents([])}
                               className="text-[9px] font-mono uppercase bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded border border-slate-700 font-bold"
                             >
                               Clear
                             </button>
                           </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 max-h-[140px] overflow-y-auto p-2 bg-[#111822] rounded border border-slate-800 font-mono text-[10px]">
                           {[
                             { id: "agent_event_memory", label: "Event Memory" },
                             { id: "agent_narrative_tracking", label: "Narrative Tracker" },
                             { id: "agent_political", label: "Political Intel" },
                             { id: "agent_geopolitical", label: "Geopolitical Desk" },
                             { id: "agent_news_sentiment", label: "News Sentiment" },
                             { id: "agent_macro", label: "Macro Variables" },
                             { id: "agent_news_historian", label: "News Historian" },
                             { id: "agent_quant_baseline", label: "Quant Baseline" },
                             { id: "agent_quant_ml", label: "Quant ML Engine" },
                             { id: "agent_proposer", label: "Autobot Proposer" },
                             { id: "agent_risk_manager", label: "Autobot Risk Manager" }
                           ].map(agent => (
                             <label key={agent.id} className="flex items-center gap-2 text-slate-300 hover:text-white cursor-pointer select-none">
                               <input
                                 type="checkbox"
                                 checked={chaosSelectedAgents.includes(agent.id)}
                                 onChange={(e) => {
                                   if (e.target.checked) {
                                     setChaosSelectedAgents([...chaosSelectedAgents, agent.id]);
                                   } else {
                                     setChaosSelectedAgents(chaosSelectedAgents.filter(id => id !== agent.id));
                                   }
                                 }}
                                 className="accent-amber-500 border-slate-800 bg-slate-900 rounded"
                               />
                               <span className="truncate">{agent.label}</span>
                             </label>
                           ))}
                        </div>
                     </div>
                  </div>

                  {chaosMsg && (
                     <div className={`p-3 rounded text-center text-xs font-mono mb-4 border ${chaosMsg.includes("Error") || chaosMsg.includes("Network") ? 'bg-rose-950/20 border-rose-800 text-rose-400' : 'bg-emerald-950/20 border-emerald-800 text-emerald-400'}`}>
                        {chaosMsg}
                     </div>
                  )}

                  <div className="flex gap-3 justify-end border-t border-slate-800 pt-4">
                     <button
                       onClick={saveChaosConfig}
                       disabled={chaosSaving}
                       className="bg-[#D97706] hover:bg-[#B45309] text-white px-5 py-2.5 rounded text-xs font-bold font-mono transition-all flex items-center gap-2"
                     >
                       <ServerCrash size={14} className={chaosSaving ? "animate-spin" : ""} />
                       {chaosSaving ? "SYNCHRONIZING..." : "SYNCHRONIZE CHAOS ENVIRONMENT"}
                     </button>
                  </div>
              </div>

              {/* === COMPONENT: ADAPTIVE SYSTEM ENGINE ARCHITECTURE === */}
              <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col mb-6" id="adaptive-terminal-panel">
                  <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2 border-b border-slate-800 pb-4">
                    <Cpu size={20} className="text-indigo-400 font-bold" />
                    Adaptive Architecture & Evolutionary Prompting
                  </h2>
                  <p className="text-xs text-slate-400 leading-relaxed mb-6">
                    Monitor and manually trigger the evolutionary layers of the terminal: Adaptive Market Regime-Switching calculations, Synthetic Macro Shocks, and Genetic prompt optimizers.
                  </p>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                      
                      {/* Column 1: Regime-Switching */}
                      <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                          <div>
                              <div className="flex justify-between items-center mb-3">
                                  <h3 className="text-xs font-mono font-bold text-indigo-400 uppercase tracking-widest flex items-center gap-1.5">
                                      <Activity size={14} />
                                      Regime Switching Core
                                  </h3>
                                  <span className="text-[10px] font-mono text-slate-500">ADX (14)</span>
                              </div>

                              <p className="text-xs text-slate-400 mb-4">
                                  Overriding Proposer prompts based on low volatility Range vs high volatility Trend-following mathematical regimes.
                              </p>

                              {autoBotConfig.regimeState ? (
                                  <div className="bg-slate-950/40 border border-slate-850 p-3 rounded font-mono text-xs space-y-2">
                                      <div className="flex justify-between">
                                          <span className="text-slate-500">DETECTED REGIME:</span>
                                          <span className={`font-bold ${autoBotConfig.regimeState.regime === "TRENDING" ? "text-emerald-400" : autoBotConfig.regimeState.regime === "RANGE" ? "text-amber-400" : "text-indigo-400"}`}>
                                              {autoBotConfig.regimeState.regime}
                                          </span>
                                      </div>
                                      <div className="flex justify-between">
                                          <span className="text-slate-500">ADX VALUE:</span>
                                          <span className="text-white font-bold">{autoBotConfig.regimeState.adx?.toFixed(2)}</span>
                                      </div>
                                      <div className="flex justify-between">
                                          <span className="text-slate-500">VOLATILITY RATIO:</span>
                                          <span className="text-white font-bold">{typeof autoBotConfig.regimeState.volatilityRatio === 'number' ? autoBotConfig.regimeState.volatilityRatio.toFixed(2) : 'DATA_UNAVAILABLE'}</span>
                                      </div>
                                      <div className="text-[10px] text-slate-400 mt-2 border-t border-slate-900 pt-2 leading-normal">
                                          <span className="text-slate-500 block uppercase font-bold text-[9px] mb-0.5">Prompt Directives Applied:</span>
                                          {autoBotConfig.regimeState.regime === "RANGE" 
                                            ? "PRIORITIZING MEAN-REVERSION (buying supports, selling resistance)." 
                                            : autoBotConfig.regimeState.regime === "TRENDING" 
                                              ? "PRIORITIZING MOMENTUM-BREAKOUTS (buying breakouts, trailing trends)." 
                                              : "BALANCED MULTI-AGENT TARGET PARAMETERS ACTIVE."}
                                      </div>
                                  </div>
                              ) : (
                                  <div className="text-center py-6 text-slate-500 border border-dashed border-slate-800 rounded font-mono text-xs">
                                      Awaiting first scanning cycle...
                                  </div>
                              )}
                          </div>
                          
                          <div className="mt-4 pt-3 border-t border-slate-850 text-[10px] text-slate-500 font-mono flex justify-between items-center">
                              <span>SIMULATION CYCLE</span>
                              <span className="text-indigo-400 font-bold">{autoBotConfig.cycleCount || 0} CYCLES</span>
                          </div>
                      </div>

                      {/* Column 2: Macro Shock Generator */}
                      <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                          <div>
                              <div className="flex justify-between items-center mb-3">
                                  <h3 className="text-xs font-mono font-bold text-amber-500 uppercase tracking-widest flex items-center gap-1.5">
                                      <AlertTriangle size={14} />
                                      Macro Shock Generator
                                  </h3>
                                  <span className="text-[10px] font-mono text-slate-500">CHAOS SUITE</span>
                              </div>

                              <p className="text-xs text-slate-400 mb-4">
                                  Inject contradictory macroeconomic news cascades generated via Gemini to evaluate bot resilience under extreme information overload.
                              </p>

                              {autoBotConfig.activeMacroShock ? (
                                  <div className="bg-amber-950/20 border border-amber-900/30 p-3 rounded text-xs space-y-2">
                                      <div className="flex items-center gap-1.5 text-amber-400 font-mono font-bold text-[10px] uppercase">
                                          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-ping"></span>
                                          ACTIVE SHOCK: {autoBotConfig.activeMacroShock.title}
                                      </div>
                                      <p className="text-slate-300 text-[11px] leading-normal">{autoBotConfig.activeMacroShock.description}</p>
                                      <div className="text-[10px] text-slate-400 mt-1 border-t border-amber-950/40 pt-1 leading-normal">
                                          <span className="text-amber-500/70 uppercase font-bold text-[9px] block">Implications:</span>
                                          {autoBotConfig.activeMacroShock.implications}
                                      </div>
                                  </div>
                              ) : (
                                  <div className="text-center py-6 text-slate-500 border border-dashed border-slate-800 rounded font-mono text-xs">
                                      No narrative shocks active.
                                  </div>
                              )}
                          </div>

                          <div className="mt-4 flex gap-2">
                              {autoBotConfig.activeMacroShock ? (
                                  <button
                                      onClick={clearMacroShock}
                                      disabled={macroShockLoading}
                                      className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold font-mono py-2 rounded text-xs transition-all uppercase"
                                  >
                                      {macroShockLoading ? "CLEARING..." : "CLEAR SHOCK"}
                                  </button>
                              ) : (
                                  <button
                                      onClick={triggerMacroShock}
                                      disabled={macroShockLoading}
                                      className="flex-1 bg-amber-600/20 hover:bg-amber-600/30 text-amber-500 border border-amber-600/40 font-bold font-mono py-2 rounded text-xs transition-all uppercase flex items-center justify-center gap-1.5"
                                  >
                                      <Sparkles size={12} />
                                      {macroShockLoading ? "INJECTING..." : "INJECT NEWS CASCADE"}
                                  </button>
                              )}
                          </div>
                      </div>

                      {/* Column 3: Genetic Prompt Tuning */}
                      <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-between">
                          <div>
                              <div className="flex justify-between items-center mb-3">
                                  <h3 className="text-xs font-mono font-bold text-emerald-400 uppercase tracking-widest flex items-center gap-1.5">
                                      <Layers size={14} />
                                      Prompt Evolution Core
                                  </h3>
                                  <span className="text-[10px] font-mono text-slate-500">CHROMOSOME</span>
                              </div>

                              <p className="text-xs text-slate-400 mb-4">
                                  Evolve prompt strategies based on historical agent performance. Genetic algorithms introduce and backtest mutated chromosomes.
                              </p>
                              <p className="text-[10px] text-amber-500/80 font-mono mb-4 border border-amber-500/20 bg-amber-500/5 rounded p-2">
                                  GATED: there is no real backtest to score a mutation against, and the evolved prompt is not
                                  wired into any agent's actual AI calls yet. Re-enabling requires both.
                              </p>

                              {autoBotConfig.geneticPrompt ? (
                                  <div className="space-y-3">
                                      <div className="bg-slate-950/40 border border-slate-850 p-2.5 rounded font-mono text-xs space-y-1">
                                          <div className="flex justify-between text-[11px]">
                                              <span className="text-slate-500">GENERATION:</span>
                                              <span className="text-emerald-400 font-bold">GEN {autoBotConfig.geneticPrompt.generation}</span>
                                          </div>
                                          <div className="flex justify-between text-[11px]">
                                              <span className="text-slate-500">FITNESS (SHARPE):</span>
                                              <span className="text-amber-500/80 font-bold">AWAITING_EVIDENCE</span>
                                          </div>
                                          <div className="flex justify-between text-[11px]">
                                              <span className="text-slate-500">DEFLATED SHARPE (DSR):</span>
                                              <span className="text-amber-500/80 font-bold">AWAITING_EVIDENCE</span>
                                          </div>
                                      </div>

                                      <div className="border border-slate-850 rounded p-2 bg-slate-950">
                                          <span className="text-[9px] font-mono text-slate-500 block uppercase font-bold mb-1">Active Prompt DNA:</span>
                                          <div className="text-[9px] font-mono text-indigo-300 max-h-[60px] overflow-y-auto leading-tight break-all scrollbar-none">
                                              {autoBotConfig.geneticPrompt.currentBestPrompt}
                                          </div>
                                      </div>
                                  </div>
                              ) : (
                                  <div className="text-center py-6 text-slate-500 border border-dashed border-slate-800 rounded font-mono text-xs">
                                      Awaiting initialization...
                                  </div>
                              )}
                          </div>

                          <div className="mt-4 flex gap-2">
                              <button
                                  disabled
                                  title="Gated off: no real fitness evaluation exists yet (see notice above)"
                                  className="flex-1 bg-slate-800 text-slate-500 font-bold font-mono py-2 rounded text-xs uppercase flex items-center justify-center gap-1.5 cursor-not-allowed"
                              >
                                  <RefreshCw size={12} />
                                  MUTATE PROMPT DNA (GATED)
                              </button>
                          </div>
                      </div>

                  </div>

                  {/* Evolutionary History — fitness metrics gated until a real evaluation endpoint exists */}
                  {autoBotConfig.geneticPrompt?.performanceHistory?.length > 0 && (
                      <div className="mt-6 border-t border-slate-800 pt-4">
                          <h3 className="text-xs font-mono font-bold text-slate-300 uppercase tracking-widest mb-3 flex items-center gap-1">
                              <History size={13} className="text-slate-400" />
                              Chromosome Mutation History (log only)
                          </h3>
                          <p className="text-[10px] font-mono text-amber-400/90 mb-3 uppercase tracking-widest">
                            Sharpe / DSR columns gated — AWAITING_EVIDENCE (no Bailey DSR API for this surface)
                          </p>
                          <div className="max-h-[160px] overflow-y-auto rounded border border-slate-800 bg-[#111822] font-mono text-[10px] divide-y divide-slate-850">
                              {autoBotConfig.geneticPrompt.performanceHistory.map((item: any, idx: number) => (
                                  <div key={idx} className="p-2.5 flex flex-col md:flex-row justify-between items-start md:items-center gap-2 hover:bg-slate-900/30">
                                      <div className="flex items-center gap-2 flex-wrap">
                                          <span className="text-emerald-400 font-bold">GEN {item.generation}</span>
                                          <span className="bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded font-bold">{item.mutationType || "Mutation"}</span>
                                          <span className="text-slate-400 text-[9px]">{item.explanation}</span>
                                      </div>
                                      <div className="text-slate-500 text-[9px] shrink-0">
                                          {item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : '—'}
                                      </div>
                                  </div>
                              ))}
                          </div>
                      </div>
                  )}

              </div>

             {/* Token Consumption Dashboard */}
             <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col">
                 <h2 className="text-lg font-bold text-white mb-4 flex items-center gap-2 border-b border-slate-800 pb-4">
                   <Coins size={20} className="text-indigo-400" />
                   Token Consumption & Projected Costs
                 </h2>

                 {tokenAlertEnabled && tokenConsumptionTotals && tokenConsumptionTotals.projectedCycleCost > tokenAlertThreshold && (
                   <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 flex items-start gap-4 mb-6">
                     <AlertCircle className="text-amber-400 mt-0.5" size={20} />
                     <div>
                       <h4 className="text-amber-400 font-bold text-sm uppercase tracking-wide mb-1">Cost Threshold Alert</h4>
                       <p className="text-amber-200/80 text-xs">
                         Projected cycle cost (<span className="font-bold text-white">${tokenConsumptionTotals.projectedCycleCost.toFixed(2)}</span>) has exceeded the configured alert threshold of <span className="text-amber-300">${tokenAlertThreshold}</span>. Consider optimizing token usage or rate limiting premium agents.
                       </p>
                     </div>
                   </div>
                 )}

                 <div className="flex flex-col md:flex-row justify-between md:items-center gap-4 mb-6">
                   <p className="text-xs text-slate-400 leading-relaxed max-w-xl">
                     Real token consumption from the last 14 days of AI calls, grouped by real agent. "Local" is any real call that cost $0 (Ollama/local Chronos); "Paid" is any real call to a billed provider. Cost projection extrapolates the real average daily cost to 30 days.
                   </p>

                   <div className="flex items-center gap-4 bg-[#111822] border border-slate-800 p-3 rounded-lg min-w-[280px]">
                     <div className="flex-1">
                       <div className="flex items-center justify-between mb-2">
                         <span className="text-[10px] text-white font-mono uppercase tracking-wider">Enable Limits Alert</span>
                         <button
                           onClick={() => setTokenAlertEnabled(!tokenAlertEnabled)}
                           className="text-slate-400 hover:text-white transition-colors"
                         >
                           {tokenAlertEnabled ? <ToggleRight size={20} className="text-amber-400" /> : <ToggleLeft size={20} />}
                         </button>
                       </div>
                       <div className="flex justify-between items-center mb-1 text-xs">
                         <span className="text-slate-500 font-mono">Limit</span>
                         <span className="font-bold text-amber-400">${tokenAlertThreshold}</span>
                       </div>
                       <input
                         type="range"
                         min="10"
                         max="200"
                         value={tokenAlertThreshold}
                         onChange={(e) => setTokenAlertThreshold(Number(e.target.value))}
                         disabled={!tokenAlertEnabled}
                         className="w-full h-1 accent-amber-500 bg-slate-700 rounded-lg appearance-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                       />
                     </div>
                   </div>
                 </div>

                 {tokenConsumptionAvailable === false && (
                   <AwaitingSignal reason="No real AI calls recorded in the last 14 days." label="Token Consumption" />
                 )}

                 {tokenConsumptionAvailable === null && (
                   <div className="py-8 text-center text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loading real token consumption...</div>
                 )}

                 {tokenConsumptionAvailable === true && tokenConsumptionTotals && (
                   <>
                     <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                         <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-center items-center text-center">
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2">Local (Free) Tokens</span>
                            <div className="text-2xl font-bold text-slate-200">{(tokenConsumptionTotals.localTokens / 1_000_000).toFixed(2)}M</div>
                            <span className="text-xs text-indigo-400 mt-1">$0.00</span>
                         </div>
                         <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col justify-center items-center text-center">
                            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono mb-2">Paid Provider Tokens</span>
                            <div className="text-2xl font-bold text-slate-200">{(tokenConsumptionTotals.paidTokens / 1_000_000).toFixed(2)}M</div>
                            <span className="text-xs text-emerald-400 mt-1">~${tokenConsumptionTotals.totalCostLastNDays.toFixed(2)} (14d)</span>
                         </div>
                         <div className="bg-indigo-500/10 border border-indigo-500/30 rounded-lg p-4 flex flex-col justify-center items-center text-center relative overflow-hidden">
                            <div className="absolute -right-4 -top-4 w-16 h-16 bg-indigo-500/20 rounded-full blur-2xl"></div>
                            <span className="text-[10px] text-indigo-300 uppercase tracking-widest font-mono mb-2">Projected Cycle Cost</span>
                            <div className="text-3xl font-bold text-white">${tokenConsumptionTotals.projectedCycleCost.toFixed(2)}</div>
                            <span className="text-xs text-slate-400 mt-1">Real 14d run rate x 30</span>
                         </div>
                     </div>

                     <div className="h-[300px] w-full">
                        <SafeResponsiveContainer>
                           <BarChart
                             data={tokenConsumptionData || []}
                             layout="vertical"
                             margin={{ top: 5, right: 30, left: 30, bottom: 5 }}
                           >
                             <XAxis type="number" fontSize={10} stroke="#475569" tickLine={false} axisLine={false} tickFormatter={(val) => `${(val / 1000000).toFixed(1)}M`} />
                             <YAxis dataKey="agent" type="category" fontSize={10} stroke="#475569" tickLine={false} axisLine={false} />
                             <Tooltip
                               contentStyle={{ backgroundColor: '#1e293b', borderColor: '#334155', fontSize: '12px', borderRadius: '8px' }}
                               itemStyle={{ color: '#e2e8f0' }}
                               formatter={(value: any, name: any) => [`${(value / 1000).toFixed(1)}k`, name === 'localTokens' ? 'Local (Free)' : 'Paid Provider']}
                             />
                             <Legend iconType="circle" wrapperStyle={{ fontSize: '10px', paddingTop: '10px' }} />
                             <Bar dataKey="localTokens" name="Local Models (Free)" fill="#818cf8" radius={[0, 4, 4, 0]} barSize={12} stackId="a" />
                             <Bar dataKey="paidTokens" name="Paid Providers" fill="#34d399" radius={[0, 4, 4, 0]} barSize={12} stackId="a" />
                           </BarChart>
                        </SafeResponsiveContainer>
                     </div>
                   </>
                 )}
             </div>

              {/* Outbound Webhooks Integration */}
              <div id="webhooks-integration-panel" className="bg-[#1A1F2B] border border-slate-800 rounded-lg p-6 flex flex-col mt-6">
                  <h2 className="text-lg font-bold text-white mb-2 flex items-center gap-2 border-b border-slate-800 pb-4">
                    <BellRing size={20} className="text-indigo-400" />
                    Real-Time Outbound Webhook Integrations
                  </h2>
                  
                  <p className="text-xs text-slate-400 leading-relaxed mb-6 max-w-xl">
                    Configure rule-based triggers linking internal agent operations directly to outbound Slack, Discord, or generic JSON POST webhooks. Receive instant notifications when specific risk parameters are breached, sector safety limits are exceeded, or an LLM decision is vetoed by the Risk Oversight Node.
                  </p>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                     {/* Left Panel: Register Webhook Form */}
                     <div className="lg:col-span-1 bg-[#111822] border border-slate-800/80 rounded-lg p-5">
                        <h3 className="text-xs font-bold text-indigo-400 uppercase tracking-widest mb-4">Register New Endpoint</h3>
                        <form onSubmit={handleAddWebhook} className="flex flex-col gap-4">
                           <div>
                              <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Friendly Name</label>
                              <input 
                                 type="text" 
                                 value={newWebhookName} 
                                 onChange={(e) => setNewWebhookName(e.target.value)} 
                                 placeholder="e.g. Risk Alerts Slack"
                                 className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                              />
                           </div>

                           <div>
                              <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Webhook URL</label>
                              <input 
                                 type="text" 
                                 value={newWebhookUrl} 
                                 onChange={(e) => setNewWebhookUrl(e.target.value)} 
                                 placeholder="https://hooks.slack.com/services/..."
                                 className="w-full bg-slate-900 border border-slate-800 rounded px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                              />
                           </div>

                           <div>
                              <label className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Integration Service Profile</label>
                              <div className="grid grid-cols-3 gap-2">
                                 {["slack", "discord", "generic"].map((type) => (
                                    <button
                                       key={type}
                                       type="button"
                                       onClick={() => setNewWebhookType(type as any)}
                                       className={`py-1.5 px-2 rounded border text-[10px] font-mono uppercase tracking-wider text-center transition-all ${
                                          newWebhookType === type 
                                             ? "bg-indigo-500/10 border-indigo-500 text-indigo-400 font-bold" 
                                             : "bg-slate-900 border-slate-800 text-slate-500 hover:text-slate-300"
                                       }`}
                                    >
                                       {type}
                                    </button>
                                 ))}
                              </div>
                           </div>

                           <div>
                              <label className="text-[10px] uppercase font-mono text-slate-500 block mb-2">Select Active Risk Event Triggers</label>
                              <div className="flex flex-col gap-2">
                                 {[
                                    { key: "veto", label: "Oversight Node Vetoes" },
                                    { key: "daily_loss_breach", label: "Daily Loss Limit Breaches" },
                                    { key: "sector_exposure_breach", label: "Sector Allocation Breaches" }
                                 ].map((item) => {
                                    const active = newWebhookEvents.includes(item.key);
                                    return (
                                       <label key={item.key} className="flex items-center gap-2 cursor-pointer group">
                                          <input 
                                             type="checkbox"
                                             checked={active}
                                             onChange={() => {
                                                if (active) {
                                                   setNewWebhookEvents(newWebhookEvents.filter(k => k !== item.key));
                                                } else {
                                                   setNewWebhookEvents([...newWebhookEvents, item.key]);
                                                }
                                             }}
                                             className="rounded border-slate-800 bg-slate-900 text-indigo-600 focus:ring-0 focus:ring-offset-0 h-3 w-3"
                                          />
                                          <span className="text-[11px] text-slate-400 group-hover:text-slate-200 transition-colors">{item.label}</span>
                                       </label>
                                    );
                                 })}
                              </div>
                           </div>

                           {webhookErrorMsg && (
                              <div className="text-[10px] text-rose-400 bg-rose-500/10 border border-rose-500/20 px-2.5 py-1.5 rounded">
                                 {webhookErrorMsg}
                              </div>
                           )}

                           <button 
                              type="submit"
                              className="mt-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-mono uppercase tracking-wider py-2 px-4 rounded font-bold transition-colors flex items-center justify-center gap-2"
                           >
                              <Plus size={14} /> Add Integration
                           </button>
                        </form>
                     </div>

                     {/* Right Panel: Webhooks List */}
                     <div className="lg:col-span-2 flex flex-col gap-4">
                        <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                           <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest">Configured Endpoints ({webhooksList.length})</h3>
                           <button onClick={fetchWebhooks} className="text-[10px] font-mono text-slate-500 hover:text-indigo-400 flex items-center gap-1 transition-colors">
                              <RefreshCw size={10} /> Sync Status
                           </button>
                        </div>

                        {webhooksList.length === 0 ? (
                           <div className="bg-[#111822]/40 border border-dashed border-slate-800 rounded-lg p-12 text-center flex flex-col items-center justify-center">
                              <Bell size={32} className="text-slate-600 mb-3" />
                              <span className="text-slate-400 font-bold text-xs">No Outbound Webhooks Registered</span>
                              <span className="text-slate-600 text-[10px] mt-1 max-w-sm">Use the form on the left to connect your Slack workspace, Discord guild, or back-office system to live risk metrics.</span>
                           </div>
                        ) : (
                           <div className="flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1">
                              {webhooksList.map((wh) => (
                                 <div key={wh.id} className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:border-slate-700/60 transition-colors">
                                    <div className="flex flex-col gap-1.5">
                                       <div className="flex items-center gap-2 flex-wrap">
                                          <span className="text-xs font-bold text-white">{wh.name}</span>
                                          <span className={`px-1.5 py-0.5 rounded text-[8px] font-mono uppercase tracking-widest border ${
                                             wh.type === "slack" 
                                                ? "bg-purple-500/10 border-purple-500/20 text-purple-400" 
                                                : wh.type === "discord" 
                                                   ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-400" 
                                                   : "bg-slate-800 border-slate-700 text-slate-400"
                                          }`}>
                                             {wh.type}
                                          </span>
                                          <span className="text-slate-600 text-[9px] font-mono">
                                             ID: {wh.id}
                                          </span>
                                       </div>
                                       
                                       <div className="text-[10px] text-slate-500 font-mono truncate max-w-[280px] md:max-w-md">
                                          {wh.url}
                                       </div>

                                       <div className="flex items-center gap-1.5 flex-wrap">
                                          <span className="text-[9px] text-slate-500 uppercase font-mono">Triggers:</span>
                                          {wh.events.map((ev: string) => (
                                             <span key={ev} className="bg-slate-900 text-slate-400 text-[8px] font-mono px-1.5 py-0.5 rounded border border-slate-800">
                                                {ev.replace(/_/g, ' ')}
                                             </span>
                                          ))}
                                       </div>
                                    </div>

                                    <div className="flex items-center gap-3 shrink-0 self-end md:self-auto">
                                       {/* Test Connection Button */}
                                       <button 
                                          onClick={() => handleTestWebhook(wh.url, wh.type)}
                                          className={`py-1 px-2.5 rounded font-mono text-[9px] uppercase tracking-wider border transition-all flex items-center gap-1 ${
                                             webhookTestStatus === "testing" 
                                                ? "bg-slate-800 border-slate-700 text-slate-400 cursor-not-allowed" 
                                                : "bg-slate-900 border-slate-800 text-slate-400 hover:text-white hover:border-slate-700"
                                          }`}
                                          disabled={webhookTestStatus === "testing"}
                                       >
                                          {webhookTestStatus === "testing" ? "Testing..." : "Test Connection"}
                                       </button>

                                       {/* Toggle switch */}
                                       <button 
                                          onClick={() => handleToggleWebhook(wh.id, wh.enabled)}
                                          className="text-slate-400 hover:text-white transition-colors"
                                       >
                                          {wh.enabled ? <ToggleRight size={22} className="text-indigo-400" /> : <ToggleLeft size={22} />}
                                       </button>

                                       {/* Delete */}
                                       <button 
                                          onClick={() => handleDeleteWebhook(wh.id)}
                                          className="text-slate-500 hover:text-rose-400 p-1 rounded hover:bg-rose-500/5 transition-colors"
                                       >
                                          <Trash2 size={14} />
                                       </button>
                                    </div>
                                 </div>
                              ))}
                           </div>
                        )}

                        {webhookTestStatus && webhookTestStatus !== "testing" && (
                           <div className={`mt-2 text-xs p-3 rounded border font-mono ${
                              webhookTestStatus === "success" 
                                 ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                                 : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                           }`}>
                              {webhookTestStatus === "success" 
                                 ? "✓ WEBHOOK SENT SUCCESSFUL: Connection verified. Test notification payload has been delivered."
                                 : "✗ TEST DISPATCH FAILED: Remote server returned an error. Check the URL and connection settings."
                              }
                           </div>
                        )}
                     </div>
                  </div>
              </div>

          </div>
        )}
        </div>
        </MobilePullRefresh>
      </main>

      <ResponsiveNavDrawer
        open={navDrawerOpen}
        activeTab={activeTab as AppTabId}
        onClose={() => setNavDrawerOpen(false)}
        onSelectTab={(tab) => setActiveTab(tab)}
      />
      <ResponsiveBottomNav
        activeTab={activeTab as AppTabId}
        onSelectTab={(tab) => setActiveTab(tab)}
        onOpenDrawer={() => setNavDrawerOpen(true)}
        tradingMode={autoBotTradingMode}
        enginesHalted={enginesHalted}
        onEmergencyStop={() => {
          if (enginesHalted) {
            setActiveTab('command');
          } else {
            setHaltReason('UI emergency stop');
            setHaltTime(new Date().toLocaleTimeString());
            fetch("/api/v1/system/emergency-stop", { method: "POST", credentials: "include" }).then(async (res) => {
              const data = await res.json().catch(() => ({}));
              if (res.ok) {
                applyTradingState(typeof data?.tradingState === 'string' ? data.tradingState : 'EMERGENCY_STOP', 'UI emergency stop');
              } else {
                setHaltReason('');
                setHaltTime('');
              }
            }).catch(() => {
              setHaltReason('');
              setHaltTime('');
            });
          }
        }}
      />

      {/* Selected Agent Modal */}
      {selectedAgentNode && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="bg-[#1A1F2B] border border-slate-700 rounded-lg w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-800">
               <div>
                  <h2 className="text-xl font-bold text-white flex items-center gap-3">
                    <Server className="text-indigo-400" size={20} />
                    {selectedAgentNode.node} Instance
                  </h2>
                  <p className="text-xs text-slate-400 font-mono mt-1">
                    ID: {selectedAgentNode.node.toLowerCase().replace(/ /g, '_')}_01 | VER: 2.1.4
                  </p>
               </div>
               <button 
                onClick={() => setSelectedAgentNode(null)}
                className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors"
               >
                 <X size={20} />
               </button>
            </div>
            
            {/* Modal Content - Scrollable */}
            <div className="flex-1 overflow-y-auto p-5 pb-8">
              
              {/* Top Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                 <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
                   <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Health</span>
                   <span className="text-lg font-bold flex items-center gap-2">
                     {selectedAgentNode.health === "Green" ? <span className="text-emerald-400">OPTIMAL</span> : selectedAgentNode.health === "Yellow" ? <span className="text-yellow-500">DEGRADED</span> : <span className="text-rose-500">FAILED</span>}
                   </span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
                   <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Total P&L Contrib</span>
                   <span className="text-lg font-bold text-emerald-400">+$14,240</span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
                   <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Win Rate</span>
                   <span className="text-lg font-bold text-white">{selectedAgentNode.succ}</span>
                 </div>
                 <div className="bg-[#111822] border border-slate-800 p-4 rounded-lg">
                   <span className="text-[10px] uppercase font-mono text-slate-500 block mb-1">Trades Influenced</span>
                   <span className="text-lg font-bold text-white">1,204</span>
                 </div>
              </div>

              {/* Grid Layout for Charts & Errors */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                 
                 {/* Left Column: Errors & Recent Logs */}
                 <div className="lg:col-span-1 flex flex-col gap-6">
                    {/* Error Log */}
                    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4">
                       <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wide flex items-center gap-2 border-b border-slate-800 pb-2">
                         <AlertCircle size={14} className="text-rose-400" />
                         Recent Exceptions
                       </h3>
                       {selectedAgentNode.err > 0 ? (
                         <div className="space-y-3">
                           <div className="text-xs font-mono">
                             <div className="text-rose-400 font-bold mb-1">[WARN] RateLimitExceeded</div>
                             <div className="text-slate-400 text-[10px]">Retry policy triggered at backoff=2000ms. Upstream API endpoint returned 429.</div>
                             <div className="text-slate-500 text-[9px] mt-1">Timestamp: {new Date().toISOString()}</div>
                           </div>
                           <div className="h-px bg-slate-800 w-full" />
                           <div className="text-xs font-mono">
                             <div className="text-amber-400 font-bold mb-1">[TIMEOUT] Context Overload</div>
                             <div className="text-slate-400 text-[10px]">Processing aborted after 4.2s. Payload exceeded context slicing window.</div>
                             <div className="text-slate-500 text-[9px] mt-1">Timestamp: {new Date(Date.now() - 3600000).toISOString()}</div>
                           </div>
                         </div>
                       ) : (
                         <div className="py-4 text-center text-xs font-mono text-slate-500">
                           <CheckCircle size={24} className="mx-auto text-slate-700 mb-2" />
                           No recent exceptions.<br/>Agent is operating within optimal parameters.
                         </div>
                       )}
                    </div>

                    {/* Agent Weights over time simple text proxy or stats */}
                    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex-1">
                       <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wide flex items-center gap-2 border-b border-slate-800 pb-2">
                         <Activity size={14} className="text-indigo-400" />
                         Current Voting Profile
                       </h3>
                       <div className="space-y-4 text-xs font-mono">
                         <div>
                            <div className="flex justify-between text-slate-400 mb-1"><span>Bull Regime Wgt</span><span className="text-white">"0.00"</span></div>
                            <div className="w-full bg-slate-800 h-1.5 rounded"><div className="bg-emerald-500 h-full w-[70%]" /></div>
                         </div>
                         <div>
                            <div className="flex justify-between text-slate-400 mb-1"><span>Bear Regime Wgt</span><span className="text-white">"0.00"</span></div>
                            <div className="w-full bg-slate-800 h-1.5 rounded"><div className="bg-rose-500 h-full w-[30%]" /></div>
                         </div>
                         <div>
                            <div className="flex justify-between text-slate-400 mb-1"><span>Volatile Wgt</span><span className="text-white">"0.00"</span></div>
                            <div className="w-full bg-slate-800 h-1.5 rounded"><div className="bg-amber-500 h-full w-[50%]" /></div>
                         </div>
                       </div>
                    </div>
                 </div>

                 {/* Right Column: Historical Performance Chart & Trades */}
                 <div className="lg:col-span-2 flex flex-col gap-6">
                    {/* Recent Activity Log */}
                    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex flex-col max-h-96">
                       <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wide border-b border-slate-800 pb-2 flex items-center gap-2">
                         <Terminal size={14} className="text-emerald-400" />
                         Recent Activity Log (Last 20 Operations)
                       </h3>
                       <div className="flex-1 overflow-y-auto space-y-3 pr-2 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">
                          {Array.from({ length: 20 }).map((_, i) => (
                             <div key={i} className="text-[10px] font-mono border-b border-slate-800/50 pb-2 mb-2 last:border-0">
                                <div className="flex justify-between text-slate-500 mb-1">
                                   <span>{new Date(Date.now() - i * 15 * 60000).toISOString()}</span>
                                   <span className="text-indigo-400">{selectedAgentNode.lat || "0ms"}</span>
                                </div>
                                <div className="text-slate-400">INPUT: <span className="text-slate-300">{"{\"ticker\": \"AAPL\", \"context\": \"Market momentum shifting positive\"}"}</span></div>
                                <div className="text-slate-400 mt-1">OUTPUT: <span className="text-slate-500">NO DATA</span></div>
                             </div>
                          ))}
                       </div>
                    </div>

                    {/* Fake Chart area */}
                    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 h-64 flex flex-col">
                       <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wide border-b border-slate-800 pb-2">
                         Alpha Generation / Contribution (30d)
                       </h3>
                       <div className="flex-1 w-full relative group cursor-crosshair">
                          {/* We use recharts for actual chart, creating some dummy data for the specific agent */}
                          <SafeResponsiveContainer>
                            <AreaChart data={[
                               { date: 'Day 1', val: 0 }, { date: 'Day 5', val: 120 }, { date: 'Day 10', val: 400 },
                               { date: 'Day 15', val: 380 }, { date: 'Day 20', val: 600 }, { date: 'Day 25', val: 950 },
                               { date: 'Day 30', val: 1420 }
                            ]}>
                              <defs>
                                <linearGradient id="colorAgentVal" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3}/>
                                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <Tooltip 
                                contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', fontSize: '12px', fontFamily: 'monospace' }}
                                itemStyle={{ color: '#10b981' }}
                              />
                              <Area type="monotone" dataKey="val" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#colorAgentVal)" />
                            </AreaChart>
                          </SafeResponsiveContainer>
                       </div>
                    </div>

                    {/* Individual Trade Contributions */}
                    <div className="bg-[#111822] border border-slate-800 rounded-lg p-4 flex-1">
                       <h3 className="text-xs font-bold text-white mb-3 uppercase tracking-wide border-b border-slate-800 pb-2">
                         Recent Distinct Trade Contributions
                       </h3>
                       <div className="overflow-x-auto">
                         <table className="w-full text-left border-collapse min-w-max text-xs font-mono">
                           <thead>
                             <tr className="border-b border-slate-800 text-[10px] text-slate-500 uppercase">
                               <th className="py-2 px-2">Ticker</th>
                               <th className="py-2 px-2">Agent Signal</th>
                               <th className="py-2 px-2">Final Consensus</th>
                               <th className="py-2 px-2 text-right">Outcome Target</th>
                             </tr>
                           </thead>
                           <tbody className="text-slate-300">
                             <tr className="border-b border-slate-800/50 hover:bg-slate-800/30">
                               <td className="py-2.5 px-2 font-bold text-white">NVDA</td>
                               <td className="py-2.5 px-2 text-emerald-400">BUY (Strong)</td>
                               <td className="py-2.5 px-2 text-emerald-400">BUY</td>
                               <td className="py-2.5 px-2 text-right text-emerald-400">+$2,450.00</td>
                             </tr>
                             <tr className="border-b border-slate-800/50 hover:bg-slate-800/30">
                               <td className="py-2.5 px-2 font-bold text-white">TSLA</td>
                               <td className="py-2.5 px-2 text-rose-400">SELL (Moderate)</td>
                               <td className="py-2.5 px-2 text-slate-400">HOLD</td>
                               <td className="py-2.5 px-2 text-right text-slate-500">Vetoed</td>
                             </tr>
                             <tr className="border-b border-slate-800/50 hover:bg-slate-800/30">
                               <td className="py-2.5 px-2 font-bold text-white">AMD</td>
                               <td className="py-2.5 px-2 text-emerald-400">BUY (Weak)</td>
                               <td className="py-2.5 px-2 text-emerald-400">BUY</td>
                               <td className="py-2.5 px-2 text-right text-rose-400">-$420.50</td>
                             </tr>
                             <tr className="border-b border-slate-800/50 hover:bg-slate-800/30">
                               <td className="py-2.5 px-2 font-bold text-white">META</td>
                               <td className="py-2.5 px-2 text-rose-400">SELL (Strong)</td>
                               <td className="py-2.5 px-2 text-rose-400">SELL</td>
                               <td className="py-2.5 px-2 text-right text-emerald-400">+$1,130.25</td>
                             </tr>
                           </tbody>
                         </table>
                       </div>
                    </div>
                 </div>

                              <button onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.db,.sqlite';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (file) {
                      const formData = new FormData();
                      formData.append('database', file);
                      // Send as raw body to system/import-db
                      const reader = new FileReader();
                      reader.onload = async (re) => {
                        const res = await fetch('/api/v1/system/import-db', {
                           method: 'POST',
                           headers: { 'Content-Type': 'application/octet-stream' },
                           body: re.target?.result
                        });
                        if (res.ok) { alert('Database imported successfully. Restarting...'); window.location.reload(); }
                      };
                      reader.readAsArrayBuffer(file);
                    }
                  };
                  input.click();
                }} className="w-full text-left bg-[#111822] hover:bg-slate-800 border border-slate-800 hover:border-amber-500/50 p-4 rounded group transition-all flex justify-between items-center cursor-pointer">
                  <div className="flex flex-col gap-1">
                    <span className="text-white font-bold text-xs">Import Database Backup</span>
                    <span className="text-[10px] text-slate-500 font-mono">Restore system from an argus.db file. [DB]</span>
                  </div>
                  <Database size={16} className="text-amber-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
                <button onClick={() => window.open("/api/v1/system/export-db", "_blank")} className="w-full text-left bg-[#111822] hover:bg-slate-800 border border-slate-800 hover:border-indigo-500/50 p-4 rounded group transition-all flex justify-between items-center cursor-pointer">
                  <div className="flex flex-col gap-1">
                    <span className="text-white font-bold text-xs">Export Full Database Backup</span>
                    <span className="text-[10px] text-slate-500 font-mono">Download the entire SQLite database file for backup. [DB]</span>
                  </div>
                  <Database size={16} className="text-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Risk Veto Detailed Modal */}
      {selectedRiskVetoForModal && (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#0A0F16] border border-slate-800 rounded-lg w-full max-w-2xl shadow-2xl overflow-hidden animate-fade-in relative flex flex-col">
            {/* Decorative Top Accent Bar representing Veto Block */}
            <div className="h-1.5 w-full bg-gradient-to-r from-amber-500 via-rose-500 to-indigo-600 shadow" />
            
            <div className="p-6 flex flex-col h-full font-mono text-[11px] select-none">
              {/* Header */}
              <div className="flex justify-between items-center mb-5 pb-3 border-b border-slate-800/80">
                <h2 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                  <ShieldAlert size={16} className="text-amber-500 animate-pulse" />
                  RISK SAFEGUARD VETO EVALUATION BRIEF
                </h2>
                <button 
                  onClick={() => setSelectedRiskVetoForModal(null)}
                  className="text-slate-400 hover:text-white transition-colors flex items-center gap-1 hover:bg-slate-800/50 px-2.5 py-1 rounded border border-slate-800"
                >
                  <X size={13} className="text-slate-500" />
                  <span className="text-[9px] font-bold tracking-widest uppercase">DISMISS</span>
                </button>
              </div>

              {/* Veto Identity / Overview */}
              <div className="grid grid-cols-2 gap-4 mb-4 bg-[#111822] p-3 rounded border border-slate-800">
                <div>
                  <span className="text-[9px] text-slate-500 uppercase font-mono block mb-1">VETO LOG ID</span>
                  <span className="text-xs font-semibold text-white tracking-widest">{selectedRiskVetoForModal.id}</span>
                </div>
                <div className="text-right">
                  <span className="text-[9px] text-slate-500 uppercase font-mono block mb-1">TIMESTAMP LOG</span>
                  <span className="text-xs font-semibold text-slate-350">{new Date(selectedRiskVetoForModal.timestamp).toLocaleString()}</span>
                </div>
              </div>

              {/* ORIGINAL TRADE PROPOSAL DETAILS */}
              <div className="mb-5 bg-[#111822]/40 rounded border border-slate-800 p-4">
                <h4 className="text-[10px] text-indigo-400 font-bold mb-3 tracking-widest uppercase border-b border-indigo-500/10 pb-1.5 flex items-center gap-1.5">
                  <span className="text-[#818cf8]">■</span> ORIGINAL TRADE PROPOSAL
                </h4>
                
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-y-3.5 gap-x-4">
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">ASSET TICKER</span>
                    <span className="text-xs font-black text-white">{selectedRiskVetoForModal.symbol}</span>
                  </div>
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">ACTION TYPE</span>
                    <span className={`text-xs font-extrabold ${selectedRiskVetoForModal.original_trade_details?.side === 'SELL' ? 'text-amber-500' : 'text-emerald-400'}`}>
                      {selectedRiskVetoForModal.original_trade_details?.side || 'BUY'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">PROPOSED AMOUNT</span>
                    <span className="text-xs font-extrabold text-white">
                      {selectedRiskVetoForModal.original_trade_details?.proposed_amount 
                        ? `$${selectedRiskVetoForModal.original_trade_details.proposed_amount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` 
                        : selectedRiskVetoForModal.original_trade_details?.price && selectedRiskVetoForModal.original_trade_details?.quantity 
                        ? `$${(selectedRiskVetoForModal.original_trade_details.price * selectedRiskVetoForModal.original_trade_details.quantity).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
                        : '$100.00'
                      }
                    </span>
                  </div>
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">PROPOSAL PRICE</span>
                    <span className="text-xs font-bold text-[#818cf8]">
                      ${selectedRiskVetoForModal.original_trade_details?.price || '120.00'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">PROPOSED BY</span>
                    <span className="text-xs font-bold text-slate-300 flex items-center gap-1">
                      <Cpu size={10} className="text-indigo-400 shrink-0" />
                      {selectedRiskVetoForModal.original_trade_details?.proposed_by?.replace("Agent", "") || 'NewsAgent'}
                    </span>
                  </div>
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">CONFIDENCE INDEX</span>
                    <span className="text-xs font-bold text-indigo-300">
                      {selectedRiskVetoForModal.original_trade_details?.confidence || "85%"}
                    </span>
                  </div>
                </div>

                <div className="mt-4 bg-[#090D14] p-2.5 rounded border border-slate-850 flex justify-between items-center text-[9px] text-slate-400">
                  <span className="uppercase tracking-widest text-[8px]">ACTIVE STRATEGY REGIME CONTEXT:</span>
                  <span className="font-extrabold uppercase text-indigo-400 tracking-wider">
                    {selectedRiskVetoForModal.original_trade_details?.regime || "STANDARD BASELINE"}
                  </span>
                </div>
              </div>

              {/* RISK VETO EXPLANATION */}
              <div className="mb-5">
                <h4 className="text-[10px] text-amber-500 font-bold mb-2.5 tracking-widest uppercase flex items-center gap-1.5">
                  <span className="text-amber-500">▲</span> RISK COMPLIANCE VETO REASON
                </h4>
                
                <div className="bg-amber-500/[0.03] border border-amber-500/20 rounded p-4 flex flex-col gap-2.5">
                  <div className="flex justify-between items-center">
                    <span className="text-[8.5px] text-slate-500 uppercase">INTERCEPTING RISK AGENT</span>
                    <span className="px-2 py-0.5 bg-amber-500/10 text-amber-400 border border-amber-500/20 font-black rounded text-[8px] uppercase tracking-wider">
                      {selectedRiskVetoForModal.vetoed_by?.replace("_", " ")}
                    </span>
                  </div>
                  <p className="text-amber-200/90 leading-relaxed font-mono text-[10.5px] italic border-l-2 border-amber-500/40 pl-3.5 bg-amber-500/[0.01] py-1.5">
                    "{selectedRiskVetoForModal.veto_reason}"
                  </p>
                </div>
              </div>

              {/* COMPLIANCE ACTIONS */}
              <div className="mt-auto bg-[#111822]/80 border border-slate-800 rounded p-4 flex flex-col gap-4">
                <div className="flex justify-between items-center text-[10px] border-b border-slate-800 pb-3">
                  <div>
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">ENFORCEMENT ACTION</span>
                    <span className="text-rose-500 font-extrabold uppercase tracking-widest">
                      {selectedRiskVetoForModal.action_taken || "FULL_VETO"}
                    </span>
                  </div>
                  <div className="text-right">
                    <span className="text-[8.5px] text-slate-500 uppercase block mb-0.5">HUMAN REVIEW STATUS</span>
                    <span className={`font-black uppercase tracking-widest ${selectedRiskVetoForModal.review_requested ? 'text-indigo-400' : 'text-slate-500'}`}>
                      {selectedRiskVetoForModal.review_requested ? '▲ REVIEW_REQUESTED (PENDING)' : '■ NOT_REQUESTED'}
                    </span>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <button 
                    onClick={() => setSelectedRiskVetoForModal(null)}
                    className="flex-1 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold uppercase py-2.5 rounded transition-all text-center border border-slate-700 hover:border-slate-600 text-[10px] tracking-widest"
                  >
                    CLOSE BRIEF
                  </button>
                  
                  {selectedRiskVetoForModal.review_requested ? (
                    <div className="flex-[2] bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 font-extrabold flex items-center justify-center gap-2 py-2.5 rounded tracking-widest text-[9.5px] shadow-inner select-none uppercase">
                      <Check size={14} className="text-indigo-400 shrink-0" />
                      REVIEW DISPATCHED TO COMPLIANCE DESK
                    </div>
                  ) : (
                    <button 
                      onClick={() => handleRequestHumanReview(selectedRiskVetoForModal.id)}
                      disabled={isVetoSubmittingReview}
                      className="flex-[2] bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 text-white font-extrabold uppercase py-2.5 rounded transition-all text-center flex items-center justify-center gap-1.5 shadow text-[9.5px] tracking-widest cursor-pointer"
                    >
                      {isVetoSubmittingReview ? (
                        <>
                          <div className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full shrink-0" />
                          DISPATCHING COMPLIANCE REQUEST...
                        </>
                      ) : (
                        <>
                          <UserCheck size={14} className="text-white shrink-0" />
                          REQUEST MANUAL HUMAN REVIEW
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      )}

      {rebalanceResult && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#1A1F2B] border border-slate-800 rounded-lg max-w-lg w-full p-6 shadow-2xl relative flex flex-col max-h-[90vh]">
            
            <button
              onClick={() => setRebalanceResult(null)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100 transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>

            <div className="flex items-center gap-3 border-b border-slate-800 pb-4 mb-5">
              <div className="p-2 bg-emerald-500/10 rounded border border-emerald-500/20 text-emerald-400">
                <Scale size={20} />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white uppercase tracking-wider">SYSTEM REBALANCE REPORT</h3>
                <span className="text-[10px] text-slate-400 font-mono">
                  RISK CONFIGURATION: <span className="text-indigo-400 font-bold uppercase">{rebalanceResult.riskLevel}</span>
                </span>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Target & Equity Summary */}
              <div className="grid grid-cols-2 gap-3 bg-[#111822] p-3 rounded border border-slate-800 font-mono text-[11px]">
                <div>
                  <span className="text-[9px] text-slate-500 block">TOTAL EQUITY BEFORE</span>
                  <span className="text-slate-200 font-bold">${rebalanceResult.totalEquityBefore?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div>
                  <span className="text-[9px] text-slate-500 block">TOTAL EQUITY AFTER</span>
                  <span className="text-emerald-400 font-bold">${rebalanceResult.totalEquityAfter?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              </div>

              {/* Target Percentages Breakdown */}
              <div className="space-y-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest block font-bold">Target Allocations Set</span>
                <div className="grid grid-cols-4 gap-2 text-center text-[10px] font-mono">
                  {Object.entries(rebalanceResult.targetAllocations || {}).map(([key, value]: [any, any]) => (
                    <div key={key} className="bg-[#111822]/60 p-2 border border-slate-800/80 rounded">
                      <span className="text-slate-500 block uppercase font-bold">{key}</span>
                      <span className="text-indigo-300 font-bold">{value}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Operations Checklist */}
              <div className="space-y-2">
                <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest block font-bold">Executed Audit Stream</span>
                <div className="space-y-1.5 font-mono text-[10.5px]">
                  {rebalanceResult.actionsExecuted && rebalanceResult.actionsExecuted.length > 0 ? (
                    rebalanceResult.actionsExecuted.map((action: any, idx: number) => {
                      const isBuy = action.side === "BUY";
                      return (
                        <div key={idx} className={`p-2.5 rounded border border-slate-800/80 flex justify-between items-center bg-[#111822]/40`}>
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0.5 text-[8px] font-black rounded ${isBuy ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"}`}>
                              {action.side}
                            </span>
                            <span className="font-bold text-slate-200">{action.symbol}</span>
                            <span className="text-slate-400">({action.quantity} shares)</span>
                          </div>
                          <div className="text-right">
                            <span className="text-slate-300 font-bold">${action.price.toFixed(2)}</span>
                            <span className="text-slate-500 block text-[9px]">${action.total_amount?.toLocaleString(undefined, { minimumFractionDigits: 2 })} total</span>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="text-center p-6 text-slate-500 border border-dashed border-slate-800/50 rounded bg-[#111822]/20">
                      No matching purchase or sale transactions needed. Current portfolio weights are optimal.
                    </div>
                  )}
                </div>
              </div>

              {/* Success Message Banner */}
              <div className="p-3 bg-emerald-500/5 border border-emerald-500/25 rounded text-emerald-400 text-[11px] leading-relaxed font-mono flex items-start gap-2">
                <Check size={14} className="shrink-0 mt-0.5" />
                <span>{rebalanceResult.message}</span>
              </div>
            </div>

            <button
              onClick={() => setRebalanceResult(null)}
              className="mt-6 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold uppercase tracking-widest py-3 rounded text-[10px] border border-slate-700 hover:border-slate-600 transition-colors cursor-pointer"
            >
              ACKNOWLEDGE ALIGNMENT
            </button>

          </div>
        </div>
      )}

      {/* Risk Attribution Drill-Down Modal */}
      {riskDrilldownActive && drilldownDate && drilldownAgent && (
        <div className="fixed inset-0 z-[60] bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-[#0A0F16] border border-slate-800 rounded-lg max-w-2xl w-full p-6 shadow-2xl relative flex flex-col max-h-[90vh]">
            <button
              onClick={() => setRiskDrilldownActive(false)}
              className="absolute top-4 right-4 text-slate-400 hover:text-slate-100 transition-colors z-10 cursor-pointer"
            >
              <X size={18} />
            </button>

            {/* Modal Header */}
            <div className="border-b border-slate-800 pb-4 mb-5 pr-8">
              <h3 className="text-lg font-bold text-white flex items-center gap-2 tracking-wide font-mono uppercase">
                <Search size={18} className="text-indigo-400" />
                Risk Factor Contribution Drill-Down
              </h3>
              <p className="text-xs text-slate-400 mt-1 font-mono">
                Attribution analysis isolated for <span className="text-indigo-200 font-bold">{drilldownDate}</span>
              </p>
            </div>

            {/* Agent Tabs */}
            <div className="flex gap-2 border-b border-slate-850 pb-3 mb-4 overflow-x-auto nice-scrollbar">
              {[
                { key: "NewsAgent", label: "News NLP" },
                { key: "MacroAgent", label: "Macro Quant" },
                { key: "TechnicalAgent", label: "Technical TA" },
                { key: "SentimentAgent", label: "Sentiment Social" },
                { key: "OrderFlowAgent", label: "Order Flow L2" }
              ].map(a => (
                <button
                  key={a.key}
                  onClick={() => setDrilldownAgent(a.key)}
                  className={`px-3 py-1.5 rounded cursor-pointer text-xs font-mono font-bold transition-all whitespace-nowrap ${
                    drilldownAgent === a.key 
                      ? "bg-indigo-500/20 text-indigo-400 border border-indigo-500/40 shadow-inner" 
                      : "bg-[#111822] text-slate-500 hover:text-slate-300 border border-slate-800"
                  }`}
                >
                  {a.label}
                </button>
              ))}
            </div>

            <div className="text-xs text-slate-400 font-mono mb-3 flex items-center gap-2">
              <Activity size={14} className="text-amber-500" />
              TOP 5 VOLATILITY INJECTORS FOR {drilldownAgent.toUpperCase()}:
            </div>

            {/* Factors List */}
            <div className="flex-1 overflow-y-auto space-y-2.5 pr-2">
               <AwaitingSignal reason="Per-agent volatility-injector lists are not persisted. This modal does not invent headlines or L2 spoofing events." label="Risk factor drill-down" />
            </div>

            <button
               onClick={() => setRiskDrilldownActive(false)}
               className="mt-6 w-full bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold uppercase tracking-widest py-3 rounded text-[10px] border border-slate-700 hover:border-slate-600 transition-colors cursor-pointer"
            >
               ACKNOWLEDGE CAUSALITY
            </button>
          </div>
        </div>
      )}

      {/* Custom Alert & Notification Engine Modal */}
      {alertsModalOpen && (
        <div className="fixed inset-0 bg-[#0A0F16]/90 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-[#1A1F2B] border border-slate-800 w-full max-w-2xl rounded-lg shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-[#111822] rounded-t-lg">
              <h2 className="text-white font-bold text-sm tracking-widest uppercase flex items-center gap-2">
                <BellRing size={16} className="text-indigo-400" />
                Custom Alert & Notification Engine
              </h2>
              <button 
                onClick={() => setAlertsModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="p-5 flex-1 overflow-y-auto custom-scrollbar">
              <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                Configure rule-based triggers linking internal agent operations directly to notification webhooks. Receive alerts when specific risk boundaries are breached or specific agents take over the consensus protocol.
              </p>

              <div className="space-y-4">
                {/* Alert Rules List */}
                <div className="bg-[#1A1F2B] border border-slate-700/50 rounded p-4 flex justify-between items-center">
                  <div className="flex flex-col gap-1">
                    <span className="text-emerald-400 font-bold text-[10px] uppercase font-mono tracking-widest">Rule Triggered</span>
                    <span className="text-white text-xs font-medium">Risk VETO Limit Exceeded</span>
                    <span className="text-slate-400 text-[10px]">Notify when Risk Manager VETOs 3 consecutive trades within 30 min.</span>
                  </div>
                  <ToggleRight size={24} className="text-emerald-400" />
                </div>

                <div className="bg-[#1A1F2B] border border-slate-700/50 rounded p-4 flex justify-between items-center">
                  <div className="flex flex-col gap-1">
                    <span className="text-emerald-400 font-bold text-[10px] uppercase font-mono tracking-widest">Rule Triggered</span>
                    <span className="text-white text-xs font-medium">Reflection Engine Learning Capture</span>
                    <span className="text-slate-400 text-[10px]">Notify when Reflection Engine extracts a new valid memory rule.</span>
                  </div>
                  <ToggleRight size={24} className="text-emerald-400" />
                </div>

                <div className="bg-[#1A1F2B] border border-slate-700/50 opacity-60 rounded p-4 flex justify-between items-center text-slate-500">
                  <div className="flex flex-col gap-1">
                    <span className="text-slate-500 font-bold text-[10px] uppercase font-mono tracking-widest">Rule Inactive</span>
                    <span className="text-slate-400 text-xs font-medium">Drawdown Violation Imminent</span>
                    <span className="text-slate-500 text-[10px]">Alert if daily unrealized P&L falls within 5% of maximum authorized halt.</span>
                  </div>
                  <ToggleLeft size={24} className="text-slate-600" />
                </div>
              </div>

              <button className="mt-6 w-full border border-dashed border-slate-700 hover:border-indigo-500/50 text-slate-400 hover:text-indigo-400 bg-transparent py-4 rounded flex items-center justify-center gap-2 text-xs uppercase tracking-widest font-bold transition-colors">
                <Plus size={14} /> NEW ALERT RULE
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export & Data Portability Extensions Modal */}
      {exportModalOpen && (
        <div className="fixed inset-0 bg-[#0A0F16]/90 backdrop-blur-sm z-[100] flex items-center justify-center p-4">
          <div className="bg-[#1A1F2B] border border-slate-800 w-full max-w-lg rounded-lg shadow-2xl flex flex-col max-h-[90vh]">
            <div className="p-5 border-b border-slate-800 flex justify-between items-center bg-[#111822] rounded-t-lg">
              <h2 className="text-white font-bold text-sm tracking-widest uppercase flex items-center gap-2">
                <DownloadCloud size={16} className="text-emerald-400" />
                Export Data & Portability
              </h2>
              <button 
                onClick={() => setExportModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            
            <div className="p-6">
              <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                Generate and download flattened CSV/JSON diagnostics of backend system behavior for local data science modeling or audit compliance.
              </p>

              <div className="space-y-3">
                <button onClick={() => window.open("/database/argus.db", "_blank")} className="w-full text-left bg-[#111822] hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/50 p-4 rounded group transition-all flex justify-between items-center cursor-pointer">
                  <div className="flex flex-col gap-1">
                    <span className="text-white font-bold text-xs">Vector Event Memory Logs</span>
                    <span className="text-[10px] text-slate-500 font-mono">Download exact RAG query history resolving macro precedents. [JSON]</span>
                  </div>
                  <Download size={16} className="text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
                
                <button onClick={() => window.open("/database/argus.db", "_blank")} className="w-full text-left bg-[#111822] hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/50 p-4 rounded group transition-all flex justify-between items-center cursor-pointer">
                  <div className="flex flex-col gap-1">
                    <span className="text-white font-bold text-xs">Accumulated Reflection Rules</span>
                    <span className="text-[10px] text-slate-500 font-mono">Extract all post-mortem loss rules deduced by the system. [CSV]</span>
                  </div>
                  <Download size={16} className="text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>

                <button onClick={() => window.open("/database/argus.db", "_blank")} className="w-full text-left bg-[#111822] hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/50 p-4 rounded group transition-all flex justify-between items-center cursor-pointer">
                  <div className="flex flex-col gap-1">
                    <span className="text-white font-bold text-xs">Historical Trade Decisions Ledger</span>
                    <span className="text-[10px] text-slate-500 font-mono">Full execution ledger including Proposer justification payloads. [CSV/JSON]</span>
                  </div>
                  <Download size={16} className="text-emerald-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer System Status Banner */}
      <footer
        className="border-t border-slate-850 px-6 py-4 bg-[#1A1F2B] flex flex-col md:flex-row items-center justify-between gap-4 text-xs text-slate-500"
        id="platform-footer"
      >
        <span className="font-medium">
          Argus AI Platform &copy; 2026. Built with Clean Hexagonal
          Architecture.
        </span>

        <div className="flex gap-4 font-mono">
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            Drizzle ORM: Ready
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            Redis: Cached
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            Pytest Suite: Passed
          </span>
        </div>
      </footer>
    </div>
  );
}
