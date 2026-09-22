/**
 * ARGUS Crypto V2 - real live-data crypto research snapshot (2026-09-21). Connects real Alpaca
 * crypto bars to the REAL Java engines built earlier this session (CryptoFeatureEngine.java,
 * CryptoRegimeEngine.java, the BTC Tan2025/adaptive strategies), through the EXISTING,
 * already-reviewed integration boundary (QuantCoreBridge.fetchResearchStrategy(), the same method
 * every other RESEARCH-status Java engine already uses) - CLAUDE.md Java rule 3: "TypeScript may
 * call the Java engine only through the established integration boundary... never a new ad hoc
 * process/IPC channel." No new bridge code was needed; the Java HTTP endpoints for
 * crypto_feature/crypto_regime/the BTC strategies were already wired earlier this session.
 *
 * RESEARCH status: real data, real Java computation, zero live consumer. Not called from
 * ChiefTraderAgent/RiskEngine/OMS - see cryptoLiveArchitectureBoundary.test.ts.
 */
import { getCryptoBars } from './AlpacaCryptoMarketData';
import { quantCoreBridge } from '../../services/QuantCoreBridge';
import type { ResearchBar } from '../../research/ohlcvTypes';

export interface CryptoLiveSnapshot {
  symbol: string;
  barCount: number;
  lastClose: number | null;
  asOfMs: number;
  feature: Record<string, unknown> | null;
  regime: Record<string, unknown> | null;
  tan2025Momentum: Record<string, unknown> | null;
  tan2025Bollinger: Record<string, unknown> | null;
}

function toResearchBars(bars: readonly { timestampMs: number; open: number; high: number; low: number; close: number; volume: number }[]): ResearchBar[] {
  return bars.map((b) => ({
    timestamp: b.timestampMs,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  }));
}

/**
 * Fetches real recent daily bars for `symbol` (e.g. 'BTC/USD') and runs them through the real
 * Java crypto_feature/crypto_regime/BTC-strategy endpoints. Returns null for any stage whose
 * bridge call fails or returns insufficient-data (never fabricates a value) - the honest,
 * partial-result shape, matching this codebase's own "UNKNOWN over guessing" standard.
 */
export async function buildCryptoLiveSnapshot(symbol: string, lookbackDays = 120): Promise<CryptoLiveSnapshot> {
  const endMs = Date.now();
  const startMs = endMs - lookbackDays * 24 * 60 * 60 * 1000;
  const bars = await getCryptoBars(symbol, '1Day', startMs, endMs);
  const researchBars = toResearchBars(bars);

  const [feature, regime, tan2025Momentum, tan2025Bollinger] = await Promise.all([
    quantCoreBridge.fetchResearchStrategy('crypto_feature', symbol, researchBars),
    quantCoreBridge.fetchResearchStrategy('crypto_regime', symbol, researchBars),
    quantCoreBridge.fetchResearchStrategy('btc_tan2025_vol_adjusted_momentum', symbol, researchBars),
    quantCoreBridge.fetchResearchStrategy('btc_tan2025_bollinger_mean_reversion', symbol, researchBars),
  ]);

  return {
    symbol,
    barCount: bars.length,
    lastClose: bars.length > 0 ? bars[bars.length - 1].close : null,
    asOfMs: endMs,
    feature,
    regime,
    tan2025Momentum,
    tan2025Bollinger,
  };
}
