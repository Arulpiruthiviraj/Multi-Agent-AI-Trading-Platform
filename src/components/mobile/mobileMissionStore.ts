/**
 * Centralized mobile mission-control snapshot store.
 * Widgets subscribe via useSyncExternalStore selectors to avoid full-page re-renders.
 */
import type { MobileLayoutOverride } from './mobileUtils';
import type { MobileTabId } from './mobileTabs';

export interface MobileGateRow {
  name: string;
  passed: boolean | null;
  detail?: string | null;
  source: 'live' | 'persisted';
}

export interface MobileAgentVote {
  agent: string;
  side: string;
  confidence: number;
  weight: number;
  agreed?: boolean;
}

export interface MobileLogEvent {
  id: string;
  type: string;
  timestamp: number;
  source?: string;
  payload?: unknown;
}

export interface MobileMissionSnapshot {
  layoutOverride: MobileLayoutOverride;
  viewportMobile: boolean;
  refreshing: boolean;
  lastRefreshAt: number | null;
  wsStatus: 'connecting' | 'connected' | 'disconnected';
  wsLatencyMs: number | null;
  tradingMode: string;
  marketSession: string;
  autobotEnabled: boolean;
  emergencyStopActive: boolean;
  portfolio: {
    equity: number | null;
    cash: number | null;
    drawdown: number | null;
    peakValuation: number | null;
    positions: Array<{ symbol: string; quantity: number; marketValue?: number; unrealizedPl?: number; currentPrice?: number }>;
  } | null;
  capital: {
    argusAllocated: number | null;
    argusUsed: number | null;
    argusRemaining: number | null;
    openOrders: number | null;
    dailyPnl: number | null;
    unrealizedPnl: number | null;
  } | null;
  settings: {
    maxPortfolioDrawdownPct: number | null;
    budget: number | null;
  } | null;
  missionControl: Record<string, unknown> | null;
  latestTxId: string | null;
  latestTxDetail: Record<string, unknown> | null;
  transactions: Array<Record<string, unknown>>;
  closedTrades: Array<Record<string, unknown>>;
  consensus: {
    side: string | null;
    weightedConfidence: number | null;
    threshold: number | null;
    approved: boolean | null;
    agentVotes: MobileAgentVote[];
    noConsensus: boolean;
  };
  quant: Record<string, unknown> | null;
  gates: MobileGateRow[];
  gateSummary: { passed: number; failed: number; unknown: number };
  dailyLimits: {
    currentDailyLoss: number | null;
    dailyLossLimit: number | null;
    dailyBuyNotional: number | null;
    maxDailyBuyNotional: number | null;
  };
  diagnostics: Array<Record<string, unknown>>;
  startupHealth: Array<Record<string, unknown>>;
  logEvents: MobileLogEvent[];
  logFilter: string;
  errors: Record<string, string>;
  sessionExpired: boolean;
  actionBanner: { tone: 'success' | 'error' | 'danger'; message: string } | null;
  tradingState: string;
  activeTab: MobileTabId;
  equityHistory: Array<{ timestamp?: number; equity?: number; value?: number }>;
  organicPaper: {
    closedTradeCount: number | null;
    sessionCount: number | null;
    minPaperTrades: number;
    minPaperSessions: number;
    soakStatus: string | null;
  } | null;
}

const initialSnapshot = (): MobileMissionSnapshot => ({
  layoutOverride: 'auto',
  viewportMobile: typeof window !== 'undefined' ? window.innerWidth < 768 : false,
  refreshing: false,
  lastRefreshAt: null,
  wsStatus: 'disconnected',
  wsLatencyMs: null,
  tradingMode: 'PAPER',
  marketSession: 'UNKNOWN',
  autobotEnabled: false,
  emergencyStopActive: false,
  portfolio: null,
  capital: null,
  settings: null,
  missionControl: null,
  latestTxId: null,
  latestTxDetail: null,
  transactions: [],
  closedTrades: [],
  consensus: {
    side: null,
    weightedConfidence: null,
    threshold: null,
    approved: null,
    agentVotes: [],
    noConsensus: false,
  },
  quant: null,
  gates: [],
  gateSummary: { passed: 0, failed: 0, unknown: 0 },
  dailyLimits: {
    currentDailyLoss: null,
    dailyLossLimit: null,
    dailyBuyNotional: null,
    maxDailyBuyNotional: null,
  },
  diagnostics: [],
  startupHealth: [],
  logEvents: [],
  logFilter: '',
  errors: {},
  sessionExpired: false,
  actionBanner: null,
  tradingState: 'TRADING_ENABLED',
  activeTab: 'cockpit',
  equityHistory: [],
  organicPaper: null,
});

let snapshot: MobileMissionSnapshot = initialSnapshot();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getMobileMissionSnapshot(): MobileMissionSnapshot {
  return snapshot;
}

export function patchMobileMissionSnapshot(patch: Partial<MobileMissionSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

export function mergeMobileMissionSnapshot(updater: (prev: MobileMissionSnapshot) => Partial<MobileMissionSnapshot>): void {
  snapshot = { ...snapshot, ...updater(snapshot) };
  emit();
}

export function subscribeMobileMissionSnapshot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function resetMobileMissionSnapshot(): void {
  snapshot = initialSnapshot();
  emit();
}
