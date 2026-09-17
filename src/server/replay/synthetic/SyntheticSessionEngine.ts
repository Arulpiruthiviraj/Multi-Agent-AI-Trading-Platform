/**
 * ==========================================================
 * Module: SyntheticSessionEngine
 *
 * Synthetic Market Session Simulator (2026-09-14 mandate) - the orchestrator. Boots the REAL Argus
 * core (bootArgusCore(), isolated DB/session-marker, same pattern every forensic harness this
 * codebase already uses) and installs a synthetic, replay-shaped ActiveReplaySession (isolated
 * clock + isolated HistoricalReplayBroker + a synthetic point-in-time news provider) via the SAME
 * seam FullArgusReplayEngine.ts uses (setActiveReplaySession() - ReplayContext.ts). RiskEngine,
 * BrokerManager, and OMS all already redirect to this session transparently; no application code is
 * modified to make that happen.
 *
 * Unlike FullArgusReplayEngine (which reconstructs ChiefTrader's vote-math directly via
 * EvidenceAggregator, bypassing the live EventBus by design - replay's own header comment says so
 * explicitly, to avoid mixing live agents with reconstructed PIT ones), this engine drives the REAL
 * production EventBus: synthetic bars become real eventBus.emitMarketData() calls, which the REAL
 * TechnicalAgent (already constructed by bootArgusCore()) reacts to exactly as it would to a live
 * Alpaca tick, emitting real TRADE_IDEA_GENERATED ideas that the REAL ChiefTraderAgent consumes,
 * exactly per the mandate's section 12 ("Do not create a special simulation-only decision path").
 *
 * Honest, disclosed limitation: ChiefTraderAgent's consensus debounce
 * (tradingSafety.consensusAggregationWindowMs) and RiskEngine's evaluationQueue mutex are real
 * async machinery running on the REAL Node event loop / real setTimeout, not on the synthetic
 * clock - there is no seam to accelerate them the way bar generation itself is accelerated. This
 * engine therefore paces bar delivery with a small REAL wall-clock yield between bars (enough for
 * the real async chain to drain), and a longer settle wait at the end of the session. A session's
 * WALL-CLOCK duration is bounded by this, not by speedMultiplier - see the class doc below for
 * the exact numbers used.
 *
 * Timer-driven context agents this pass does NOT wire in (each is fundamentally network/LLM-
 * dependent - AlphaVantage, RSS+paid news APIs, an LLM call - none of which an isolated
 * deterministic simulation should invoke): FundamentalAgent, MacroAgent, and NewsEngine's own real
 * RSS pipeline. NewsAgent's real GATE 14 vote-relevant surface (news_veto) IS exercised, via
 * SyntheticNewsGenerator's HistoricalNewsProvider - see that file's own header comment.
 * ==========================================================
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { assertSyntheticSimulationIsolation, assertActiveSessionIsSynthetic } from '../SyntheticSimulationSafety';
import { computeSyntheticSimulationPaths } from '../syntheticSimulationPaths';
import { SyntheticMarketClock } from '../SyntheticMarketClock';
import { SyntheticRandom } from './SyntheticRandom';
import { SyntheticMarketDataEngine, defaultSyntheticUniverse, type SyntheticBar, type SyntheticSymbolConfig } from './SyntheticMarketDataEngine';
import { getScenario, type ScenarioProfile } from './SyntheticScenario';
import { seedSyntheticNewsForScenario, buildSyntheticNewsProvider, type SyntheticNewsItem } from './SyntheticNewsGenerator';
import type { DecisionTimeline, TimelineEntry } from './DecisionTimeline';
import { InformationCutoff } from '../InformationCutoff';
import { HistoricalReplayBroker } from '../../../brokers/HistoricalReplayBroker';
import { replaySafety } from '../replaySafety';
import { setActiveReplaySession, type ActiveReplaySession, defaultReplayConfig } from '../ReplayContext';
import type { ResearchBar } from '../../research/ohlcvTypes';
import type { CalibrationSeedSpec, CalibrationSeedResult } from './CalibrationHistorySeeder';

/**
 * Isolation note (2026-09-14, real incident - see below): DecisionTimeline (imports eventBus),
 * unavailableHistoricalMacroProvider, and unavailableHistoricalFundamentalProvider (both of which
 * import `db` at THEIR OWN top level) are deliberately imported DYNAMICALLY inside run() below,
 * never statically here. A real production-database pollution incident happened during Phase 1
 * smoke testing of this exact file: SyntheticNewsGenerator.ts used to have a top-level
 * `import { db } from '../../db'`, which this file's own top-level `import ... from
 * './SyntheticNewsGenerator'` transitively triggered - meaning db/index.ts (which OPENS a real
 * SQLite connection at module-evaluation time) was evaluated the instant this file was imported,
 * BEFORE prepareIsolatedEnvironment()/the caller had any chance to set an isolated ARGUS_DB_PATH.
 * Confirmed real damage: 3 spurious settings rows + 20 synthetic SPY/QQQ ohlcv_bars rows written to
 * the LIVE data/argus.db before this was caught. Fixed by making every db-touching import (however
 * many hops away) dynamic, awaited only from inside run(), strictly after prepareIsolatedEnvironment()
 * has already set ARGUS_DB_PATH - the same "env vars first, then dynamic Argus imports" discipline
 * every other forensic harness in this codebase already follows (see scripts/forensic/reproduce_p1a.ts).
 * Do not reintroduce a static top-level import of any module that (directly or transitively) reads
 * `db` into this file or any file it statically imports.
 */

const BAR_INTERVAL_MS = 60_000;
/** Real wall-clock yield between bars - long enough for ChiefTraderAgent's real debounce
 *  (tradingSafety.consensusAggregationWindowMs, 500ms default) plus RiskEngine/OMS's real async
 *  chain to drain before the next bar's data lands. Not on the synthetic clock - see class doc. */
const REAL_MS_BETWEEN_BARS = 150;
/** Real settle wait after the last bar, before results are collected. */
const REAL_SETTLE_MS = 3000;
/** How often (in bars) to trigger QuantSignalAgent's real cycle - it is timer-driven with no clock
 *  injection (see architecture map), so this engine calls its real triggerNow() at a fixed
 *  bar-cadence instead of waiting on QUANT_ENGINE_INTERVAL_MS's real setInterval. */
const QUANT_TRIGGER_EVERY_BARS = 5;
/** Same rationale as QUANT_TRIGGER_EVERY_BARS, for PortfolioMonitor's real exit-review cycle. */
const PORTFOLIO_MONITOR_TRIGGER_EVERY_BARS = 3;

export interface SyntheticSessionOptions {
  simulationId: string;
  scenarioId: string;
  seed: number;
  universeSize?: number;
  sessionDurationMinutes?: number;
  initialCash?: number;
  /** Real seconds : simulated seconds. Governs only how fast the clock ITSELF reports simulated
   *  time to consumers (SessionLifecycle, RiskEngine's market_hours-via-classifyMarketSession) -
   *  does not change the real wall-clock pacing of bar delivery (see REAL_MS_BETWEEN_BARS above). */
  speedMultiplier?: number;
  sessionStartMs?: number; // defaults to a fixed, real MARKET_OPEN-shaped timestamp for determinism
  /** Explicit, disclosed methodology change (2026-09-14, operator-authorized) - seeds a synthetic
   *  prior calibration track record for these (agent, bucket) pairs before the session runs, via
   *  CalibrationHistorySeeder.ts's real runCalibrationValidationCycle() call. Undefined/empty by
   *  default (no seeding) - see that file's own header for the full disclosure this represents. */
  calibrationSeeds?: CalibrationSeedSpec[];
}

export interface MemorySample {
  atBarIndex: number;
  rssMb: number;
  heapUsedMb: number;
}

export interface SyntheticSessionResult {
  simulationId: string;
  scenarioId: string;
  seed: number;
  universe: string[];
  sessionStartMs: number;
  sessionEndMs: number;
  timeline: readonly TimelineEntry[];
  newsItems: SyntheticNewsItem[];
  broker: HistoricalReplayBroker;
  memorySamples: MemorySample[];
  eventLoopP50Ms: number | null;
  eventLoopP95Ms: number | null;
  eventLoopP99Ms: number | null;
  eventLoopMaxMs: number | null;
  wallClockDurationMs: number;
  dbPath: string;
  /** Non-empty only when options.calibrationSeeds was supplied - see CalibrationHistorySeeder.ts's
   *  own header for the full disclosure. CertificationGate.ts surfaces this as calibrationSeeded
   *  so a Test B PASS achieved this way is never confused with organic calibration proof. */
  calibrationSeedResults: CalibrationSeedResult[];
}

function defaultSessionStartMs(): number {
  // Fixed, deterministic MARKET_OPEN-shaped timestamp (09:30 America/New_York, a real weekday) -
  // never `Date.now()`, so a given seed reproduces the exact same session regardless of when it
  // is actually run.
  return new Date('2026-09-15T13:30:00.000Z').getTime();
}

export class SyntheticSessionEngine {
  private clock!: SyntheticMarketClock;
  private timeline!: DecisionTimeline;
  private broker!: HistoricalReplayBroker;
  private dbPath!: string;
  private sessionMarkerPath!: string;

  /** Pre-flight isolation proof + env setup - call BEFORE any other method, and before importing
   *  any real Argus module (env vars must be set first, matching every other harness this session
   *  already established). */
  prepareIsolatedEnvironment(options: SyntheticSessionOptions): void {
    const paths = computeSyntheticSimulationPaths(options.simulationId);
    this.dbPath = paths.dbPath;
    this.sessionMarkerPath = paths.sessionMarkerPath;

    process.env.SYNTHETIC_SIMULATION = 'true';
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.LIVE_ARM;
    process.env.ARGUS_DB_PATH = this.dbPath;
    process.env.ARGUS_DISABLE_MARKET_DATA_WS = 'true';
    process.env.ARGUS_DISABLE_HEAP_SNAPSHOTS = 'true';
    process.env.OPENALICE_ENABLED = 'false';
    // getActiveSymbols() churn root cause (2026-09-14, Step 2 of the isolation hardening plan - a
    // real finding, not a guess): EncryptionService.ts calls dotenv.config() as a module-load side
    // effect, which - because dotenv never overwrites a key already present in process.env - loads
    // whatever ARGUS_OPPORTUNITY_LOOP_ENABLED / ARGUS_BROAD_UNIVERSE_ENABLED /
    // ARGUS_MARKET_MOVERS_ENABLED happen to be set to in this deployment's real .env (all `true`
    // here) UNLESS this method has already forced them off first. Left unset, bootArgusCore()'s
    // unconditional opportunityDiscoveryWorker.start() fires a REAL Alpaca discovery scan within
    // moments of boot (its own tick() runs immediately, not after its first interval), which calls
    // the REAL marketDataWorker.subscribe() for real, live-ticked candidates - directly competing
    // with this session's synthetic symbols for MarketDataWorker's shared, capacity-capped
    // activeStreams pool. Synthetic symbols lose that race every time: this engine feeds prices via
    // cacheObservedQuote() (a freshness-only cache write - see its own doc comment - that
    // deliberately never increments tickCounts/dynamicMomentumScores, unlike the real WS/IBKR tick
    // path), so rankEvictionCandidates() sees them as permanently score=0/ticks=0 - indistinguishable
    // from a dead subscription - and evicts them first the instant any real discovered candidate
    // (ticks >= 1) needs a slot. This is NOT a bug in MarketDataWorker's eviction design, and it is
    // NOT reproducible in live production: a genuinely live-streamed symbol's tickCounts/momentum
    // are updated by real ticks, so it never looks artificially cold the way a cacheObservedQuote()-
    // fed synthetic symbol does. It is specific to running these real, network-dependent discovery
    // workers inside an isolated deterministic simulation that was never supposed to depend on real
    // external market data at all - the same category of out-of-scope dependency this file's own
    // header comment already documents for FundamentalAgent/MacroAgent/NewsEngine's real RSS
    // pipeline. The correct fix is therefore to keep these workers idle for the session (reproducing
    // production's real activeStreams lifecycle for the symbols that DO belong to this simulation),
    // not to keep re-winning an eviction race from outside every bar - see the main loop below,
    // which no longer needs the defensive per-bar re-subscribe this fix replaces.
    process.env.ARGUS_OPPORTUNITY_LOOP_ENABLED = 'false';
    process.env.ARGUS_BROAD_UNIVERSE_ENABLED = 'false';
    process.env.ARGUS_MARKET_MOVERS_ENABLED = 'false';
    // getActiveSymbols() churn, part 2 - a SECOND, larger real root cause found empirically
    // (2026-09-14) while validating VALIDATED_CONVERGENCE_CONTROL: QuantSignalAgent logged "No
    // actively-tracked symbols" on EVERY cycle of an entire 240-bar session, despite this session's
    // own subscribe() calls below and real MARKET_DATA flowing the whole time. Root cause:
    // BrokerManager.resolveBootBrokerSelection() falls back to process.env.ARGUS_ACTIVE_BROKER
    // whenever settings.selectedBroker is unset (true here - this is a fresh, empty, isolated DB) -
    // and because EncryptionService.ts's dotenv.config() side effect loads this deployment's real
    // .env (which sets ARGUS_ACTIVE_BROKER=ibkr_gateway, the real live deployment's actual broker),
    // BrokerManager selects IBKR Gateway for this isolated session too. MarketDataWorker.subscribe()
    // then routes through its ibkr_gateway branch, which - since no real IB Gateway process is
    // reachable from this isolated simulation - throws and, in its own catch block, DELETES the
    // symbol it just added to activeStreams. Every subscribe() call this engine makes was therefore
    // silently rolling itself back the entire time; getActiveSymbols() stayed permanently empty
    // regardless of the (correct, and still necessary) Step 2 discovery-worker-churn fix above. This
    // does NOT affect order placement (BrokerManager.getActiveBroker() is separately, transparently
    // redirected to this session's own HistoricalReplayBroker via ActiveReplaySession, per the
    // established seam every other Argus subsystem already uses) - it only ever affected
    // MarketDataWorker's own internal quote-backend bookkeeping. Forcing internal_paper here is safe
    // and appropriate: it is the SAME "no real network dependency" broker BrokerManager itself falls
    // back to by default when nothing else is configured (see resolveBootBrokerSelection's own
    // 'Simulation Mode'/default branch), so this is not inventing new behavior, only making the
    // isolated session actually reach the safe default this deployment's real .env was overriding.
    process.env.ARGUS_ACTIVE_BROKER = 'internal_paper';

    // Determinism fix (2026-09-15, Rule 2 of the follow-up mandate - real finding, not a guess):
    // a same-seed QUIET_OPEN run compared twice showed identical ohlcv_bars/TechnicalAgent counts
    // (the genuinely synthetic, seeded path) but DIFFERENT news_clusters/total agent_predictions/
    // CHIEF_CONSENSUS_COMPLETED counts (86 vs 76 news_clusters; 12 vs 13 predictions) - because
    // ArgusCoreBoot.ts's newsEngine.start() runs unconditionally and independently polls real RSS
    // feeds + paid news APIs + an LLM on its own real-time schedule, regardless of whether this
    // engine "wires in" SyntheticNewsGenerator's deterministic provider for gate 14. That provider
    // (see buildSyntheticNewsProvider() below) already gives gate 14 news_veto a fully deterministic,
    // scenario-defined view - this flag only stops the SEPARATE, redundant real-network background
    // loop from also running and writing its own non-deterministic news_clusters rows alongside it.
    process.env.ARGUS_NEWS_ENGINE_ENABLED = 'false';

    assertSyntheticSimulationIsolation({ dbPath: this.dbPath, sessionMarkerPath: this.sessionMarkerPath });
  }

  /** Runs one full synthetic session end-to-end: boot real core, install synthetic replay session,
   *  drive bars through the real EventBus, wait for the real pipeline to settle, collect results.
   *  Must be called from a process where prepareIsolatedEnvironment() has already run. */
  async run(options: SyntheticSessionOptions): Promise<SyntheticSessionResult> {
    const wallClockStart = Date.now();
    const sessionStartMs = options.sessionStartMs ?? defaultSessionStartMs();
    const sessionDurationMs = (options.sessionDurationMinutes ?? 90) * 60_000;
    const sessionEndMs = sessionStartMs + sessionDurationMs;
    const scenario = getScenario(options.scenarioId);
    const universeConfigs = defaultSyntheticUniverse(options.universeSize ?? 5);
    const universe = universeConfigs.map((u) => u.symbol);

    // --- Seed the isolated settings row + session-recovery isolation BEFORE boot (same fix this
    // codebase already learned the hard way in reproduce_p1a.ts - a background worker re-reads
    // trading state from the DB, so a post-boot in-memory override races and loses). ---
    const { setSessionRecoveryPathForTests } = await import('../../core/sessionRecovery');
    setSessionRecoveryPathForTests(this.sessionMarkerPath);
    const { db } = await import('../../db');
    const schema = await import('../../db/schema');
    await db.insert(schema.settings).values({
      tradingMode: 'PAPER', riskLevel: 'Medium', budget: options.initialCash ?? 100_000,
      strategy: 'ADAPTIVE_MULTI_STRATEGY', maxTradeSize: 3000, dailyLossLimit: 5000,
      takeProfitPct: 15, trailingStopPct: 5, minAiConfidence: 75, adversarialDebateMode: true,
      autoBotEnabled: true, tradingState: 'TRADING_ENABLED',
    } as any);

    const { bootArgusCore } = await import('../../core/ArgusCoreBoot');
    await bootArgusCore();
    await sleep(1500); // let boot's own async settle (matches every other harness this session)

    // Determinism fix continued (2026-09-15, Rule 2): FundamentalAgent/MacroAgent are real,
    // network-dependent idea agents (AlphaVantage market data + AIRouter LLM calls to whichever real
    // provider is currently healthy) - unlike TechnicalAgent (deterministic RSI/MACD/BB) or
    // KronosForecastAgent (a local, session-controlled :8008 service), there is no synthetic/isolated
    // equivalent data source for these two today, and building a fabricated deterministic stand-in
    // for a real AI call would be exactly the kind of invented evidence this simulator must not
    // produce. Per the explicit instruction that "external AI providers are not consulted unless
    // explicitly running a separate integration test," this engine disables both agents in-process
    // for the duration of the session rather than let their real, rate-limited, non-deterministic
    // output silently vary CHIEF_CONSENSUS_COMPLETED/TRADE_IDEA_GENERATED counts across same-seed
    // runs (confirmed root cause of part of the 12-vs-13 prediction-count drift found in the
    // 2026-09-15 determinism check). This is in-memory-only (pipelineAgentGate.ts), never touches
    // config/pipelineAgents.json defaults, and is reset on process exit - production behavior when
    // Autobot arms these agents is completely unaffected.
    {
      const { setPipelineAgentEnabled } = await import('../../core/pipelineAgentGate');
      setPipelineAgentEnabled('FundamentalAgent', false);
      setPipelineAgentEnabled('MacroAgent', false);
    }

    // Explicit, disclosed methodology change (2026-09-14, operator-authorized) - see
    // CalibrationHistorySeeder.ts's own header for the full disclosure. Runs BEFORE the main loop
    // so any real consensus reached during the session sees an already-established (real,
    // genuinely-computed) calibration champion for these specific agent/bucket pairs, exactly as a
    // deployment with real prior history would.
    let calibrationSeedResults: import('./CalibrationHistorySeeder').CalibrationSeedResult[] = [];
    if (options.calibrationSeeds && options.calibrationSeeds.length > 0) {
      const { seedSyntheticCalibrationHistory } = await import('./CalibrationHistorySeeder');
      calibrationSeedResults = await seedSyntheticCalibrationHistory(options.calibrationSeeds);
    }

    // These three imports must stay here (dynamic, after env vars + DB isolation are already in
    // effect) - see this file's own top-of-file isolation note for why.
    const { unavailableHistoricalMacroProvider } = await import('../HistoricalMacroProvider');
    const { unavailableHistoricalFundamentalProvider } = await import('../HistoricalFundamentalProvider');
    const { DecisionTimeline: DecisionTimelineClass } = await import('./DecisionTimeline');

    // --- Generate the full deterministic session (market data + news) up front. Point-in-time
    // safety is enforced by CONSUMPTION below (strict prefix), not by generation order. ---
    const rng = new SyntheticRandom(options.seed);
    const marketDataEngine = new SyntheticMarketDataEngine(rng, universeConfigs, scenario);
    const barsBySymbol = marketDataEngine.generateSession(sessionStartMs, sessionEndMs);
    const newsItems = await seedSyntheticNewsForScenario(scenario, sessionStartMs, universe);
    const newsProvider = buildSyntheticNewsProvider(newsItems);

    // --- Install the synthetic, replay-shaped session - the one seam RiskEngine/BrokerManager/OMS
    // already redirect to (ReplayContext.ts). ---
    // speedMultiplier is deliberately NOT passed to the clock's own auto-drift here: this engine's
    // main loop is a DISCRETE, explicitly-driven sequence (every simulated-time step is an exact
    // bar timestamp via clock.advance(t), mirroring FullArgusReplayEngine's own model), not a
    // passive "let real time drive it" consumer. At a high multiplier, auto-drift between explicit
    // advance() calls (while this loop's own real per-bar work - DB writes, EventBus dispatch,
    // sleep(REAL_MS_BETWEEN_BARS) - is happening) could drift now() PAST the next bar's target
    // before this loop calls advance() for it, tripping the clock's own no-backwards-travel guard
    // (found via an actual repro during Phase 1 smoke testing - the fix is architectural, not a
    // patched threshold). speedMultiplier instead scales the REAL wall-clock pacing between bars
    // below (see realMsBetweenBars) - the lever that actually controls how fast a session
    // completes in wall-clock time, which is what section 27's speed knobs are really asking for.
    this.clock = new SyntheticMarketClock(sessionStartMs, { speedMultiplier: 1 });
    const requestedSpeedMultiplier = options.speedMultiplier ?? 1;
    const realMsBetweenBars = Math.max(5, Math.round(REAL_MS_BETWEEN_BARS / requestedSpeedMultiplier));
    const cutoff = new InformationCutoff(this.clock);
    const costs = replaySafety.costProfiles[replaySafety.defaultCostProfile];
    this.broker = new HistoricalReplayBroker({
      initialCash: options.initialCash ?? 100_000,
      costs,
      timezone: replaySafety.defaultTimezone,
      extendedHours: false,
      shortSelling: replaySafety.shortSellingDefault,
      fractional: replaySafety.fractionalSharesDefault,
    });
    assertActiveSessionIsSynthetic(this.broker); // post-install proof - refuses to proceed if the broker is not structurally incapable of live orders

    const barsBySymbolResearch = new Map<string, ResearchBar[]>();
    for (const [symbol, bars] of barsBySymbol) {
      barsBySymbolResearch.set(symbol, bars.map((b) => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })));
    }

    const session: ActiveReplaySession = {
      replayId: options.simulationId,
      status: 'RUNNING',
      config: defaultReplayConfig({ symbols: universe, timezone: replaySafety.defaultTimezone, randomSeed: options.seed, agents: ['TechnicalAgent', 'QuantEngine', 'ChiefTrader', 'RiskAgent'] }),
      clock: this.clock,
      cutoff,
      broker: this.broker,
      datasets: [],
      quality: { totalBars: 0, gaps: [], staleness: [], corporateActionFlags: [] } as any,
      datasetHash: `synthetic-${options.seed}`,
      configurationHash: `synthetic-${options.simulationId}`,
      replayHash: `synthetic-${options.simulationId}-${options.seed}`,
      news: newsProvider,
      macro: unavailableHistoricalMacroProvider(),
      fundamentals: unavailableHistoricalFundamentalProvider(),
      events: [],
      noTrade: {},
      equity: [],
      peakEquity: options.initialCash ?? 100_000,
      pauseRequested: false,
      stopRequested: false,
      stepRequested: false,
      aiCalls: 0,
      aiCostUsd: 0,
      aiLabel: 'SYNTHETIC_SIMULATION',
      partial: false,
      waiters: new Map(),
      barsBySymbol: barsBySymbolResearch,
      openStops: new Map(),
      activeDiscoveredSymbols: new Set(),
      discoveredAt: new Map(),
      discoveryTickCounter: 0,
      tradePnls: [],
      tradeLedger: [],
      rejectedOrders: [],
      agentAvailability: {},
      decisionEvidence: [],
      evaluationsAttempted: 0,
      strategyPassesAttempted: 0,
      totalBars: Math.floor(sessionDurationMs / BAR_INTERVAL_MS),
      currentBarIndex: 0,
      currentTimestamp: sessionStartMs,
      rejectionsForRetrospective: [],
      agentIdeaStats: {},
      stageDurations: {},
      replayStartedAtMs: Date.now(),
      campaign: { lockedForDate: null, lockAction: null, dailyRealizedByDate: new Map(), daysTargetMet: new Set(), postTargetEquityPeakByDate: new Map(), postTargetMaxDrawdownPct: 0 },
    };
    setActiveReplaySession(session);

    // --- Real observability: event-loop delay histogram + periodic memory samples, matching the
    // standing infrastructure this codebase already uses (processTelemetry.ts) rather than a new
    // parallel mechanism. ---
    const elHistogram = monitorEventLoopDelay({ resolution: 20 });
    elHistogram.enable();
    const memorySamples: MemorySample[] = [];

    // --- Register symbols with the real MarketDataWorker so QuantSignalAgent's getActiveSymbols()
    // includes them (subscribe() is safe to call directly here - it only opens a real stream when
    // this process is authorized as the primary market-data owner, which an isolated harness
    // process is not; see MarketDataWorker.ts's own isMarketDataWebSocketAuthorized() fail-close). ---
    const { marketDataWorker } = await import('../../services/MarketDataWorker');
    const { quantSignalAgent } = await import('../../services/QuantSignalAgent');
    const { portfolioMonitor } = await import('../../services/PortfolioMonitor');
    const { eventBus } = await import('../../core/EventBus');
    for (const symbol of universe) marketDataWorker.subscribe(symbol);

    this.timeline = new DecisionTimelineClass(this.clock);
    this.timeline.start();

    // --- The main loop: mirrors FullArgusReplayEngine.processTimestamp()'s exact NEXT_BAR_OPEN
    // sequencing (see that file's own comment this was modeled on) - the bar AT t is the fill
    // vehicle for orders placed using the PREVIOUS bar's close as the last known decision price. ---
    const timestamps = Array.from({ length: session.totalBars }, (_, i) => sessionStartMs + i * BAR_INTERVAL_MS);
    for (let i = 0; i < timestamps.length; i++) {
      const t = timestamps[i];
      if (i === 0) {
        // reset(), not advance()/setTime() - real found bug (2026-09-14): a separate reset() call
        // BEFORE this loop started left a small but real gap during which further setup work (array
        // construction, etc.) could elapse enough real wall-clock time for this clock's own 1:1
        // auto-drift (it is always constructed with speedMultiplier:1 - see below) to carry now()
        // past sessionStartMs, so this same bar's later setTime()-based advance() call would then
        // see "the target is before the current time" and throw - reproduced live on a 240-bar
        // VALIDATED_CONVERGENCE_CONTROL run. Calling reset() (unconditional, no backward-guard)
        // here, at the very first moment t is actually used, closes that gap entirely instead of
        // narrowing it.
        this.clock.reset(t);
      } else {
        this.clock.advance(t);
      }
      this.broker.clockNowMs = t;

      for (const symbol of universe) {
        // A defensive per-bar re-subscribe used to live here (see git history) to fight real
        // MarketUniverseScanner/OpportunityDiscovery subscription churn - since root-caused (2026-
        // 09-14, Step 2) to those real, network-dependent discovery workers never having been kept
        // idle for the session (see prepareIsolatedEnvironment()'s own comment on
        // ARGUS_OPPORTUNITY_LOOP_ENABLED/ARGUS_BROAD_UNIVERSE_ENABLED/ARGUS_MARKET_MOVERS_ENABLED).
        // With them genuinely idle, the ONE subscribe() call per symbol before this loop starts is
        // sufficient - this reproduces the same activeStreams lifecycle production uses for a
        // symbol nothing else is competing to evict, rather than continuously repairing it from
        // outside.
        const bars = barsBySymbol.get(symbol) ?? [];
        const currentBar = bars[i]; // the bar AT this timestamp - fill vehicle
        const previousBar = i > 0 ? bars[i - 1] : undefined; // strictly-before-t - decision price

        if (currentBar) {
          this.broker.nextFillPrice.set(symbol, currentBar.open);
          this.broker.nextFillVolume.set(symbol, currentBar.volume);
          await persistBar(symbol, currentBar);
        }

        if (previousBar) {
          marketDataWorker.cacheObservedQuote(symbol, previousBar.close, t);
          eventBus.emitMarketData(symbol, previousBar.close, previousBar.volume, new Date(t).toISOString());
        }
      }

      // Multi-bar partial-fill completion (2026-09-16, certification follow-up): once per bar, after
      // this bar's own price/volume are loaded above, give any still-open PARTIALLY_FILLED order a
      // real chance to progress using this bar's own liquidity - the same real mechanism a resting
      // order at a genuine broker would receive. A no-op every bar with no working orders (the
      // overwhelming common case); see HistoricalReplayBroker.advanceWorkingOrders()'s own doc
      // comment for the full mechanism and its duplicate-bar guard.
      this.broker.advanceWorkingOrders();

      if (i > 0 && i % QUANT_TRIGGER_EVERY_BARS === 0) {
        await quantSignalAgent.triggerNow().catch(() => { /* never fail the session on one agent's cycle error - matches production's own per-worker error isolation */ });
      }
      if (i > 0 && i % PORTFOLIO_MONITOR_TRIGGER_EVERY_BARS === 0) {
        await portfolioMonitor.triggerNow().catch(() => { /* same per-worker isolation as above */ });
      }

      memorySamples.push(sampleMemory(i));
      await sleep(realMsBetweenBars);
    }

    // A few extra portfolio-monitor passes at the very end - gives take-profit/stop/trailing exit
    // logic a real chance to fire against the session's final prices before results are collected,
    // without which Test B's "position closed" stage could fail purely from insufficient real
    // trigger opportunities near the end of a short session, not from any real pipeline defect.
    for (let extra = 0; extra < 3; extra++) {
      await portfolioMonitor.triggerNow().catch(() => {});
      await sleep(realMsBetweenBars);
    }

    await sleep(REAL_SETTLE_MS); // let the real async chain (debounce -> consensus -> risk -> OMS) drain

    this.timeline.stop();
    elHistogram.disable();
    setActiveReplaySession(null);

    const toMs = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : null);

    return {
      simulationId: options.simulationId,
      scenarioId: options.scenarioId,
      seed: options.seed,
      universe,
      sessionStartMs,
      sessionEndMs,
      timeline: this.timeline.getEntries(),
      newsItems,
      broker: this.broker,
      memorySamples,
      eventLoopP50Ms: toMs(elHistogram.percentile(50)),
      eventLoopP95Ms: toMs(elHistogram.percentile(95)),
      eventLoopP99Ms: toMs(elHistogram.percentile(99)),
      eventLoopMaxMs: toMs(elHistogram.max),
      wallClockDurationMs: Date.now() - wallClockStart,
      dbPath: this.dbPath,
      calibrationSeedResults,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleMemory(atBarIndex: number): MemorySample {
  const m = process.memoryUsage();
  return { atBarIndex, rssMb: +(m.rss / (1024 * 1024)).toFixed(1), heapUsedMb: +(m.heapUsed / (1024 * 1024)).toFixed(1) };
}

async function persistBar(symbol: string, bar: SyntheticBar): Promise<void> {
  const { db } = await import('../../db');
  const schema = await import('../../db/schema');
  await db.insert(schema.ohlcvBars).values({
    id: `${symbol}:1Min:${bar.timestamp}`,
    symbol, timeframe: '1Min', timestamp: bar.timestamp,
    open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume,
    source: 'synthetic_simulation',
  }).onConflictDoNothing();
}

