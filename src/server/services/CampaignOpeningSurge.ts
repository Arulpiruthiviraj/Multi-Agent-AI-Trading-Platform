/**
 * Campaign opening-bell momentum / RVOL hunter.
 * When campaign_enabled: once per NY session in the 09:25–09:40 ET window, scan a liquid
 * universe for RVOL + ORB (+ optional high-impact catalyst). Emits confluence nudges /
 * watchlist subscribes only — never emitTradeIdea / placeOrder. Does not enable QUANT.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { getTradingDateStr, getTradingTimeHHMM } from '../core/TradingCalendar';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { db } from '../db';
import * as schema from '../db/schema';
import { historicalDataGateway, type Bar } from '../engines/backtest/HistoricalDataGateway';
import { relativeVolume } from '../quant/indicators/volume';
import { previousDayLevels, openingRange } from '../quant/indicators/supportResistance';
import { getNewsCatalysts } from './NewsCatalystStore';
import {
  evaluateOpeningSurgeCandidate,
  isOpeningSurgeWindow,
} from './campaignIntraday';
import {
  emitCampaignEffortTelemetry,
  recordCampaignConfluenceNudge,
  recordCampaignScan,
  recordCampaignWatchlistSubscribe,
} from './campaignEffortTelemetry';
import { nudgeCampaignConfluence } from './CampaignWatchlistBoost';

const TIMEFRAME = '1Min';

let lastSurgeTradingDate: string | null = null;

export function resetCampaignOpeningSurgeForTests(): void {
  lastSurgeTradingDate = null;
}

async function isCampaignEnabled(): Promise<boolean> {
  try {
    const row = (await db.select().from(schema.settings).limit(1))[0];
    return !!row?.campaignEnabled;
  } catch {
    return false;
  }
}

function surgeUniverse(): string[] {
  return [...new Set(
    continuousIntelligence.campaignOpeningSurgeSymbols
      .map((s) => String(s).trim().toUpperCase())
      .filter((s) => looksLikeListedTicker(s)),
  )];
}

function hasHighImpactCatalyst(symbol: string): boolean {
  const cats = getNewsCatalysts(symbol);
  return cats.some((c) =>
    c.catalystStrength === 'HIGH'
    || (c.status === 'STAGED_FOR_OPEN' && c.catalystStrength !== 'LOW'),
  );
}

async function loadRecentBars(symbol: string): Promise<Bar[]> {
  const endMs = Date.now();
  const startMs = endMs - 3 * 24 * 60 * 60 * 1000;
  try {
    await historicalDataGateway.ensureBars(symbol, TIMEFRAME, startMs, endMs);
    return historicalDataGateway.getBars(symbol, TIMEFRAME, startMs, endMs);
  } catch (e) {
    console.warn(`[CampaignOpeningSurge] bars unavailable for ${symbol}`, e);
    return [];
  }
}

export async function runCampaignOpeningSurge(now: Date = new Date()): Promise<{
  ran: boolean;
  reason: string;
  hits: Array<{ symbol: string; reasons: string[] }>;
}> {
  if (!(await isCampaignEnabled())) {
    return { ran: false, reason: 'campaign_disabled', hits: [] };
  }
  const hhmm = getTradingTimeHHMM(now);
  if (!isOpeningSurgeWindow(hhmm)) {
    return { ran: false, reason: `outside_window_${hhmm}`, hits: [] };
  }
  const tradingDate = getTradingDateStr(now);
  if (lastSurgeTradingDate === tradingDate) {
    return { ran: false, reason: 'already_ran_today', hits: [] };
  }

  lastSurgeTradingDate = tradingDate;
  recordCampaignScan(1);
  const hits: Array<{ symbol: string; reasons: string[] }> = [];
  const universe = surgeUniverse();

  for (const symbol of universe) {
    eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
      symbol,
      reason: 'CAMPAIGN_OPENING_SURGE',
      source: 'CampaignOpeningSurge',
      at: now.toISOString(),
    });
    recordCampaignWatchlistSubscribe(1);

    const bars = await loadRecentBars(symbol);
    if (bars.length < 30) continue;
    const volumes = bars.map((b) => b.volume);
    const rvol = relativeVolume(volumes, 20);
    const prev = previousDayLevels(bars);
    const or = openingRange(bars, tradingSafety.campaignOpeningRangeMinutes);
    const last = bars[bars.length - 1]?.close ?? null;
    const verdict = evaluateOpeningSurgeCandidate({
      rvol,
      last,
      prevDayHigh: prev?.high ?? null,
      prevDayLow: prev?.low ?? null,
      openingRangeHigh: or.available ? or.data?.high ?? null : null,
      openingRangeLow: or.available ? or.data?.low ?? null : null,
      hasHighImpactCatalyst: hasHighImpactCatalyst(symbol),
    });
    if (!verdict.pass) continue;

    hits.push({ symbol, reasons: verdict.reasons });
    recordCampaignConfluenceNudge();
    nudgeCampaignConfluence(symbol, {
      side: verdict.orbDirection === 'BELOW' ? 'SELL' : 'BUY',
      confidence: 0.7,
      strategyId: 'OPENING_SURGE',
      traceId: `opening-surge-${tradingDate}-${symbol}`,
    });

    // Optional Quant re-eval only if the operator already enabled QUANT — never auto-enable.
    try {
      const { quantSignalAgent } = await import('./QuantSignalAgent');
      const { isRuntimeFlagEnabled } = await import('../config/effectiveRuntimeConfig');
      if (isRuntimeFlagEnabled('QUANT_ENGINE_ENABLED')) {
        void quantSignalAgent.evaluateSymbol(symbol);
      }
    } catch {
      /* Quant optional */
    }
  }

  eventBus.emit(EVENTS.CAMPAIGN_OPENING_SURGE, {
    tradingDate,
    hhmm,
    scanned: universe.length,
    hits,
    honesty: 'Subscribe + confluence nudge only. Consensus 0.75 / min-2 / 24 gates unchanged. No placeOrder.',
    at: now.toISOString(),
  });
  emitCampaignEffortTelemetry({ phase: 'opening_surge', hits: hits.length });

  console.log(
    `[CampaignOpeningSurge] ${tradingDate} ${hhmm} ET scanned=${universe.length} hits=${hits.length}`,
  );
  return { ran: true, reason: 'ok', hits };
}

export class CampaignOpeningSurgeWorker {
  private intervalId: NodeJS.Timeout | null = null;

  start(): void {
    if (this.intervalId) return;
    // 30s poll is enough to catch the open window without a dedicated clock service.
    this.intervalId = setInterval(() => {
      void runCampaignOpeningSurge();
    }, 30_000);
    void runCampaignOpeningSurge();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

export const campaignOpeningSurgeWorker = new CampaignOpeningSurgeWorker();
