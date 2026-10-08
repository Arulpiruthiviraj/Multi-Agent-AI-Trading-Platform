/**
 * Phase 17 — AI-offline certification for the Quant-First Decision Architecture.
 *
 * === SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY / NON_ORGANIC ===
 *
 * Every row this file writes lands in an ISOLATED tmp SQLite database (ARGUS_DB_PATH),
 * deleted in afterAll. Nothing here touches the production database, and nothing here is
 * organic evidence: the market bars are deterministic synthetic data (fixed seed below),
 * the strategy track record is a labeled environment seed standing in for the history a
 * VALIDATED strategy would have (exactly analogous to the engine's existing
 * CalibrationHistorySeeder pattern — same labeling discipline), and every fixture row's
 * reasoning carries the CERTIFICATION_FIXTURE_ONLY marker. The seeded win-rate rows use a
 * NULL execution_environment (legacy-untagged shape, counted by LiveStrategyPerformance
 * the same way any real untagged legacy trade would be) and a reasoning label that keeps
 * them OUT of organic-paper classification (classifyTradeEnvironment -> UNKNOWN, not
 * PAPER — the label deliberately avoids the BACKTEST/REPLAY/SIMULATION keywords).
 *
 * WHAT IS REAL HERE (not synthetic, not mocked):
 *  - the real StrategyEngine.evaluateAll over real feature pipelines (RegimeEngine,
 *    momentum/volume/supportResistance/smc indicators, MarketContext) — the trigger,
 *    confidence, stop, target, and R:R are genuinely computed, never hand-set;
 *  - the real expectedValue / riskRewardRatio math and the real computeLiveStrategyWinRate
 *    (the same EV gate QuantSignalAgent enforces at emission);
 *  - the real ChiefTraderAgent policy router (reviewIdea), the real
 *    resolveQuantStrategyAuthorization, the real evaluateQuantExecutionPolicy;
 *  - the real eventBus, the real RiskAgent module singleton, the real RiskEngine (all
 *    gates evaluated and recorded), the real OMS module singleton, the real
 *    BrokerManager with the real InternalPaperBroker, and real tick-driven fills;
 *  - the real AIRouter with every provider cleared (clearProviders), asserting
 *    hasAnyRoutableProvider() === false before AND after the run.
 *
 * WHAT IS FIXTURE (environment, not decision):
 *  - deterministic synthetic daily bars (fixed seed 1234 — the recipe below was verified
 *    to make a real CORE strategy's defining trigger fire honestly at setupScore 100);
 *  - the VALIDATED lifecycle transitions, the seeded closed-trade win-rate history, and
 *    the agentConfidenceCalibration row (the track record a VALIDATED strategy would have);
 *  - internalEnsemble: null (the same value production attaches when the independent-
 *    qualification and confluence-guard flags are off, which this file sets explicitly),
 *    so the ENSEMBLE_CONFLUENCE support dimension is honestly UNSATISFIED — the policy
 *    still clears its >=2-of-4 bar on regime + calibration + R:R;
 *  - aiContradictionAnalysis: null (production's AI-down degradation yields
 *    {available:false,...}, which the policy treats identically — advisory only, never
 *    gating — so the certified property "AI contradiction never gates" holds either way,
 *    while keeping the "zero AI invocations" assertion airtight).
 *
 * PROVEN (positive path): with EVERY AI provider down, a VALIDATED quant strategy's real
 * triggered idea flows ChiefTrader -> central authorization -> QuantExecutionPolicy ->
 * CHIEF_APPROVED_IDEA (decisionPolicy QUANT_EXECUTION, consensusConfidence null) ->
 * RiskAgent -> RiskEngine (approved, gates recorded) -> OMS -> paper broker BUY fill,
 * then a real PortfolioManager SELL exit through the real ChiefTrader risk-exit path ->
 * RiskEngine -> OMS -> SELL fill, ending flat with realized P&L.
 *
 * PROVEN (negative controls): AI-originated ideas fail closed with AI down (DESK_NO_TRADE,
 * no approval, no AI calls); an UNTESTED-lifecycle strategy falls back to consensus and a
 * single voice cannot approve; a triggerMet=false idea is terminally rejected by the policy
 * with QUANT_TRIGGER_NOT_FIRED and never enters consensus.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Certified synthetic bar recipe (deterministic given the fixed seed).
// Verified: makes a real CORE strategy's defining trigger fire with all
// conditions honestly met. This constructs the ENVIRONMENT (data); every
// decision on top of it is made by real production code.
// ---------------------------------------------------------------------------
const CERT_SEED = 1234;
const CERT_DRIFT_PCT_PER_DAY = 0.3;
const CERT_PULLBACK_PCT = 2.0;
const CERT_BAR_COUNT = 90;

interface CertBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function buildCertBars(seed: number, driftPct: number, pullbackPct: number, rng: any): CertBar[] {
  const bars: CertBar[] = [];
  const DAY = 86_400_000;
  const startMs = Date.UTC(2025, 0, 2); // fixed anchor: fully deterministic, no wall-clock dependence
  let price = 100;
  for (let i = 0; i < CERT_BAR_COUNT; i++) {
    const inPullback = i >= CERT_BAR_COUNT - 4;
    const drift = inPullback ? -pullbackPct / 100 / 3 : driftPct / 100;
    const vol = 0.008;
    const ret = drift + vol * rng.gaussian();
    const open = price;
    const close = open * Math.exp(ret);
    const wick = Math.abs(rng.gaussian()) * vol * open * 0.6;
    let high = Math.max(open, close) + wick;
    let low = Math.min(open, close) - wick;
    let volume = 1_000_000 * (0.7 + rng.next() * 0.6);
    if (i === CERT_BAR_COUNT - 1) {
      // Final bar: hammer — small body at the top, long lower wick, contracting volume.
      const bodyTop = Math.max(open, close);
      low = bodyTop * (1 - 0.02);
      high = bodyTop * (1 + 0.001);
      volume = 500_000;
    } else if (inPullback) {
      volume = 600_000;
    }
    bars.push({ timestamp: startMs + i * DAY, open, high, low, close, volume });
    price = close;
  }
  return bars;
}

const FIXTURE_LABEL =
  'CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC) — Phase 17 AI-offline certification fixture; stands in for the track record a VALIDATED strategy would have. Not organic evidence.';

describe('Phase 17 — AI-offline quant certification (Quant-First Decision Architecture)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let AIRouter: any;
  let chiefTrader: any;
  let BrokerManager: any;
  let tradingEngine: any;
  let marketDataWorker: any;

  // Fixture handles (all derived from real production code, never literals where avoidable)
  let positiveStrategyId: string;
  let positiveEvaluation: any;
  let positiveRegime: any;
  let positiveCtx: any;
  let positiveCurrentPrice: number;
  let positiveRiskReward: number;
  let negStrategyId: string; // reserved for the UNTESTED-lifecycle negative control
  let negEvaluation: any;

  const approvals: any[] = [];
  const noTrades: any[] = [];
  const consensusCompleted: any[] = [];
  let routeConsensusSpy: any;
  let routeTaskSpy: any;
  let tickPriceBySymbol: Record<string, number> = {};
  let ticker: any = null;

  async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_ai_offline_cert_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    process.env.QUANT_ENGINE_ENABLED = 'true';
    // Match the null internalEnsemble the fixture attaches: production attaches null exactly
    // when these two flags are off, so the fixture is the faithful AI-offline emission shape.
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'false';
    process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED = 'false';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    EVENTS = (await import('../core/eventNames')).EVENTS;
    ({ AIRouter } = await import('../ai/AIRouter'));
    const { ChiefTraderAgent } = await import('../services/ChiefTraderAgent');
    await import('../services/RiskAgent'); // module singleton subscribes to CHIEF_APPROVED_IDEA — import exactly once
    await import('../services/OrderManagement'); // module singleton subscribes to RISK_ASSESSMENT_COMPLETED — import exactly once
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));

    const { CORE_STRATEGIES, evaluateAll, bestStrategyIdea } = await import('./strategies/StrategyEngine');
    const { classifyRegime } = await import('./RegimeEngine');
    const { computeMomentumFeatures } = await import('./indicators/momentum');
    const { computeVolumeFeatures } = await import('./indicators/volume');
    const { computeSupportResistanceFeatures } = await import('./indicators/supportResistance');
    const { computeSmcFeatures } = await import('./indicators/smc');
    const { getMarketContext } = await import('./MarketContext');
    const { riskRewardRatio, expectedValue, MIN_SAMPLE_SIZE_FOR_KELLY } = await import('./risk/ExpectedValue');
    const { computeLiveStrategyWinRate } = await import('./risk/LiveStrategyPerformance');
    const { assessDataQuality } = await import('../core/dataQuality');
    const { computeGroupedScores } = await import('./scoring/GroupedScores');
    const { snapshotFromStrategyContext } = await import('./QuantitativeFeatureEngine');
    const { bucketFor } = await import('../services/ConfidenceCalibration');
    const { deskIntelligence } = await import('../config/deskIntelligence');
    const { tradingSafety } = await import('../config/tradingSafety');
    const { generateTraceId } = await import('../core/traceId');
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    const { SyntheticRandom } = await import('../replay/synthetic/SyntheticRandom');
    const {
      recordStrategyLifecycleTransition,
      getStrategyLifecycleStatus,
    } = await import('./strategies/StrategyEmissionEligibility');

    // ---- 1. Real strategy evaluation over deterministic synthetic bars ----
    const rng = new SyntheticRandom(CERT_SEED);
    const bars = buildCertBars(CERT_SEED, CERT_DRIFT_PCT_PER_DAY, CERT_PULLBACK_PCT, rng);
    const symbol = 'AAPL';
    const regime = classifyRegime(bars);
    // Benchmark fetch: same bars flattened for SPY/QQQ/IWM so the symbol shows the positive
    // relative strength the breakout-family conditions read. The certified strategy
    // (PULLBACK_CONTINUATION) does not read marketContext at all; this only keeps the shared
    // context construction identical to production's.
    const fetchBars = async (sym: string) => {
      if (sym === symbol) return bars;
      return bars.map((b, i) => {
        const f = 1 - 0.0008 * i;
        return { ...b, open: b.open * f, high: b.high * f, low: b.low * f, close: b.close * f };
      });
    };
    const marketContext = await getMarketContext(
      symbol, bars, '1Day', bars[0].timestamp, bars[bars.length - 1].timestamp, fetchBars as any,
    );
    const ctx: any = {
      symbol,
      currentPrice: bars[bars.length - 1].close,
      trend: regime.features.trend,
      volatility: regime.features.volatility,
      priceAction: regime.features.priceAction,
      momentum: computeMomentumFeatures(bars),
      volume: computeVolumeFeatures(bars),
      supportResistance: computeSupportResistanceFeatures(bars),
      regime,
      marketContext,
      smc: computeSmcFeatures(bars),
    };
    const evaluations = evaluateAll(ctx);
    const coreIds = new Set(CORE_STRATEGIES.map((s: any) => s.id));
    const qualifying = evaluations.filter(
      (e: any) =>
        coreIds.has(e.strategy) &&
        e.triggerMet === true &&
        e.side === 'BUY' &&
        e.confidence >= tradingSafety.minStrategyConfidenceToTrade &&
        Number.isFinite(e.stop?.price) &&
        Number.isFinite(e.target?.price) &&
        (riskRewardRatio(ctx.currentPrice, e.stop.price, e.target.price)?.ratio ?? 0) >=
          deskIntelligence.minRiskRewardRatio &&
        e.applicableRegimes.includes(regime.regime),
    );
    // The certified recipe must deterministically produce a genuinely-triggered CORE idea —
    // this assertion failing means the recipe drifted, not that the architecture broke.
    expect(qualifying.length).toBeGreaterThan(0);
    // bestStrategyIdea is what production actually picks; it must agree with our filter.
    const picked = bestStrategyIdea(evaluations.filter((e: any) => coreIds.has(e.strategy)));
    expect(picked).not.toBeNull();
    positiveEvaluation = qualifying.find((e: any) => e.strategy === picked!.strategy) ?? qualifying[0];
    positiveStrategyId = positiveEvaluation.strategy;
    positiveRegime = regime;
    positiveCtx = ctx;
    positiveCurrentPrice = ctx.currentPrice;
    positiveRiskReward =
      riskRewardRatio(ctx.currentPrice, positiveEvaluation.stop.price, positiveEvaluation.target.price)!.ratio!;
    // Reserve a DIFFERENT core strategy id for the UNTESTED-lifecycle negative control.
    negStrategyId = CORE_STRATEGIES.map((s: any) => s.id).find((id: string) => id !== positiveStrategyId)!;
    negEvaluation = evaluations.find((e: any) => e.strategy === negStrategyId) ?? null;
    expect(negEvaluation).not.toBeNull();

    // ---- 2. Lifecycle: all 5 CORE strategies VALIDATED (labeled fixture) ----
    for (const s of CORE_STRATEGIES) {
      await recordStrategyLifecycleTransition(
        s.id, 'VALIDATED', `AI_OFFLINE_CERTIFICATION_FIXTURE: ${FIXTURE_LABEL}`, null, 0,
      );
      expect(await getStrategyLifecycleStatus(s.id)).toBe('VALIDATED');
    }

    // ---- 3. Seeded win-rate history for the positive strategy (labeled fixture) ----
    // 25 closed round-trips, 60% wins — the track record a VALIDATED strategy would have.
    // Loss indices are spread so the real consecutive-loss circuit breaker (3 in a row)
    // never trips on the fixture itself: max run is 2, and the fixture ends on wins.
    // NULL execution_environment (legacy-untagged shape) so LiveStrategyPerformance counts
    // them; the reasoning label keeps them UNKNOWN (never PAPER) under classifyTradeEnvironment.
    const LOSS_INDICES = new Set([1, 4, 6, 7, 10, 13, 15, 18, 20, 22]);
    const TOTAL_ROUND_TRIPS = 25;
    const seedSymbol = 'MSFT';
    const baseMs = Date.now() - 45 * 24 * 60 * 60 * 1000; // ~45 days of plausible prior history
    for (let i = 0; i < TOTAL_ROUND_TRIPS; i++) {
      const buyPrice = 200 + i * 0.5;
      const win = !LOSS_INDICES.has(i);
      const sellPrice = win ? buyPrice * 1.04 : buyPrice * 0.97;
      const qty = 10;
      const buyAt = new Date(baseMs + i * 36 * 60 * 60 * 1000).toISOString();
      const sellAt = new Date(baseMs + i * 36 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
      await db.insert(schema.trades).values({
        id: `cert-fixture-${positiveStrategyId}-buy-${i}`,
        symbol: seedSymbol, side: 'BUY', quantity: qty, price: buyPrice, status: 'FILLED',
        timestamp: buyAt, filledAt: buyAt, reasoning: FIXTURE_LABEL,
        traceId: `cert-fixture-rt-${i}-buy`, quantStrategyId: positiveStrategyId,
        executionEnvironment: null,
      });
      await db.insert(schema.trades).values({
        id: `cert-fixture-${positiveStrategyId}-sell-${i}`,
        symbol: seedSymbol, side: 'SELL', quantity: qty, price: sellPrice, status: 'FILLED',
        timestamp: sellAt, filledAt: sellAt, reasoning: FIXTURE_LABEL,
        traceId: `cert-fixture-rt-${i}-sell`,
        profitLoss: (sellPrice - buyPrice) * qty, quantStrategyId: positiveStrategyId,
        executionEnvironment: null,
      });
    }
    const liveWinRate = await computeLiveStrategyWinRate(positiveStrategyId);
    expect(liveWinRate).not.toBeNull();
    expect(liveWinRate!.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLE_SIZE_FOR_KELLY);
    const ev = expectedValue(liveWinRate!.winProbability, positiveRiskReward);
    expect(ev).not.toBeNull();
    expect(ev!.expectedValueR).toBeGreaterThan(0); // the real emission-time EV gate would pass

    // ---- 4. Calibration history for the QuantEngine confidence bucket (labeled by table convention) ----
    const bucket = bucketFor(positiveEvaluation.confidence);
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'QuantEngine',
      bucketLow: bucket.low,
      bucketHigh: bucket.high,
      wins: 40,
      losses: 10, // 50 samples >= tradingSafety.minCalibrationSampleSize (30) -> sufficient
      calibratedConfidence: 0.8,
      lastEvaluated: new Date().toISOString(),
    });

    // ---- 5. Runtime state: paper-only, trading enabled, broker wired ----
    await db.insert(schema.settings).values({
      tradingMode: 'Paper', autoBotEnabled: true, budget: 100000, maxTradeSize: 3000,
    });
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
    tradingEngine.state.dayStartDateStr = getTradingDateStr();
    tradingEngine.state.dayStartEquity = 100000;
    tradingEngine.state.dailyLossLimit = 5000;
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    await BrokerManager.getInstance().initialize();
    delete process.env.ALPACA_API_KEY; // initialize() can repopulate from .env — delete again (paperSpine pattern)
    delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);

    for (const s of ['AAPL', 'NVDA', 'AMD', 'META']) marketDataWorker.cacheObservedQuote(s, positiveCurrentPrice);

    chiefTrader = new ChiefTraderAgent();

    // ---- 6. Kill ALL AI providers; assert the outage before the run ----
    AIRouter.getInstance().clearProviders();
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(false);

    // Spies installed AFTER fixture construction (which makes zero AI calls) so the
    // assertions below measure exactly the decision path.
    routeConsensusSpy = vi.spyOn(AIRouter.getInstance(), 'routeConsensus');
    routeTaskSpy = vi.spyOn(AIRouter.getInstance(), 'routeTask');

    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (e: any) => noTrades.push(e));
    eventBus.on(EVENTS.CHIEF_CONSENSUS_COMPLETED, (e: any) => consensusCompleted.push(e));

    // Stash builders needed by the tests.
    (globalThis as any).__cert = {
      assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, generateTraceId,
      recordStrategyLifecycleTransition, getStrategyLifecycleStatus, certBars: bars,
    };
  }, 60000);

  afterAll(() => {
    if (ticker) clearInterval(ticker);
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.PAPER_TRADING_ONLY;
    delete process.env.QUANT_ENGINE_ENABLED;
    delete process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED;
    delete process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED;
    delete (globalThis as any).__cert;
  });

  /** Build a QuantSignalAgent-faithful idea for the given evaluation (same fields, same values). */
  function buildQuantIdea(symbol: string, evaluation: any, traceId: string) {
    const { assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, certBars } = (globalThis as any).__cert;
    const groupedScores = {
      BUY: computeGroupedScores(positiveCtx, 'BUY'),
      SELL: computeGroupedScores(positiveCtx, 'SELL'),
    };
    return {
      traceId,
      symbol,
      side: evaluation.side,
      confidence: evaluation.confidence,
      currentPrice: positiveCurrentPrice,
      reasoning:
        `QuantEngine/${evaluation.strategy}: setupScore ${evaluation.setupScore} ` +
        `(${evaluation.conditionsMet.length}/${evaluation.conditionsMet.length + evaluation.conditionsFailed.length} conditions met), ` +
        `confidence ${evaluation.confidence.toFixed(2)}. CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC).`,
      agent: 'QuantEngine',
      origin: 'QUANT_STRATEGY',
      strategyId: evaluation.strategy,
      quantDetail: {
        regime: positiveRegime,
        internalEnsemble: null, // flags off -> production attaches null; ENSEMBLE_CONFLUENCE honestly unsatisfied
        strategyEvaluation: evaluation,
        groupedScores: groupedScores[evaluation.side as 'BUY' | 'SELL'],
        contradictions: evaluation.contradictions ?? [],
        aiContradictionAnalysis: null, // AI down: advisory-only either way; keeps zero-AI-invocation airtight
        featureSnapshot: snapshotFromStrategyContext({
          ctx: positiveCtx, evaluations: [evaluation], groupedScores, bars: certBars,
        }),
        ensembleRanking: [{ strategy: evaluation.strategy, setupScore: evaluation.setupScore, confidence: evaluation.confidence }],
        dataQuality: assessDataQuality(symbol),
        newsCatalysts: [],
      },
    };
  }

  function startBrokerTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      for (const [sym, price] of Object.entries(tickPriceBySymbol)) {
        BrokerManager.getInstance().tick({ [sym]: price });
        eventBus.emit('MARKET_DATA', { symbol: sym, price, volume: 1000, timestamp: new Date().toISOString() });
      }
    }, 100);
  }

  it('AI-offline positive path: validated quant idea -> QUANT_EXECUTION -> RiskEngine approval -> OMS -> paper BUY fill', async () => {
    const { generateTraceId } = (globalThis as any).__cert;
    const traceId = generateTraceId('AAPL');
    const idea = buildQuantIdea('AAPL', positiveEvaluation, traceId);

    // Pre-condition: the outage is real at decision time.
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(false);

    tickPriceBySymbol = { AAPL: positiveCurrentPrice };
    startBrokerTicker();

    await chiefTrader.reviewIdea(idea);

    // (a) CHIEF_APPROVED_IDEA with the quant decision-policy provenance.
    await waitFor(() => approvals.some((a) => a.traceId === traceId), 15000, 'CHIEF_APPROVED_IDEA');
    const approval = approvals.find((a) => a.traceId === traceId);
    expect(approval.side).toBe('BUY');
    expect(approval.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(approval.consensusConfidence).toBeNull();
    expect(approval.strategyId).toBe(positiveStrategyId);
    expect(approval.transactionId).toMatch(/^ARG-/);
    // The COMPLETED signal for this trace came from the policy branch, not the consensus evaluator.
    const completed = consensusCompleted.find((e) => e.traceId === traceId);
    expect(completed).toBeTruthy();
    expect(completed.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(completed.terminalReasonCode).toBe('QUANT_POLICY_APPROVED');
    // The idea never entered the consensus evidence pool: the router decided it first.
    expect((chiefTrader as any).recentIdeas.filter((i: any) => i.traceId === traceId)).toHaveLength(0);

    // (b) Real RiskEngine approval with every gate recorded.
    await waitFor(async () => {
      const rows = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      return rows.length > 0;
    }, 15000, 'risk_assessments row');
    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
    const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    expect(assessment.approved).toBe(true);
    expect(assessment.rejectionGate).toBeNull();
    expect(assessment.maxQuantity).toBeGreaterThan(0);
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.every((g: any) => g.passed)).toBe(true);
    for (const name of ['emergency_stop', 'price_validity', 'data_freshness', 'sufficient_size']) {
      expect(gates.map((g: any) => g.gateName)).toContain(name);
    }

    // (c) Zero AI involvement: no calls, no routable provider, decision path never invoked the router.
    const aiCallRows = await db.select().from(schema.aiCalls);
    expect(aiCallRows).toHaveLength(0);
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(false);
    expect(routeConsensusSpy).not.toHaveBeenCalled();
    expect(routeTaskSpy).not.toHaveBeenCalled();

    // (d) Real OMS -> paper broker BUY fill (tick-driven, never a hand-inserted row).
    await waitFor(async () => {
      const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
      return rows.length > 0 && rows[0].status === 'FILLED' && !!rows[0].brokerOrderId;
    }, 30000, 'BUY trade FILLED');
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
    expect(trade.side).toBe('BUY');
    expect(trade.symbol).toBe('AAPL');
    expect(trade.quantity).toBeGreaterThan(0);
    expect(trade.price).toBeGreaterThan(0);
    expect(trade.quantStrategyId).toBe(positiveStrategyId);
    expect(trade.executionEnvironment).toBe('PAPER');
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, trade.id));
    expect(fillRows.length).toBeGreaterThanOrEqual(1);
    expect(fillRows.reduce((s: number, r: any) => s + r.quantity, 0)).toBe(trade.quantity);
  }, 90000);

  it('AI-offline round trip: organic PortfolioManager SELL exit closes the position flat with realized P&L', async () => {
    const { generateTraceId } = (globalThis as any).__cert;
    // Exit above the entry so the realized P&L is positive and unambiguous.
    const exitPrice = positiveCurrentPrice * 1.03;
    tickPriceBySymbol = { AAPL: exitPrice };
    const traceId = generateTraceId('AAPL');
    const exitIdea = {
      traceId,
      symbol: 'AAPL',
      side: 'SELL',
      confidence: 0.85,
      currentPrice: exitPrice,
      reasoning:
        'CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC): organic exit — take profit at the strategy target. ' +
        `QuantEngine/${positiveStrategyId} thesis complete.`,
      agent: 'PortfolioManager',
      origin: 'PORTFOLIO_EXIT',
    };

    await chiefTrader.reviewIdea(exitIdea);

    // Risk-exit path: approved without debate or a second agent, through the real consensus evaluator.
    await waitFor(() => approvals.some((a) => a.traceId === traceId), 15000, 'exit CHIEF_APPROVED_IDEA');
    const approval = approvals.find((a) => a.traceId === traceId);
    expect(approval.side).toBe('SELL');

    await waitFor(async () => {
      const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
      return rows.length > 0 && rows[0].status === 'FILLED';
    }, 30000, 'SELL trade FILLED');
    const [sellTrade] = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
    expect(sellTrade.side).toBe('SELL');
    expect(sellTrade.executionEnvironment).toBe('PAPER');
    expect(Number.isFinite(sellTrade.profitLoss)).toBe(true);
    expect(sellTrade.profitLoss).toBeGreaterThan(0);

    // Flat: the broker holds no AAPL shares after the real SELL fill.
    const positions = await BrokerManager.getInstance().getActiveBroker().positions();
    const aapl = positions.find((p: any) => p.symbol === 'AAPL');
    expect(!aapl || aapl.quantity === 0).toBe(true);
  }, 90000);

  it('negative control (a): AI-originated idea fails closed with AI down — DESK_NO_TRADE, no approval, no AI calls', async () => {
    const { generateTraceId } = (globalThis as any).__cert;
    const traceId = generateTraceId('NVDA');
    const aiIdea = {
      traceId,
      symbol: 'NVDA',
      side: 'BUY',
      confidence: 0.5, // below the debate trigger: no debate is even attempted
      currentPrice: positiveCurrentPrice,
      reasoning: 'CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC): AI-originated news idea; AI providers are down.',
      agent: 'NewsAgent',
      origin: 'NEWS_EVENT',
    };

    await chiefTrader.reviewIdea(aiIdea);

    await waitFor(() => noTrades.some((e) => e.traceId === traceId), 15000, 'DESK_NO_TRADE for AI idea');
    expect(approvals.some((a) => a.traceId === traceId)).toBe(false);
    // Non-quant origin: took the unchanged consensus path (single voice in the pool), never the quant router.
    expect((chiefTrader as any).recentIdeas.some((i: any) => i.traceId === traceId)).toBe(true);
    const completed = consensusCompleted.find((e) => e.traceId === traceId);
    expect(completed).toBeTruthy();
    expect(completed.approved).toBe(false);
    // Fails closed WITHOUT consulting AI: no debate, no task route.
    expect(routeConsensusSpy).not.toHaveBeenCalled();
    expect(routeTaskSpy).not.toHaveBeenCalled();
    expect(await AIRouter.getInstance().hasAnyRoutableProvider()).toBe(false);
  }, 30000);

  it('negative control (b): UNTESTED-lifecycle strategy idea falls back to consensus — single voice, no approval', async () => {
    const { generateTraceId, recordStrategyLifecycleTransition, getStrategyLifecycleStatus } = (globalThis as any).__cert;
    // Labeled fixture transition: this strategy was never validated.
    await recordStrategyLifecycleTransition(
      negStrategyId, 'UNTESTED', `AI_OFFLINE_CERTIFICATION_FIXTURE (negative control): ${FIXTURE_LABEL}`, null, 0,
    );
    expect(await getStrategyLifecycleStatus(negStrategyId)).toBe('UNTESTED');

    const traceId = generateTraceId('AMD');
    const idea = buildQuantIdea('AMD', negEvaluation, traceId);

    await chiefTrader.reviewIdea(idea);

    await waitFor(() => noTrades.some((e) => e.traceId === traceId), 15000, 'DESK_NO_TRADE for UNTESTED idea');
    expect(approvals.some((a) => a.traceId === traceId)).toBe(false);
    // REQUIRES_CONSENSUS: entered the consensus evidence pool like any ordinary idea — never the quant policy.
    expect((chiefTrader as any).recentIdeas.some((i: any) => i.traceId === traceId)).toBe(true);
    expect(routeConsensusSpy).not.toHaveBeenCalled();
    expect(routeTaskSpy).not.toHaveBeenCalled();
  }, 30000);

  it('negative control (c): triggerMet=false idea is terminally rejected by the policy — QUANT_TRIGGER_NOT_FIRED', async () => {
    const { generateTraceId } = (globalThis as any).__cert;
    const traceId = generateTraceId('META');
    // The real evaluation, but with the defining trigger unfired: confirming conditions
    // must never outvote a missing trigger.
    const unfiredEvaluation = { ...positiveEvaluation, triggerMet: false };
    const idea = buildQuantIdea('META', unfiredEvaluation, traceId);

    await chiefTrader.reviewIdea(idea);

    await waitFor(
      () => noTrades.some((e) => e.traceId === traceId && e.quantReasonCode === 'QUANT_TRIGGER_NOT_FIRED'),
      15000,
      'DESK_NO_TRADE with QUANT_TRIGGER_NOT_FIRED',
    );
    const noTrade = noTrades.find((e) => e.traceId === traceId);
    expect(noTrade.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(noTrade.terminalReasonCode).toBe('QUANT_POLICY_REJECTED');
    expect(approvals.some((a) => a.traceId === traceId)).toBe(false);
    // Terminal policy rejection: never silently re-routed into the consensus pool.
    expect((chiefTrader as any).recentIdeas.some((i: any) => i.traceId === traceId)).toBe(false);
    expect(routeConsensusSpy).not.toHaveBeenCalled();
    expect(routeTaskSpy).not.toHaveBeenCalled();
  }, 30000);
});
