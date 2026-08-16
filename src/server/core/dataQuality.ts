/**
 * Module: dataQuality
 *
 * GREEN / YELLOW / RED snapshot for a decision. Never fabricates missing feeds.
 */
import { deskIntelligence } from '../config/deskIntelligence';
import { tradingSafety } from '../config/tradingSafety';
import { marketDataWorker } from '../services/MarketDataWorker';
import { listRecentNewsCatalysts } from '../services/NewsCatalystStore';

export type DataQualityColor = 'GREEN' | 'YELLOW' | 'RED';

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
  const rank = { GREEN: 0, YELLOW: 1, RED: 2 };
  return rank[a] >= rank[b] ? a : b;
}

export function assessDataQuality(symbol: string): DataQualitySnapshot {
  const { greenMaxStaleMs, yellowMaxStaleMs } = deskIntelligence.dataQuality;
  const ageMs = marketDataWorker.getLatestPriceAgeMs?.(symbol) ?? null;
  let market: DataQualityChannel;
  if (ageMs === null) {
    market = { channel: 'market_data', status: 'YELLOW', reason: 'No tick age recorded for this symbol (paper/internal feed may still have a last price).' };
  } else if (ageMs <= greenMaxStaleMs) {
    market = { channel: 'market_data', status: 'GREEN', reason: `Last tick ${ageMs}ms ago.` };
  } else if (ageMs <= yellowMaxStaleMs) {
    market = { channel: 'market_data', status: 'YELLOW', reason: `Last tick ${ageMs}ms ago (stale vs desk green band).` };
  } else {
    market = { channel: 'market_data', status: 'RED', reason: `Market data stale by ${ageMs}ms (threshold ${tradingSafety.stalePriceThresholdMs}ms).` };
  }

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
  const tradeBlocked = market.status === 'RED';
  return {
    overall,
    tradeBlocked,
    blockReason: tradeBlocked ? market.reason : null,
    channels,
  };
}
