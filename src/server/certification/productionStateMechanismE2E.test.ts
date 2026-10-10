// LABEL: MECHANISM_E2E
/**
 * PRODUCTION_STATE / MECHANISM_E2E (2026-10-09).
 *
 * === Read this header before interpreting any result from this file ===
 *
 * What this test proves: the critical decision branches between strategy
 * authorization and a paper fill are REAL, WIRED, and EXECUTABLE — when a
 * strategy holds a VALIDATED lifecycle row, an idea from it flows through
 * authorization -> QuantExecutionPolicy -> ChiefTrader approval -> RiskAgent ->
 * RiskEngine -> PositionSizing -> OMS -> paper fill. Every assertion below is
 * grounded in RUNTIME EVIDENCE (rows in observability_events / event_traces /
 * risk_assessments / risk_gate_results / trades / fills written by the real
 * production code) — never mocks, never injected approvals, never injected
 * fills.
 *
 * What this test does NOT prove (standing testing principle): that tomorrow's
 * real Argus state can naturally reach the trading path. The VALIDATED row is
 * recorded via the real transition mechanism into an ISOLATED temp DB, and the
 * market bars are SYNTHETIC_SEEDED (CERTIFICATION_FIXTURE_ONLY, NON_ORGANIC) —
 * this is the ENVIRONMENT, not the decision. A seeded VALIDATED proves the
 * mechanism, never readiness. See productionStateCertification.test.ts for the
 * state-certification half of Layer 3.
 *
 * Why not a full SyntheticSessionEngine.run() session here: a 6-minute
 * QUIET_OPEN session cannot deterministically produce an approved quant trade
 * (the Oct-9 audit itself showed thousands of below-confidence rounds and zero
 * fills) — asserting DEAD_BRANCH_NOT_CERTIFIED on branches a scenario simply
 * did not reach would be a false failure, not evidence of a dead branch. This
 * file instead drives the SAME production entry point a real idea takes
 * (chiefTrader.reviewIdea) with a genuinely-evaluated idea, through the real
 * module singletons (ChiefTraderAgent, RiskAgent, OrderManagement), the real
 * RiskEngine, the real PositionSizing, and the real OMS into the real
 * internal_paper broker — the identical harness the Phase-17 AI-offline
 * certification uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq, and } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Deterministic synthetic bar recipe (same as the Phase-17 AI-offline
// certification: constructs the ENVIRONMENT; every decision is made by real
// production code). SYNTHETIC_SEEDED / NON_ORGANIC / CERTIFICATION_FIXTURE_ONLY.
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
  const startMs = Date.UTC(2025, 0, 2); // fixed anchor: fully deterministic
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
  'CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC) — Layer-3 mechanism-E2E fixture; stands in for the track record a VALIDATED strategy would have. Not organic evidence.';

describe('production-state mechanism E2E: critical branches execute (PRODUCTION_STATE / MECHANISM_E2E)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let chiefTrader: any;
  let BrokerManager: any;
  let tradingEngine: any;
  let marketDataWorker: any;
  let flushObservabilityStore: () => Promise<void>;

  let positiveStrategyId: string;
  let positiveEvaluation: any;
  let positiveRegime: any;
  let positiveCtx: any;
  let positiveCurrentPrice: number;
  let positiveRiskReward: number;

  let ticker: any = null;
  let tickPriceBySymbol: Record<string, number> = {};
  const approvals: any[] = [];

  async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function startBrokerTicker() {
    if (ticker) return;
    ticker = setInterval(() => {
      for (const [sym, price] of Object.entries(tickPriceBySymbol)) {
        marketDataWorker.cacheObservedQuote(sym, price);
        BrokerManager.getInstance().tick({ [sym]: price });
        eventBus.emit('MARKET_DATA', { symbol: sym, price, volume: 1000, timestamp: new Date().toISOString() });
      }
    }, 100);
  }

  /** Build a QuantSignalAgent-faithful idea for the given evaluation. */
  function buildQuantIdea(symbol: string, evaluation: any, traceId: string, helpers: any) {
    const { assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, certBars } = helpers;
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
        `confidence ${evaluation.confidence.toFixed(2)}. ${FIXTURE_LABEL}`,
      agent: 'QuantEngine',
      origin: 'QUANT_STRATEGY',
      strategyId: evaluation.strategy,
      quantDetail: {
        regime: positiveRegime,
        internalEnsemble: null, // flags off -> production attaches null; ENSEMBLE_CONFLUENCE honestly unsatisfied
        strategyEvaluation: evaluation,
        groupedScores: groupedScores[evaluation.side as 'BUY' | 'SELL'],
        contradictions: evaluation.contradictions ?? [],
        aiContradictionAnalysis: null,
        featureSnapshot: snapshotFromStrategyContext({
          ctx: positiveCtx, evaluations: [evaluation], groupedScores, bars: certBars,
        }),
        ensembleRanking: [{ strategy: evaluation.strategy, setupScore: evaluation.setupScore, confidence: evaluation.confidence }],
        dataQuality: assessDataQuality(symbol),
        newsCatalysts: [],
      },
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_prodmech_e2e_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM;
    process.env.QUANT_ENGINE_ENABLED = 'true';
    // Match the null internalEnsemble the fixture attaches: production attaches null exactly
    // when these two flags are off, so the fixture is the faithful AI-offline emission shape.
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'false';
    process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED = 'false';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    EVENTS = (await import('../core/eventNames')).EVENTS;
    const { chiefTrader: canonicalChiefTrader } = await import('../services/ChiefTraderAgent');
    await import('../services/RiskAgent'); // module singleton subscribes to CHIEF_APPROVED_IDEA — import exactly once
    await import('../services/OrderManagement'); // module singleton subscribes to RISK_ASSESSMENT_COMPLETED — import exactly once
    ({ BrokerManager } = await import('../../brokers/BrokerManager'));
    ({ tradingEngine } = await import('../engines/TradingEngine'));
    ({ marketDataWorker } = await import('../services/MarketDataWorker'));
    ({ flushObservabilityStore } = await import('../observability/ObservabilityStore'));

    const { CORE_STRATEGIES, evaluateAll, bestStrategyIdea } = await import('../quant/strategies/StrategyEngine');
    const { classifyRegime } = await import('../quant/RegimeEngine');
    const { computeMomentumFeatures } = await import('../quant/indicators/momentum');
    const { computeVolumeFeatures } = await import('../quant/indicators/volume');
    const { computeSupportResistanceFeatures } = await import('../quant/indicators/supportResistance');
    const { computeSmcFeatures } = await import('../quant/indicators/smc');
    const { getMarketContext } = await import('../quant/MarketContext');
    const { riskRewardRatio, expectedValue, MIN_SAMPLE_SIZE_FOR_KELLY } = await import('../quant/risk/ExpectedValue');
    const { computeLiveStrategyWinRate } = await import('../quant/risk/LiveStrategyPerformance');
    const { assessDataQuality } = await import('../core/dataQuality');
    const { computeGroupedScores } = await import('../quant/scoring/GroupedScores');
    const { snapshotFromStrategyContext } = await import('../quant/QuantitativeFeatureEngine');
    const { bucketFor } = await import('../services/ConfidenceCalibration');
    const { deskIntelligence } = await import('../config/deskIntelligence');
    const { tradingSafety } = await import('../config/tradingSafety');
    const { generateTraceId } = await import('../core/traceId');
    const { getTradingDateStr } = await import('../core/TradingCalendar');
    const { SyntheticRandom } = await import('../replay/synthetic/SyntheticRandom');
    const {
      recordStrategyLifecycleTransition,
      getStrategyLifecycleStatus,
    } = await import('../quant/strategies/StrategyEmissionEligibility');

    // ---- 1. Real strategy evaluation over deterministic synthetic bars ----
    const rng = new SyntheticRandom(CERT_SEED);
    const bars = buildCertBars(CERT_SEED, CERT_DRIFT_PCT_PER_DAY, CERT_PULLBACK_PCT, rng);
    const symbol = 'AAPL';
    const regime = classifyRegime(bars);
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
    // The recipe must deterministically produce a genuinely-triggered CORE idea —
    // this failing means the recipe drifted, not that the architecture broke.
    expect(qualifying.length).toBeGreaterThan(0);
    const picked = bestStrategyIdea(evaluations.filter((e: any) => coreIds.has(e.strategy)));
    expect(picked).not.toBeNull();
    positiveEvaluation = qualifying.find((e: any) => e.strategy === picked!.strategy) ?? qualifying[0];
    positiveStrategyId = positiveEvaluation.strategy;
    positiveRegime = regime;
    positiveCtx = ctx;
    positiveCurrentPrice = ctx.currentPrice;
    positiveRiskReward =
      riskRewardRatio(ctx.currentPrice, positiveEvaluation.stop.price, positiveEvaluation.target.price)!.ratio!;

    // ---- 2. Lifecycle: ONE strategy VALIDATED via the real canonical mechanism ----
    // MECHANISM_E2E: isolated test data in a temp DB — tests the transition mechanism,
    // never production authority.
    await recordStrategyLifecycleTransition(
      positiveStrategyId,
      'VALIDATED',
      `LAYER3_MECHANISM_E2E: ${FIXTURE_LABEL}`,
      { testControl: true, backtestWinRate: 0.62, sampleTrades: 120 },
      120,
    );
    expect(await getStrategyLifecycleStatus(positiveStrategyId)).toBe('VALIDATED');

    // ---- 3. Seeded win-rate history for the positive strategy (labeled fixture) ----
    // 25 closed round-trips, 60% wins — the track record a VALIDATED strategy would have.
    // Loss indices are spread so the real consecutive-loss circuit breaker (3 in a row)
    // never trips on the fixture itself. NULL execution_environment (legacy-untagged
    // shape) so LiveStrategyPerformance counts them.
    const LOSS_INDICES = new Set([1, 4, 6, 7, 10, 13, 15, 18, 20, 22]);
    const TOTAL_ROUND_TRIPS = 25;
    const seedSymbol = 'MSFT';
    const baseMs = Date.now() - 45 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < TOTAL_ROUND_TRIPS; i++) {
      const buyPrice = 200 + i * 0.5;
      const win = !LOSS_INDICES.has(i);
      const sellPrice = win ? buyPrice * 1.04 : buyPrice * 0.97;
      const qty = 10;
      const buyAt = new Date(baseMs + i * 36 * 60 * 60 * 1000).toISOString();
      const sellAt = new Date(baseMs + i * 36 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
      await db.insert(schema.trades).values({
        id: `mech-e2e-${positiveStrategyId}-buy-${i}`,
        symbol: seedSymbol, side: 'BUY', quantity: qty, price: buyPrice, status: 'FILLED',
        timestamp: buyAt, filledAt: buyAt, reasoning: FIXTURE_LABEL,
        traceId: `mech-e2e-rt-${i}-buy`, quantStrategyId: positiveStrategyId,
        executionEnvironment: null,
      });
      await db.insert(schema.trades).values({
        id: `mech-e2e-${positiveStrategyId}-sell-${i}`,
        symbol: seedSymbol, side: 'SELL', quantity: qty, price: sellPrice, status: 'FILLED',
        timestamp: sellAt, filledAt: sellAt, reasoning: FIXTURE_LABEL,
        traceId: `mech-e2e-rt-${i}-sell`,
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

    // ---- 4. Calibration history for the QuantEngine confidence bucket ----
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

    chiefTrader = canonicalChiefTrader;

    // In-process capture of the approval (real EventBus listener, not a mock).
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));

    // Stash builders needed by the test.
    (globalThis as any).__mechE2E = {
      assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, generateTraceId, certBars: bars,
    };
  }, 120000);

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
    delete (globalThis as any).__mechE2E;
  });

  it('every critical branch from authorization to paper fill executed — runtime evidence, zero mocks', async () => {
    const { generateTraceId } = (globalThis as any).__mechE2E;
    const traceId = generateTraceId('AAPL');
    const idea = buildQuantIdea('AAPL', positiveEvaluation, traceId, (globalThis as any).__mechE2E);

    tickPriceBySymbol = { AAPL: positiveCurrentPrice };
    startBrokerTicker();

    // Drive the SAME production entry point a real idea takes.
    await chiefTrader.reviewIdea(idea);

    // --- Pipeline must complete first (real modules, real DB writes) ---
    await waitFor(() => approvals.some((a) => a.traceId === traceId), 30000, 'CHIEF_APPROVED_IDEA');
    const approval = approvals.find((a) => a.traceId === traceId);
    expect(approval.side).toBe('BUY');
    expect(approval.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(approval.strategyId).toBe(positiveStrategyId);

    await waitFor(async () => {
      const rows = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
      return rows.length > 0;
    }, 30000, 'risk_assessments row');

    await waitFor(async () => {
      const rows = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
      return rows.length > 0 && rows[0].status === 'FILLED' && !!rows[0].brokerOrderId;
    }, 60000, 'BUY trade FILLED');
    const [trade] = await db.select().from(schema.trades).where(eq(schema.trades.traceId, traceId));
    expect(trade.side).toBe('BUY');
    expect(trade.quantStrategyId).toBe(positiveStrategyId);
    expect(trade.executionEnvironment).toBe('PAPER');
    const fillRows = await db.select().from(schema.fills).where(eq(schema.fills.orderId, trade.id));
    expect(fillRows.length).toBeGreaterThanOrEqual(1);

    // --- Branch evidence: observability_events + event_traces for THIS traceId ---
    // The store flushes asynchronously; force-flush then poll.
    const missing: string[] = [];
    const note = (branch: string, ok: boolean, evidence: string) => {
      if (!ok) missing.push(`${branch}: DEAD_BRANCH_NOT_CERTIFIED (expected ${evidence})`);
    };

    const obsEvents = async (eventType: string) => {
      await flushObservabilityStore();
      return db
        .select()
        .from(schema.observabilityEvents)
        .where(
          and(
            eq(schema.observabilityEvents.eventType, eventType),
            eq(schema.observabilityEvents.traceId, traceId),
          ),
        );
    };
    const traces = async (eventType: string) => {
      return db
        .select()
        .from(schema.eventTraces)
        .where(
          and(
            eq(schema.eventTraces.eventType, eventType),
            eq(schema.eventTraces.correlationId, traceId),
          ),
        );
    };
    const payloadOf = (row: any) => {
      try {
        return row?.payload ? JSON.parse(row.payload) : {};
      } catch {
        return {};
      }
    };

    // B1: authorization checked — resolveQuantStrategyAuthorization ran for this idea.
    await waitFor(async () => (await obsEvents('STRATEGY_AUTHORIZATION_CHECKED')).length > 0, 30000, 'STRATEGY_AUTHORIZATION_CHECKED evidence');
    const authRows = await obsEvents('STRATEGY_AUTHORIZATION_CHECKED');
    const authPayload = payloadOf(authRows[0]);
    // NOTE: the payload's `authorization` / `authorizationReason` VALUES are stored as
    // "[REDACTED]" by production's own redactSecretsDeep (SecretRedaction.ts's
    // SENSITIVE_KEY matches any key containing "authorization" — a known
    // over-redaction quirk of the observability pipeline, not something this test
    // works around). The unredacted fields — strategyId and strategyLifecycle —
    // prove the check ran for this idea and resolved this strategy's VALIDATED
    // lifecycle state; the granted authority itself is independently proven by B2
    // (decisionPolicy=QUANT_EXECUTION is selected in production code ONLY when
    // authority === 'AUTHORIZED_QUANT_POLICY') and by the full downstream path.
    note(
      'B1 authorization checked (resolveQuantStrategyAuthorization)',
      authRows.length > 0 &&
        authPayload.strategyId === positiveStrategyId &&
        authPayload.strategyLifecycle === 'VALIDATED',
      'observability_events STRATEGY_AUTHORIZATION_CHECKED with this strategyId + VALIDATED lifecycle',
    );

    // B2: QuantExecutionPolicy selected — the router chose QUANT_EXECUTION for this idea.
    await waitFor(async () => (await obsEvents('CHIEF_DECISION_POLICY_SELECTED')).length > 0, 30000, 'CHIEF_DECISION_POLICY_SELECTED evidence');
    const policyRows = await obsEvents('CHIEF_DECISION_POLICY_SELECTED');
    const policyPayload = payloadOf(policyRows[0]);
    note(
      'B2 QuantExecutionPolicy selected',
      policyRows.length > 0 && policyPayload.decisionPolicy === 'QUANT_EXECUTION',
      'observability_events CHIEF_DECISION_POLICY_SELECTED with decisionPolicy=QUANT_EXECUTION',
    );

    // B3: ChiefTrader approval emitted.
    await waitFor(async () => (await traces('CHIEF_APPROVED_IDEA')).length > 0, 30000, 'CHIEF_APPROVED_IDEA trace');
    const approvalTraces = await traces('CHIEF_APPROVED_IDEA');
    note(
      'B3 ChiefTrader approval emitted',
      approvalTraces.length > 0 && approvals.some((a: any) => a.traceId === traceId),
      'event_traces CHIEF_APPROVED_IDEA for the trace',
    );

    // B4: RiskAgent received — the module singleton wired to CHIEF_APPROVED_IDEA
    // forwarded the proposal into RiskEngine (RISK_ASSESSMENT_STARTED is emitted
    // by RiskEngine on the proposal RiskAgent delivered).
    await waitFor(async () => (await traces('RISK_ASSESSMENT_STARTED')).length > 0, 30000, 'RISK_ASSESSMENT_STARTED trace');
    const startedTraces = await traces('RISK_ASSESSMENT_STARTED');
    note(
      'B4 RiskAgent received (forwarded to RiskEngine)',
      startedTraces.length > 0,
      'event_traces RISK_ASSESSMENT_STARTED for the trace',
    );

    // B5: RiskEngine evaluated — real assessment + every gate recorded.
    const [assessment] = await db.select().from(schema.riskAssessments).where(eq(schema.riskAssessments.traceId, traceId));
    const gateRows = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const gateEvalTraces = await traces('RISK_GATE_EVALUATED');
    note(
      'B5 RiskEngine evaluated',
      !!assessment && assessment.approved === true && gateRows.length > 0 && gateEvalTraces.length > 0,
      'risk_assessments row (approved) + risk_gate_results rows + RISK_GATE_EVALUATED traces',
    );

    // B6: PositionSizing executed — its own 'sufficient_size' gate, computed by
    // PositionSizing and persisted by RiskEngine, is present for the trace.
    const sizingGate = gateRows.find((g: any) => g.gateName === 'sufficient_size');
    note(
      'B6 PositionSizing executed',
      !!sizingGate && sizingGate.passed === true,
      "risk_gate_results 'sufficient_size' gate (computed by PositionSizing)",
    );

    // B7: OMS received — the real OrderManagement path submitted the order and the
    // paper broker filled it (trades + fills rows above are already that evidence;
    // the ORDER_SUBMITTED trace pins the OMS branch specifically).
    await waitFor(async () => (await traces('ORDER_SUBMITTED')).length > 0, 30000, 'ORDER_SUBMITTED trace');
    const submittedTraces = await traces('ORDER_SUBMITTED');
    note(
      'B7 OMS received (order submitted to broker)',
      submittedTraces.length > 0,
      'event_traces ORDER_SUBMITTED for the trace',
    );

    expect(
      missing,
      missing.length > 0
        ? `critical branches with NO runtime evidence:\n${missing.join('\n')}`
        : 'all branches evidenced',
    ).toEqual([]);
  }, 180000);
});
