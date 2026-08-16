/**
 * Active historical replay session. Replaces clock + broker only.
 * LIVE tradingEngine flags are not flipped on. Organic paper ignores REPLAY fills.
 */
import { ReplayClock } from '../engines/backtest/ReplayClock';
import { InformationCutoff } from './InformationCutoff';
import { HistoricalReplayBroker } from '../../brokers/HistoricalReplayBroker';
import type { CanonicalDataset, ResearchBar } from '../research/ohlcvTypes';
import type { DataQualityReport } from '../research/dataQuality';
import type { HistoricalNewsProvider } from './HistoricalNewsProvider';
import { replaySafety } from './replaySafety';

export type ReplayRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'DATA_UNAVAILABLE'
  | 'PARTIAL';

export type ReplayAiMode = 'LIVE_MODEL_REPLAY' | 'RECORDED_DECISION_REPLAY' | 'DISABLED';
export type ReplaySpeed = '1x' | '10x' | '100x' | 'MAX' | 'STEP';

export interface ReplayConfig {
  startDate: string;
  endDate: string;
  startTime?: string;
  endTime?: string;
  market: string;
  exchange: string;
  timezone: string;
  symbols: string[];
  universeSource: string;
  universeAsOf: string | null;
  frequency: string;
  initialCapital: number;
  allocationBudget: number;
  costProfile: string;
  buyingPower: number;
  shortSelling: boolean;
  fractionalShares: boolean;
  extendedHours: boolean;
  dataProvider: string;
  newsProvider: string;
  aiMode: ReplayAiMode;
  strategyIds: string[];
  agents: string[];
  riskProfile: string;
  maxDailyLoss: number;
  maxTradesPerDay: number;
  maxPositionSize: number;
  maxPortfolioExposure: number;
  randomSeed: number;
  speed: ReplaySpeed;
}

export interface ReplayEvent {
  replayId: string;
  eventId: string;
  timestamp: string;
  historicalTimestamp: number;
  type: string;
  symbol?: string;
  payload: Record<string, unknown>;
  source: string;
  engine: string;
  dataHash: string;
}

export interface ActiveReplaySession {
  replayId: string;
  status: ReplayRunStatus;
  config: ReplayConfig;
  clock: ReplayClock;
  cutoff: InformationCutoff;
  broker: HistoricalReplayBroker;
  datasets: CanonicalDataset[];
  quality: DataQualityReport;
  datasetHash: string;
  configurationHash: string;
  replayHash: string;
  news: HistoricalNewsProvider;
  events: ReplayEvent[];
  noTrade: Record<string, number>;
  equity: Array<{ t: number; equity: number; cash: number; drawdownPct: number }>;
  peakEquity: number;
  pauseRequested: boolean;
  stopRequested: boolean;
  stepRequested: boolean;
  aiCalls: number;
  aiCostUsd: number;
  aiLabel: string;
  partial: boolean;
  waiters: Map<string, () => void>;
  barsBySymbol: Map<string, ResearchBar[]>;
  openStops: Map<string, { stop: number | null; target: number | null; entryTraceId: string }>;
  tradePnls: number[];
  /** Auditable fill ledger for report / export — not organic paper. */
  tradeLedger: ReplayTradeRecord[];
  rejectedOrders: Array<{
    timestamp: number;
    symbol: string;
    side: string;
    reason: string;
    traceId?: string;
  }>;
  agentAvailability: Record<string, { status: string; reason: string }>;
}

export interface ReplayTradeRecord {
  timestamp: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  strategyId: string;
  traceId: string;
  fees: number;
  slippage: number;
  realizedPnl: number | null;
  executionModel: 'NEXT_BAR_OPEN';
  executionEnvironment: 'HISTORICAL_REPLAY';
}

let active: ActiveReplaySession | null = null;

export function getActiveReplaySession(): ActiveReplaySession | null {
  return active;
}

export function setActiveReplaySession(session: ActiveReplaySession | null): void {
  active = session;
}

export function isReplayActive(): boolean {
  return active != null && (active.status === 'RUNNING' || active.status === 'PAUSED');
}

export function notifyReplayOrder(traceId: string): void {
  const w = active?.waiters.get(traceId);
  if (w) {
    w();
    active?.waiters.delete(traceId);
  }
}

export function waitReplayOrder(traceId: string, timeoutMs = 8000): Promise<void> {
  if (!active) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      active?.waiters.delete(traceId);
      resolve();
    }, timeoutMs);
    active.waiters.set(traceId, () => {
      clearTimeout(t);
      resolve();
    });
  });
}

/**
 * Point-in-time bars for RiskEngine correlation / sizing.
 * Strict prefix: timestamp < clock.now() — same cutoff as decision bars in FullArgusReplayEngine.
 * The bar at T is the fill bar (NEXT_BAR_OPEN); it must not enter decision-time closes.
 */
export function replayVisibleBars(symbol: string): ResearchBar[] {
  if (!active) return [];
  const bars = active.barsBySymbol.get(symbol.toUpperCase()) || [];
  const t = active.clock.now();
  return bars.filter((b) => b.timestamp < t);
}

export function defaultReplayConfig(partial?: Partial<ReplayConfig>): ReplayConfig {
  return {
    startDate: '2024-01-02',
    endDate: '2024-12-31',
    market: 'US',
    exchange: 'NYSE',
    timezone: replaySafety.defaultTimezone,
    symbols: ['AAPL'],
    universeSource: replaySafety.universeSourceDefault,
    universeAsOf: null,
    frequency: replaySafety.defaultFrequency,
    initialCapital: replaySafety.defaultInitialCapital,
    allocationBudget: replaySafety.defaultAllocationBudget,
    costProfile: replaySafety.defaultCostProfile,
    buyingPower: replaySafety.defaultInitialCapital,
    shortSelling: replaySafety.shortSellingDefault,
    fractionalShares: replaySafety.fractionalSharesDefault,
    extendedHours: replaySafety.extendedHoursDefault,
    dataProvider: 'golden_replay',
    newsProvider: 'golden_replay_news',
    aiMode: replaySafety.defaultAiMode as ReplayAiMode,
    strategyIds: ['MOMENTUM_BREAKOUT'],
    agents: ['QuantEngine', 'TechnicalAgent', 'NewsAgent', 'ChiefTrader', 'RiskAgent'],
    riskProfile: 'Balanced',
    maxDailyLoss: 1000,
    maxTradesPerDay: 20,
    maxPositionSize: replaySafety.defaultAllocationBudget,
    maxPortfolioExposure: 1,
    randomSeed: 1,
    speed: 'MAX',
    ...partial,
  };
}
