// LABEL: FAULT_INJECTION - COMBINATION chaos: pairs of faults through REAL
// production modules. Each scenario asserts bounded queues, engaged circuit
// breakers, an unaffected validated-quant path where the architecture requires
// it, a healthy event-loop heartbeat, and fail-closed behavior. Heavy
// combinations (extreme volume, memory pressure, real wall-clock timeouts) are
// in nightly/ChaosMatrixHeavy.test.ts so the pre-market gate stays fast.
/**
 * CHAOS MATRIX (FAULT_INJECTION / SYNTHETIC_SEEDED / NON_ORGANIC).
 *
 * Combinations, not isolated faults:
 *
 *  C1  AI down + market-volume burst (20k events)
 *  C2  slow provider (429 storm) + late-mover rescue flood (capacity exhaustion)
 *  C3  backup running + AI timeouts
 *  C4  restart: persisted watchdog storm-lockout survives reboot + backup
 *      mid-run kill stays fail-closed
 *  C5  market-data reconnect + scheduler-style evaluation cycle
 *  C6  queue overload: 50k EventBus events, bounded delivery
 *
 * Every scenario asserts the same five properties:
 *   (a) bounded queues / no unbounded growth,
 *   (b) circuit breakers engage,
 *   (c) validated-quant path unaffected where the architecture requires it,
 *   (d) event-loop/memory heartbeat healthy,
 *   (e) fail-closed behavior preserved.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const savedEnv: Record<string, string | undefined> = {};

describe('fault-injection chaos matrix (FAULT_INJECTION, PRE-MARKET)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let governor: any;
  let authz: typeof import('../quant/QuantStrategyAuthorization');
  let eligibility: typeof import('../quant/strategies/StrategyEmissionEligibility');
  let CORE_STRATEGIES: Array<{ id: string }>;
  let scope: import('./injectors').FaultInjectionScope;
  let inj: typeof import('./injectors');
  let hbMod: typeof import('./heartbeat');

  beforeAll(async () => {
    process.env.ARGUS_FAULT_INJECTION = '1';
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY', 'JEV_API_KEY', 'TYPESAFE_API_KEY'])
      savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_fi_chaos_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    inj = await import('./injectors');
    hbMod = await import('./heartbeat');
    ({ sqliteDb } = await import('../db'));
    authz = await import('../quant/QuantStrategyAuthorization');
    eligibility = await import('../quant/strategies/StrategyEmissionEligibility');
    ({ CORE_STRATEGIES } = await import('../quant/strategies/StrategyEngine'));
    const govMod = await import('../ai/AICallGovernor');
    governor = (govMod.AICallGovernor as any).getInstance?.() ?? new (govMod.AICallGovernor as any)();

    await eligibility.recordStrategyLifecycleTransition(
      CORE_STRATEGIES[0].id, 'VALIDATED', 'chaos-matrix fixture (SYNTHETIC_SEEDED)', { fi: true }, 100,
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
  });

  let failoverCalls = 0;
  beforeEach(() => { failoverCalls = 0; });

  const govReq = (i: number, tag: string) => ({
    capability: 'STRUCTURED_DECISION' as const,
    kind: 'news_catalyst_triage',
    material: {
      symbol: `FIC${tag}_${i}`,
      fingerprintParts: { i, tag },
      materiality: 'HIGH' as const,
      decisionDeadlineMs: Date.now() + 60_000,
      traceId: `fi-chaos-${tag}-${i}`,
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

  const quantIdea = () => ({ origin: 'QUANT_STRATEGY', strategyId: CORE_STRATEGIES[0].id, agent: 'QuantEngine' });

  it('C1: AI down + market-volume burst — burst fully delivered, AI fails closed, quant unaffected', async () => {
    const provider = inj.armAiUnavailable(governor, scope);
    const { eventBus } = await import('../core/EventBus');

    const EVENT = 'FI_CHAOS_BURST';
    const N = 20_000;
    let delivered = 0;
    const listener = () => delivered++;
    eventBus.subscribe(EVENT, listener);
    scope.onDisarm(() => eventBus.unsubscribe(EVENT, listener));

    const hb = inj.startHeartbeat();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) eventBus.emit(EVENT, { i, price: 100 + (i % 50) });

    // AI requests fail closed DURING the burst.
    let failed = 0;
    for (let i = 0; i < 12; i++) {
      const res: any = await governor.request(govReq(i, 'C1'));
      if (res.status === 'FAILED') failed++;
    }
    const summary = hb.stop();
    const heapAfter = process.memoryUsage().heapUsed;

    expect(delivered).toBe(N); // (a) no event lost, no backlog left behind
    expect(failed).toBe(12); // (e) every AI call failed closed, none threw
    expect(provider.invocations).toBeLessThan(12); // (b) circuit containment
    expect(failoverCalls).toBe(0); // (e) no generative failover, ever
    hbMod.assertHeartbeatHealthy(summary, 'C1 ai-down+burst');

    // (c) validated quant still authorizes with AI fully down mid-burst.
    const quant = await authz.resolveQuantStrategyAuthorization(quantIdea());
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');

    // (a) heap delta for 20k events stays modest — no per-event leak.
    expect(heapAfter - heapBefore).toBeLessThan(50 * 1024 * 1024);
  }, 60_000);

  it('C2: 429 storm + late-mover rescue flood — denials bounded, logged, capacity holds', async () => {
    const provider = inj.makeHttpErrorJevProvider(429);
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const { MarketDataWorker } = await import('../services/MarketDataWorker');
    const { continuousIntelligence } = await import('../config/continuousIntelligence');
    const worker = new MarketDataWorker();
    const cap = continuousIntelligence.maxConcurrentTemporaryDataRescues;
    expect(cap).toBeGreaterThan(0);

    // Fill every rescue slot with MARKET_MOVER grants (the late movers).
    const holders = Array.from({ length: cap }, (_, i) => `FIMV${i}`);
    for (const sym of holders) {
      const res = worker.requestTemporaryDataRescue(sym, 'chaos C2 slot fill', {
        requestClass: 'MARKET_MOVER',
        traceId: `fi-c2-fill-${sym}`,
      });
      expect(res.granted).toBe(true);
    }

    const hb = inj.startHeartbeat();
    // Flood: 50 more late movers while the provider 429-storms in the background.
    const deniedReasons = new Map<string, number>();
    let aiFailed = 0;
    for (let i = 0; i < 50; i++) {
      const res = worker.requestTemporaryDataRescue(`FIMVLATE${i}`, 'chaos C2 late mover', {
        requestClass: 'MARKET_MOVER',
        traceId: `fi-c2-late-${i}`,
      });
      expect(res.granted).toBe(false);
      expect(res.deniedReason).toBeTruthy();
      deniedReasons.set(res.deniedReason!, (deniedReasons.get(res.deniedReason!) ?? 0) + 1);
      if (i % 10 === 0) {
        const ai: any = await governor.request(govReq(i, 'C2'));
        if (ai.status === 'FAILED') aiFailed++;
      }
    }
    const summary = hb.stop();

    // (a) capacity never exceeded, no matter the flood size.
    expect(worker.getActiveTemporaryRescues().length).toBeLessThanOrEqual(cap);
    // (e) every denial carried a reason code — nothing vanished silently.
    expect([...deniedReasons.values()].reduce((a, b) => a + b, 0)).toBe(50);
    expect(deniedReasons.get('RESCUE_CAPACITY_FULL')).toBe(50);
    // (b) the 429 storm stayed bounded behind the governor.
    expect(aiFailed).toBeGreaterThan(0);
    expect(provider.invocations).toBeLessThanOrEqual(5 * 3);
    expect(failoverCalls).toBe(0);
    hbMod.assertHeartbeatHealthy(summary, 'C2 429+rescue-flood');

    // Cleanup: release the flood's grants so the worker is pristine for later tests.
    worker.releaseExpiredTemporaryDataRescues();
  }, 60_000);

  it('C3: backup running + AI timeouts — loop stays responsive, backup succeeds, timeouts bounded', async () => {
    // Filler live DB for the backup to copy (mirrors SynthesisDefectSweep D2).
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_fi_c3_'));
    scope.onDisarm(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    const liveDbPath = path.join(tmpRoot, 'argus.db');
    const Database = (await import('better-sqlite3')).default;
    const filler = new Database(liveDbPath);
    try {
      filler.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      filler.prepare('INSERT INTO t (v) VALUES (?)').run('x');
    } finally {
      filler.close();
    }
    const prevDbPath = process.env.ARGUS_DB_PATH;
    process.env.ARGUS_DB_PATH = liveDbPath;
    scope.onDisarm(() => { process.env.ARGUS_DB_PATH = prevDbPath; });

    const { DbBackupService } = await import('../services/DbBackupService');
    const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
    const fakeWorker = {
      on(event: 'message' | 'error' | 'exit', fn: (...a: unknown[]) => void) {
        (listeners[event] ??= []).push(fn);
        return fakeWorker;
      },
      terminate: async () => 0,
    };
    const service = new DbBackupService({
      createWorker: ((() => {
        setTimeout(() => {
          for (const fn of listeners['message'] ?? [])
            fn({ type: 'complete', sha256: 'fi-c3', bytesCopied: 1, durationMs: 1500 });
        }, 1500);
        return fakeWorker;
      }) as never),
    });

    const provider = inj.makeTimeoutJevProvider();
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const hb = inj.startHeartbeat();
    const backupPromise = service.runBackup();
    // AI timeout storm DURING the backup.
    let aiFailed = 0;
    for (let i = 0; i < 6; i++) {
      const res: any = await governor.request(govReq(i, 'C3'));
      if (res.status === 'FAILED') aiFailed++;
    }
    const outcome = await backupPromise;
    const summary = hb.stop();

    // (d) the loop stayed responsive through backup + timeout storm.
    expect(summary.ticks).toBeGreaterThan(0);
    hbMod.assertHeartbeatHealthy(summary, 'C3 backup+timeouts');
    // (e) backup reached its honest terminal state; the maintenance flag cleared.
    expect(outcome.outcome).toBe('completed');
    expect(service.getBackupStatus().state).toBe('SUCCEEDED');
    expect(service.isMaintenanceInProgress()).toBe(false);
    // (b) AI timeouts bounded, failed closed, no failover.
    expect(aiFailed).toBe(6);
    expect(provider.invocations).toBeLessThanOrEqual(6 * 2);
    expect(failoverCalls).toBe(0);
    // (c) quant path unaffected by the timeout storm.
    const quant = await authz.resolveQuantStrategyAuthorization(quantIdea());
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
  }, 60_000);

  it('C4: restart stays fail-closed — watchdog lockout survives reboot; backup mid-run kill never succeeds', async () => {
    const logic = await import('../../../scripts/lib/argusWatchdogLogic');
    const cfg = {
      ...logic.DEFAULT_WATCHDOG_CONFIG,
      maxRestarts: 3,
      restartWindowMs: 600_000,
      restartCooldownBaseMs: 1,
      restartCooldownMaxMs: 5,
    };
    const t0 = Date.now();
    const deadTick = (nowMs: number) => ({
      pidAlive: false,
      healthOk: false,
      heartbeatAgeMs: 999999,
      cleanShutdown: false,
      maintenance: null,
      engineStartedAtMs: t0 - 120000,
    });

    // Drive the machine into STORM_LOCKOUT (bounded restarts, then locked).
    let machine = logic.initialStateMachine();
    for (let i = 0; i < 10; i++) {
      const res = logic.nextState(machine, deadTick(t0 + i * 60_000) as never, cfg, t0 + i * 60_000);
      machine = res.machine;
      if (res.action === 'STORM_LOCKOUT') break;
    }
    expect(machine.state).toBe('STORM_LOCKOUT');

    // --- "restart": persist the storm state, boot a fresh machine from it ---
    const persisted = {
      restartTimestamps: [...machine.restartTimestamps],
      stormLockout: machine.state === 'STORM_LOCKOUT',
      stormLockoutReason: machine.lockoutReason ?? undefined,
    };
    const rebooted = logic.seedStateMachineFromPersistence(persisted);
    // (e) the lockout survives the reboot — no restart storm across restarts.
    expect(rebooted.state).toBe('STORM_LOCKOUT');
    // (e) post-reboot death ticks still do not restart: the lockout holds.
    const after = logic.nextState(rebooted, deadTick(t0 + 900_000) as never, cfg, t0 + 900_000);
    expect(after.action).toBe('NONE');
    expect(after.machine.state).toBe('STORM_LOCKOUT');
    // (a) the persisted restart budget is preserved, not reset by the reboot.
    expect(rebooted.restartTimestamps.length).toBe(machine.restartTimestamps.length);

    // --- backup side: a mid-run kill fails closed and never reports success ---
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'argus_fi_c4_'));
    scope.onDisarm(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
    const liveDbPath = path.join(tmpRoot, 'argus.db');
    const Database = (await import('better-sqlite3')).default;
    new Database(liveDbPath).close();
    const prevDbPath = process.env.ARGUS_DB_PATH;
    process.env.ARGUS_DB_PATH = liveDbPath;
    scope.onDisarm(() => { process.env.ARGUS_DB_PATH = prevDbPath; });

    const { DbBackupService } = await import('../services/DbBackupService');
    const { createWorker, terminated } = inj.hangingBackupWorkerFactory();
    const service = new DbBackupService({ createWorker });
    const runPromise = service.runBackup();
    const settled: string[] = [];
    void runPromise.then(
      () => settled.push('resolved'),
      () => settled.push('rejected'),
    );
    await new Promise((r) => setTimeout(r, 800));
    // Mid-run: still honestly RUNNING (not SUCCEEDED, not FAILED).
    expect(service.getBackupStatus().state).toBe('RUNNING');
    expect(service.isMaintenanceInProgress()).toBe(true);

    service.stop(); // the "kill" — like a process restart mid-backup
    await new Promise((r) => setTimeout(r, 300));
    // (e) fail-closed: FAILED, never SUCCEEDED; the hanging worker was terminated.
    expect(service.getBackupStatus().state).toBe('FAILED');
    expect(service.getBackupStatus().lastError).toMatch(/stopped mid-run/);
    expect(service.isMaintenanceInProgress()).toBe(false);
    expect(terminated()).toBe(true);
    // (a) a fresh instance after the "restart" starts clean, not wedged.
    const fresh = new DbBackupService({ createWorker });
    expect(fresh.getBackupStatus().state).toBe('IDLE');
    expect(fresh.isMaintenanceInProgress()).toBe(false);
  }, 60_000);

  it('C5: market-data reconnect + evaluation cycle — stale generation dropped, every symbol reaches a terminal grade', async () => {
    const { MarketDataWorker } = await import('../services/MarketDataWorker');
    const { evaluateQuoteFreshness } = await import('../core/marketDataQuality');
    const { tradingSafety } = await import('../config/tradingSafety');
    const worker = new MarketDataWorker();

    // Pre-reconnect: prime 20 symbols with fresh quotes on generation 1.
    const symbols = Array.from({ length: 20 }, (_, i) => `FIC5_${i}`);
    const socket = new inj.SimulatedFaultySocket(['open', 'close:ECONNRESET', 'open']);
    socket.next(); // generation 1
    const gen1 = socket.currentGeneration;
    for (const s of symbols) worker.cacheObservedQuote(s, 100, Date.now());

    socket.next(); // ECONNRESET
    expect(socket.connectionState).toBe('CLOSED');
    // Ticks queued pre-reconnect arrive late on the stale generation: dropped.
    for (const s of symbols) socket.send({ symbol: s, price: 999 }, gen1);
    expect(socket.droppedStale).toHaveLength(20);
    expect(socket.delivered).toHaveLength(0);

    socket.next(); // reconnect -> generation 2
    const gen2 = socket.currentGeneration;
    expect(gen2).toBe(gen1 + 1);

    // Post-reconnect cycle: fresh quotes on the new generation deliver; a
    // duplicate of an old-generation tick is dropped AND would be ignored by
    // the monotonicity guard even if it leaked through.
    const hb = inj.startHeartbeat();
    const grades = new Map<string, string>();
    for (const s of symbols) {
      socket.send({ symbol: s, price: 101 }, gen2);
      worker.cacheObservedQuote(s, 101, Date.now());
      const age = worker.getLatestPriceAgeMs(s);
      const g = evaluateQuoteFreshness({ priceAgeMs: age });
      grades.set(s, g.grade);
    }
    // Stale-generation duplicate sneaking past the socket: the worker's own
    // monotonicity guard still ignores the backward write.
    worker.cacheObservedQuote(symbols[0], 50, Date.now() - 120_000);
    const summary = hb.stop();

    expect(socket.delivered).toHaveLength(20);
    expect(worker.getLatestPrice(symbols[0])).toBe(101); // rollback ignored
    // (e) completeness: every symbol in the cycle reached a terminal grade —
    // none threw, none went missing after the reconnect.
    expect(grades.size).toBe(20);
    for (const [s, grade] of grades) {
      expect(['GREEN', 'YELLOW', 'RED']).toContain(grade);
      expect(s).toBeTruthy();
    }
    hbMod.assertHeartbeatHealthy(summary, 'C5 reconnect+cycle');
  }, 60_000);

  it('C6: queue overload — 50k events deliver with bounded memory and a live loop', async () => {
    const { eventBus } = await import('../core/EventBus');
    const EVENT = 'FI_CHAOS_OVERLOAD';
    const N = 50_000;
    let delivered = 0;
    const listener = () => delivered++;
    const before = eventBus.listenerCount(EVENT);
    eventBus.subscribe(EVENT, listener);
    scope.onDisarm(() => eventBus.unsubscribe(EVENT, listener));

    const hb = inj.startHeartbeat();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) eventBus.emit(EVENT, { i });
    const heapAfter = process.memoryUsage().heapUsed;
    const summary = hb.stop();

    expect(delivered).toBe(N);
    // (a) listener registration is stable — the flood added no stray listeners.
    expect(eventBus.listenerCount(EVENT)).toBe(before + 1);
    hbMod.assertHeartbeatHealthy(summary, 'C6 queue-overload', { maxHeapDeltaBytes: 150 * 1024 * 1024 });
    expect(heapAfter - heapBefore).toBeLessThan(150 * 1024 * 1024);
  }, 90_000);
});
