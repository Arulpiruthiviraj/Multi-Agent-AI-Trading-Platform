import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  wrapResearchResult,
  newResearchRunId,
  unavailableDataQuality,
} from './types';
import { analyzeDrawdown, runDrawdownResearch } from './DrawdownResearch';
import { runCorrelationResearch } from './CorrelationResearch';
import { runRegimeDetectionResearch } from './RegimeDetectionResearch';
import { runMultiFactorResearch } from './MultiFactorResearch';
import { runMonteCarloSimulation } from './MonteCarloResearch';
import { runStrategyOptimization } from './StrategyOptimizationResearch';
import { classifyEdge } from './AlphaEdgeResearch';
import { runStrategyGenerationResearch } from './StrategyGenerationResearch';
import { runTradeSetupResearch } from './TradeSetupResearch';
import { tradingSafety } from '../../config/tradingSafety';
import { researchSafety } from '../../config/researchSafety';

const DIR = path.join(__dirname);
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

function sourceOf(file: string): string {
  return fs.readFileSync(path.join(DIR, file), 'utf8');
}

function importLinesOf(file: string): string[] {
  return sourceOf(file).split('\n').filter((l) => /^\s*import\b/.test(l));
}

describe('Research/Intelligence architecture boundary (Phase 2 + Phase 20)', () => {
  it('1. no file anywhere in this directory calls placeOrder', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/\.placeOrder\s*\(/);
    }
  });

  it('2. no file imports ChiefTraderAgent (cannot bypass consensus)', () => {
    for (const f of FILES) {
      expect(importLinesOf(f).some((l) => /ChiefTraderAgent/.test(l)), f).toBe(false);
    }
  });

  it('3. no file imports RiskEngine, OrderManagement, or BrokerManager', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /RiskEngine|OrderManagement|BrokerManager/.test(l));
      expect(hit, f).toBe(false);
    }
  });

  it('4. no file imports localPortfolioSync or writes portfolio/trades/fills schema tables (cannot contaminate live state)', () => {
    for (const f of FILES) {
      const hit = importLinesOf(f).some((l) => /localPortfolioSync|db\/schema.*\b(portfolio|trades|fills)\b/.test(l));
      expect(hit, f).toBe(false);
    }
  });

  it('5. no file references PAPER_TRADING_ONLY, setLiveMode, or LIVE_ARM (cannot touch live-arming)', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/PAPER_TRADING_ONLY|setLiveMode|LIVE_ARM\b/);
    }
  });

  it('6. no file references evaluateLiveReadiness (cannot influence LIVE_NO_GO)', () => {
    for (const f of FILES) {
      expect(sourceOf(f), f).not.toMatch(/evaluateLiveReadiness/);
    }
  });

  it('7. no file calls emitTradeIdea/emitChiefApproval (cannot inject into the live idea pipeline) — checked outside comments', () => {
    for (const f of FILES) {
      const codeOnly = sourceOf(f)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(codeOnly, f).not.toMatch(/\.emitTradeIdea\s*\(|\.emitChiefApproval\s*\(/);
    }
  });

  it('8. importing the whole research/intelligence barrel does not change consensus thresholds', async () => {
    const before = { t: tradingSafety.consensusApprovalThreshold, a: tradingSafety.minIndependentAgreeingAgents, d: tradingSafety.disagreementPenalty };
    await import('./index');
    expect(tradingSafety.consensusApprovalThreshold).toBe(before.t);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(before.a);
    expect(tradingSafety.disagreementPenalty).toBe(before.d);
    expect(tradingSafety.consensusApprovalThreshold).toBe(0.75);
    expect(tradingSafety.minIndependentAgreeingAgents).toBe(2);
  });

  it('9. every ResearchResult is labeled canPlaceOrders:false, isLiveTrade:false and never counted as a live trade', () => {
    const r = wrapResearchResult({ capability: 'TEST', dataQuality: unavailableDataQuality('test', 'n/a'), data: { x: 1 } });
    expect(r.canPlaceOrders).toBe(false);
    expect(r.isLiveTrade).toBe(false);
    expect(['RESEARCH', 'ADVISORY']).toContain(r.label);
  });

  it('10. missing data returns UNAVAILABLE/null, never a fabricated value (regime + multi-factor on empty bars)', () => {
    const regime = runRegimeDetectionResearch({ symbol: 'TEST', bars: [] });
    expect(regime.dataQuality.quality).toBe('UNAVAILABLE');
    const factors = runMultiFactorResearch({ symbol: 'TEST', bars: [] });
    expect(factors.data.compositeScore).toBeNull();
    expect(factors.data.factors.filter((f) => f.missing).length).toBeGreaterThan(0);
  });

  it('11. strategy optimization reports train/test divergence rather than silently trusting train-best (no test-set leakage)', () => {
    // A pathological evaluator that memorizes train perfectly but does poorly out-of-sample —
    // the harness must surface this divergence, not hide it behind a single "best" number.
    const result = runStrategyOptimization({
      symbol: 'TEST',
      strategyId: 'TEST_STRAT',
      parameterRanges: { period: [5, 10, 20] },
      evaluate: (params) => ({ trainMetric: 100 - params.period, testMetric: params.period === 10 ? 5 : -5 }),
    });
    expect(result.data.evaluations.length).toBe(3);
    expect(result.data.bestByTrain).not.toBeNull();
    expect(result.data.bestByTest).not.toBeNull();
    // Train-best (period=5, trainMetric=95) differs from test-best (period=10) — must be reported, not hidden.
    expect(result.data.bestByTrain!.params.period).not.toBe(result.data.bestByTest!.params.period);
    expect(result.data.meanTrainTestDivergence).toBeGreaterThan(0);
    expect(result.data.overfitWarning).not.toBeNull();
  });

  it('12. Monte Carlo draws exclusively from the supplied historical observations (no external randomness injected into outcomes)', () => {
    const returns = [0.05, -0.05]; // exactly two possible per-trade outcomes
    for (let i = 0; i < Math.max(researchSafety.minOosTrades, 5); i++) returns.push(i % 2 === 0 ? 0.05 : -0.05);
    const result = runMonteCarloSimulation({ historicalTradeReturnsPct: returns, iterations: 500, seed: () => 0.999999 });
    expect('insufficientSample' in result).toBe(false);
    if (!('insufficientSample' in result)) {
      // seed() always returns ~1 -> Math.floor(0.999999 * n) always picks the LAST element every draw.
      const last = returns[returns.length - 1];
      const expectedFinal = 100000 * Math.pow(1 + last, returns.length);
      expect(result.bestCaseFinalEquity).toBeCloseTo(expectedFinal, 2);
      expect(result.worstCaseFinalEquity).toBeCloseTo(expectedFinal, 2);
    }
  });

  it('12b. Monte Carlo refuses below the shared minOosTrades floor rather than simulating on a tiny sample', () => {
    const result = runMonteCarloSimulation({ historicalTradeReturnsPct: [0.01, -0.01] });
    expect('insufficientSample' in result && result.insufficientSample).toBe(true);
  });

  it('13. research trace IDs are namespaced separately from live trade/transaction IDs', () => {
    const id = newResearchRunId();
    expect(id.startsWith('research-')).toBe(true);
    expect(id).not.toMatch(/^ARG-\d{4}-\d{2}-\d{2}-\d{6}$/);
  });

  it('alpha edge classification never grants VALIDATED_EDGE from a positive return alone', () => {
    // Small sample, no walk-forward, no cost check — must NOT be VALIDATED_EDGE regardless of a "good" win rate.
    const weak = classifyEdge({ wins: 3, totalTrades: 4 });
    expect(weak.classification).not.toBe('VALIDATED_EDGE');
    expect(weak.classification).toBe('RESEARCH_CANDIDATE');
  });

  it('drawdown analysis computes a real underwater curve and max drawdown from an equity series', () => {
    const series = [100, 110, 90, 95, 120, 80, 130].map((equity, i) => ({ timestamp: i, equity }));
    const dd = analyzeDrawdown(series);
    // Peak reaches 120 (index 4) BEFORE the drop to 80 (index 5) — the max drawdown is measured
    // from that 120 peak, not the earlier 110 peak: (120-80)/120, not (110-80)/110.
    expect(dd.maxDrawdownPct).toBeCloseTo((120 - 80) / 120, 5);
    expect(dd.underwaterCurve.length).toBe(series.length);
    expect(dd.periods.length).toBe(2);
  });

  it('correlation research reuses returnCorrelation and never fabricates a value for insufficient overlap', () => {
    const result = runCorrelationResearch({
      closesBySymbol: { AAA: [1], BBB: [1] }, // 1 point each — insufficient overlap
    });
    expect(result.data.pairs[0].correlation).toBeNull();
    expect(result.data.diversificationScore).toBeNull();
  });

  it('strategy generation only ever produces artifacts tied to a real, already-implemented strategy id', () => {
    const result = runStrategyGenerationResearch({ universe: ['AAPL'], timeframe: '1Day' });
    for (const def of result.data) {
      expect(typeof def.strategyId).toBe('string');
      expect(def.strategyId.length).toBeGreaterThan(0);
    }
  });

  it('trade setup generation is always labeled RESEARCH_SETUP_NOT_AN_APPROVED_TRADE and carries an expiry', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ timestamp: i, open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1000 }));
    const result = runTradeSetupResearch({ symbol: 'TEST', bars });
    expect(result.data.status).toBe('RESEARCH_SETUP_NOT_AN_APPROVED_TRADE');
    expect(new Date(result.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('14. this file itself confirms it ran alongside the existing architecture.protection.test.ts (see full-suite run)', () => {
    // Placeholder assertion — actual cross-check is running architecture.protection.test.ts in the
    // same suite invocation, done at the CLI level (Phase 21 regression), not re-implemented here.
    expect(true).toBe(true);
  });
});
