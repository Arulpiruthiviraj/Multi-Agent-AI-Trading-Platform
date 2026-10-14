/**
 * Full-session certification plan builder (2026-10-11, Worker H).
 *
 * PARENT-SAFE: this module is imported by the parent launcher process, so it must
 * never (even transitively, at module-evaluation time) open a DB, touch the
 * EventBus, or boot Argus core. It imports ONLY types (erased at compile time)
 * plus the pure SessionFaultPlan module (which itself has no static runtime
 * imports - only `import type` and dynamic imports inside methods).
 */
import type { SessionFault } from '../../src/server/replay/synthetic/SessionFaultPlan';
import { buildCanonicalFullDayFaultPlan } from '../../src/server/replay/synthetic/SessionFaultPlan';
import type { SyntheticNewsArticleSpec } from '../../src/server/replay/synthetic/SyntheticInjectableNewsProvider';
import type { SyntheticSymbolConfig } from '../../src/server/replay/synthetic/SyntheticMarketDataEngine';
import type { HistoricalReplayBrokerState } from '../../src/brokers/HistoricalReplayBroker';

/**
 * Must equal defaultSessionStartMs() in SyntheticSessionEngine.ts (09:30 America/New_York
 * on a fixed weekday - never Date.now(), so seeds reproduce exactly). Duplicated here as a
 * literal because the parent launcher must not import the engine module.
 */
export const FULL_SESSION_START_MS = new Date('2026-09-15T13:30:00.000Z').getTime();

export const FULL_SESSION_BARS = 390; // one RTH day, 09:30-16:00 ET

export interface FullSessionSpec {
  simulationId: string;
  scenarioId: string;
  seed: number;
  speed: number;
  durationMinutes: number;
  symbols: number;
  faultPlan: SessionFault[];
  lateMoverConfigs?: SyntheticSymbolConfig[];
  staleCacheSymbols?: string[];
  stopAfterBarIndex?: number;
  /** Event-based restart point (see SyntheticSessionOptions.stopWhen). */
  stopWhen?: { condition: import('../../src/server/replay/synthetic/SyntheticSessionEngine').RestartCondition; extraBars?: number };
  /** Argus research capital AND simulated broker cash (default 100k for legacy runs). */
  initialCash?: number;
  /** Per-trade cap and daily-loss limit for the session's replay risk config (see SyntheticSessionOptions.riskProfile). */
  riskProfile?: { maxPositionSizeUsd?: number; maxDailyLossUsd?: number };
  /** Agent calibration + weights loaded into the session's isolated DB (see AgentCalibrationProfiles.ts). Undefined = legacy uncalibrated session (NOT production-faithful). */
  calibrationProfile?: 'PRODUCTION_OCT14' | 'POSITIVE_CAPABILITY' | 'POSITIVE_CAPABILITY_BROAD';
  resume?: { startBarIndex: number; brokerState: HistoricalReplayBrokerState };
  /** REAL DISCOVERY inside the session (see SyntheticSessionOptions.discovery). */
  discovery?: Partial<import('../../src/server/replay/synthetic/discovery/SessionDiscoveryDriver').SessionDiscoveryOptions>;
  /** Test-scoped strategy lifecycle records (see SyntheticSessionOptions.lifecycle). Absent = production Oct 14 state (no records). */
  lifecycle?: { baselineCoreUntested?: boolean; records?: Array<{ strategyId: string; status: string; reason: string }> };
  /**
   * Operator-gated cold-start bootstrap (2026-10-11): when true, the parent sets
   * QUANT_COLD_START_BOOTSTRAP_ENABLED=true in the child env. This is ENVIRONMENT control
   * (the documented operator gate that lets COLD_START quant strategies emit regime-only
   * ideas with no EV/stop/target claim); emitted ideas still travel the full
   * TRADE_IDEA_GENERATED → consensus (0.75 strict >, min-2-agents) → RiskEngine → OMS path.
   * Nothing is forced. Used for trade-lifecycle coverage in the synthetic session.
   */
  coldStartBootstrap?: boolean;
  /** null = no certification gate (observation run); true/false = Test B / Test A. */
  requireTradeForCertification: boolean | null;
  /** Where the child writes its result JSON. */
  outputPath: string;
  /** Human label for the report. */
  label: string;
}

const LATE_MOVER_CONFIG: SyntheticSymbolConfig = {
  symbol: 'CERT_LATE',
  startPrice: 85,
  baseVolatility: 0.0011,
  baseVolumePerBar: 95_000,
  baseSpreadPct: 0.0003,
};

/**
 * Deterministic news-burst articles for the NEWS_BURST fault. Raw provider-shaped
 * article text only - sentiment, clustering, vetoes, and any NewsAgent idea are
 * computed by the real news pipeline. Timestamps are session-clock, never wall-clock.
 */
export function buildNewsBurstArticles(sessionStartMs: number, atBar: number): SyntheticNewsArticleSpec[] {
  const atMs = sessionStartMs + atBar * 60_000;
  const symbols = ['AAPL', 'MSFT', 'NVDA', 'SPY'];
  const headlines = [
    'beats quarterly revenue estimates, raises forward guidance',
    'announces major supply agreement, shares jump in heavy volume',
    'unveils new product line ahead of holiday quarter',
    'added to closely-watched momentum index, passive flows expected',
    'analyst upgrades citing resilient enterprise demand',
    'expands buyback authorization, cites strong cash generation',
    'reports record quarterly bookings, backlog at all-time high',
    'names new chief executive, board cites transformation plan',
  ];
  return headlines.map((h, i) => ({
    id: `cert-burst-${atBar}-${i}`,
    title: `${symbols[i % symbols.length]} ${h}`,
    content:
      `In a widely reported development, ${symbols[i % symbols.length]} ${h}. ` +
      `Market participants are repricing the name as the news disseminates across trading desks. ` +
      `This is a synthetic certification fixture article (CERTIFICATION_FIXTURE_ONLY), not real news.`,
    symbol: symbols[i % symbols.length],
    publishedAtMs: atMs + i * 7_000, // staggered ~7s apart inside the same minute bar
    source: 'Synthetic Wire (certification burst)',
  }));
}

/** The canonical full trading-day run: CERTIFIED_BULLISH_ENTRY_EXIT + full fault matrix. */
export function buildCanonicalFullDaySpec(outputPath: string, seed = 424242): FullSessionSpec {
  const faultPlan = buildCanonicalFullDayFaultPlan((bar) =>
    buildNewsBurstArticles(FULL_SESSION_START_MS, bar),
  );
  // Unique per driver invocation: a previous crashed run with the same simulationId leaves an
  // unclean session marker that would silently hold idea generation for the next run
  // (restart-safety). The engine now fails loud on a held gate, but uniqueness avoids the
  // trap entirely.
  const runTag = Date.now().toString(36);
  return {
    simulationId: `full-session-canonical-${seed}-${runTag}`,
    scenarioId: 'CERTIFIED_BULLISH_ENTRY_EXIT',
    seed,
    speed: 30,
    durationMinutes: FULL_SESSION_BARS,
    symbols: 5,
    faultPlan,
    lateMoverConfigs: [LATE_MOVER_CONFIG],
    staleCacheSymbols: ['MSFT'],
    requireTradeForCertification: true,
    outputPath,
    label: 'canonical full RTH day (PREMARKET→CLOSE→POST_CLOSE) with fault matrix',
  };
}

/**
 * Trade-lifecycle variant of the canonical run (2026-10-11): identical environment and fault
 * matrix, but with the operator-gated cold-start bootstrap enabled
 * (QUANT_COLD_START_BOOTSTRAP_ENABLED=true) so COLD_START quant strategies emit regime-only
 * ideas (no EV/stop/target claim) and the full idea → consensus → Risk → OMS → fill →
 * protective-exit lifecycle can be exercised against the synthetic session. The bootstrap is
 * ENVIRONMENT control (a documented operator gate); every emitted idea still faces the
 * identical 0.75-strict / min-2-agents consensus gate, the 27 RiskEngine gates, and OMS
 * idempotency. Outcomes (win/loss/partial fill/protective exit) are whatever the real
 * pipeline produces against the synthetic data - reported honestly, never forced.
 * requireTradeForCertification stays true: the gate FAILs if the pipeline still produces
 * no trade, so a "lifecycle covered" claim can never rest on zero trades.
 */
export function buildTradeLifecycleSpec(outputPath: string, seed = 424242): FullSessionSpec {
  const spec = buildCanonicalFullDaySpec(outputPath, seed);
  spec.simulationId = `full-session-lifecycle-${seed}-${Date.now().toString(36)}`;
  spec.coldStartBootstrap = true;
  spec.label = 'trade-lifecycle full RTH day (cold-start bootstrap; same fault matrix)';
  return spec;
}

/**
 * Multi-trade RTH day on the MULTI_TRADE_DAY per-symbol paths with $20K research capital (KNOWN_OPPORTUNITY_PLATFORM_FIXTURE:
 * mechanical capability, not market alpha). Same environment control as the lifecycle run (cold-start bootstrap is an operator gate;
 * every idea still faces consensus, the RiskEngine gates and OMS). requireTradeForCertification stays true.
 */
export function buildMultiTradeDaySpec(outputPath: string, seed = 424242, symbols = 5): FullSessionSpec {
  return {
    simulationId: `full-session-multitrade-${seed}-${Date.now().toString(36)}`,
    scenarioId: 'MULTI_TRADE_DAY',
    seed,
    speed: 30,
    durationMinutes: FULL_SESSION_BARS,
    symbols,
    faultPlan: [],
    coldStartBootstrap: true,
    initialCash: 20_000,
    // $20K research capital with the production per-trade ($3,000) and daily-loss ($250) profile
    riskProfile: { maxPositionSizeUsd: 3_000, maxDailyLossUsd: 250 },
    requireTradeForCertification: true,
    outputPath,
    label: 'KNOWN_OPPORTUNITY_PLATFORM_FIXTURE: multi-trade RTH day, $20K research capital (mechanical capability, not alpha)',
  };
}

/** Restart-certification halves. Run 1 stops after bar 199; run 2 resumes at bar 200. */
export function buildRestartSpecs(
  outputPath1: string,
  outputPath2: string,
  seed = 424242,
): { first: FullSessionSpec; second: FullSessionSpec } {
  const first = buildCanonicalFullDaySpec(outputPath1, seed);
  // Restart halves share one simulationId (same isolated DB + session marker): the first half
  // marks a clean shutdown on its planned stop, so the resume half does not inherit a hold.
  const restartId = `full-session-restart-${seed}-${Date.now().toString(36)}`;
  first.simulationId = restartId;
  first.stopAfterBarIndex = 199;
  first.requireTradeForCertification = null; // certification runs on the merged session
  first.label = 'restart certification, first half (bars 0-199)';
  // The second half is materialized by the driver after the first half exports brokerState.
  const second: FullSessionSpec = {
    ...first,
    faultPlan: first.faultPlan,
    outputPath: outputPath2,
    label: 'restart certification, resume half (bars 200-389, fresh process)',
    stopAfterBarIndex: undefined,
    resume: undefined, // filled in by the driver from the first half's brokerState
  };
  second.simulationId = restartId;
  return { first, second };
}

/** Lighter matrix runs (fault-focused, shorter). */
export function buildMatrixSpecs(outDir: string): FullSessionSpec[] {
  const specs: FullSessionSpec[] = [];
  const noFaults: SessionFault[] = [];
  const runTag = Date.now().toString(36);
  specs.push({
    simulationId: `matrix-${runTag}-quiet-open`, scenarioId: 'QUIET_OPEN', seed: 12345, speed: 60,
    durationMinutes: 90, symbols: 5, faultPlan: noFaults,
    requireTradeForCertification: false, outputPath: `${outDir}/matrix-quiet-open.json`,
    label: 'Test A: quiet open, no-trade safety (90 bars)',
  });
  specs.push({
    simulationId: `matrix-${runTag}-extreme-noise`, scenarioId: 'EXTREME_NOISE', seed: 777, speed: 60,
    durationMinutes: 90, symbols: 5, faultPlan: noFaults,
    requireTradeForCertification: false, outputPath: `${outDir}/matrix-extreme-noise.json`,
    label: 'noise rejection: pure random walk must not manufacture trades (90 bars)',
  });
  specs.push({
    simulationId: `matrix-${runTag}-data-interruption`, scenarioId: 'DATA_INTERRUPTION', seed: 999, speed: 60,
    durationMinutes: 90, symbols: 5, faultPlan: noFaults,
    requireTradeForCertification: false, outputPath: `${outDir}/matrix-data-interruption.json`,
    label: 'feed outage at bar 30 (10 bars): no orders inside the outage, recovery after (90 bars)',
  });
  specs.push({
    simulationId: `matrix-${runTag}-trending-bear`, scenarioId: 'TRENDING_BEAR', seed: 31337, speed: 60,
    durationMinutes: 90, symbols: 5, faultPlan: noFaults,
    // Expected BEHAVIOUR, not expected activity: the system is long-only (a SELL idea with no position is rejected by sell_position_exists), so a
    // correct decline of a bear trend is a PASS. A trade here would be the suspicious outcome, not the absence of one.
    requireTradeForCertification: false, outputPath: `${outDir}/matrix-trending-bear.json`,
    label: 'short-side mirror: sustained downtrend (90 bars)',
  });
  specs.push({
    simulationId: `matrix-${runTag}-news-shock`, scenarioId: 'NEWS_SHOCK', seed: 271828, speed: 60,
    durationMinutes: 90, symbols: 5,
    faultPlan: [
      {
        kind: 'NEWS_BURST', fromBar: 20, phase: 'MORNING',
        label: 'news burst aligned with the scenario shock',
        params: { articles: buildNewsBurstArticles(FULL_SESSION_START_MS, 20) },
      },
    ],
    // Same principle: a single-source news burst that fails the 0.75 / independent-evidence bar must be declined; certification checks the
    // decline is explicit and invariants hold, not that a trade occurred.
    requireTradeForCertification: false, outputPath: `${outDir}/matrix-news-shock.json`,
    label: 'news shock + burst through the real news pipeline (90 bars)',
  });
  specs.push({
    simulationId: `matrix-${runTag}-scheduler-load`, scenarioId: 'TRENDING_BULL_GAP_AND_GO', seed: 555, speed: 60,
    durationMinutes: 60, symbols: 10,
    faultPlan: [
      { kind: 'JEV_OUTAGE_PROBE', fromBar: -1, phase: 'PREMARKET', label: 'premarket: Jev inertness' },
    ],
    requireTradeForCertification: null, outputPath: `${outDir}/matrix-scheduler-load.json`,
    label: 'scheduler load: 10-symbol universe, 60 bars (quant cycle latency observation)',
  });
  return specs;
}

/**
 * END-TO-END PRODUCTION-FAITHFUL SESSIONS (2026-10-14). Both run the REAL discovery -> subscription -> quant -> consensus -> risk -> OMS pipeline over a
 * 500-symbol hidden-truth market with 90 occupied IBKR-style lines and Oct 14 routine rescue pressure. Only external market/broker boundaries are simulated.
 *  - TEST A reproduces the Oct 14 decision conditions (production-calibrated agents, NO lifecycle records) and must ABSTAIN with every no-trade explained.
 *  - TEST B keeps discovery/market identical but provides legitimately-established independent evidence (labeled synthetic calibration) and test-scoped
 *    lifecycle eligibility (UNTESTED baseline = REQUIRES_CONSENSUS, the planned production state); a genuine opportunity must be discovered by the
 *    production allocator, approved by real 0.75 consensus, pass RiskEngine, BUY, be monitored and SELL.
 */
const END_TO_END_DISCOVERY = { seed: 102, universeSize: 500, startingWatchlistSize: 120, validCount: 20, trapCount: 8, outsideFraction: 1, incumbentCount: 87, renewalsPerMinute: 37, hardCap: 90 };
export function buildTestASpec(outputPath: string, seed = 102): FullSessionSpec {
  return {
    simulationId: `e2e-testA-${seed}-${Date.now().toString(36)}`,
    scenarioId: 'QUIET_OPEN', seed, speed: 30, durationMinutes: FULL_SESSION_BARS, symbols: 5,
    faultPlan: [], discovery: { ...END_TO_END_DISCOVERY, seed },
    initialCash: 20_000, riskProfile: { maxPositionSizeUsd: 3_000, maxDailyLossUsd: 250 },
    calibrationProfile: 'PRODUCTION_OCT14',
    requireTradeForCertification: true, outputPath,
    label: 'TEST A: Oct 14 production-faithful session (real discovery at 90 lines, production calibration, no lifecycle records) must abstain with explained reasons',
  };
}
export function buildTestBSpec(outputPath: string, seed = 102): FullSessionSpec {
  return {
    ...buildTestASpec(outputPath, seed),
    simulationId: `e2e-testB-${seed}-${Date.now().toString(36)}`,
    calibrationProfile: 'POSITIVE_CAPABILITY_BROAD',
    // production fixture parity: PULLBACK_CONTINUATION is RETIRED in production (baseline skips it), so it must not be revived by a fresh-DB baseline
    lifecycle: { baselineCoreUntested: true, records: [{ strategyId: 'PULLBACK_CONTINUATION', status: 'RETIRED', reason: 'production parity: retired strategy stays retired' }] },
    discovery: { ...END_TO_END_DISCOVERY, seed, postWindowReversal: { driftPerMin: -0.0016, minutes: 60 } },
    label: 'TEST B: 500 hidden stocks -> real discovery -> real consensus (labeled synthetic calibration, UNTESTED baseline lifecycle) -> Risk -> BUY -> monitor -> SELL',
  };
}
