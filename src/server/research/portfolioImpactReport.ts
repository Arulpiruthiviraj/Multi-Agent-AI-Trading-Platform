/**
 * Portfolio Candidate-Impact Report (Phase 5, ARGUS_MASTER_REDESIGN_PLAN.md "Portfolio
 * Construction" section, 2026-09-27). Read-only, operator-facing research report answering: "if I
 * hypothetically added this candidate trade to my CURRENT real portfolio, what happens to
 * portfolio-level variance and marginal risk contribution?"
 *
 * Same pattern as argus-cli quant-evidence / execution-quality (src/server/observability/*.ts):
 * a pure function assembling already-real data sources, no new bridge, no new IPC. Reuses:
 *  - BrokerManager.getActiveBroker().portfolio() for the REAL current holdings/cash/equity
 *    (the same read PortfolioReconciliation/PortfolioRebalance already use - never a second
 *    portfolio source of truth).
 *  - fetchAlpacaBars() (ingestAlpacaWarehouse.ts) for REAL historical daily bars per held symbol
 *    plus the candidate symbol - the same Alpaca REST source the research warehouse already uses.
 *  - statistics.ts's real Pearson covariance() over real daily returns - no hand-rolled matrix math
 *    duplicated in this file.
 *  - quantCoreBridge.fetchResearchStrategy('ojalgo_portfolio_risk', ...) and
 *    ('portfolio_min_variance_optimizer', ...) - the EXISTING generic institutional-strategy HTTP
 *    dispatcher (QuantCoreBridge.ts), never a new bridge/endpoint-calling convention.
 *
 * ARCHITECTURAL GUARANTEE (see portfolioImpactReport.readOnly.test.ts): this module NEVER imports
 * OrderManagement/RiskEngine/BrokerManager.placeOrder/ChiefTraderAgent/PositionSizing, and never
 * calls any order-placing method. It is advisory research output only - CLAUDE.md's "target
 * portfolio layer produces proposals, not orders" applies in full. Every returned field is either
 * a real measured number or null/an explicit UNAVAILABLE status - nothing here is fabricated when
 * a real data source (bars, broker connectivity, Java quant core) is missing.
 */
import { BrokerManager } from '../../brokers/BrokerManager';
import type { Position } from '../../brokers/BrokerAdapter';
import { fetchAlpacaBars } from './ingestAlpacaWarehouse';
import { covariance as pearsonCovariance, rollingReturns } from '../quant/statistics';
import { quantCoreBridge } from '../services/QuantCoreBridge';
import type { ResearchBar } from './ohlcvTypes';

export const PORTFOLIO_IMPACT_REPORT_VERSION = 'portfolio-impact-v1-2026-09-27';

export type PortfolioImpactStatus =
  | 'OK'
  | 'BROKER_UNAVAILABLE'
  | 'NO_HOLDINGS_AND_NO_CANDIDATE_HISTORY'
  | 'INSUFFICIENT_RETURN_HISTORY'
  | 'JAVA_QUANT_CORE_UNAVAILABLE';

export interface HoldingSnapshot {
  symbol: string;
  marketValue: number;
  currentWeight: number;
  returnObservations: number;
}

export interface PortfolioImpactReport {
  reportVersion: string;
  generatedAt: string;
  status: PortfolioImpactStatus;
  detail: string | null;
  /** ADVISORY ONLY - never a live target, never consumed by RiskEngine/OMS/PositionSizing. */
  advisory: true;
  candidateSymbol: string;
  candidateSide: 'BUY' | 'SELL';
  /** Fraction of current real equity the hypothetical trade notional represents. */
  candidateWeightDelta: number;
  currentEquity: number | null;
  currentCash: number | null;
  holdings: HoldingSnapshot[];
  lookbackTradingDays: number;
  maxWeightPctUsed: number;
  riskContribution: {
    currentPortfolioVariance: number | null;
    proposedPortfolioVariance: number | null;
    marginalRiskContributionPct: number | null;
    candidateWeightBefore: number | null;
    candidateWeightAfter: number | null;
    exceedsMaxWeight: boolean | null;
  } | null;
  minVarianceOptimizer: {
    optimizerStatus: string;
    /** symbol -> recommended weight. Empty unless optimizerStatus === 'OPTIMAL'. */
    recommendedWeights: Record<string, number>;
    portfolioVariance: number | null;
  } | null;
}

const DEFAULT_LOOKBACK_TRADING_DAYS = 90;
const MIN_RETURN_OVERLAP = 20; // matches statistics.ts's own correlation/covariance floor
const ONE_MINIMAL_BAR: ResearchBar = { timestamp: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 };

async function fetchDailyCloses(symbol: string, lookbackTradingDays: number): Promise<number[]> {
  const end = new Date();
  const start = new Date(end.getTime() - lookbackTradingDays * 2 * 24 * 60 * 60 * 1000); // 2x calendar buffer for weekends/holidays
  const fetched = await fetchAlpacaBars(symbol, '1Day', start.toISOString(), end.toISOString());
  if (fetched.status !== 'OK') return [];
  return fetched.bars.map((b) => b.close);
}

/**
 * Builds one read-only candidate-impact report. `candidateNotionalDollars` is the HYPOTHETICAL
 * trade size an operator is considering - this function never places, sizes for, or authorizes
 * that trade; it only reports what portfolio-level risk evidence would look like if it existed.
 */
export async function buildPortfolioImpactReport(
  candidateSymbol: string,
  candidateSide: 'BUY' | 'SELL',
  candidateNotionalDollars: number,
  maxWeightPct: number = 0.20,
  lookbackTradingDays: number = DEFAULT_LOOKBACK_TRADING_DAYS,
): Promise<PortfolioImpactReport> {
  const generatedAt = new Date().toISOString();
  const symbol = candidateSymbol.trim().toUpperCase();

  let positions: Position[] = [];
  let equity: number | null = null;
  let cash: number | null = null;
  try {
    const broker = BrokerManager.getInstance().getActiveBroker();
    const portfolio = await broker.portfolio();
    positions = portfolio.positions ?? [];
    equity = portfolio.equity;
    cash = portfolio.cash;
  } catch (e) {
    return baseReport(generatedAt, symbol, candidateSide, candidateNotionalDollars, maxWeightPct, lookbackTradingDays,
      'BROKER_UNAVAILABLE', `Could not read real broker portfolio: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (!equity || equity <= 0) {
    return baseReport(generatedAt, symbol, candidateSide, candidateNotionalDollars, maxWeightPct, lookbackTradingDays,
      'BROKER_UNAVAILABLE', 'Broker reported non-positive or missing equity.');
  }

  const heldSymbols = positions.map((p) => p.symbol.toUpperCase());
  const alreadyHeld = heldSymbols.includes(symbol);
  const allSymbols = alreadyHeld ? heldSymbols : [...heldSymbols, symbol];

  if (allSymbols.length === 0) {
    return baseReport(generatedAt, symbol, candidateSide, candidateNotionalDollars, maxWeightPct, lookbackTradingDays,
      'NO_HOLDINGS_AND_NO_CANDIDATE_HISTORY', 'No current holdings and no candidate symbol to build a single-asset "portfolio".', equity, cash);
  }

  // Real, sequential per-symbol fetch (small n - typically <=25 open positions per RiskEngine
  // gate 18's own cap) - no new batching mechanism invented here.
  const closesBySymbol = new Map<string, number[]>();
  for (const s of allSymbols) {
    closesBySymbol.set(s, await fetchDailyCloses(s, lookbackTradingDays));
  }

  const returnsBySymbol = new Map<string, number[]>();
  for (const [s, closes] of closesBySymbol) {
    returnsBySymbol.set(s, closes.length >= 2 ? rollingReturns(closes, 1) : []);
  }

  const insufficientSymbols = allSymbols.filter((s) => (returnsBySymbol.get(s)?.length ?? 0) < MIN_RETURN_OVERLAP);
  if (insufficientSymbols.length > 0) {
    return baseReport(generatedAt, symbol, candidateSide, candidateNotionalDollars, maxWeightPct, lookbackTradingDays,
      'INSUFFICIENT_RETURN_HISTORY',
      `Fewer than ${MIN_RETURN_OVERLAP} real daily-return observations for: ${insufficientSymbols.join(', ')}. Covariance requires real overlapping history for every symbol in the hypothetical portfolio.`,
      equity, cash);
  }

  // Real covariance matrix over REAL historical daily returns - pairwise Pearson covariance
  // (statistics.ts), diagonal = each symbol's own variance (covariance(x, x)).
  const n = allSymbols.length;
  const covMatrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const c = pearsonCovariance(returnsBySymbol.get(allSymbols[i])!, returnsBySymbol.get(allSymbols[j])!, MIN_RETURN_OVERLAP) ?? 0;
      covMatrix[i][j] = c;
      covMatrix[j][i] = c;
    }
  }

  // Real current weights = real marketValue / real equity. Candidate not yet held enters at
  // weight 0 (its "before" weight), matching OjAlgoPortfolioRiskEngine's own contract.
  const weights = allSymbols.map((s) => {
    const pos = positions.find((p) => p.symbol.toUpperCase() === s);
    return pos ? pos.marketValue / equity! : 0;
  });
  const candidateIndex = allSymbols.indexOf(symbol);
  const candidateWeightDelta = candidateSide === 'BUY'
    ? candidateNotionalDollars / equity!
    : -Math.min(candidateNotionalDollars / equity!, weights[candidateIndex]); // SELL cannot exceed real held weight

  const holdings: HoldingSnapshot[] = allSymbols.map((s, i) => ({
    symbol: s,
    marketValue: positions.find((p) => p.symbol.toUpperCase() === s)?.marketValue ?? 0,
    currentWeight: weights[i],
    returnObservations: returnsBySymbol.get(s)?.length ?? 0,
  }));

  const [riskResult, optimizerResult] = await Promise.all([
    quantCoreBridge.fetchResearchStrategy('ojalgo_portfolio_risk', 'PORTFOLIO', [ONE_MINIMAL_BAR], {
      covariance: covMatrix, weights, candidateIndex, candidateWeightDelta, maxWeightPct,
    }),
    quantCoreBridge.fetchResearchStrategy('portfolio_min_variance_optimizer', 'PORTFOLIO', [ONE_MINIMAL_BAR], {
      covariance: covMatrix, maxWeightPct,
    }),
  ]);

  if (!riskResult && !optimizerResult) {
    return baseReport(generatedAt, symbol, candidateSide, candidateNotionalDollars, maxWeightPct, lookbackTradingDays,
      'JAVA_QUANT_CORE_UNAVAILABLE', 'Java quant core unreachable, disabled, or circuit-open for both ojalgo_portfolio_risk and portfolio_min_variance_optimizer.',
      equity, cash, holdings);
  }

  const riskContribution = riskResult ? {
    currentPortfolioVariance: numOrNull(riskResult.currentPortfolioVariance),
    proposedPortfolioVariance: numOrNull(riskResult.proposedPortfolioVariance),
    marginalRiskContributionPct: numOrNull(riskResult.marginalRiskContributionPct),
    candidateWeightBefore: numOrNull(riskResult.candidateWeightBefore),
    candidateWeightAfter: numOrNull(riskResult.candidateWeightAfter),
    exceedsMaxWeight: typeof riskResult.exceedsMaxWeight === 'boolean' ? riskResult.exceedsMaxWeight : null,
  } : null;

  let minVarianceOptimizer: PortfolioImpactReport['minVarianceOptimizer'] = null;
  if (optimizerResult) {
    const optStatus = String(optimizerResult.status ?? 'UNKNOWN');
    const rawWeights = Array.isArray(optimizerResult.weights) ? optimizerResult.weights as number[] : [];
    const recommendedWeights: Record<string, number> = {};
    if (optStatus === 'OPTIMAL' && rawWeights.length === allSymbols.length) {
      for (let i = 0; i < allSymbols.length; i++) recommendedWeights[allSymbols[i]] = rawWeights[i];
    }
    minVarianceOptimizer = {
      optimizerStatus: optStatus,
      recommendedWeights,
      portfolioVariance: numOrNull(optimizerResult.portfolioVariance),
    };
  }

  return {
    reportVersion: PORTFOLIO_IMPACT_REPORT_VERSION, generatedAt, status: 'OK', detail: null, advisory: true,
    candidateSymbol: symbol, candidateSide, candidateWeightDelta,
    currentEquity: equity, currentCash: cash, holdings, lookbackTradingDays, maxWeightPctUsed: maxWeightPct,
    riskContribution, minVarianceOptimizer,
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function baseReport(
  generatedAt: string, symbol: string, candidateSide: 'BUY' | 'SELL', candidateNotionalDollars: number,
  maxWeightPct: number, lookbackTradingDays: number, status: PortfolioImpactStatus, detail: string,
  equity: number | null = null, cash: number | null = null, holdings: HoldingSnapshot[] = [],
): PortfolioImpactReport {
  return {
    reportVersion: PORTFOLIO_IMPACT_REPORT_VERSION, generatedAt, status, detail, advisory: true,
    candidateSymbol: symbol, candidateSide, candidateWeightDelta: 0,
    currentEquity: equity, currentCash: cash, holdings, lookbackTradingDays, maxWeightPctUsed: maxWeightPct,
    riskContribution: null, minVarianceOptimizer: null,
  };
}

export function formatPortfolioImpactReport(r: PortfolioImpactReport): string {
  const lines: string[] = [];
  lines.push(`Portfolio Candidate-Impact Report (${r.reportVersion}) - ADVISORY ONLY, never a live order/target.`);
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Candidate: ${r.candidateSide} ${r.candidateSymbol}, status=${r.status}`);
  if (r.detail) lines.push(`Detail: ${r.detail}`);
  if (r.status !== 'OK') return lines.join('\n');
  lines.push(`Equity: $${r.currentEquity?.toFixed(2)}  Cash: $${r.currentCash?.toFixed(2)}`);
  lines.push(`Candidate weight delta (hypothetical): ${(r.candidateWeightDelta * 100).toFixed(2)}%`);
  lines.push('');
  lines.push('Current holdings:');
  for (const h of r.holdings) {
    lines.push(`  ${h.symbol}: weight=${(h.currentWeight * 100).toFixed(2)}%  marketValue=$${h.marketValue.toFixed(2)}  returnObs=${h.returnObservations}`);
  }
  if (r.riskContribution) {
    const rc = r.riskContribution;
    lines.push('');
    lines.push('Marginal risk contribution (OjAlgoPortfolioRiskEngine.java, advisory):');
    lines.push(`  currentPortfolioVariance=${rc.currentPortfolioVariance ?? 'null'}`);
    lines.push(`  proposedPortfolioVariance=${rc.proposedPortfolioVariance ?? 'null'}`);
    lines.push(`  marginalRiskContributionPct=${rc.marginalRiskContributionPct ?? 'null'}`);
    lines.push(`  candidateWeight before/after=${rc.candidateWeightBefore ?? 'null'} -> ${rc.candidateWeightAfter ?? 'null'}`);
    lines.push(`  exceedsMaxWeight(${r.maxWeightPctUsed})=${rc.exceedsMaxWeight ?? 'null'}`);
  } else {
    lines.push('');
    lines.push('Marginal risk contribution: UNAVAILABLE (Java quant core unreachable/disabled for ojalgo_portfolio_risk).');
  }
  if (r.minVarianceOptimizer) {
    lines.push('');
    lines.push(`Minimum-variance optimizer (PortfolioOptimizationEngine.java, advisory, status=${r.minVarianceOptimizer.optimizerStatus}):`);
    if (r.minVarianceOptimizer.optimizerStatus === 'OPTIMAL') {
      for (const [sym, w] of Object.entries(r.minVarianceOptimizer.recommendedWeights)) {
        lines.push(`  ${sym}: recommended=${(w * 100).toFixed(2)}%`);
      }
      lines.push(`  portfolioVariance=${r.minVarianceOptimizer.portfolioVariance ?? 'null'}`);
    }
  } else {
    lines.push('');
    lines.push('Minimum-variance optimizer: UNAVAILABLE (Java quant core unreachable/disabled for portfolio_min_variance_optimizer).');
  }
  lines.push('');
  lines.push('This report is research/advisory output only. It never places, sizes, or authorizes any order.');
  return lines.join('\n');
}
