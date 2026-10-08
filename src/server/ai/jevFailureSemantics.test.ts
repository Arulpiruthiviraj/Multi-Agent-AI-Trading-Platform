/**
 * Phase 40 — Jev failure semantics: AI-unavailable-neutral parity for validated quant.
 *
 * === SYNTHETIC_SEEDED / CERTIFICATION_FIXTURE_ONLY / NON_ORGANIC ===
 *
 * Against the REAL AICallGovernor + JevDecisionProvider contracts (siblings landed 2026-10-07):
 *   AICallGovernor.getInstance().__setJevProviderForTests(fake) — fake implements
 *     { isConfigured(): boolean; decide(req): Promise<{answers, model, inputTokens, latencyMs}> },
 *     throwing the real JevError{kind} (kinds: NO_API_KEY|AUTH|RATE_LIMIT|OVERLOAD|SERVER|
 *     NETWORK|TIMEOUT|VALIDATION|ABORTED|UNKNOWN).
 *   request({capability:'STRUCTURED_DECISION', kind, material:{symbol, fingerprintParts:Record,
 *     materiality:'HIGH'|'MEDIUM'|'LOW', decisionDeadlineMs:epochMs}, jev:{state, questions:Record,
 *     schemaVersion}, run}) -> {status:'CALLED',result,latencyMs} | {status:'CACHE_HIT',result} |
 *     {status:'SKIPPED',reason,detail} | {status:'FAILED',error,kind}
 *   Governor NEVER throws for provider failure (FAILED is a status), and NEVER fails over
 *   STRUCTURED_DECISION into the generative executor (the required `run` hook must stay silent).
 *
 * PROPERTIES PROVEN:
 *  1. FAILURE PARITY: for each failure mode (TIMEOUT, 429/RATE_LIMIT, 500/SERVER, circuit
 *     OPEN, NO_API_KEY), a validated-quant scenario through the governor + policy path yields
 *     an AI-unavailable-neutral outcome, and the quant policy decision is IDENTICAL to the
 *     Jev-healthy run (same deterministic inputs -> same approval, decisionPolicy,
 *     terminalReasonCode). The advisory may differ; the DECISION may not.
 *  2. NO FAILOVER: the generative `run` hook is never invoked for STRUCTURED_DECISION,
 *     healthy or failing — a Jev outage must not become a cost storm of LLM calls.
 *  3. FAIL-CLOSED: AI-originated ideas (origin AI_RESEARCH / NEWS_EVENT) with all AI down
 *     are never approved — DESK_NO_TRADE, no CHIEF_APPROVED_IDEA.
 *
 * FIXTURE STRATEGY: mirrors AiOfflineQuantCertification.test.ts (the anchor) §§1-5 —
 * deterministic synthetic bars (same CERT_SEED recipe), real evaluateAll over the real
 * feature pipelines, labeled VALIDATED lifecycle + seeded win-rate history + calibration
 * row, settings + paper broker init, isolated tmp SQLite DB deleted in afterAll. The anchor
 * certifies the trigger fires honestly; this file reuses that recipe as decision INPUT and
 * asserts the cross-governor-state parity property. If the recipe drifts,
 * `qualifying.length > 0` fails loudly here too rather than silently testing a
 * non-triggered idea.
 *
 * ADVISORY CHANNEL: the governor result reaches the policy path ONLY through the existing
 * advisory-only field quantDetail.aiContradictionAnalysis — healthy -> {available:true,...},
 * failed/skipped -> {available:false,...} (production's AI-down shape, which the policy
 * treats identically — advisory only, never gating, per the anchor's header).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Synthetic bar recipe — mirrored from AiOfflineQuantCertification.test.ts.
// ---------------------------------------------------------------------------
const CERT_SEED = 1234;
const CERT_BAR_COUNT = 90;

function buildCertBars(rng: any) {
  const bars: any[] = [];
  const DAY = 86_400_000;
  const startMs = Date.UTC(2025, 0, 2);
  let price = 100;
  for (let i = 0; i < CERT_BAR_COUNT; i++) {
    const inPullback = i >= CERT_BAR_COUNT - 4;
    const drift = inPullback ? -0.02 / 3 : 0.003;
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
  'CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC) — Phase 40 Jev failure-semantics fixture. Not organic evidence.';

/** Maps a governor result onto the sanctioned advisory-only channel. */
function advisoryFor(result: any, failureKind?: string) {
  if (result.status === 'CALLED' || result.status === 'CACHE_HIT') {
    return {
      available: true,
      aiAgreesWithSide: true,
      summary: 'SYNTHETIC_SEEDED: Jev structured decision (healthy path)',
      jevCatalyst: result.result?.answers ?? result.result ?? null,
    };
  }
  return {
    available: false,
    reason: `SYNTHETIC_SEEDED: Jev unavailable [${failureKind ?? (result as any).reason ?? result.status}] — AI-unavailable-neutral`,
  };
}

describe('Jev failure semantics: AI-unavailable-neutral parity for validated quant (SYNTHETIC_SEEDED)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let EVENTS: any;
  let chiefTrader: any;
  let governor: any;
  let JevError: any;

  let positiveEvaluation: any;
  let positiveStrategyId: string;
  let positiveRegime: any;
  let positiveCtx: any;
  let positiveCurrentPrice: number;

  const approvals: any[] = [];
  const noTrades: any[] = [];
  const completed: any[] = [];

  async function waitFor(cond: () => boolean, timeoutMs: number, label: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cond()) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  function buildQuantIdea(symbol: string, evaluation: any, traceId: string, advisory: any) {
    const { assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, certBars } =
      (globalThis as any).__jevFailSem;
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
        `QuantEngine/${evaluation.strategy}: setupScore ${evaluation.setupScore}. ` +
        `CERTIFICATION_FIXTURE_ONLY (SYNTHETIC_SEEDED, NON_ORGANIC).`,
      agent: 'QuantEngine',
      origin: 'QUANT_STRATEGY',
      strategyId: evaluation.strategy,
      quantDetail: {
        regime: positiveRegime,
        internalEnsemble: null,
        strategyEvaluation: evaluation,
        groupedScores: groupedScores[evaluation.side as 'BUY' | 'SELL'],
        contradictions: evaluation.contradictions ?? [],
        aiContradictionAnalysis: advisory, // the ONLY channel carrying governor output
        featureSnapshot: snapshotFromStrategyContext({
          ctx: positiveCtx, evaluations: [evaluation], groupedScores, bars: certBars,
        }),
        dataQuality: assessDataQuality(symbol),
        newsCatalysts: [],
      },
    };
  }

  /**
   * Runs one full governor + policy pass. The fake Jev is injected per scenario;
   * `run` counts generative-fallback invocations (must stay 0 for STRUCTURED_DECISION).
   */
  async function runScenario(opts: {
    label: string;
    jevBehavior: 'healthy' | { failKind: string; status?: number } | 'circuitOpen' | 'noApiKey';
    ideaOrigin?: string;
    ideaAgent?: string;
  }) {
    // Drain any fire-and-forget advisory work from a prior scenario before resetting
    // the shared governor, so a late-settling advisory can't trip the fresh circuit.
    try { (await import('./AiAdvisoryService')).aiAdvisoryService.drainPendingAdvisoryWork(); } catch { /* best-effort */ }
    governor.resetForTests();
    let providerInvocations = 0;
    let generativeFallbackCalls = 0;

    if (opts.jevBehavior === 'noApiKey') {
      governor.__setJevProviderForTests(null); // forced absent -> SKIPPED/NO_API_KEY
    } else {
      governor.__setJevProviderForTests({
        isConfigured: () => true,
        decide: async () => {
          providerInvocations++;
          if (opts.jevBehavior === 'healthy') {
            return {
              answers: { relevant: 0.9, materiality: 4, classification: 'SYNTHETIC_CATALYST' },
              model: 'jev-synthetic',
              inputTokens: 10,
              latencyMs: 1,
            };
          }
          const kind = opts.jevBehavior === 'circuitOpen' ? 'OVERLOAD' : (opts.jevBehavior as any).failKind;
          const status = (opts.jevBehavior as any)?.status;
          throw new JevError(kind, `synthetic Jev failure [${kind}] (SYNTHETIC_SEEDED)`, status ? { status } : undefined);
        },
      });
    }

    const requestFor = (i: number | string, symbol = 'AAPL') =>
      governor.request({
        capability: 'STRUCTURED_DECISION',
        kind: 'news_catalyst_triage',
        material: {
          symbol,
          fingerprintParts: { event: 'parity-scenario', label: opts.label, i },
          materiality: 'HIGH',
          decisionDeadlineMs: Date.now() + 60_000,
          traceId: `synthetic-failsem-${opts.label}-${i}`,
        },
        jev: {
          state: { synthetic: true },
          questions: { material: 'is this catalyst material?' },
          schemaVersion: '1',
        },
        // Required by the type; for STRUCTURED_DECISION the governor builds the Jev
        // call itself and must NEVER invoke this (no automatic failover, ever).
        run: async () => {
          generativeFallbackCalls++;
          return { value: null, cacheable: false };
        },
      });

    if (opts.jevBehavior === 'circuitOpen') {
      // Drive the circuit open behaviorally: 5 consecutive tripping-kind failures
      // (jevConsecutiveFailureThreshold) -> circuit OPEN. Distinct symbols: the governor
      // stamps the 5-minute per-symbol cooldown at SHOULD_CALL even when the call fails,
      // so reusing one symbol would mask the circuit behind SYMBOL_COOLDOWN skips (which
      // never reach the provider and never count toward the breaker).
      for (let i = 0; i < 5; i++) {
        const r = await requestFor(`sat-${i}`, `CIRCUIT_SAT_${i}`);
        expect(r.status).toBe('FAILED');
      }
      expect(governor.getDiagnostics().circuits.jev).toBe('OPEN');
    }

    // The governor NEVER throws for provider failure: FAILED/SKIPPED is a status.
    const govResult = await requestFor('parity');
    expect(govResult && typeof govResult.status).toBe('string');
    if (opts.jevBehavior !== 'healthy') {
      expect(['FAILED', 'SKIPPED']).toContain(govResult.status);
    } else {
      expect(['CALLED', 'CACHE_HIT']).toContain(govResult.status);
    }

    const traceId = `jev-failsem-${opts.label}-${Date.now()}`;
    const advisory = advisoryFor(govResult, (opts.jevBehavior as any)?.failKind);
    const isQuant = !opts.ideaOrigin || opts.ideaOrigin === 'QUANT_STRATEGY';
    const idea = isQuant
      ? buildQuantIdea('AAPL', positiveEvaluation, traceId, advisory)
      : {
          traceId, symbol: 'NVDA', side: 'BUY', confidence: 0.5, currentPrice: positiveCurrentPrice,
          reasoning: `SYNTHETIC_SEEDED (NON_ORGANIC): AI-originated idea; Jev ${opts.label}.`,
          agent: opts.ideaAgent ?? 'NewsAgent',
          origin: opts.ideaOrigin,
        };

    await chiefTrader.reviewIdea(idea);
    await waitFor(
      () => approvals.some((a: any) => a.traceId === traceId) || noTrades.some((e: any) => e.traceId === traceId),
      15000,
      `policy outcome for ${opts.label}`,
    );
    const approval = approvals.find((a: any) => a.traceId === traceId) ?? null;
    const noTrade = noTrades.find((e: any) => e.traceId === traceId) ?? null;
    const done = completed.find((e: any) => e.traceId === traceId) ?? null;
    return {
      label: opts.label,
      govStatus: govResult.status,
      govReason: (govResult as any).reason ?? (govResult as any).kind ?? null,
      providerInvocations,
      generativeFallbackCalls,
      approved: !!approval,
      decisionPolicy: approval?.decisionPolicy ?? noTrade?.decisionPolicy ?? done?.decisionPolicy ?? null,
      terminalReasonCode: approval?.terminalReasonCode ?? noTrade?.terminalReasonCode ?? done?.terminalReasonCode ?? null,
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_jev_failsem_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    process.env.QUANT_ENGINE_ENABLED = 'true';
    process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED = 'false';
    process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED = 'false';

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    EVENTS = (await import('../core/eventNames')).EVENTS;
    const { ChiefTraderAgent } = await import('../services/ChiefTraderAgent');
    await import('../services/RiskAgent');
    await import('../services/OrderManagement');
    const { AICallGovernor } = await import('./AICallGovernor');
    ({ JevError } = await import('./JevDecisionProvider'));
    governor = AICallGovernor.getInstance();
    const { BrokerManager } = await import('../../brokers/BrokerManager');
    const { tradingEngine } = await import('../engines/TradingEngine');
    const { marketDataWorker } = await import('../services/MarketDataWorker');

    const { CORE_STRATEGIES, evaluateAll } = await import('../quant/strategies/StrategyEngine');
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
    const { recordStrategyLifecycleTransition, getStrategyLifecycleStatus } =
      await import('../quant/strategies/StrategyEmissionEligibility');

    // Anchor §1: real strategy evaluation over deterministic synthetic bars.
    const rng = new SyntheticRandom(CERT_SEED);
    const bars = buildCertBars(rng);
    const symbol = 'AAPL';
    const regime = classifyRegime(bars);
    const fetchBars = async (sym: string) => (sym === symbol ? bars : bars);
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
    expect(qualifying.length).toBeGreaterThan(0); // recipe drifted if this fails (anchor §1)
    positiveEvaluation = qualifying[0];
    positiveStrategyId = positiveEvaluation.strategy;
    positiveRegime = regime;
    positiveCtx = ctx;
    positiveCurrentPrice = ctx.currentPrice;

    // Anchor §2: lifecycle VALIDATED (labeled fixture).
    for (const s of CORE_STRATEGIES) {
      await recordStrategyLifecycleTransition(
        s.id, 'VALIDATED', `JEV_FAILSEM_FIXTURE: ${FIXTURE_LABEL}`, null, 0,
      );
      expect(await getStrategyLifecycleStatus(s.id)).toBe('VALIDATED');
    }

    // Anchor §3: seeded win-rate history for the positive strategy (labeled fixture).
    const LOSS_INDICES = new Set([1, 4, 6, 7, 10, 13, 15, 18, 20, 22]);
    const baseMs = Date.now() - 45 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 25; i++) {
      const buyPrice = 200 + i * 0.5;
      const win = !LOSS_INDICES.has(i);
      const sellPrice = win ? buyPrice * 1.04 : buyPrice * 0.97;
      const buyAt = new Date(baseMs + i * 36 * 60 * 60 * 1000).toISOString();
      const sellAt = new Date(baseMs + i * 36 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString();
      await db.insert(schema.trades).values({
        id: `jev-failsem-${positiveStrategyId}-buy-${i}`,
        symbol: 'MSFT', side: 'BUY', quantity: 10, price: buyPrice, status: 'FILLED',
        timestamp: buyAt, filledAt: buyAt, reasoning: FIXTURE_LABEL,
        traceId: `jev-failsem-rt-${i}-buy`, quantStrategyId: positiveStrategyId,
        executionEnvironment: null,
      });
      await db.insert(schema.trades).values({
        id: `jev-failsem-${positiveStrategyId}-sell-${i}`,
        symbol: 'MSFT', side: 'SELL', quantity: 10, price: sellPrice, status: 'FILLED',
        timestamp: sellAt, filledAt: sellAt, reasoning: FIXTURE_LABEL,
        traceId: `jev-failsem-rt-${i}-sell`,
        profitLoss: (sellPrice - buyPrice) * 10, quantStrategyId: positiveStrategyId,
        executionEnvironment: null,
      });
    }
    const liveWinRate = await computeLiveStrategyWinRate(positiveStrategyId);
    expect(liveWinRate!.sampleSize).toBeGreaterThanOrEqual(MIN_SAMPLE_SIZE_FOR_KELLY);
    expect(
      expectedValue(liveWinRate!.winProbability,
        riskRewardRatio(positiveCurrentPrice, positiveEvaluation.stop.price, positiveEvaluation.target.price)!.ratio!)!
        .expectedValueR,
    ).toBeGreaterThan(0);

    // Anchor §4: calibration row for the QuantEngine confidence bucket.
    const bucket = bucketFor(positiveEvaluation.confidence);
    await db.insert(schema.agentConfidenceCalibration).values({
      agentName: 'QuantEngine',
      bucketLow: bucket.low,
      bucketHigh: bucket.high,
      wins: 40, losses: 10,
      calibratedConfidence: 0.8,
      lastEvaluated: new Date().toISOString(),
    });

    // Anchor §5: runtime state — paper-only, trading enabled, broker wired (the approval
    // fans out to RiskAgent -> OMS, which must not blow up on an uninitialized broker).
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
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;
    expect(await BrokerManager.getInstance().setActiveBroker('internal_paper', { initialCash: 100000 })).toBe(true);
    for (const s of ['AAPL', 'NVDA']) marketDataWorker.cacheObservedQuote(s, positiveCurrentPrice);

    chiefTrader = new ChiefTraderAgent();
    eventBus.on(EVENTS.CHIEF_APPROVED_IDEA, (a: any) => approvals.push(a));
    eventBus.on(EVENTS.DESK_NO_TRADE, (e: any) => noTrades.push(e));
    eventBus.on(EVENTS.CHIEF_CONSENSUS_COMPLETED, (e: any) => completed.push(e));

    (globalThis as any).__jevFailSem = {
      assessDataQuality, computeGroupedScores, snapshotFromStrategyContext, generateTraceId, certBars: bars,
    };
  }, 120000);

  afterAll(() => {
    try { governor?.resetForTests(); } catch { /* never mask the real result */ }
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    delete process.env.ARGUS_DB_PATH;
    delete process.env.PAPER_TRADING_ONLY;
    delete process.env.QUANT_ENGINE_ENABLED;
    delete process.env.ARGUS_QUANT_INDEPENDENT_QUALIFICATION_ENABLED;
    delete process.env.ARGUS_STRATEGY_SELECTION_CONFLUENCE_GUARD_ENABLED;
    delete (globalThis as any).__jevFailSem;
  });

  afterEach(async () => {
    // Drain fire-and-forget advisory work first: the advisory service shares the
    // governor singleton, and an advisory request from a prior scenario settling
    // here would trip the shared circuit early (test-only race, no production impact).
    try { (await import('./AiAdvisoryService')).aiAdvisoryService.drainPendingAdvisoryWork(); } catch { /* best-effort */ }
    try { governor?.resetForTests(); } catch { /* best-effort */ }
  });

  const FAILURE_MODES = [
    { label: 'timeout', jevBehavior: { failKind: 'TIMEOUT' } },
    { label: 'rate-limit-429', jevBehavior: { failKind: 'RATE_LIMIT', status: 429 } },
    { label: 'server-500', jevBehavior: { failKind: 'SERVER', status: 500 } },
    { label: 'circuit-open', jevBehavior: 'circuitOpen' },
    { label: 'no-api-key', jevBehavior: 'noApiKey' },
  ] as const;

  it('parity: validated-quant policy outcome is IDENTICAL across Jev-healthy and every failure mode', async () => {
    const healthy = await runScenario({ label: 'healthy', jevBehavior: 'healthy' });
    expect(healthy.govStatus).toMatch(/CALLED|CACHE_HIT/);
    expect(healthy.approved).toBe(true);
    expect(healthy.decisionPolicy).toBe('QUANT_EXECUTION');
    expect(healthy.generativeFallbackCalls).toBe(0);
    console.log(`[jev-failure-semantics] healthy: ${JSON.stringify(healthy)}`);

    for (const mode of FAILURE_MODES) {
      const failed = await runScenario({ label: mode.label, jevBehavior: mode.jevBehavior as any });
      console.log(`[jev-failure-semantics] ${mode.label}: ${JSON.stringify(failed)}`);
      // AI-unavailable-neutral: the failure never becomes a throw (asserted inside
      // runScenario), and the quant decision is identical to the healthy run.
      // The advisory may (and does) differ.
      expect(failed.govStatus, `${mode.label}: governor must surface a status`).toMatch(/FAILED|SKIPPED/);
      expect(failed.approved, `${mode.label}: approval outcome must match healthy`).toBe(healthy.approved);
      expect(failed.decisionPolicy, `${mode.label}: decisionPolicy must match healthy`).toBe(healthy.decisionPolicy);
      expect(failed.terminalReasonCode, `${mode.label}: terminalReasonCode must match healthy`)
        .toBe(healthy.terminalReasonCode);
      // No automatic failover into the generative executor, ever — even with Jev down.
      expect(failed.generativeFallbackCalls, `${mode.label}: no generative failover`).toBe(0);
    }
  }, 180000);

  it.each([
    { origin: 'AI_RESEARCH', agent: 'ResearchAgent' },
    { origin: 'NEWS_EVENT', agent: 'NewsAgent' },
  ])('fail-closed: AI-originated idea ($origin) with all AI down is never approved', async ({ origin, agent }) => {
    const outcome = await runScenario({
      label: `failclosed-${origin}`, jevBehavior: 'circuitOpen', ideaOrigin: origin, ideaAgent: agent,
    });
    console.log(`[jev-failure-semantics] fail-closed ${origin}: ${JSON.stringify(outcome)}`);
    expect(outcome.govStatus).toMatch(/FAILED|SKIPPED/);
    expect(outcome.approved).toBe(false);
    expect(outcome.decisionPolicy).not.toBe('QUANT_EXECUTION');
    expect(outcome.generativeFallbackCalls).toBe(0);
  }, 120000);
});
