/**
 * When campaign_enabled, keep a liquid watchlist subscribed and nudge confluence agents
 * on high-conviction Quant candidates. Never emitTradeIdea / placeOrder. Never enables QUANT env.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { db } from '../db';
import * as schema from '../db/schema';
import { runtimeIntervals } from '../config/runtimeIntervals';
import {
  recordCampaignConfluenceNudge,
  recordCampaignScan,
  recordCampaignWatchlistSubscribe,
  emitCampaignEffortTelemetry,
} from './campaignEffortTelemetry';

const CAMPAIGN_LIQUID_EXTRA = ['GLD', 'SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'IWM'];

function campaignUniverse(): string[] {
  const names = [
    ...continuousIntelligence.seedSymbols,
    ...continuousIntelligence.watchUniverseSymbols,
    ...continuousIntelligence.protectedSymbols,
    ...CAMPAIGN_LIQUID_EXTRA,
  ];
  return [...new Set(names.map((s) => s.trim().toUpperCase()).filter((s) => looksLikeListedTicker(s)))];
}

async function isCampaignEnabled(): Promise<boolean> {
  try {
    const row = (await db.select().from(schema.settings).limit(1))[0];
    return !!row?.campaignEnabled;
  } catch {
    return false;
  }
}

export async function runCampaignWatchlistBoost(): Promise<{ subscribed: number; enabled: boolean }> {
  if (!(await isCampaignEnabled())) {
    return { subscribed: 0, enabled: false };
  }
  const universe = campaignUniverse();
  recordCampaignScan(1);
  let subscribed = 0;
  for (const symbol of universe.slice(0, continuousIntelligence.maxActiveSubscriptions)) {
    eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
      symbol,
      reason: 'CAMPAIGN_WATCHLIST_BOOST',
      source: 'CampaignWatchlistBoost',
      at: new Date().toISOString(),
    });
    subscribed += 1;
  }
  recordCampaignWatchlistSubscribe(subscribed);
  emitCampaignEffortTelemetry({ phase: 'watchlist_boost' });
  return { subscribed, enabled: true };
}

/** Quant high-conviction candidate → ask Technical/Kronos/News to evaluate (ideas still gated). */
export function nudgeCampaignConfluence(symbol: string, opts: {
  side: string;
  confidence: number;
  strategyId?: string | null;
  traceId?: string;
}): void {
  const ticker = looksLikeListedTicker(symbol);
  if (!ticker) return;
  if (!(opts.confidence >= 0.55)) return;
  recordCampaignConfluenceNudge();
  eventBus.emit(EVENTS.CAMPAIGN_CONFLUENCE_NUDGE, {
    symbol: ticker,
    side: opts.side,
    confidence: opts.confidence,
    strategyId: opts.strategyId ?? null,
    traceId: opts.traceId ?? null,
    agents: ['TechnicalAgent', 'KronosForecastAgent', 'NewsAgent'],
    note: 'Observability nudge only — agents still require Autobot/idea gates; consensus floors unchanged',
    at: new Date().toISOString(),
  });
}

export class CampaignWatchlistBoostWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private onQuantAssessment: ((payload: any) => void) | null = null;

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      void runCampaignWatchlistBoost();
    }, Math.max(runtimeIntervals.portfolioMonitorMs, continuousIntelligence.opportunityScanMs));
    void runCampaignWatchlistBoost();

    this.onQuantAssessment = (payload: any) => {
      void (async () => {
        if (!(await isCampaignEnabled())) return;
        if (!payload?.emittedTradeIdea || !payload?.symbol) return;
        const evals = Array.isArray(payload.strategyEvaluations) ? payload.strategyEvaluations : [];
        const best = evals.find((e: any) => e?.strategy && e?.side && e?.confidence > 0)
          ?? evals[0];
        nudgeCampaignConfluence(payload.symbol, {
          side: best?.side ?? 'BUY',
          confidence: typeof best?.confidence === 'number' ? best.confidence : 0.6,
          strategyId: best?.strategy ?? null,
          traceId: payload.traceId,
        });
      })();
    };
    eventBus.on(EVENTS.QUANT_ASSESSMENT_COMPLETED, this.onQuantAssessment);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.onQuantAssessment) {
      eventBus.off(EVENTS.QUANT_ASSESSMENT_COMPLETED, this.onQuantAssessment);
      this.onQuantAssessment = null;
    }
  }
}

export const campaignWatchlistBoostWorker = new CampaignWatchlistBoostWorker();
