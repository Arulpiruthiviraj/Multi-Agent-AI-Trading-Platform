/**
 * Live re-evaluation of a QuantEngine trade's original thesis.
 *
 * Rule types are implemented here; which strategies they apply to, thresholds, and message
 * templates come from config/thesisInvalidation.json. Do not add strategy-id literals here.
 */
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import { detectFalseBreakout } from '../indicators/priceAction';
import {
  thesisInvalidationConfig,
  ThesisInvalidationRule,
} from '../../config/thesisInvalidation';

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

function ruleApplies(rule: ThesisInvalidationRule, thesis: StoredThesis): boolean {
  const strategy = thesis.strategy || '';
  const hasStrategies = Array.isArray(rule.strategies) && rule.strategies.length > 0;
  const hasText = Array.isArray(rule.textIncludes) && rule.textIncludes.length > 0;
  if (!hasStrategies && !hasText) return true;
  const strategyHit = hasStrategies && rule.strategies!.includes(strategy);
  const textHit = hasText && rule.textIncludes!.some(needle => thesis.texts.some(t => t.includes(needle)));
  return strategyHit || textHit;
}

function formatMessage(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function varsFor(thesis: StoredThesis, live: LiveMarketRead, rule: ThesisInvalidationRule): Record<string, string> {
  const bias = thesisInvalidationConfig.biasLabels[thesis.side] ?? thesis.side;
  return {
    entryRegime: thesis.entryRegime ?? 'entry',
    liveRegime: live.regime ?? '',
    applicable: thesis.applicableRegimes.join(', '),
    rvol: live.rvol !== null ? live.rvol.toFixed(2) : '',
    threshold: rule.threshold !== undefined ? String(rule.threshold) : '',
    level: thesis.structuralLevel !== null ? thesis.structuralLevel.toFixed(2) : '',
    close: live.lastClose !== null ? live.lastClose.toFixed(2) : '',
    side: thesis.side,
    bias,
    adx: live.adx !== null ? live.adx.toFixed(1) : '',
    structureTrend: live.structureTrend ?? '',
    structureEvent: live.structureEvent ?? '',
  };
}

function evaluateRule(rule: ThesisInvalidationRule, thesis: StoredThesis, live: LiveMarketRead): string | null {
  const msg = () => formatMessage(rule.message, varsFor(thesis, live, rule));

  switch (rule.type) {
    case 'regime_not_in_applicable': {
      if (thesis.applicableRegimes.length > 0 && live.regime && !thesis.applicableRegimes.includes(live.regime)) {
        return msg();
      }
      return null;
    }
    case 'rvol_below': {
      const threshold = rule.threshold;
      if (threshold === undefined || live.rvol === null) return null;
      if (live.rvol < threshold) return msg();
      return null;
    }
    case 'adx_below': {
      const threshold = rule.threshold;
      if (threshold === undefined || live.adx === null) return null;
      if (live.adx < threshold) return msg();
      return null;
    }
    case 'false_breakout_through_structural_level': {
      if (thesis.structuralLevel === null || live.bars.length < 2) return null;
      const breakoutDirection = thesis.side === 'BUY' ? 'UP' : 'DOWN';
      if (detectFalseBreakout(live.bars, thesis.structuralLevel, breakoutDirection)) return msg();
      return null;
    }
    case 'choch_against_side': {
      const chochAgainst = thesis.side === 'BUY' ? 'CHOCH_BEARISH' : 'CHOCH_BULLISH';
      if (live.structureEvent === chochAgainst) return msg();
      return null;
    }
    case 'close_through_structural_level': {
      if (thesis.structuralLevel === null || live.lastClose === null) return null;
      const broke = thesis.side === 'BUY'
        ? live.lastClose < thesis.structuralLevel
        : live.lastClose > thesis.structuralLevel;
      return broke ? msg() : null;
    }
    case 'structure_trend_against_side': {
      const trendAgainst = thesis.side === 'BUY' ? 'DOWNTREND' : 'UPTREND';
      if (live.structureTrend === trendAgainst) return msg();
      return null;
    }
    default:
      return null;
  }
}

export function evaluateThesisInvalidation(thesis: StoredThesis, live: LiveMarketRead): InvalidationResult {
  const reasons: string[] = [];
  for (const rule of thesisInvalidationConfig.rules) {
    if (!ruleApplies(rule, thesis)) continue;
    const reason = evaluateRule(rule, thesis, live);
    if (reason) reasons.push(reason);
  }
  return { invalidated: reasons.length > 0, reasons };
}
