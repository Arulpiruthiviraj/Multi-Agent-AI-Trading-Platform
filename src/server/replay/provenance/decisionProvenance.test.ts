// LABEL: POINT_IN_TIME_REPLAY - proves a past Quant decision replays identically from retained
// provenance: persisted input bar IDs + available-at timestamps + quote timestamps + the
// bounded StrategyContext feed the REAL StrategyEngine.evaluateAll() path (never a
// reimplementation), and production calculation == replay calculation. Also proves the
// no-lookahead gate REJECTS deliberately future-dated provenance. Not organic trading
// evidence; synthetic seeded bars, labeled fixtures. Closes OCT9_PIT_PROVENANCE_ESCAPE.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('decision provenance: point-in-time replay', () => {
  let tmpDbPath: string;
  let sqliteDb: any;
  let mod: typeof import('./decisionProvenance');
  let evaluateAll: (ctx: any) => any[];
  let baseFixture: () => any;
  let classifyRegime: (bars: any[]) => any;
  let computeMomentumFeatures: (bars: any[]) => any;
  let computeVolumeFeatures: (bars: any[]) => any;
  let computeSupportResistanceFeatures: (bars: any[]) => any;
  let computeSmcFeatures: (bars: any[]) => any;

  const DAY_MS = 86_400_000;
  const uid = () => `pit-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  // Deterministic seeded RNG — the SAME bars every run, so the "production" and "replay"
  // legs of the test cannot diverge on input randomness. There is no RNG inside
  // StrategyDefinition.evaluate (contractually pure); this seed only fixes the fixture.
  function seededBars(n: number, seedStart: number) {
    let seed = seedStart;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const bars: any[] = [];
    let p = 100;
    const t0 = Date.parse('2026-09-01T14:30:00Z') - n * DAY_MS;
    for (let i = 0; i < n; i++) {
      const o = p;
      const driftPct = 0.25 + (rnd() - 0.45) * 0.8; // net upward drift with noise
      const c = o * (1 + driftPct / 100);
      const h = Math.max(o, c) * (1 + rnd() * 0.002);
      const l = Math.min(o, c) * (1 - rnd() * 0.002);
      bars.push({ timestamp: t0 + i * DAY_MS, open: o, high: h, low: l, close: c, volume: 1_000_000 + Math.floor(rnd() * 500_000) });
      p = c;
    }
    return bars;
  }

  /** Build a production-shaped StrategyContext through the REAL indicator pipeline. */
  function productionShapedContext(symbol: string, bars: any[]) {
    const regime = classifyRegime(bars);
    const ctx = baseFixture();
    ctx.symbol = symbol;
    ctx.currentPrice = bars[bars.length - 1].close;
    ctx.trend = regime.features.trend;
    ctx.volatility = regime.features.volatility;
    ctx.priceAction = regime.features.priceAction;
    ctx.momentum = computeMomentumFeatures(bars);
    ctx.volume = computeVolumeFeatures(bars);
    ctx.supportResistance = computeSupportResistanceFeatures(bars);
    ctx.regime = regime;
    ctx.smc = computeSmcFeatures(bars);
    return ctx;
  }

  function provenanceInput(decisionId: string, symbol: string, bars: any[], ctx: any, evaluations: any[], decisionTimeMs: number) {
    const quoteObservedAt = decisionTimeMs - 5_000;
    return {
      decisionId,
      symbol,
      timeframe: '1Day',
      decisionTimeMs,
      bars: mod.buildBarEvidence(symbol, '1Day', bars, decisionTimeMs - 60_000, DAY_MS),
      quote: { price: bars[bars.length - 1].close, observedAtMs: quoteObservedAt, source: 'test-fixture' },
      bid: { price: bars[bars.length - 1].close * 0.9999, observedAtMs: quoteObservedAt },
      ask: { price: bars[bars.length - 1].close * 1.0001, observedAtMs: quoteObservedAt },
      currentPrice: bars[bars.length - 1].close,
      priceObservedAtMs: decisionTimeMs - 60_000,
      strategyContext: ctx,
      strategyEvaluations: evaluations,
      strategyId: evaluations[0]?.strategy ?? null,
      dataSource: 'QUANT_ENGINE',
    };
  }

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_pitprovenance_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ sqliteDb } = await import('../../db/index'));
    mod = await import('./decisionProvenance');
    ({ evaluateAll } = await import('../../quant/strategies/StrategyEngine'));
    ({ baseFixture } = await import('../../quant/strategies/testHelpers'));
    ({ classifyRegime } = await import('../../quant/RegimeEngine'));
    ({ computeMomentumFeatures } = await import('../../quant/indicators/momentum'));
    ({ computeVolumeFeatures } = await import('../../quant/indicators/volume'));
    ({ computeSupportResistanceFeatures } = await import('../../quant/indicators/supportResistance'));
    ({ computeSmcFeatures } = await import('../../quant/indicators/smc'));
  });

  afterAll(() => {
    try { fs.unlinkSync(tmpDbPath); } catch { /* best effort */ }
    delete process.env.ARGUS_DB_PATH;
  });

  it('persists a full provenance row for a real evaluation', async () => {
    const decisionId = uid();
    const symbol = 'PITTEST';
    const bars = seededBars(120, 42);
    const ctx = productionShapedContext(symbol, bars);
    const evaluations = evaluateAll(ctx);
    expect(evaluations.length).toBeGreaterThan(0);
    const decisionTimeMs = Date.now();

    const outcome = await mod.persistDecisionProvenance(provenanceInput(decisionId, symbol, bars, ctx, evaluations, decisionTimeMs));
    expect(outcome).toBe('written');

    const row = sqliteDb.prepare(`SELECT * FROM ${mod.DECISION_PROVENANCE_TABLE} WHERE decision_id = ?`).get(decisionId);
    expect(row).toBeDefined();
    expect(row.symbol).toBe(symbol);
    expect(row.decision_time_ms).toBe(decisionTimeMs);
    expect(row.build_sha).toBe(mod.resolveBuildSha());
    expect(row.evaluation_fingerprint).toBe(mod.sha256Hex(mod.stableStringify(evaluations)));
    // Bar evidence: every input bar retained with its available-at timestamp (no-lookahead audit).
    const barEvidence = JSON.parse(row.bar_evidence_json);
    expect(barEvidence).toHaveLength(120);
    expect(barEvidence[0].barId).toBe(`${symbol}:1Day:${bars[0].timestamp}`);
    for (const b of barEvidence) expect(b.availableAtMs).toBeLessThanOrEqual(decisionTimeMs);
    // Quote evidence: the quote used + its observation timestamp.
    const quote = JSON.parse(row.quote_json);
    expect(quote.price).toBe(bars[bars.length - 1].close);
    // Strategy versions recorded for every evaluated strategy; lifecycle states read (not seeded).
    const versions = JSON.parse(row.strategy_versions_json);
    for (const e of evaluations) expect(typeof versions[e.strategy]).toBe('string');
    const lifecycle = JSON.parse(row.lifecycle_states_json);
    for (const e of evaluations) expect(typeof lifecycle[e.strategy]).toBe('string');
  });

  it('POINT_IN_TIME_REPLAY: replay through the REAL evaluateAll() path equals production', async () => {
    // What is asserted equal: the FULL StrategyEvaluation objects for every strategy
    // evaluateAll() evaluated (side, setupScore, confidence, triggerMet, conditionsMet,
    // conditionsFailed, contradictions, invalidationConditions, stop, target,
    // applicableRegimes) — compared under canonical JSON plus sha256 fingerprints.
    // Preconditions (fail closed, documented in replayQuantDecision): identical build SHA
    // and identical strategy-spec config versions; a different build invalidates the
    // comparison rather than silently passing.
    const decisionId = uid();
    const symbol = 'PITREPLAY';
    const bars = seededBars(150, 1337);
    const ctx = productionShapedContext(symbol, bars);
    // "Production": the real evaluation path on the real (in-memory) context.
    const productionEvaluations = evaluateAll(ctx);
    expect(productionEvaluations.length).toBeGreaterThan(0);

    const outcome = await mod.persistDecisionProvenance(provenanceInput(decisionId, symbol, bars, ctx, productionEvaluations, Date.now()));
    expect(outcome).toBe('written');

    // "Replay": loads ONLY from what was persisted (real SQLite read + JSON.parse — the
    // in-memory ctx object above is never reused), validates no-lookahead, then runs the
    // same real evaluateAll() on the reconstructed context.
    const result = await mod.replayQuantDecision(decisionId);
    expect(result.equal).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.decisionId).toBe(decisionId);
    expect(result.replayEvaluations).toEqual(result.productionEvaluations);
    expect(result.replayEvaluations).toEqual(productionEvaluations);
    expect(mod.sha256Hex(mod.stableStringify(result.replayEvaluations))).toBe(
      mod.sha256Hex(mod.stableStringify(productionEvaluations)),
    );
  });

  it('no-lookahead: emission REFUSES provenance claiming data available after decision time', async () => {
    const decisionId = uid();
    const symbol = 'PITFUTURE';
    const bars = seededBars(120, 7);
    const ctx = productionShapedContext(symbol, bars);
    const evaluations = evaluateAll(ctx);
    const decisionTimeMs = Date.now();

    const input = provenanceInput(decisionId, symbol, bars, ctx, evaluations, decisionTimeMs);
    // Deliberate future-data injection: one bar claims to have been available an hour AFTER the decision.
    input.bars[10] = { ...input.bars[10], availableAtMs: decisionTimeMs + 3_600_000 };

    expect(() => mod.assertNoLookahead(input)).toThrow(mod.ProvenanceLookaheadViolation);
    expect(mod.findLookaheadViolations(input)).toHaveLength(1);

    const outcome = await mod.persistDecisionProvenance(input);
    expect(outcome).toBe('rejected_lookahead');
    // Fail closed: the untrustworthy row was NOT stored.
    expect(
      sqliteDb.prepare(`SELECT id FROM ${mod.DECISION_PROVENANCE_TABLE} WHERE decision_id = ?`).get(decisionId),
    ).toBeUndefined();
  });

  it('no-lookahead: the replay engine REJECTS a hand-inserted future-dated row', async () => {
    const decisionId = uid();
    const symbol = 'PITHAND';
    const bars = seededBars(120, 99);
    const ctx = productionShapedContext(symbol, bars);
    const evaluations = evaluateAll(ctx);
    const decisionTimeMs = Date.now();

    // Hand-insert a row whose bar evidence postdates the decision (bypassing write-time
    // enforcement — the replay-time check is the second line of defense).
    const evilBars = mod.buildBarEvidence(symbol, '1Day', bars, decisionTimeMs, DAY_MS);
    evilBars[0] = { ...evilBars[0], availableAtMs: decisionTimeMs + 60_000 };
    sqliteDb.prepare(
      `INSERT INTO ${mod.DECISION_PROVENANCE_TABLE}
       (id, decision_id, symbol, timeframe, decision_time_ms, bar_evidence_json, quote_json,
        strategy_context_json, evaluations_json, evaluation_fingerprint, build_sha, created_at)
       VALUES (?, ?, 'X', '1Day', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      decisionId, decisionId, decisionTimeMs,
      JSON.stringify(evilBars),
      JSON.stringify({ price: 100, observedAtMs: decisionTimeMs - 1000, source: 'test' }),
      JSON.stringify(ctx),
      JSON.stringify(evaluations),
      mod.sha256Hex(mod.stableStringify(evaluations)),
      mod.resolveBuildSha(),
      new Date().toISOString(),
    );

    await expect(mod.replayQuantDecision(decisionId)).rejects.toThrow(mod.ProvenanceLookaheadViolation);
  });

  it('replay fails closed on a missing row, a truncated context, and a build mismatch', async () => {
    await expect(mod.replayQuantDecision('no-such-decision')).rejects.toThrow(mod.ProvenanceNotFound);

    const truncatedId = uid();
    sqliteDb.prepare(
      `INSERT INTO ${mod.DECISION_PROVENANCE_TABLE}
       (id, decision_id, symbol, timeframe, decision_time_ms, strategy_context_json, context_truncated, created_at)
       VALUES (?, ?, 'X', '1Day', ?, NULL, 1, ?)`,
    ).run(truncatedId, truncatedId, Date.now(), new Date().toISOString());
    await expect(mod.replayQuantDecision(truncatedId)).rejects.toThrow(mod.ProvenanceContextTruncated);

    // Build mismatch: the row was recorded under a different build — equality is not
    // claimable across builds, so replay refuses rather than comparing.
    const decisionId = uid();
    const symbol = 'PITBUILD';
    const bars = seededBars(120, 55);
    const ctx = productionShapedContext(symbol, bars);
    const evaluations = evaluateAll(ctx);
    const outcome = await mod.persistDecisionProvenance(provenanceInput(decisionId, symbol, bars, ctx, evaluations, Date.now()));
    expect(outcome).toBe('written');
    sqliteDb.prepare(`UPDATE ${mod.DECISION_PROVENANCE_TABLE} SET build_sha = ? WHERE decision_id = ?`)
      .run('deadbeef-different-build', decisionId);
    await expect(mod.replayQuantDecision(decisionId)).rejects.toThrow(mod.ProvenanceVersionMismatch);
  });

  it('byte caps: an oversized strategy context is redacted in code, never written unbounded', () => {
    // A 200KB free-text blob inside the context must be truncated to the redaction cap —
    // numbers pass through untouched (replay equality depends on numeric fidelity).
    const giant = { note: 'x'.repeat(200_000), nested: { value: 1.5, label: 'y'.repeat(200_000) } };
    const bounded = mod.boundPayload(giant, mod.PROVENANCE_STRATEGY_CONTEXT_MAX_BYTES);
    expect(bounded.truncated).toBe(false);
    expect(bounded.json).not.toBeNull();
    expect(Buffer.byteLength(bounded.json as string, 'utf8')).toBeLessThanOrEqual(mod.PROVENANCE_STRATEGY_CONTEXT_MAX_BYTES);
    const parsed = JSON.parse(bounded.json as string);
    expect(parsed.nested.value).toBe(1.5); // numerics untouched
    expect(parsed.note).toContain('[truncated');

    // Beyond even redaction (pure numeric bulk): json=null signals the caller to record the
    // truncation honestly (context_truncated=1) instead of writing an oversized row.
    const numericBulk = Array.from({ length: 30_000 }, (_, i) => i * 1.000001);
    const tooBig = mod.boundPayload({ data: numericBulk }, 1024);
    expect(tooBig.truncated).toBe(true);
    expect(tooBig.json).toBeNull();
  });

  it('per-decision row cap: duplicate writes beyond the cap are skipped', async () => {
    const decisionId = uid();
    const symbol = 'PITCAP';
    const bars = seededBars(120, 21);
    const ctx = productionShapedContext(symbol, bars);
    const evaluations = evaluateAll(ctx);
    const input = provenanceInput(decisionId, symbol, bars, ctx, evaluations, Date.now());

    // Fill the per-decision cap by hand (the cap is defense-in-depth; a traceId appears once).
    const insert = sqliteDb.prepare(
      `INSERT INTO ${mod.DECISION_PROVENANCE_TABLE} (id, decision_id, symbol, timeframe, decision_time_ms, created_at)
       VALUES (?, ?, 'X', '1Day', ?, ?)`,
    );
    for (let i = 0; i < mod.PROVENANCE_MAX_ROWS_PER_DECISION; i++) {
      insert.run(`${decisionId}-dup-${i}`, decisionId, Date.now(), new Date().toISOString());
    }
    const outcome = await mod.persistDecisionProvenance(input);
    expect(outcome).toBe('skipped_row_cap');
  });

  it('buildBarEvidence never claims availability after the observation time', () => {
    const observedAt = 1_700_000_000_000;
    const bars = [{ timestamp: observedAt - 10 * DAY_MS }, { timestamp: observedAt - 60_000 }];
    const evidence = mod.buildBarEvidence('SYM', '1Day', bars, observedAt, DAY_MS);
    expect(evidence[0].barId).toBe(`SYM:1Day:${bars[0].timestamp}`);
    // Completed bar: available at its close.
    expect(evidence[0].availableAtMs).toBe(bars[0].timestamp + DAY_MS);
    // Still-forming bar: available only when observed (clamped to observedAt).
    expect(evidence[1].availableAtMs).toBe(observedAt);
    for (const b of evidence) expect(b.availableAtMs).toBeLessThanOrEqual(observedAt);
  });

  it('recordDecisionProvenance never throws and never blocks the caller', () => {
    // Even garbage input must not propagate — provenance is telemetry, never a gate.
    expect(() => mod.recordDecisionProvenance(undefined as any)).not.toThrow();
    expect(() => mod.recordDecisionProvenance(null as any)).not.toThrow();
    expect(() => mod.recordDecisionProvenance({} as any)).not.toThrow();
  });
});
