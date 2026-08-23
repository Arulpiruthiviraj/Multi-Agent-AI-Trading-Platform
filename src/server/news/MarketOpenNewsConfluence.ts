/**
 * Market-open confluence: match STAGED_FOR_OPEN overnight catalysts to opening ticks.
 * Emits TRADE_IDEA_GENERATED only through emitTradeIdea (Chief→Risk→OMS). Never places orders.
 * Off-hours: no OMS path — staging only.
 */
import { eventBus } from '../core/EventBus';
import { EVENTS } from '../core/eventNames';
import { runtimeIntervals } from '../config/runtimeIntervals';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { isPipelineAgentEnabled } from '../core/pipelineAgentGate';
import { newsAgentEmitsTradeIdeas } from '../config/deskIntelligence';
import { looksLikeListedTicker } from '../ai/AIOutputValidator';
import { generateTraceId } from '../core/traceId';
import { marketDataWorker } from '../services/MarketDataWorker';
import { isUsEquityRegularSession } from './newsSessionCadence';
import {
  listStagedForOpenCatalysts,
  markStagedCatalystConsumed,
  markStagedCatalystExpired,
  type NewsCatalyst,
} from '../services/NewsCatalystStore';
import { classifyMarketSession } from '../replay/marketSession';
import { TRADING_TIMEZONE } from '../core/TradingCalendar';

const OPEN_MOMENTUM_BPS = 15; // 0.15% move confirms direction vs reference

export class MarketOpenNewsConfluence {
  private static instance: MarketOpenNewsConfluence;
  private intervalId: NodeJS.Timeout | null = null;
  private lastSession: string | null = null;
  private sessionOpenMs: number | null = null;

  static getInstance(): MarketOpenNewsConfluence {
    if (!MarketOpenNewsConfluence.instance) {
      MarketOpenNewsConfluence.instance = new MarketOpenNewsConfluence();
    }
    return MarketOpenNewsConfluence.instance;
  }

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => {
      void this.tick();
    }, 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Test/helper: evaluate one staged catalyst against a live price. */
  evaluateConfluence(
    catalyst: NewsCatalyst,
    livePrice: number | null,
  ): 'CONFIRM' | 'CONTRADICT' | 'INSUFFICIENT' {
    if (livePrice == null || !Number.isFinite(livePrice) || livePrice <= 0) return 'INSUFFICIENT';
    const ref = catalyst.referencePrice;
    if (ref == null || !Number.isFinite(ref) || ref <= 0) {
      // Without a reference, do not invent confirmation — keep staged until ticks + price exist.
      return 'INSUFFICIENT';
    }
    const bps = ((livePrice - ref) / ref) * 10_000;
    if (catalyst.tradingBias === 'BULLISH') {
      if (bps >= OPEN_MOMENTUM_BPS) return 'CONFIRM';
      if (bps <= -OPEN_MOMENTUM_BPS) return 'CONTRADICT';
      return 'INSUFFICIENT';
    }
    if (catalyst.tradingBias === 'BEARISH') {
      if (bps <= -OPEN_MOMENTUM_BPS) return 'CONFIRM';
      if (bps >= OPEN_MOMENTUM_BPS) return 'CONTRADICT';
      return 'INSUFFICIENT';
    }
    return 'INSUFFICIENT';
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    const session = classifyMarketSession(now, TRADING_TIMEZONE, false);
    const prev = this.lastSession;
    this.lastSession = session;

    if (session === 'REGULAR' && prev !== 'REGULAR') {
      this.sessionOpenMs = now;
    }

    if (!isUsEquityRegularSession(now) || this.sessionOpenMs == null) return;
    if (now - this.sessionOpenMs > runtimeIntervals.newsOpenConfluenceWindowMs) return;

    const staged = listStagedForOpenCatalysts(40);
    for (const catalyst of staged) {
      if (catalyst.status !== 'STAGED_FOR_OPEN') continue;
      const ticker = looksLikeListedTicker(catalyst.symbol);
      if (!ticker) continue;
      const live = marketDataWorker.getLatestPrice(ticker);
      const verdict = this.evaluateConfluence(catalyst, live);

      if (verdict === 'CONTRADICT') {
        markStagedCatalystExpired(catalyst.traceId);
        eventBus.publish(EVENTS.NEWS_OPEN_CONTRADICTORY_PRICE_ACTION, {
          symbol: ticker,
          traceId: catalyst.traceId,
          tradingBias: catalyst.tradingBias,
          livePrice: live,
          headline: catalyst.headline,
          at: new Date().toISOString(),
        });
        continue;
      }

      if (verdict !== 'CONFIRM') continue;

      markStagedCatalystConsumed(catalyst.traceId);
      const side = catalyst.tradingBias === 'BULLISH' ? 'BUY' : 'SELL';
      const confidence = Math.min(0.95, Math.max(0.35, Math.abs(catalyst.contribution)));
      const traceId = generateTraceId(ticker);

      eventBus.publish(EVENTS.NEWS_OPEN_CONFLUENCE, {
        symbol: ticker,
        side,
        confidence,
        priorTraceId: catalyst.traceId,
        livePrice: live,
        headline: catalyst.headline,
        at: new Date().toISOString(),
      });

      // Ideas only when desk policy + Autobot/idea gate allow — never bypass Chief/Risk/OMS.
      if (newsAgentEmitsTradeIdeas() && isLiveIdeaGenerationEnabled() && isPipelineAgentEnabled('NewsAgent')) {
        eventBus.emitTradeIdea({
          traceId,
          symbol: ticker,
          side,
          confidence,
          reasoning: `[News open confluence] Staged overnight catalyst confirmed by opening price action: ${catalyst.headline}`,
          agent: 'NewsAgent',
          currentPrice: live ?? undefined,
          newsDetails: {
            used: true,
            sentiment: catalyst.sentiment ?? 0,
            confidence,
            sources: catalyst.source,
            reasoning: catalyst.reasoning,
            stagedForOpen: true,
          },
        });
      }
    }
  }
}

export const marketOpenNewsConfluence = MarketOpenNewsConfluence.getInstance();
