// LABEL: FAULT_INJECTION - every deterministic injector driven against the REAL
// production module it targets (governor, DB, market-data worker, replay
// broker, model-runtime manager). Proves each injector produces the intended
// fault shape AND that the production code fails closed / stays bounded. Does
// NOT prove combinations (see ChaosMatrix.test.ts) or production reachability
// (structurally impossible — see FaultInjectionGate.test.ts).
/**
 * INJECTOR ISOLATION (FAULT_INJECTION / SYNTHETIC_SEEDED / NON_ORGANIC).
 *
 * One injector at a time, each against the real production module:
 *
 *  PROVIDER  timeout / 402 / 429 / 503 / network-down through the REAL
 *            AICallGovernor (its own __setJevProviderForTests seam): typed
 *            failure kinds, bounded invocations, circuit containment, zero
 *            generative failover, validated-quant authorization unaffected.
 *  DB        slow-query (synchronous stall, bounded) and SQLITE_BUSY (error
 *            surfaces, then recovery) against a temp SQLite DB.
 *  MARKET    stale / frozen / rollback quotes through a REAL MarketDataWorker:
 *            staleness is graded RED from config thresholds, the monotonicity
 *            guard ignores rollback writes.
 *  SOCKET    deterministic close/open script: stale-generation messages are
 *            dropped, new-generation messages deliver.
 *  BROKER    HistoricalReplayBroker out-of-session clock -> REJECTED with zero
 *            fill; volume-capped partial fill -> exact completion, never a
 *            fabricated quantity.
 *  WORKER    a real crashing child through the production tracked-spawn path
 *            is reaped (no leak, no zombie).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const savedEnv: Record<string, string | undefined> = {};

describe('fault-injection injector isolation (FAULT_INJECTION)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let governor: any;
  let authz: typeof import('../quant/QuantStrategyAuthorization');
  let eligibility: typeof import('../quant/strategies/StrategyEmissionEligibility');
  let CORE_STRATEGIES: Array<{ id: string }>;
  let scope: import('./injectors').FaultInjectionScope;
  let inj: typeof import('./injectors');

  beforeAll(async () => {
    process.env.ARGUS_FAULT_INJECTION = '1';
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY', 'JEV_API_KEY', 'TYPESAFE_API_KEY'])
      savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_fi_iso_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    inj = await import('./injectors');
    ({ sqliteDb } = await import('../db'));
    authz = await import('../quant/QuantStrategyAuthorization');
    eligibility = await import('../quant/strategies/StrategyEmissionEligibility');
    ({ CORE_STRATEGIES } = await import('../quant/strategies/StrategyEngine'));
    const govMod = await import('../ai/AICallGovernor');
    governor = (govMod.AICallGovernor as any).getInstance?.() ?? new (govMod.AICallGovernor as any)();

    // Seeded VALIDATED fixture (SYNTHETIC_SEEDED, temp DB only — never production).
    await eligibility.recordStrategyLifecycleTransition(
      CORE_STRATEGIES[0].id, 'VALIDATED', 'fault-injection fixture (SYNTHETIC_SEEDED)', { fi: true }, 100,
    );
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* best-effort */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort */ }
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    scope = inj.createFaultInjectionScope();
    if (typeof governor.resetForTests === 'function') governor.resetForTests();
  });

  afterEach(() => {
    scope.disarmAll();
    if (typeof governor.resetForTests === 'function') governor.resetForTests();
    expect(scope.restorationCount).toBe(0);
  });

  const govReq = (i: number, tag: string) => ({
    capability: 'STRUCTURED_DECISION' as const,
    kind: 'news_catalyst_triage',
    material: {
      symbol: `FI${tag}_${i}`,
      fingerprintParts: { i, tag },
      materiality: 'HIGH' as const,
      decisionDeadlineMs: Date.now() + 60_000,
      traceId: `fi-iso-${tag}-${i}`,
    },
    jev: {
      state: { synthetic: true },
      questions: { material: 'is this catalyst material?' },
      schemaVersion: '1',
    },
    run: async () => {
      failoverCalls++;
      return { value: null, cacheable: false };
    },
  });
  let failoverCalls = 0;
  beforeEach(() => { failoverCalls = 0; });

  const quantIdea = { origin: 'QUANT_STRATEGY', strategyId: '', agent: 'QuantEngine' };

  // -- PROVIDER -----------------------------------------------------------

  it('timeout: typed TIMEOUT failure, bounded invocations, no failover, quant unaffected', async () => {
    const provider = inj.makeTimeoutJevProvider();
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const first: any = await governor.request(govReq(0, 'TMO'));
    expect(first.status).toBe('FAILED');
    expect(first.kind).toBe('TIMEOUT');
    expect(provider.invocations).toBe(1); // a timeout is never retried within one request
    expect(failoverCalls).toBe(0);

    const quant = await authz.resolveQuantStrategyAuthorization({ ...quantIdea, strategyId: CORE_STRATEGIES[0].id });
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
  });

  it('402: BILLING, non-retryable, circuit contains the storm, quant unaffected', async () => {
    const provider = inj.makeHttpErrorJevProvider(402);
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const first: any = await governor.request(govReq(0, 'B402'));
    expect(first.status).toBe('FAILED');
    expect(first.kind).toBe('BILLING');
    expect(provider.invocations).toBe(1);

    for (let i = 1; i < 12; i++) await governor.request(govReq(i, 'B402'));
    expect(provider.invocations).toBeLessThan(12); // circuit containment
    expect(provider.invocations).toBeGreaterThan(1);
    expect(failoverCalls).toBe(0);

    const quant = await authz.resolveQuantStrategyAuthorization({ ...quantIdea, strategyId: CORE_STRATEGIES[0].id });
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
  });

  it('429/503: RATE_LIMIT/SERVER kinds, retryable, invocations stay bounded', async () => {
    for (const [status, kind, tag] of [[429, 'RATE_LIMIT', 'R429'], [503, 'SERVER', 'S503']] as const) {
      governor.resetForTests();
      const provider = inj.makeHttpErrorJevProvider(status);
      governor.__setJevProviderForTests(provider);
      const first: any = await governor.request(govReq(0, tag));
      expect(first.status).toBe('FAILED');
      expect(first.kind).toBe(kind);
      // The retryable error may be retried within policy, but a fixed request
      // count must never produce an unbounded invocation count.
      for (let i = 1; i < 8; i++) await governor.request(govReq(i, tag));
      expect(provider.invocations).toBeLessThanOrEqual(8 * 3);
      expect(failoverCalls).toBe(0);
    }
  });

  it('network-down: AI unavailable fails closed (FAILED, never throws), quant path independent', async () => {
    const provider = inj.armAiUnavailable(governor, scope);
    const res: any = await governor.request(govReq(0, 'DOWN'));
    expect(res.status).toBe('FAILED');
    expect(provider.invocations).toBeGreaterThan(0);
    expect(failoverCalls).toBe(0);

    // AI entirely down: validated quant still evaluates — architecture invariant.
    const quant = await authz.resolveQuantStrategyAuthorization({ ...quantIdea, strategyId: CORE_STRATEGIES[0].id });
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
    expect(quant.reason).toBe('STRATEGY_VALIDATED');
  });

  it('flaky script: degradation mid-session is contained deterministically', async () => {
    const provider = inj.makeFlakyJevProvider(['ok', 'http-429', 'down']);
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const ok: any = await governor.request(govReq(0, 'FLK'));
    expect(ok.status).not.toBe('FAILED');
    const r429: any = await governor.request(govReq(1, 'FLK'));
    expect(r429.kind).toBe('RATE_LIMIT');
    const down: any = await governor.request(govReq(2, 'FLK'));
    expect(down.status).toBe('FAILED');
    // Script repeats its last step: calls 4+ stay deterministically 'down'.
    const again: any = await governor.request(govReq(3, 'FLK'));
    expect(again.status).toBe('FAILED');
    expect(provider.invocations).toBeLessThanOrEqual(4 * 3);
  });

  // -- DB -----------------------------------------------------------------

  it('slow query: synchronous stall is bounded, statement still works, loop resumes', async () => {
    inj.injectDbSlowQuery(sqliteDb, 150, scope);
    const hb = inj.startHeartbeat();
    const t0 = Date.now();
    const row: any = sqliteDb.prepare('SELECT 1 AS one').get();
    const elapsed = Date.now() - t0;
    const summary = hb.stop();
    expect(row.one).toBe(1); // the statement still works after the stall
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(5000); // bounded — no runaway stall
    expect(summary.maxGapMs).toBeLessThan(5000); // the loop resumed
  });

  it('locked: SQLITE_BUSY surfaces (never silently swallowed), then recovers after disarm', async () => {
    const handle = inj.injectDbLocked(sqliteDb, 2, scope);
    const attempt = () => sqliteDb.prepare('SELECT 1').get();
    expect(() => attempt()).toThrow(/database is locked/);
    expect(() => attempt()).toThrow(/database is locked/);
    expect(handle.remaining()).toBe(0);
    expect(attempt()).toBeTruthy(); // lock released: the call path works again
    scope.disarmAll();
    expect(attempt()).toBeTruthy(); // restoration removed the patch entirely
  });

  // -- MARKET DATA --------------------------------------------------------

  it('stale quote: age beyond the config threshold grades RED', async () => {
    const { MarketDataWorker } = await import('../services/MarketDataWorker');
    const { evaluateQuoteFreshness } = await import('../core/marketDataQuality');
    const { tradingSafety } = await import('../config/tradingSafety');
    const worker = new MarketDataWorker();

    inj.feedStaleQuote(worker, 'FISTALE', tradingSafety.stalePriceThresholdMs + 60_000);
    const age = worker.getLatestPriceAgeMs('FISTALE');
    expect(age).toBeGreaterThan(tradingSafety.stalePriceThresholdMs);
    const grade = evaluateQuoteFreshness({ priceAgeMs: age });
    expect(grade.grade).toBe('RED');
    expect(grade.passed).toBe(false);
  });

  it('frozen quote: age keeps growing, price never invents freshness', async () => {
    const { MarketDataWorker } = await import('../services/MarketDataWorker');
    const worker = new MarketDataWorker();

    inj.feedFrozenQuote(worker, 'FIFROZEN', 5, 100);
    const age1 = worker.getLatestPriceAgeMs('FIFROZEN')!;
    await new Promise((r) => setTimeout(r, 120));
    const age2 = worker.getLatestPriceAgeMs('FIFROZEN')!;
    expect(worker.getLatestPrice('FIFROZEN')).toBe(100);
    expect(age2).toBeGreaterThan(age1); // frozen: only ever older, never "fresh again"
  });

  it('rollback: an older quote arriving after a newer one is ignored (monotonicity guard)', async () => {
    const { MarketDataWorker } = await import('../services/MarketDataWorker');
    const worker = new MarketDataWorker();

    const { newerPrice, olderPrice } = inj.feedRollbackQuote(worker, 'FIROLL');
    expect(worker.getLatestPrice('FIROLL')).toBe(newerPrice);
    expect(worker.getLatestPrice('FIROLL')).not.toBe(olderPrice);
  });

  // -- SOCKET ---------------------------------------------------------------

  it('lost websocket: stale-generation messages drop, new-generation messages deliver', () => {
    const socket = new inj.SimulatedFaultySocket(['open', 'close:ECONNRESET', 'open']);
    expect(socket.next()).toBe(true); // open -> generation 1
    expect(socket.currentGeneration).toBe(1);
    socket.send({ tick: 1 }, 1);
    expect(socket.delivered).toHaveLength(1);

    expect(socket.next()).toBe(true); // close:ECONNRESET
    expect(socket.connectionState).toBe('CLOSED');
    socket.send({ tick: 2 }, 1); // queued pre-reconnect on generation 1
    expect(socket.delivered).toHaveLength(1);
    expect(socket.droppedStale).toHaveLength(1);

    expect(socket.next()).toBe(true); // open -> generation 2
    expect(socket.currentGeneration).toBe(2);
    socket.send({ tick: 3 }, 1); // stale generation after reconnect: still dropped
    expect(socket.droppedStale).toHaveLength(2);
    socket.send({ tick: 4 }, 2); // current generation: delivered
    expect(socket.delivered).toHaveLength(2);
    expect(socket.next()).toBe(false); // script exhausted
  });

  // -- BROKER ---------------------------------------------------------------

  it('broker reject: out-of-session order is REJECTED with zero fill, no position', async () => {
    const { HistoricalReplayBroker } = await import('../../brokers/HistoricalReplayBroker');
    const { replaySafety } = await import('../replay/replaySafety');
    const costProfiles = replaySafety.costProfiles;
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = inj.outOfSessionClockMs(); // 00:30 ET: no fill session

    const order = await broker.placeOrder({ symbol: 'FIREJ', side: 'BUY', quantity: 10, price: 50, type: 'MARKET' });
    expect(order.status).toBe('REJECTED');
    expect(order.filledQuantity).toBe(0);

    const portfolio = await broker.portfolio();
    expect(portfolio.positions.filter((p: any) => p.symbol === 'FIREJ')).toHaveLength(0);
  });

  it('broker partial fill: capped fill is exact, completion aggregates with no fabricated quantity', async () => {
    const { HistoricalReplayBroker } = await import('../../brokers/HistoricalReplayBroker');
    const { replaySafety } = await import('../replay/replaySafety');
    const costProfiles = replaySafety.costProfiles;
    const broker = new HistoricalReplayBroker({
      initialCash: 1_000_000,
      costs: costProfiles.Base,
      timezone: 'America/New_York',
      extendedHours: false,
      shortSelling: false,
      fractional: false,
      maxVolumeParticipationPct: 0.1,
    });
    broker.clockNowMs = Date.UTC(2024, 0, 2, 14, 30, 0); // 09:30 ET: regular session
    broker.nextFillPrice.set('FIPARTIAL', 50);
    broker.nextFillVolume.set('FIPARTIAL', 1000); // cap = 100 of the requested 300

    const order = await broker.placeOrder({ symbol: 'FIPARTIAL', side: 'BUY', quantity: 300, price: 50, type: 'MARKET' });
    expect(order.status).toBe('PARTIALLY_FILLED');
    expect(order.filledQuantity).toBe(100);

    broker.clockNowMs += 60_000;
    broker.nextFillPrice.set('FIPARTIAL', 51);
    broker.nextFillVolume.set('FIPARTIAL', 100_000);
    broker.advanceWorkingOrders();

    const [updated] = (await broker.orders()).filter((o: any) => o.id === order.id);
    expect(updated.status).toBe('FILLED');
    expect(updated.filledQuantity).toBe(300); // exactly the requested quantity — never more
    const pos = (await broker.portfolio()).positions.find((p: any) => p.symbol === 'FIPARTIAL');
    expect(pos?.quantity).toBe(300);
  });

  // -- WORKER DEATH ----------------------------------------------------------

  it('worker death: a crashing child through the tracked-spawn path is reaped', async () => {
    const handle = await inj.spawnCrashingChild('fi-crash-test');
    const reaped = await handle.waitForReap(10_000);
    expect(reaped).toBe(true);
    expect(handle.trackedCount()).toBe(0); // no leak, no zombie entry retained
  });
});
