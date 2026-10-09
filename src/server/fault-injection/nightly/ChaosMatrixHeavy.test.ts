// LABEL: FAULT_INJECTION - NIGHTLY TIER. Heavy combinations excluded from the
// pre-market gate: extreme event volumes, memory pressure with a real news
// burst, and a real wall-clock provider timeout (waits out the governor's own
// abort timer). Run with: npm run test:faultinjection:nightly
/**
 * CHAOS MATRIX — HEAVY (FAULT_INJECTION / SYNTHETIC_SEEDED / NON_ORGANIC /
 * NIGHTLY).
 *
 *  H1  AI down + extreme market volume (200k events): bounded delivery, the
 *      loop never stalls, governor invocations bounded, quant unaffected.
 *  H2  memory pressure + news burst: 10k stale articles land at once, the
 *      production retention sweep prunes them in bounded batches while the
 *      heartbeat keeps ticking — no unbounded table growth, no loop stall.
 *  H3  real wall-clock provider timeout: a hanging provider is killed by the
 *      governor's own abort timer (config jevTimeoutMs) — the abort signal
 *      reaches the provider, the result is a typed TIMEOUT, invocations stay
 *      bounded, quant unaffected.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

const savedEnv: Record<string, string | undefined> = {};

describe('fault-injection chaos matrix HEAVY (FAULT_INJECTION, NIGHTLY)', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let governor: any;
  let authz: typeof import('../../quant/QuantStrategyAuthorization');
  let eligibility: typeof import('../../quant/strategies/StrategyEmissionEligibility');
  let CORE_STRATEGIES: Array<{ id: string }>;
  let scope: import('../injectors').FaultInjectionScope;
  let inj: typeof import('../injectors');
  let hbMod: typeof import('../heartbeat');

  beforeAll(async () => {
    process.env.ARGUS_FAULT_INJECTION = '1';
    for (const k of ['ARGUS_DB_PATH', 'PAPER_TRADING_ONLY', 'JEV_API_KEY', 'TYPESAFE_API_KEY'])
      savedEnv[k] = process.env[k];
    tmpDbPath = path.join(os.tmpdir(), `argus_fi_heavy_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    process.env.PAPER_TRADING_ONLY = 'true';
    delete process.env.JEV_API_KEY;
    delete process.env.TYPESAFE_API_KEY;

    inj = await import('../injectors');
    hbMod = await import('../heartbeat');
    ({ sqliteDb } = await import('../../db'));
    authz = await import('../../quant/QuantStrategyAuthorization');
    eligibility = await import('../../quant/strategies/StrategyEmissionEligibility');
    ({ CORE_STRATEGIES } = await import('../../quant/strategies/StrategyEngine'));
    const govMod = await import('../../ai/AICallGovernor');
    governor = (govMod.AICallGovernor as any).getInstance?.() ?? new (govMod.AICallGovernor as any)();

    await eligibility.recordStrategyLifecycleTransition(
      CORE_STRATEGIES[0].id, 'VALIDATED', 'chaos-heavy fixture (SYNTHETIC_SEEDED)', { fi: true }, 100,
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

  /** Chunked, loop-yielding burst — see ChaosMatrix.test.ts emitBurst. */
  const emitBurst = async (
    bus: { emit: (event: string, payload: unknown) => boolean },
    event: string,
    n: number,
    chunk = 5000,
  ) => {
    for (let base = 0; base < n; base += chunk) {
      const end = Math.min(base + chunk, n);
      for (let i = base; i < end; i++) bus.emit(event, { i });
      await new Promise<void>((r) => setImmediate(r));
    }
  };

  const govReq = (i: number, tag: string) => ({
    capability: 'STRUCTURED_DECISION' as const,
    kind: 'news_catalyst_triage',
    material: {
      symbol: `FIH${tag}_${i}`,
      fingerprintParts: { i, tag },
      materiality: 'HIGH' as const,
      decisionDeadlineMs: Date.now() + 120_000,
      traceId: `fi-heavy-${tag}-${i}`,
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

  it('H1: AI down + extreme volume — 200k events deliver, loop alive, AI contained, quant unaffected', async () => {
    const provider = inj.armAiUnavailable(governor, scope);
    const { eventBus } = await import('../../core/EventBus');
    const EVENT = 'FI_HEAVY_BURST';
    const N = 200_000;
    let delivered = 0;
    const listener = () => delivered++;
    eventBus.subscribe(EVENT, listener);
    scope.onDisarm(() => eventBus.unsubscribe(EVENT, listener));

    const hb = inj.startHeartbeat();
    await emitBurst(eventBus, EVENT, N);

    const outcomes: Array<{ status: string; reason?: string }> = [];
    for (let i = 0; i < 15; i++) {
      const res: any = await governor.request(govReq(i, 'H1'));
      outcomes.push({ status: res.status, reason: res.reason });
    }
    const summary = hb.stop();

    expect(delivered).toBe(N);
    // Fail-closed throughout: FAILED while the fault is live, SKIPPED once
    // the breaker engages — never a success, never a throw.
    expect(outcomes.every((o) => o.status === 'FAILED' || o.status === 'SKIPPED')).toBe(true);
    expect(outcomes.filter((o) => o.status === 'FAILED').length).toBeGreaterThan(0);
    expect(outcomes.some((o) => o.status === 'SKIPPED' && o.reason === 'CIRCUIT_OPEN')).toBe(true);
    expect(provider.invocations).toBeLessThan(15);
    expect(failoverCalls).toBe(0);
    hbMod.assertHeartbeatHealthy(summary, 'H1 ai-down+200k', { maxHeapDeltaBytes: 300 * 1024 * 1024 });

    const quant = await authz.resolveQuantStrategyAuthorization({
      origin: 'QUANT_STRATEGY', strategyId: CORE_STRATEGIES[0].id, agent: 'QuantEngine',
    });
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
  }, 180_000);

  it('H2: news burst under memory pressure — 10k stale articles pruned by the production sweep, loop alive', async () => {
    const { sweepNewsArticlesRetention } = await import('../../db/operationalRetention');
    const { runtimeIntervals } = await import('../../config/runtimeIntervals');
    const retentionDays: number = runtimeIntervals.newsArticlesRetentionDays;
    expect(retentionDays).toBeGreaterThan(0);

    const N = 10_000;
    const oldIso = new Date(Date.now() - (retentionDays + 5) * 24 * 60 * 60 * 1000).toISOString();
    const freshIso = new Date().toISOString();
    const insert = sqliteDb.prepare(
      'INSERT INTO news_articles (id, title, source, published_at, content, summary) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const insertMany = sqliteDb.transaction((rows: Array<[string, string]>) => {
      for (const [id, publishedAt] of rows) insert.run(id, `t ${id}`, 'fi-heavy', publishedAt, 'x', 's');
    });
    const rows: Array<[string, string]> = [];
    for (let i = 0; i < N; i++) rows.push([`fi-h2-old-${i}`, oldIso]);
    rows.push(['fi-h2-fresh', freshIso]);
    insertMany(rows);

    const before = (sqliteDb.prepare("SELECT COUNT(*) AS n FROM news_articles WHERE id LIKE 'fi-h2-%'").get() as any).n;
    expect(before).toBe(N + 1);

    // Memory pressure: hold a large buffer while the sweep runs.
    const pressure = Buffer.alloc(50 * 1024 * 1024, 1);
    const hb = inj.startHeartbeat();
    const pruned = await sweepNewsArticlesRetention();
    const summary = hb.stop();
    pressure.fill(0);

    // The production sweep pruned the stale burst and kept the fresh row.
    expect(pruned).toBeGreaterThanOrEqual(N);
    const remaining = (sqliteDb.prepare("SELECT COUNT(*) AS n FROM news_articles WHERE id LIKE 'fi-h2-%'").get() as any).n;
    expect(remaining).toBe(1);
    expect(sqliteDb.prepare("SELECT id FROM news_articles WHERE id = 'fi-h2-fresh'").get()).toBeTruthy();
    // Idempotent: a second run deletes nothing.
    expect(await sweepNewsArticlesRetention()).toBe(0);
    hbMod.assertHeartbeatHealthy(summary, 'H2 news-burst', { maxHeapDeltaBytes: 400 * 1024 * 1024 });
  }, 180_000);

  it('H3: real wall-clock timeout — the governor\'s own abort timer kills a hanging provider', async () => {
    const { aiCallGovernor } = await import('../../config/aiCallGovernor');
    const timeoutMs: number = aiCallGovernor.jevTimeoutMs;
    expect(timeoutMs).toBeGreaterThan(0);

    const provider = inj.makeHangingJevProvider();
    governor.__setJevProviderForTests(provider);
    scope.onDisarm(() => governor.__setJevProviderForTests(null));

    const t0 = Date.now();
    const res: any = await governor.request(govReq(0, 'H3'));
    const elapsed = Date.now() - t0;

    // The governor's own timer fired (not our code): result is a typed TIMEOUT
    // at ~jevTimeoutMs, the provider SAW the abort signal, and the hanging
    // call did not leak into a second invocation.
    expect(res.status).toBe('FAILED');
    expect(res.kind).toBe('TIMEOUT');
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs);
    expect(elapsed).toBeLessThan(timeoutMs + 15_000);
    expect(provider.abortedSignals).toBeGreaterThanOrEqual(1);
    expect(provider.lastTimeoutMs).toBe(timeoutMs);
    expect(provider.invocations).toBe(1);
    expect(failoverCalls).toBe(0);

    const quant = await authz.resolveQuantStrategyAuthorization({
      origin: 'QUANT_STRATEGY', strategyId: CORE_STRATEGIES[0].id, agent: 'QuantEngine',
    });
    expect(quant.authority).toBe('AUTHORIZED_QUANT_POLICY');
  }, 120_000);
});
