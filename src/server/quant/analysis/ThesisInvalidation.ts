/**
 * Live re-evaluation of a QuantEngine trade's original thesis.
 *
 * Strategy modules state invalidation conditions up front (false breakout, regime flip,
 * RVOL collapse, ADX fade, CHoCH against). Those strings used to be stored on
 * supportingQuantDetail and never read again. This module turns the structured snapshot
 * captured at entry into a real pass/fail against current market features - never by
 * parsing the English sentences.
 */
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { detectFalseBreakout } from '../indicators/priceAction';

export interface StoredThesis {
  texts: string[];
  strategy: string | null;
  side: 'BUY' | 'SELL';
  entryRegime: string | null;
  applicableRegimes: string[];
  structuralLevel: number | null;
}

export interface LiveMarketRead {
  regime: string | null;
  rvol: number | null;
  adx: number | null;
  structureEvent: string | null;
  structureTrend: string | null;
  lastClose: number | null;
  bars: Bar[];
}

export interface InvalidationResult {
  invalidated: boolean;
  reasons: string[];
}

export function parseStoredThesis(raw: string | null | undefined): StoredThesis | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || (parsed.side !== 'BUY' && parsed.side !== 'SELL')) return null;
    return {
      texts: Array.isArray(parsed.texts) ? parsed.texts : [],
      strategy: parsed.strategy ?? null,
      side: parsed.side,
      entryRegime: parsed.entryRegime ?? null,
      applicableRegimes: Array.isArray(parsed.applicableRegimes) ? parsed.applicableRegimes : [],
      structuralLevel: typeof parsed.structuralLevel === 'number' ? parsed.structuralLevel : null,
    };
  } catch {
    return null;
  }
}

export function serializeStoredThesis(thesis: StoredThesis): string {
  return JSON.stringify(thesis);
}

export function evaluateThesisInvalidation(thesis: StoredThesis, live: LiveMarketRead): InvalidationResult {
  const reasons: string[] = [];
  const strategy = thesis.strategy || '';

  if (thesis.applicableRegimes.length > 0 && live.regime && !thesis.applicableRegimes.includes(live.regime)) {
    reasons.push(`Market regime flipped from ${thesis.entryRegime ?? 'entry'} to ${live.regime} (no longer in [${thesis.applicableRegimes.join(', ')}]).`);
  }

  if (strategy === 'MOMENTUM_BREAKOUT' || thesis.texts.some(t => t.includes('RVOL'))) {
    if (live.rvol !== null && live.rvol < 1.2) {
      reasons.push(`RVOL collapsed to ${live.rvol.toFixed(2)}x (below 1.2x follow-through).`);
    }
  }

  if (thesis.structuralLevel !== null && live.bars.length >= 2) {
    const breakoutDirection = thesis.side === 'BUY' ? 'UP' : 'DOWN';
    if (detectFalseBreakout(live.bars, thesis.structuralLevel, breakoutDirection)) {
      reasons.push(`Price closed back through the structural level ${thesis.structuralLevel.toFixed(2)} (false breakout).`);
    }
  }

  if (strategy === 'TREND_FOLLOWING' || thesis.texts.some(t => t.includes('ADX'))) {
    if (live.adx !== null && live.adx < 20) {
      reasons.push(`ADX faded to ${live.adx.toFixed(1)} (below 20 - trend strength gone).`);
    }
  }

  const chochAgainst = thesis.side === 'BUY' ? 'CHOCH_BEARISH' : 'CHOCH_BULLISH';
  if (live.structureEvent === chochAgainst) {
    reasons.push(`Market structure printed ${live.structureEvent} against the ${thesis.side} thesis.`);
  }

  if (strategy === 'SMC_LIQUIDITY_SWEEP' && thesis.structuralLevel !== null && live.lastClose !== null) {
    if (thesis.side === 'BUY' && live.lastClose < thesis.structuralLevel) {
      reasons.push(`Price closed back through the SMC sweep extreme ${thesis.structuralLevel.toFixed(2)} (continuation against the long).`);
    }
    if (thesis.side === 'SELL' && live.lastClose > thesis.structuralLevel) {
      reasons.push(`Price closed back through the SMC sweep extreme ${thesis.structuralLevel.toFixed(2)} (continuation against the short).`);
    }
  }

  if (strategy === 'MEAN_REVERSION' || strategy === 'PULLBACK_CONTINUATION') {
    const trendAgainst = thesis.side === 'BUY' ? 'DOWNTREND' : 'UPTREND';
    if (live.structureTrend === trendAgainst) {
      reasons.push(`Market structure trend flipped to ${live.structureTrend}.`);
    }
  }

  if (strategy === 'RANGE_REVERSION' && thesis.structuralLevel !== null && live.lastClose !== null) {
    const broke = thesis.side === 'BUY'
      ? live.lastClose < thesis.structuralLevel
      : live.lastClose > thesis.structuralLevel;
    if (broke) {
      reasons.push(`Close ${live.lastClose.toFixed(2)} broke the range boundary ${thesis.structuralLevel.toFixed(2)}.`);
    }
  }

  return { invalidated: reasons.length > 0, reasons };
}
