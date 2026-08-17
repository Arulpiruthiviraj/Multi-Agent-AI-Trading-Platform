/**
 * Research-only thresholds. Never live knobs. VectorBT cannot place orders.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface ResearchSafetyConfig {
  pythonTimeoutMs: number;
  minPaperTrades: number;
  minPaperSessions: number;
  minOosTrades: number;
  minWalkForwardWindows: number;
  permutationAlpha: number;
  costStressMaxMultipleStillProfitable: number;
  goldenSmaFast: number;
  goldenSmaSlow: number;
  smallAccountCapitals: number[];
  allowlistedJobs: string[];
  allowlistedStrategies: string[];
  coreStrategyIds: string[];
  experimentalStrategyIds: string[];
  proxyAdapterNote: string;
  commissionPerShare: number;
  spreadBps: number;
  slippageBps: number;
  zeroCostBlocksPromotion: boolean;
  researchQtyShares: number;
  wfoEmbargoBars: number;
  wfoTrainBars: number;
  wfoValBars: number;
  wfoTestBars: number;
  ingestDailyLookbackDays: number;
  ingestIntradayLookbackDays: number;
  ingestDefaultSymbols: string[];
  ingestAllowedTimeframes: string[];
  ingestMinYears: number;
  ingestMaxYears: number;
  alpacaBarsFeed: string;
  missingIntervalYellowCount: number;
  missingIntervalRedCount: number;
  ingestMaxPages: number;
  goldenInitialCapital: number;
  crossEnginePnlTolerance: number;
  multipleTestingWarnAboveTrials: number;
}

const raw = loadRepoConfigJson<Partial<ResearchSafetyConfig> & Record<string, unknown>>('researchSafety.json');

export const researchSafety: ResearchSafetyConfig = {
  pythonTimeoutMs: Number(raw.pythonTimeoutMs ?? 25000),
  minPaperTrades: Number(raw.minPaperTrades ?? 30),
  minPaperSessions: Number(raw.minPaperSessions ?? 10),
  minOosTrades: Number(raw.minOosTrades ?? 30),
  minWalkForwardWindows: Number(raw.minWalkForwardWindows ?? 3),
  permutationAlpha: Number(raw.permutationAlpha ?? 0.05),
  costStressMaxMultipleStillProfitable: Number(raw.costStressMaxMultipleStillProfitable ?? 2),
  goldenSmaFast: Number(raw.goldenSmaFast ?? 3),
  goldenSmaSlow: Number(raw.goldenSmaSlow ?? 8),
  smallAccountCapitals: Array.isArray(raw.smallAccountCapitals) ? raw.smallAccountCapitals.map(Number) : [100, 500, 1000, 5000],
  allowlistedJobs: Array.isArray(raw.allowlistedJobs) ? raw.allowlistedJobs.map(String) : ['capability', 'golden_sma'],
  allowlistedStrategies: Array.isArray(raw.allowlistedStrategies) ? raw.allowlistedStrategies.map(String) : ['GOLDEN_SMA'],
  coreStrategyIds: Array.isArray(raw.coreStrategyIds) ? raw.coreStrategyIds.map(String) : [],
  experimentalStrategyIds: Array.isArray(raw.experimentalStrategyIds) ? raw.experimentalStrategyIds.map(String) : ['SMC_LIQUIDITY_SWEEP'],
  proxyAdapterNote: String(raw.proxyAdapterNote ?? 'CORE adapters are proxies.'),
  commissionPerShare: (() => {
    if (raw.commissionPerShare == null || !Number.isFinite(Number(raw.commissionPerShare))) {
      throw new Error('researchSafety.json must define numeric commissionPerShare (no silent zero default)');
    }
    return Number(raw.commissionPerShare);
  })(),
  spreadBps: (() => {
    if (raw.spreadBps == null || !Number.isFinite(Number(raw.spreadBps))) {
      throw new Error('researchSafety.json must define numeric spreadBps (no silent zero default)');
    }
    return Number(raw.spreadBps);
  })(),
  slippageBps: (() => {
    if (raw.slippageBps == null || !Number.isFinite(Number(raw.slippageBps))) {
      throw new Error('researchSafety.json must define numeric slippageBps (no silent zero default)');
    }
    return Number(raw.slippageBps);
  })(),
  zeroCostBlocksPromotion: raw.zeroCostBlocksPromotion !== false,
  researchQtyShares: Number(raw.researchQtyShares ?? 1),
  wfoEmbargoBars: Number(raw.wfoEmbargoBars ?? 5),
  wfoTrainBars: Number(raw.wfoTrainBars ?? 60),
  wfoValBars: Number(raw.wfoValBars ?? 20),
  wfoTestBars: Number(raw.wfoTestBars ?? 20),
  ingestDailyLookbackDays: Number(raw.ingestDailyLookbackDays ?? 2520),
  ingestIntradayLookbackDays: Number(raw.ingestIntradayLookbackDays ?? 60),
  ingestDefaultSymbols: Array.isArray(raw.ingestDefaultSymbols)
    ? raw.ingestDefaultSymbols.map(String)
    : ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMD'],
  ingestAllowedTimeframes: Array.isArray(raw.ingestAllowedTimeframes)
    ? raw.ingestAllowedTimeframes.map(String)
    : ['1Day', '1Hour', '5Min', '15Min', '1Min'],
  ingestMinYears: Number(raw.ingestMinYears ?? 5),
  ingestMaxYears: Number(raw.ingestMaxYears ?? 10),
  alpacaBarsFeed: String(raw.alpacaBarsFeed ?? 'iex'),
  missingIntervalYellowCount: Number(raw.missingIntervalYellowCount ?? 3),
  missingIntervalRedCount: Number(raw.missingIntervalRedCount ?? 10),
  ingestMaxPages: Number(raw.ingestMaxPages ?? 50),
  goldenInitialCapital: Number(raw.goldenInitialCapital ?? 10000),
  crossEnginePnlTolerance: Number(raw.crossEnginePnlTolerance ?? 1e-6),
  multipleTestingWarnAboveTrials: Number(raw.multipleTestingWarnAboveTrials ?? 100),
};

export function isTheoreticalZeroCost(): boolean {
  return researchSafety.commissionPerShare === 0 && researchSafety.spreadBps === 0 && researchSafety.slippageBps === 0;
}
