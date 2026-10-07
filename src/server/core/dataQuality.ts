/**
 * Module: dataQuality
 *
 * GREEN / YELLOW / RED snapshot for a decision. Never fabricates missing feeds.
 */
import { deskIntelligence } from '../config/deskIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { marketDataWorker } from '../services/MarketDataWorker';
import { listRecentNewsCatalysts } from '../services/NewsCatalystStore';
import { evaluateQuoteFreshness, type MarketDataGrade } from './marketDataQuality';
import { recordPitLive } from '../engines/backtest/PitLedgerRecorder';
import { getActiveReplaySession } from '../replay/ReplayContext';

export type DataQualityColor = MarketDataGrade;

export interface DataQualityChannel {
  channel: string;
  status: DataQualityColor;
  reason: string;
}

export interface DataQualitySnapshot {
  overall: DataQualityColor;
  tradeBlocked: boolean;
  blockReason: string | null;
  channels: DataQualityChannel[];
}

function worst(a: DataQualityColor, b: DataQualityColor): DataQualityColor {
  const rank = { GREEN: 0, YELLOW: 1, RED: 2, UNKNOWN: 3 };
  return rank[a] >= rank[b] ? a : b;
}

export function assessDataQuality(symbol: string): DataQualitySnapshot {
  const { yellowMaxStaleMs } = deskIntelligence.dataQuality;
  // Real defect found and fixed (2026-10-06, synthetic/replay trigger-to-idea forensic pass):
  // this was the ONLY live freshness check in the QuantEngine emission path that never consulted
  // an active replay/synthetic session - RiskEngine.ts already does this in three places
  // (`replay ? 0 : marketDataWorker.getLatestPriceAgeMs(...)`, e.g. its own gate 13
  // `data_freshness`), because a replay/synthetic session's `MarketDataWorker.cacheObservedQuote()`
  // timestamps are stamped with the session's own simulated clock (deterministic, often far from
  // real wall-clock `Date.now()` by design - see SyntheticSessionEngine.ts's fixed
  // `defaultSessionStartMs()`), so a raw `Date.now() - t` here is never a real staleness signal
  // during replay/synthetic - it is always "stale" regardless of how fresh the simulated tick
  // actually is. Verified live: this was the real, sole reason every triggered CORE strategy's
  // cold-start-bootstrap/EV-backed idea was silently discarded as STALE_MARKET_DATA before ever
  // reaching ChiefTrader, while TechnicalAgent/KronosForecastAgent ideas (which never call
  // assessDataQuality()) emitted normally in the same runs. Matches RiskEngine's own precedent
  // exactly - never changes real-production wall-clock freshness behavior (getActiveReplaySession()
  // is always null outside replay/synthetic), never weakens stalePriceThresholdMs itself.
  const replay = getActiveReplaySession();
  const ageMs = replay ? 0 : (marketDataWorker.getLatestPriceAgeMs?.(symbol) ?? null);
  const freshness = evaluateQuoteFreshness({
    priceAgeMs: ageMs,
    staleThresholdMs: tradingSafety.stalePriceThresholdMs,
  });
  const market: DataQualityChannel = {
    channel: 'market_data',
    status: freshness.grade,
    reason: freshness.reason,
  };

  const channels = [market];

  const catalysts = listRecentNewsCatalysts(5);
  const newsAge = catalysts[0]?.publishedAtMs ? Date.now() - catalysts[0].publishedAtMs : (catalysts[0]?.recordedAt ? Date.now() - Date.parse(catalysts[0].recordedAt) : null);
  if (newsAge === null) {
    channels.push({ channel: 'news', status: 'YELLOW', reason: 'DATA UNAVAILABLE: no NEWS_CATALYST in this process. WHY: NewsEngine has not recorded a catalyst. IMPACT: catalyst score is empty, not fabricated. HOW TO FIX: configure a news provider and wait for a real item.' });
  } else if (newsAge > yellowMaxStaleMs) {
    channels.push({ channel: 'news', status: 'YELLOW', reason: `Last catalyst ${newsAge}ms ago.` });
  } else {
    channels.push({ channel: 'news', status: 'GREEN', reason: `Last catalyst ${newsAge}ms ago.` });
  }

  channels.push({ channel: 'fundamental', status: 'YELLOW', reason: 'DATA UNAVAILABLE: per-symbol fundamental freshness is not a tick clock. IMPACT: fundamental evidence may be cached. HOW TO FIX: inspect FundamentalAgent last run; do not invent freshness.' });
  channels.push({ channel: 'market_index', status: 'YELLOW', reason: 'Index freshness is not scored unless SPY ticks are in MarketDataWorker. HOW TO FIX: subscribe SPY.' });
  channels.push({ channel: 'sector', status: 'YELLOW', reason: 'DATA UNAVAILABLE: sector ETF freshness is not a dedicated clock.' });
  channels.push({ channel: 'forecast', status: 'YELLOW', reason: 'DATA UNAVAILABLE: Chronos/Kronos freshness is not attached to this symbol tick.' });
  channels.push({ channel: 'broker', status: 'YELLOW', reason: 'Broker snapshot freshness is not measured here. RiskEngine still requires a live portfolio() call.' });
  const overall = channels.reduce((acc, c) => worst(acc, c.status), 'GREEN' as DataQualityColor);
  const tradeBlocked = market.status === 'RED' || market.status === 'UNKNOWN';
  const result: DataQualitySnapshot = {
    overall,
    tradeBlocked,
    blockReason: tradeBlocked ? market.reason : null,
    channels,
  };
  recordPitLive({
    kind: 'DATA_QUALITY',
    symbol,
    agent: 'MarketDataQuality',
    payloadJson: JSON.stringify({
      overall: result.overall,
      tradeBlocked: result.tradeBlocked,
      blockReason: result.blockReason,
      market: market.status,
    }),
    source: 'assessDataQuality',
  });
  return result;
}
