/**
 * 2026-09-29 (Codex review of the discovery-to-evaluation coverage fix): the earlier IOVA-class
 * unit test in OpportunityDiscovery.test.ts proves only that a real WATCHLIST_SUBSCRIBE_REQUESTED
 * event was emitted, in-process, with every collaborator mocked. It does NOT prove a real
 * MarketDataWorker subscription state change, a real provider acknowledgment, fresh live data, or
 * that QuantSignalAgent can actually reach a real quantitative assessment for the admitted symbol.
 *
 * 2026-09-29 SECOND Codex review (this revision): the first version of this file still fell short.
 * It manually called marketDataWorker.subscribe() and QuantSignalAgent.evaluateSymbol() directly,
 * which proves those two methods work in isolation - it does NOT prove that a real
 * WATCHLIST_SUBSCRIBE_REQUESTED event automatically causes a real subscription (via
 * MarketDataWorker's own production listener) or that a real per-cycle evaluation automatically
 * reaches the admitted symbol (via QuantSignalAgent's own production scheduling). "Full capacity"
 * was also established via mocked getters, not real worker state. This revision fixes all three:
 *
 *   1. MarketDataWorker.ensureWatchlistListener() (private, idempotent, the exact handler start()
 *      registers in production) is invoked once so the REAL WATCHLIST_SUBSCRIBE_REQUESTED listener
 *      is live - runOpportunityScan()'s emitted event causes marketDataWorker.subscribe() to run
 *      because the real listener is wired, not because this test calls subscribe() itself.
 *   2. Full capacity is established via real, repeated marketDataWorker.subscribe() calls against
 *      the real singleton's real activeStreams set - not mocked getActiveSymbols()/getDynamicSymbols()
 *      return values.
 *   3. The quantitative assessment is reached via quantSignalAgent.triggerNow() - the SAME real,
 *      production-callable entry point SyntheticSessionEngine.ts already uses for an accelerated
 *      clock, which runs the exact private runCycle() the timer calls (fans out
 *      marketDataWorker.getActiveSymbols() -> evaluateSymbol() per symbol) - never a direct,
 *      single-symbol evaluateSymbol('TRACE') call reaching around that scheduling. The resulting
 *      assessment is observed via a call-through spy on QuantSignalAgent.prototype.evaluateSymbol
 *      (real implementation still runs; the spy only records the call/result for TRACE specifically
 *      out of every symbol runCycle() fans out to).
 *
 * What "simulated" means here, precisely (2026-09-29 second review, item 2): marketDataWorker.
 * ingestIbkrQuote() is called to deliver a fresh price after admission. This is REAL market-data
 * ingestion at MarketDataWorker's own public tick-ingestion boundary (the same method a real
 * IbkrSocketSession tickPrice handler calls in production) - but the CALL ITSELF is simulated, not a
 * real broker acknowledgment. This file does NOT exercise, and cannot honestly claim to exercise, a
 * real provider subscription acknowledgment/rejection or transport lifecycle (that lives inside
 * IbkrSocketSession/AlpacaBroker's own socket handling, a different, provider-specific boundary this
 * pass did not build a harness for). Every comment and assertion below says "simulated market-data
 * ingestion", never "acknowledgment".
 *
 * What this file does NOT do, deliberately: it never injects a strategy approval, a ChiefTrader
 * consensus approval, a RiskEngine pass, or a fill. The real evaluateSymbol() is asked to produce
 * whatever REAL regime/strategyEvaluations the REAL StrategyEngine computes from the fixture bars -
 * a correct abstention (no trade idea) is an accepted, honest outcome, not a test failure. Proving
 * discovery causally reaches real evaluation is the goal; proving the evaluation approves a trade is
 * explicitly out of scope here (and would be a different, larger, protected-path claim this pass is
 * not authorized to make).
 *
 * Test isolation note: every test here mutates the REAL marketDataWorker singleton's subscription
 * state (the same singleton QuantSignalAgent/OpportunityDiscovery read in production) - every symbol
 * subscribed by a test is explicitly unsubscribed in afterEach so state never leaks between tests.
 */
// @ts-nocheck

import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { continuousIntelligence } from '../config/continuousIntelligence';
import { EVENTS } from '../core/eventNames';
import * as SnapshotScanner from './SnapshotScanner';
import * as MarketUniverseScanner from './MarketUniverseScanner';
import { resetBroadUniverseAllocatorForTests } from './BroadUniverseSubscriptionAllocator';
import { structuredLogger } from '../observability/StructuredLogger';

const FLAG_O = continuousIntelligence.opportunityLoopEnabledEnvVar;

function withVolume(symbols: string[], startingVolume = 100_000_000): { symbol: string; dollarVolume: number; gapPct: number | null }[] {
  return symbols.map((symbol, i) => ({ symbol, dollarVolume: startingVolume - i * 1000, gapPct: null }));
}

/** looksLikeListedTicker() requires ^[A-Z]{1,5}(\.[A-Z])?$ - no digits, max 5 letters. Real defect
 *  found while writing this file's own tests: a numbered or >5-letter filler name is silently
 *  rejected by MarketDataWorker.subscribe() (the same ticker validator every real symbol goes
 *  through), so a naive numbered-filler helper would make every "real subscribe" a silent no-op.
 *  This generates distinct, valid, letters-only 5-char tickers instead (AAAAA, BBBBB, ...). */
function fillerSymbol(i: number): string {
  const letter = String.fromCharCode('A'.charCodeAt(0) + i);
  return letter.repeat(5);
}

/** Real-shaped daily bars, well above MIN_BARS, for QuantSignalAgent's own historicalDataGateway
 *  fetch (the Alpaca REST provider boundary - the one real external dependency this whole chain
 *  has, mocked here exactly like QuantSignalAgent.warmingUp.test.ts already does). Symbol-agnostic
 *  so it serves every symbol runCycle() fans out to, not just the one this test cares about. */
function fakeDailyBarsResponse(basePrice: number, count = 80) {
  const now = Date.now();
  return {
    ok: true,
    json: async () => ({
      bars: Array.from({ length: count }, (_, i) => {
        const close = basePrice + i * 0.05;
        return {
          t: new Date(now - (count - i) * 86_400_000).toISOString(),
          o: close, h: close * 1.01, l: close * 0.99, c: close, v: 1_000_000,
        };
      }),
    }),
  };
}

describe('Discovery-to-quantitative-assessment real cross-service trace (2026-09-29, causal-wiring revision)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let eventBus: any;
  let marketDataWorker: any;
  let MarketDataWorkerClass: any;
  let QuantSignalAgent: any;
  let quantSignalAgent: any;
  let runOpportunityScan: any;
  let resetOpportunityScanForTests: any;
  const subscribedThisTest: string[] = [];

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_discovery_to_quant_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.ALPACA_API_KEY = process.env.ALPACA_API_KEY || 'test-key';
    process.env.ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY || 'test-secret';
    ({ sqliteDb } = await import('../db'));
    ({ eventBus } = await import('../core/EventBus'));
    ({ marketDataWorker, MarketDataWorker: MarketDataWorkerClass } = await import('../services/MarketDataWorker'));
    ({ QuantSignalAgent, quantSignalAgent } = await import('../services/QuantSignalAgent'));
    ({ runOpportunityScan, resetOpportunityScanForTests } = await import('./OpportunityDiscovery'));

    // ===== Real production wiring, registered once: the SAME private, idempotent listener
    // MarketDataWorker.start() registers (guarded by its own watchlistListening flag - calling it
    // here does not start the real Alpaca WebSocket, does not IBKR-default-subscribe, and is a
    // no-op on any later call). From this point on, a real WATCHLIST_SUBSCRIBE_REQUESTED event
    // causes a real marketDataWorker.subscribe() call, exactly as production wiring does - this
    // test file itself never calls subscribe() to admit a discovery-sourced symbol. =====
    (marketDataWorker as any).ensureWatchlistListener();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
  });

  beforeEach(() => {
    resetOpportunityScanForTests();
    subscribedThisTest.length = 0;
  });

  afterEach(() => {
    delete process.env[FLAG_O];
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpportunityScanForTests();
    SnapshotScanner.resetSnapshotScannerForTests();
    resetBroadUniverseAllocatorForTests();
    // Real singleton cleanup - undo every real subscribe() this test performed (whether this test
    // called it directly or the real listener above did) so state never leaks into the next test in
    // this file. Deliberately never calls setBrokerQuoteContext() to change backend here - doing so
    // on the 'alpaca' backend triggers a REAL reconnect() attempt (a genuine external WebSocket
    // connection), which a test must never do.
    for (const symbol of subscribedThisTest) {
      try { marketDataWorker.unsubscribe(symbol, { force: true }); } catch { /* best-effort */ }
    }
  });

  function realSubscribe(symbol: string, momentumScore: number) {
    marketDataWorker.subscribe(symbol, { momentumScore });
    subscribedThisTest.push(symbol);
  }

  /** Real dwell-protection clearance (continuousIntelligence.minDynamicDwellTicks) - a freshly
   *  subscribed symbol is eviction-immune until it accrues enough real ticks OR enough real wall
   *  time has passed. Feeding real ticks via the same public ingestIbkrQuote() used elsewhere in
   *  this file is deterministic and fast; waiting on wall-clock time is not. */
  function clearDwellProtection(symbol: string) {
    for (let i = 0; i < continuousIntelligence.minDynamicDwellTicks; i++) {
      marketDataWorker.ingestIbkrQuote(symbol, 10 + i * 0.01);
    }
  }

  /** Real, non-mocked full capacity: subscribes `cap` distinct, dwell-cleared (evictable) filler
   *  symbols via the real MarketDataWorker singleton. Every symbol subscribed this way scores 0 via
   *  OpportunityDiscovery's real priorityScoreOf() (no snapshot/mover/composable/gap evidence for
   *  any filler in this test file), so a genuinely-evidenced discovery candidate can out-score and
   *  evict one of them - the real shape of "a broad-universe admission wins an OCCUPIED slot", not a
   *  mocked getter standing in for that state. */
  function establishRealFullEvictableCapacity(cap: number): void {
    for (let i = 0; i < cap; i++) {
      const sym = fillerSymbol(i);
      realSubscribe(sym, 0);
      clearDwellProtection(sym);
    }
    expect(marketDataWorker.getActiveSymbols().length).toBe(cap);
  }

  it('causal trace: a real WATCHLIST_SUBSCRIBE_REQUESTED event, through the REAL production listener, at REAL full capacity, causes a real subscription; the REAL per-cycle scheduler then reaches a real quantitative assessment for that symbol - no manual subscribe()/evaluateSymbol() bridging', async () => {
    // Real quantSignalAgent.triggerNow() fans real per-symbol evaluation (real SQLite + mocked-fetch
    // historical bars, real StrategyEngine) out across every one of the cap (12) real active symbols
    // this test establishes - genuinely slower than a single evaluateSymbol() call, and the default
    // 5000ms test timeout is tuned for the old, single-symbol, non-causal version of this test.
    process.env[FLAG_O] = 'true';
    const cap = continuousIntelligence.maxActiveSubscriptions;
    establishRealFullEvictableCapacity(cap);
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['TRACE']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'TRACE' ? 0.30 : null));

    // ===== STAGE 1+2 COMBINED (the real causal link this revision adds): running discovery emits
    // a real WATCHLIST_SUBSCRIBE_REQUESTED event; the REAL listener registered in beforeAll is what
    // turns that into a real marketDataWorker.subscribe() call - this test performs no subscribe()
    // call of its own for TRACE. =====
    expect(marketDataWorker.getActiveSymbols()).not.toContain('TRACE'); // not active before the scan
    const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    expect(stats.ideasEmitted).toBe(0); // discovery/subscribe only, never a trade idea from this layer

    // The real production listener did its job: TRACE is now a real active symbol, caused entirely
    // by the emitted event, not by a manual subscribe() call in this test.
    expect(marketDataWorker.getActiveSymbols()).toContain('TRACE');
    subscribedThisTest.push('TRACE'); // real state was mutated by the listener - clean it up too

    // ===== STAGE 3: simulated market-data ingestion (2026-09-29 second review, item 2 - this is
    // NOT a "provider acknowledgment"; see this file's header comment for the precise, honest scope
    // of what ingestIbkrQuote() does and does not exercise here). Real production tick path:
    // IbkrSocketSession's tickPrice handler -> BrokerManager -> marketDataWorker.ingestIbkrQuote().
    // Calling the same real, public method here delivers a fresh price without needing a real
    // socket. =====
    expect(marketDataWorker.getLatestPrice('TRACE')).toBeNull(); // no simulated tick has arrived yet
    marketDataWorker.ingestIbkrQuote('TRACE', 42.5);
    expect(marketDataWorker.getLatestPrice('TRACE')).toBe(42.5);
    expect(marketDataWorker.getLatestPriceAgeMs('TRACE')).not.toBeNull();
    expect(marketDataWorker.getLatestPriceAgeMs('TRACE')!).toBeLessThan(5000); // genuinely fresh

    // ===== STAGE 4: real quantitative assessment via REAL scheduling. quantSignalAgent.triggerNow()
    // is the same real, production-callable entry point SyntheticSessionEngine.ts already uses - it
    // runs the exact private runCycle() the timer calls, which fans out
    // marketDataWorker.getActiveSymbols() (now cap+1 symbols, including TRACE) to evaluateSymbol()
    // with bounded concurrency. This test never calls evaluateSymbol('TRACE') directly - it observes
    // the real fan-out via a call-through spy (the real implementation still executes; the spy only
    // records the call/result for TRACE out of every symbol this cycle evaluates). QuantSignalAgent's
    // own data path is historicalDataGateway (daily bars via Alpaca REST), a DIFFERENT boundary than
    // the live tick cache above - the real architectural separation gate 13 (data_freshness) and
    // QuantSignalAgent's own bar-sufficiency check each independently enforce. Mocked here at the
    // real network boundary (fetch, symbol-agnostic), not by injecting a strategy result. =====
    vi.stubGlobal('fetch', vi.fn(async () => fakeDailyBarsResponse(42.5)));
    const evalSpy = vi.spyOn(QuantSignalAgent.prototype, 'evaluateSymbol');
    await quantSignalAgent.triggerNow();

    const traceCallIndex = evalSpy.mock.calls.findIndex((args) => args[0] === 'TRACE');
    expect(traceCallIndex).toBeGreaterThanOrEqual(0); // real runCycle() fan-out reached TRACE
    const assessment = await evalSpy.mock.results[traceCallIndex].value;

    // Real assessment reached - this is the actual defect closed: TRACE (discovered via the broad
    // universe, never in the static momentum list, admitted only because this fix let it compete
    // for an occupied slot) now has a real regime classification and real strategy evaluations,
    // where before this fix it would never have been streamed at all and this call would never
    // have had fresh enough data to justify making. A null/abstained strategyIdea is an ACCEPTED,
    // correct outcome here - this test does not require or fabricate a trade idea.
    expect(assessment).not.toBeNull();
    expect(assessment!.regime).toBeDefined();
    expect(Array.isArray(assessment!.strategyEvaluations)).toBe(true);
    expect(assessment!.strategyEvaluations.length).toBeGreaterThan(0);

    // ===== Explicitly OUT OF SCOPE, not exercised or asserted here: ChiefTrader consensus,
    // RiskEngine, OMS/BrokerManager, or an actual fill. Reaching a real quantitative assessment via
    // real production wiring is the discovery-to-evaluation defect this fix addresses -
    // approval/execution are separate, already-protected stages this pass does not touch or claim
    // to verify. =====
  }, 30000);

  // 2026-09-30 (Discovery Challenger Observability Hardening §10 - runtime proof). Section 10 of
  // the mandate asks for proof, in PAPER, without changing selection behavior, of a complete trace:
  // admitted -> scorer inputs -> score -> rank -> truncation result -> swap budget -> promotion/
  // non-promotion reason. The currently-running production engine (started earlier this session via
  // `argus-cli start --enable-trading`) does not yet have this change loaded and must not be
  // restarted as a side effect of this task - this test instead reconstructs the full trace against
  // the REAL OpportunityDiscovery/MarketDataWorker collaborators (same real singleton, same real
  // production WATCHLIST_SUBSCRIBE_REQUESTED listener as the causal-trace test above), which is the
  // strongest proof available without restarting the live process. It reuses the exact same real
  // full-capacity setup and assertions as the pre-existing causal-trace test above (decision outcome
  // unchanged: TRACE-class symbol is admitted, discovery/subscribe only) and additionally asserts
  // every new observability field this task added is present and internally consistent.
  it('runtime proof: the complete admitted -> scorer inputs -> score -> rank -> truncation -> swap budget -> promotion trace is reconstructable from real emitted events, with the real decision outcome unchanged', async () => {
    process.env[FLAG_O] = 'true';
    const cap = continuousIntelligence.maxActiveSubscriptions;
    establishRealFullEvictableCapacity(cap);
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['TRACX']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'TRACX' ? 0.30 : null));

    const logSpy = vi.spyOn(structuredLogger, 'info');
    expect(marketDataWorker.getActiveSymbols()).not.toContain('TRACX');
    const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
    expect(stats.ideasEmitted).toBe(0); // unchanged: discovery/subscribe only, never a trade idea

    // Real decision outcome, identical in shape to the pre-existing causal-trace test: the real
    // production listener admitted TRACX via a real eviction.
    expect(marketDataWorker.getActiveSymbols()).toContain('TRACX');
    subscribedThisTest.push('TRACX');

    // STAGE 1: admitted -> scorer inputs -> score -> rank -> truncation result. One bounded
    // discovery_challenger_cycle_snapshot event covers the whole pre-truncation pool for this cycle.
    const snapshotCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'DISCOVERY_CHALLENGER_CYCLE_SNAPSHOT');
    expect(snapshotCall).toBeTruthy();
    const snapshotFields = snapshotCall![1] as Record<string, unknown>;
    const candidates = snapshotFields.candidates as Array<Record<string, unknown>>;
    const trace2Candidate = candidates.find((c) => c.symbol === 'TRACX');
    expect(trace2Candidate).toBeTruthy(); // real scorer inputs persisted for this exact symbol
    expect(trace2Candidate!.hasGapEvidence).toBe(true);
    expect(trace2Candidate!.gapPct).toBeCloseTo(0.30, 5);
    expect(typeof trace2Candidate!.finalPriorityScore).toBe('number');
    expect(trace2Candidate!.finalPriorityScore as number).toBeGreaterThan(0);
    expect(trace2Candidate!.survivedTruncation).toBe(true);
    expect(typeof trace2Candidate!.rankBeforeTruncation).toBe('number');

    // STAGE 2: swap budget for this cycle - real values, correlated by cycleId to the snapshot above.
    const swapOutcomeCall = logSpy.mock.calls.find((c) => c[1]?.eventType === 'DISCOVERY_CHALLENGER_SWAP_OUTCOME');
    expect(swapOutcomeCall).toBeTruthy();
    const swapFields = swapOutcomeCall![1] as Record<string, unknown>;
    expect(swapFields.cycleId).toBe(snapshotFields.cycleId); // same cycle, correlatable
    expect(swapFields.swapsConsumed).toBe(1); // real single-swap-per-cycle pacing, unchanged
    expect(swapFields.swapsRemaining).toBe(0);

    // STAGE 3: promotion reason - the real per-decision explainer output, extended with the new
    // canonical reasonCode and displacement detail.
    const promotedCall = logSpy.mock.calls.find(
      (c) => c[0] === 'subscription_priority_decision' && c[1]?.symbol === 'TRACX' && c[1]?.eventType === 'SUBSCRIPTION_PROMOTED',
    );
    expect(promotedCall).toBeTruthy();
    const promotedFields = promotedCall![1] as Record<string, unknown>;
    expect(promotedFields.reasonCode).toBe('CHALLENGER_SELECTED');
    expect(promotedFields.promotedSymbol).toBe('TRACX');
    expect(typeof promotedFields.displacedSymbol).toBe('string');
    expect(marketDataWorker.getActiveSymbols()).not.toContain(promotedFields.displacedSymbol); // really evicted
    expect(typeof promotedFields.challengerScore).toBe('number');
    expect(typeof promotedFields.incumbentScore).toBe('number');
  }, 30000);

  it('no evidence, no request: a broad-universe candidate that does NOT clear the score edge at REAL full capacity never reaches MarketDataWorker at all - the pipeline correctly stops at stage 1, never silently forcing a subscription (renamed 2026-09-30 - "subscription failure" now names a distinct, provider-rejection test below, per the IOVA-gap mandate\'s own test taxonomy)', async () => {
    process.env[FLAG_O] = 'true';
    const cap = continuousIntelligence.maxActiveSubscriptions;
    establishRealFullEvictableCapacity(cap);
    vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
    vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
    // No gap evidence at all - real shape of "admitted but with nothing to compete on".
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['NOWIN']));
    vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockReturnValue(null);

    await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));

    expect(marketDataWorker.getActiveSymbols()).not.toContain('NOWIN'); // the real listener never fired for it
    expect(marketDataWorker.getLatestPrice('NOWIN')).toBeNull();
  });

  describe('2026-09-29 second correction (item 3): capacity outcomes split into deterministic cases', () => {
    it('evictable pool: a genuinely full but entirely dwell-cleared (evictable) pool admits a new, higher-priority symbol via a real bounded eviction', () => {
      const cap = continuousIntelligence.maxActiveSubscriptions;
      establishRealFullEvictableCapacity(cap);

      const capacityFullEvents: any[] = [];
      const onFull = (p: any) => capacityFullEvents.push(p);
      eventBus.subscribe(EVENTS.MARKET_DATA_CAPACITY_FULL, onFull);
      marketDataWorker.subscribe('NEWCP', { momentumScore: 5, requestedBy: 'IntegrationTest' });
      subscribedThisTest.push('NEWCP');
      eventBus.unsubscribe(EVENTS.MARKET_DATA_CAPACITY_FULL, onFull);

      // Deterministic: every occupant is evictable and scores 0 (no momentumScore was ever set above
      // the default), while NEWCP carries a real positive score - it MUST be admitted via a real
      // eviction, and the refusal signal must never fire for it.
      expect(marketDataWorker.getActiveSymbols()).toContain('NEWCP');
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap); // still at cap - one real eviction happened
      expect(capacityFullEvents.some((e) => e.symbol === 'NEWCP')).toBe(false);
    });

    it('non-evictable pool: a genuinely full pool where EVERY occupant is still within real dwell protection refuses a new symbol and emits the real MARKET_DATA_CAPACITY_FULL signal', () => {
      const cap = continuousIntelligence.maxActiveSubscriptions;
      // Deliberately NOT dwell-cleared: every occupant is freshly subscribed and still within
      // continuousIntelligence.minDynamicDwellTicks/minDynamicDwellMs, so
      // MarketDataWorker.rankEvictionCandidates() (which filters out isWithinDynamicDwell() symbols)
      // has nothing eligible to evict - a real, structurally guaranteed non-evictable full pool, not
      // an assumption about scores.
      for (let i = 0; i < cap; i++) {
        const sym = fillerSymbol(i);
        realSubscribe(sym, 0);
      }
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap);

      const capacityFullEvents: any[] = [];
      const onFull = (p: any) => capacityFullEvents.push(p);
      eventBus.subscribe(EVENTS.MARKET_DATA_CAPACITY_FULL, onFull);
      marketDataWorker.subscribe('NEWCP', { momentumScore: 999, requestedBy: 'IntegrationTest' });
      subscribedThisTest.push('NEWCP');
      eventBus.unsubscribe(EVENTS.MARKET_DATA_CAPACITY_FULL, onFull);

      // Deterministic refusal: even an extremely high-scored new candidate cannot be admitted when
      // nothing in the pool is eligible for eviction - real defensive behavior this fix never
      // bypasses, and the real refusal signal (not silence) is what production/operators observe.
      expect(marketDataWorker.getActiveSymbols()).not.toContain('NEWCP');
      expect(capacityFullEvents.some((e) => e.symbol === 'NEWCP')).toBe(true);
    });
  });

  it('post-admission eviction: a symbol admitted via a real, propagated priority score is correctly ranked for eviction once it becomes the weakest active dynamic symbol - proves the score is genuinely used downstream, not merely emitted', () => {
    const cap = continuousIntelligence.maxActiveSubscriptions;
    // Fill cap-2 real slots with a real, dwell-cleared MIDDLE score (5) - strictly above WEAKN
    // (2) and strictly below STRNG (50), so WEAKN is the unambiguous global weakest and STRNG
    // the unambiguous global strongest among all real, dwell-cleared occupants.
    for (let i = 0; i < cap - 2; i++) {
      const sym = fillerSymbol(i);
      realSubscribe(sym, 5);
      clearDwellProtection(sym);
    }
    realSubscribe('WEAKN', 2);
    clearDwellProtection('WEAKN');
    realSubscribe('STRNG', 50);
    clearDwellProtection('STRNG');
    expect(marketDataWorker.getActiveSymbols().length).toBe(cap);

    // A real subscribe() at genuine full capacity forces a real eviction decision among all
    // dwell-cleared occupants.
    marketDataWorker.subscribe('NEWAR', { momentumScore: 10 });
    subscribedThisTest.push('NEWAR');

    // WEAKN (real stored score 2, the unambiguous global weakest) must be the one evicted;
    // STRNG (real stored score 50, the unambiguous global strongest) must never be evicted -
    // a real consequence of the propagated score, not a coincidence of subscribe order.
    const active = marketDataWorker.getActiveSymbols();
    expect(active.includes('STRNG')).toBe(true);
    expect(active.includes('WEAKN')).toBe(false);
  });

  /**
   * 2026-09-30 (IOVA request-to-evaluation gap, docs/audits/archive/
   * ARGUS_FULL_SESSION_REVIEW_2026-09-29.md): IOVA received 7 real BROAD_UNIVERSE_HOT_SWAP
   * WATCHLIST_SUBSCRIBE_REQUESTED events (15:55:50-15:59:59 ET) and was never admitted or
   * evaluated - and, critically, produced NO observable refusal outcome either, because
   * ensureWatchlistListener() never forwarded requestedBy, silently skipping subscribe()'s
   * existing requestedBy-gated observability. These tests reproduce the real production path
   * end-to-end (real listener, real capacity, real dwell/rescue protection) for every outcome
   * class the mandate names, and verify the new unconditional MARKET_DATA_SUBSCRIPTION_OUTCOME
   * logging (structuredLogger, spied call-through - the real implementation still runs) makes
   * every one of them durably observable with real provenance.
   */
  describe('2026-09-30 IOVA request-to-evaluation gap fix', () => {
    it('requestedBy propagation: a real discovery-originated WATCHLIST_SUBSCRIBE_REQUESTED admission logs a real requestedBy (source:reason), never the UNSPECIFIED fallback', async () => {
      process.env[FLAG_O] = 'true';
      const cap = continuousIntelligence.maxActiveSubscriptions;
      establishRealFullEvictableCapacity(cap);
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['IOVA']));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'IOVA' ? 0.34 : null));
      const logSpy = vi.spyOn(structuredLogger, 'info');

      await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      subscribedThisTest.push('IOVA');

      expect(marketDataWorker.getActiveSymbols()).toContain('IOVA');
      const outcomeCalls = logSpy.mock.calls.filter((c) => c[1]?.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME' && c[1]?.symbol === 'IOVA');
      expect(outcomeCalls.length).toBeGreaterThan(0);
      const requestedBy = outcomeCalls[0][1].requestedBy as string;
      // Real fix: ensureWatchlistListener() now forwards `${source}:${reason}` from the real
      // WATCHLIST_SUBSCRIBE_REQUESTED payload - never the 'UNSPECIFIED' fallback for a real
      // discovery-originated request, and never blank.
      expect(requestedBy).not.toBe('UNSPECIFIED');
      expect(requestedBy).toContain('OpportunityDiscovery');
      expect(outcomeCalls[0][1].outcome).toBe('ACCEPTED');
    }, 30000);

    it('dwell-protected incumbents: a genuinely full pool where every occupant is within real dwell protection refuses the request and logs REFUSED_CAPACITY with real provenance - never silent', () => {
      const cap = continuousIntelligence.maxActiveSubscriptions;
      for (let i = 0; i < cap; i++) {
        const sym = fillerSymbol(i);
        realSubscribe(sym, 0);
      }
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap);
      const logSpy = vi.spyOn(structuredLogger, 'info');

      marketDataWorker.subscribe('IOVA', { momentumScore: 7.64, requestedBy: 'OpportunityDiscovery:BROAD_UNIVERSE_HOT_SWAP' });
      subscribedThisTest.push('IOVA');

      expect(marketDataWorker.getActiveSymbols()).not.toContain('IOVA');
      const outcomeCalls = logSpy.mock.calls.filter((c) => c[1]?.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME' && c[1]?.symbol === 'IOVA');
      expect(outcomeCalls).toHaveLength(1);
      expect(outcomeCalls[0][1].outcome).toBe('REFUSED_CAPACITY');
      expect(outcomeCalls[0][1].requestedBy).toBe('OpportunityDiscovery:BROAD_UNIVERSE_HOT_SWAP');
    });

    it('rescue-protected incumbents: a genuinely full, dwell-CLEARED pool where every occupant instead holds an active temporary data rescue still refuses the request - a distinct protection mechanism from dwell, not a duplicate test', () => {
      const cap = continuousIntelligence.maxActiveSubscriptions;
      for (let i = 0; i < cap; i++) {
        const sym = fillerSymbol(i);
        realSubscribe(sym, 0);
        clearDwellProtection(sym); // dwell is NOT what protects these occupants in this test
        // RENEWAL grant (symbol already active) - structurally exempt from the concurrent-rescue
        // budget (continuousIntelligence.maxConcurrentTemporaryDataRescues), so all cap occupants
        // can genuinely hold an active rescue at once, exactly reproducing the real IOVA-day
        // pattern of many simultaneous rescue grants (27 in the 15:55-16:01 window).
        const grant = marketDataWorker.requestTemporaryDataRescue(sym, 'test-rescue', { requestClass: 'ROUTINE_RECOVERY' });
        expect(grant.granted).toBe(true);
      }
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap);
      expect(marketDataWorker.getEvictionEligibleDynamicSymbols()).toHaveLength(0); // none evictable

      const logSpy = vi.spyOn(structuredLogger, 'info');
      marketDataWorker.subscribe('IOVA', { momentumScore: 7.64, requestedBy: 'OpportunityDiscovery:BROAD_UNIVERSE_HOT_SWAP' });
      subscribedThisTest.push('IOVA');

      expect(marketDataWorker.getActiveSymbols()).not.toContain('IOVA');
      const outcomeCalls = logSpy.mock.calls.filter((c) => c[1]?.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME' && c[1]?.symbol === 'IOVA');
      expect(outcomeCalls).toHaveLength(1);
      expect(outcomeCalls[0][1].outcome).toBe('REFUSED_CAPACITY');
    });

    it('no eligible eviction (heterogeneous, matching the real IOVA-day mix): some occupants dwell-protected, some rescue-protected, one permanently core-protected - refusal still holds and the planner correctly plans zero swaps rather than one it cannot fulfill', async () => {
      process.env[FLAG_O] = 'true';
      const cap = continuousIntelligence.maxActiveSubscriptions;
      const half = Math.floor((cap - 1) / 2);
      // Occupant 0: dwell-protected (freshly subscribed, never ticked).
      realSubscribe(fillerSymbol(0), 0);
      // Occupants 1..half: dwell-cleared but rescue-protected.
      for (let i = 1; i <= half; i++) {
        const sym = fillerSymbol(i);
        realSubscribe(sym, 0);
        clearDwellProtection(sym);
        marketDataWorker.requestTemporaryDataRescue(sym, 'test-rescue', { requestClass: 'ROUTINE_RECOVERY' });
      }
      // Remaining occupants: dwell-protected (fresh), filling out the rest of capacity.
      for (let i = half + 1; i < cap; i++) {
        realSubscribe(fillerSymbol(i), 0);
      }
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap);
      expect(marketDataWorker.getEvictionEligibleDynamicSymbols()).toHaveLength(0);

      // Real discovery planning against this real, fully-protected pool: IOVA has real gap
      // evidence but zero eligible incumbent to compete against - the planner must correctly
      // plan NO swap this cycle (not "win" one MarketDataWorker will silently refuse).
      vi.spyOn(SnapshotScanner, 'getTopMomentumCandidates').mockResolvedValue([]);
      vi.spyOn(SnapshotScanner, 'getLastSnapshotScore').mockReturnValue(null);
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseCandidatesWithVolume').mockReturnValue(withVolume(['IOVA']));
      vi.spyOn(MarketUniverseScanner, 'getCachedBroadUniverseGapPct').mockImplementation((s: string) => (s === 'IOVA' ? 0.34 : null));

      const subs: Array<{ symbol?: string }> = [];
      const onSub = (p: { symbol?: string }) => subs.push(p);
      eventBus.subscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);
      const stats = await runOpportunityScan(new Date('2026-08-21T14:00:00.000Z'));
      eventBus.unsubscribe(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, onSub);

      // Real, precise explanation, not silence: the planner scored IOVA as a challenger (real
      // evidence exists) but never requested it, because no incumbent was genuinely evictable.
      expect(stats.broadUniverseChallengers).toBe(1);
      expect(subs.find((s) => s.symbol === 'IOVA')).toBeUndefined();
      expect(marketDataWorker.getActiveSymbols()).not.toContain('IOVA');
    });

    it('repeated requests: IOVA\'s real 7x pattern against a permanently non-evictable pool - never admitted, never silent, never leaks state across attempts', () => {
      const cap = continuousIntelligence.maxActiveSubscriptions;
      for (let i = 0; i < cap; i++) realSubscribe(fillerSymbol(i), 0); // all dwell-protected, fresh
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap);

      const logSpy = vi.spyOn(structuredLogger, 'info');
      const requestTimes = ['15:55:50', '15:56:27', '15:57:05', '15:57:41', '15:58:19', '15:59:21', '15:59:59'];
      for (const t of requestTimes) {
        eventBus.emit(EVENTS.WATCHLIST_SUBSCRIBE_REQUESTED, {
          symbol: 'IOVA', source: 'OpportunityDiscovery', reason: 'BROAD_UNIVERSE_HOT_SWAP',
          momentumScore: 7.640062597809081, honesty: 'Subscribe request only.',
        });
      }
      subscribedThisTest.push('IOVA');

      // Never admitted, across all 7 real attempts.
      expect(marketDataWorker.getActiveSymbols()).not.toContain('IOVA');
      expect(marketDataWorker.getActiveSymbols().length).toBe(cap); // no growth, no leak
      // Never leaks a stale priority-score entry for a symbol that was never actually admitted.
      expect(marketDataWorker.getDynamicMomentumScore('IOVA')).toBeNull();
      // Every one of the 7 real attempts produced its own observable, provenance-carrying refusal -
      // this is the exact gap that made IOVA's real repeated requests indistinguishable from silence.
      const outcomeCalls = logSpy.mock.calls.filter((c) => c[1]?.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME' && c[1]?.symbol === 'IOVA');
      expect(outcomeCalls).toHaveLength(requestTimes.length);
      expect(outcomeCalls.every((c) => c[1].outcome === 'REFUSED_CAPACITY')).toBe(true);
      expect(outcomeCalls.every((c) => c[1].requestedBy === 'OpportunityDiscovery:BROAD_UNIVERSE_HOT_SWAP')).toBe(true);
    });

    it('subscription failure: a genuine provider-level rejection (IBKR bridge subscribe() throws) is rolled back and logged as REFUSED_PROVIDER_REJECTED - a distinct outcome from capacity refusal, on an ISOLATED worker instance so no real IBKR/Alpaca connection is ever touched', () => {
      // Isolated instance (never the shared singleton) - constructing this and switching its
      // backend to 'ibkr_gateway' (not 'alpaca') never triggers MarketDataWorker.reconnect()
      // (setBrokerQuoteContext only calls reconnect() when switching AWAY from ibkr_gateway), so
      // this test never opens or attempts any real external connection.
      const isolated = new MarketDataWorkerClass();
      const throwingBridge = {
        subscribe: (symbol: string) => { throw new Error(`IBKR rejected ${symbol}: contract not found`); },
        unsubscribe: () => {},
        clear: () => {},
      };
      isolated.setBrokerQuoteContext({ backend: 'ibkr_gateway', ibkrBridge: throwingBridge });

      const logSpy = vi.spyOn(structuredLogger, 'info');
      isolated.subscribe('REJSY', { momentumScore: 5, requestedBy: 'test' });

      expect(isolated.getActiveSymbols()).not.toContain('REJSY'); // real rollback, not a phantom entry
      const outcomeCalls = logSpy.mock.calls.filter((c) => c[1]?.eventType === 'MARKET_DATA_SUBSCRIPTION_OUTCOME' && c[1]?.symbol === 'REJSY');
      expect(outcomeCalls).toHaveLength(1);
      expect(outcomeCalls[0][1].outcome).toBe('REFUSED_PROVIDER_REJECTED');
      expect(String(outcomeCalls[0][1].providerError)).toContain('contract not found');
    });

    it('reconnect / generation change: a real unsubscribe+resubscribe cycle (the bookkeeping every reconnect-driven generation change performs) correctly RE-ARMS dwell protection, never leaking a PRIOR generation\'s cleared-dwell state into the new one - on an ISOLATED worker instance, never the real Alpaca reconnect path', () => {
      // Isolated instance (never the shared singleton, never setBrokerQuoteContext with a backend
      // change) - this test exercises the exact real bookkeeping primitive a reconnect-driven
      // generation change depends on (unsubscribe the old registration, resubscribe fresh) without
      // any risk of a genuine external network attempt from either backend's own reconnect path.
      const isolated = new MarketDataWorkerClass();
      isolated.subscribe('GENSY', { momentumScore: 1 });
      for (let i = 0; i < continuousIntelligence.minDynamicDwellTicks; i++) isolated.ingestIbkrQuote('GENSY', 10 + i * 0.01);
      expect(isolated.getEvictionEligibleDynamicSymbols()).toContain('GENSY'); // genuinely evictable in this generation

      // Real reconnect-driven generation change bookkeeping: the prior generation's registration is
      // torn down and a fresh one established - exactly what a real IBKR/Alpaca reconnect's
      // subscription-rehydration does for a symbol that survives the reconnect.
      isolated.unsubscribe('GENSY', { force: true });
      isolated.subscribe('GENSY', { momentumScore: 1 });

      // Real fix under test: GENSY is active again in the new generation, but its dwell timer reset
      // to "now" (subscribe() always sets a fresh subscribedAtMs for a symbol not already in
      // activeStreams) - it must NOT still read as eviction-eligible immediately after the
      // generation change just because the PRIOR generation had cleared its dwell window. A real
      // reconnect must never let a stale generation's eligibility silently carry into the new one.
      expect(isolated.getActiveSymbols()).toContain('GENSY');
      expect(isolated.getEvictionEligibleDynamicSymbols()).not.toContain('GENSY');
    });
  });
});
