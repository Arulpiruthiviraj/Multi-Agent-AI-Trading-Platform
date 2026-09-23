import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('forecastEngine (Institutional Transformation Mandate Part 7)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let mod: typeof import('./forecastEngine');
  let fetchSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_forecast_engine_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    mod = await import('./forecastEngine');
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  beforeEach(() => {
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
    delete process.env.QUANT_JAVA_CORE_ENABLED;
  });

  it('returns MODEL_UNAVAILABLE (never a fabricated forecast) when the Java bridge is disabled', async () => {
    const forecast = await mod.buildForecast({ agentName: 'QuantEngine', symbol: 'FCUNAVAIL', direction: 'BUY' });
    expect(forecast.status).toBe('MODEL_UNAVAILABLE');
    expect(forecast.expectedReturn).toBeNull();
    expect(forecast.probabilityOfProfit).toBeNull();
  });

  it('correctly orients returns for BUY vs SELL and only includes the matching direction/agent, then persists the real forecast', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const ts = new Date().toISOString();

    // 25 real BUY predictions for TechnicalAgent on FCORIENT with a real +0.01 actualReturn each -
    // favorable for BUY (oriented value stays +0.01).
    const buyRows = Array.from({ length: 25 }, (_, i) => ({
      id: `fc-buy-${i}`, agentName: 'TechnicalAgent', symbol: 'FCORIENT', prediction: 'BUY' as const,
      confidence: 0.7, reasoning: 'RSI oversold bounce', timestamp: ts,
    }));
    // 25 real SELL predictions with the SAME raw +0.01 actualReturn - unfavorable for SELL, so the
    // oriented sample below must be built from SELL-only rows, and must flip the sign.
    const sellRows = Array.from({ length: 25 }, (_, i) => ({
      id: `fc-sell-${i}`, agentName: 'TechnicalAgent', symbol: 'FCORIENT', prediction: 'SELL' as const,
      confidence: 0.7, reasoning: 'RSI overbought fade', timestamp: ts,
    }));
    await db.insert(schema.agentPredictions).values([...buyRows, ...sellRows]);
    await db.insert(schema.predictionOutcomes).values([
      ...buyRows.map((r) => ({ predictionId: r.id, sourceTable: 'agent_predictions', symbol: 'FCORIENT', actualReturn: 0.01, actualPrice: 101, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: ts })),
      ...sellRows.map((r) => ({ predictionId: r.id, sourceTable: 'agent_predictions', symbol: 'FCORIENT', actualReturn: 0.01, actualPrice: 101, actualDirection: 'UP', outcome: 'LOSS', evaluatedAt: ts })),
    ]);

    let capturedBody: any = null;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      const fakeResult = {
        schemaVersion: 1, status: 'VALID', sampleSize: capturedBody.historicalReturns.length,
        meanReturn: -0.01, medianReturn: -0.01, trimmedMeanReturn: -0.01, stdevReturn: 0,
        meanReturnLower: -0.01, meanReturnUpper: -0.01,
        probabilityOfProfit: 0, probabilityOfProfitLower: 0, probabilityOfProfitUpper: 0.13,
        transactionCostBps: capturedBody.transactionCostBps, netExpectedReturn: -0.01,
      };
      return new Response(JSON.stringify(fakeResult), { status: 200 });
    });

    const forecast = await mod.buildForecast({ agentName: 'TechnicalAgent', symbol: 'FCORIENT', direction: 'SELL' });

    // 25 SELL rows only - BUY rows must be excluded from the sample sent to Java.
    expect(capturedBody.historicalReturns).toHaveLength(25);
    // Raw actualReturn was +0.01 for every row, but SELL orientation flips it to -0.01.
    expect(capturedBody.historicalReturns.every((v: number) => v === -0.01)).toBe(true);

    expect(forecast.status).toBe('VALID');
    expect(forecast.direction).toBe('SELL');
    expect(forecast.expectedReturn).toBe(-0.01);
    expect(forecast.estimatedTransactionCostBps).toBeNull();
    expect(forecast.netExpectedReturn).toBeNull();
    expect(forecast.probabilityOfProfit).toBeNull();
    expect(forecast.provenance.transactionCostSource).toBe('UNKNOWN_TOTAL_COST');
    expect(forecast.sampleSize).toBe(25);
    expect(forecast.modelVersion).toBe(mod.FORECAST_MODEL_VERSION);
    expect(forecast.provenance.sourceRowCount).toBe(25);

    // Persisted, immutable, and readable back via the bounded read-only lookup.
    const persisted = await db.select().from(schema.quantForecasts).where(
      (await import('drizzle-orm')).eq(schema.quantForecasts.forecastId, forecast.forecastId),
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0].forecastStatus).toBe('VALID');
    expect(persisted[0].sampleSize).toBe(25);
    expect(persisted[0].estimatedTransactionCostBps).toBeNull();
    expect(persisted[0].netExpectedReturn).toBeNull();

    const readBack = await mod.mostRecentForecast('FCORIENT', 'TechnicalAgent', null, 'SELL');
    expect(readBack?.forecastId).toBe(forecast.forecastId);
    expect(readBack?.expectedReturn).toBe(-0.01);
  });

  it('Net-Expectancy Plumbing end-to-end: real MEASURED PAPER_ORGANIC cost evidence propagates gross -> cost -> net through a real buildForecast() call', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const ts = new Date().toISOString();

    // Real gross-return evidence, same pattern as the orientation test above.
    const buyRows = Array.from({ length: 25 }, (_, i) => ({
      id: `fc-cost-buy-${i}`, agentName: 'CostFlowAgent', symbol: 'FCCOSTFLOW', prediction: 'BUY' as const,
      confidence: 0.7, reasoning: 'real signal', timestamp: ts,
    }));
    await db.insert(schema.agentPredictions).values(buyRows);
    await db.insert(schema.predictionOutcomes).values(
      buyRows.map((r) => ({ predictionId: r.id, sourceTable: 'agent_predictions', symbol: 'FCCOSTFLOW', actualReturn: 0.02, actualPrice: 102, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: ts })),
    );

    // Real PAPER_ORGANIC trade-economic-attribution evidence: researchSafety.minOosTrades (30) real
    // SELL legs on Alpaca (verified $0-commission equity broker), each with a real, small, known
    // slippage - clears the trustworthy-sample floor resolveExpectedCost() requires.
    const researchSafety = (await import('../config/researchSafety')).researchSafety;
    for (let i = 0; i < researchSafety.minOosTrades; i++) {
      const tx = `cost-tx-${i}`;
      await db.insert(schema.consensusDecisions).values({ transactionId: tx, symbol: 'COSTEQ', side: 'SELL', weightedConfidence: .8, threshold: .75, approved: true, createdAt: ts });
      await db.insert(schema.consensusEvidence).values({ transactionId: tx, agent: 'TechnicalAgent', side: 'SELL', confidence: .8, weight: 1, agreed: true });
      await db.insert(schema.trades).values({
        id: tx, transactionId: tx, traceId: `trace-COSTEQ-${i}`, symbol: 'COSTEQ', side: 'SELL', quantity: 10,
        price: 99.5, arrivalPrice: 100, status: 'FILLED', timestamp: ts, executionEnvironment: 'PAPER',
        brokerId: 'alpaca', profitLoss: -5,
      });
      await db.insert(schema.fills).values({ orderId: tx, quantity: 10, price: 99.5, cumulativeQuantity: 10, filledAt: ts });
    }

    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      const body = JSON.parse(init.body);
      return new Response(JSON.stringify({
        schemaVersion: 1, status: 'VALID', sampleSize: body.historicalReturns.length,
        meanReturn: 0.02, medianReturn: 0.02, trimmedMeanReturn: 0.02, stdevReturn: 0,
        meanReturnLower: 0.02, meanReturnUpper: 0.02,
        probabilityOfProfit: 1, probabilityOfProfitLower: 1, probabilityOfProfitUpper: 1,
        transactionCostBps: body.transactionCostBps, netExpectedReturn: null,
      }), { status: 200 });
    });

    const forecast = await mod.buildForecast({ agentName: 'CostFlowAgent', symbol: 'FCCOSTFLOW', direction: 'BUY' });

    expect(forecast.status).toBe('VALID');
    expect(forecast.expectedReturn).toBe(0.02);
    expect(forecast.costQuality).toBe('MEASURED');
    expect(forecast.provenance.transactionCostSource).toBe('REAL_EXECUTION_QUALITY');
    expect(forecast.provenance.costSampleSize).toBe(researchSafety.minOosTrades);
    // SELL filled at 99.5 vs arrival 100 = 0.5 worse per share = 50bps slippage; $0 Alpaca equity
    // commission -> real total cost = 50bps for every seeded leg.
    expect(forecast.estimatedTransactionCostBps).toBeCloseTo(50, 6);
    expect(forecast.netReturnAvailable).toBe(true);
    // netExpectedReturn = grossExpectedReturn(0.02) - costBps(50)/10000 = 0.02 - 0.005 = 0.015
    expect(forecast.netExpectedReturn).toBeCloseTo(0.015, 6);

    // Persisted and read back faithfully - proves the whole gross -> cost -> net -> DB -> read
    // round trip, not just the in-memory return value.
    const readBack = await mod.mostRecentForecast('FCCOSTFLOW', 'CostFlowAgent', null, 'BUY');
    expect(readBack?.costQuality).toBe('MEASURED');
    expect(readBack?.netExpectedReturn).toBeCloseTo(0.015, 6);
    expect(readBack?.netReturnAvailable).toBe(true);
  });

  it('filters by real strategy id via secondaryGroupKey for QuantEngine, excluding a different strategy\'s rows', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const ts = new Date().toISOString();

    await db.insert(schema.agentPredictions).values([
      { id: 'fc-mom-1', agentName: 'QuantEngine', symbol: 'FCSTRAT', prediction: 'BUY', confidence: 0.7, reasoning: 'QuantEngine/MOMENTUM_BREAKOUT: setupScore 0.8.', timestamp: ts },
      { id: 'fc-mom-2', agentName: 'QuantEngine', symbol: 'FCSTRAT', prediction: 'BUY', confidence: 0.7, reasoning: 'QuantEngine/MOMENTUM_BREAKOUT: setupScore 0.75.', timestamp: ts },
      { id: 'fc-range-1', agentName: 'QuantEngine', symbol: 'FCSTRAT', prediction: 'BUY', confidence: 0.7, reasoning: 'QuantEngine/RANGE_REVERSION: setupScore 0.7.', timestamp: ts },
    ]);
    await db.insert(schema.predictionOutcomes).values([
      { predictionId: 'fc-mom-1', sourceTable: 'agent_predictions', symbol: 'FCSTRAT', actualReturn: 0.02, actualPrice: 102, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: ts },
      { predictionId: 'fc-mom-2', sourceTable: 'agent_predictions', symbol: 'FCSTRAT', actualReturn: 0.03, actualPrice: 103, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: ts },
      { predictionId: 'fc-range-1', sourceTable: 'agent_predictions', symbol: 'FCSTRAT', actualReturn: -0.5, actualPrice: 50, actualDirection: 'DOWN', outcome: 'LOSS', evaluatedAt: ts },
    ]);

    let capturedBody: any = null;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: capturedBody.historicalReturns.length, meanReturn: null, medianReturn: null, trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null, probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null, transactionCostBps: 0, netExpectedReturn: null }), { status: 200 });
    });

    await mod.buildForecast({ agentName: 'QuantEngine', strategyId: 'MOMENTUM_BREAKOUT', symbol: 'FCSTRAT', direction: 'BUY' });

    // Only the 2 MOMENTUM_BREAKOUT rows, never the RANGE_REVERSION row's catastrophic -0.5 return.
    expect(capturedBody.historicalReturns).toHaveLength(2);
    expect(capturedBody.historicalReturns).toEqual(expect.arrayContaining([0.02, 0.03]));
  });

  it('marks the forecast INSUFFICIENT_DATA (real Java response, not a local guess) when the real sample is thin', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: 0, meanReturn: null, medianReturn: null,
      trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null,
      probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
      transactionCostBps: 0, netExpectedReturn: null,
    }), { status: 200 }));

    const forecast = await mod.buildForecast({ agentName: 'NoSuchAgent', symbol: 'FCTHIN', direction: 'BUY' });
    expect(forecast.status).toBe('INSUFFICIENT_DATA');
    expect(forecast.expectedReturn).toBeNull();
  });

  it('reads real historical returns from prediction_outcome_horizons for a non-default horizon label, honestly finding zero rows today', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    let capturedBody: any = null;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: 0, meanReturn: null, medianReturn: null, trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null, probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null, transactionCostBps: 0, netExpectedReturn: null }), { status: 200 });
    });

    const forecast = await mod.buildForecast({ agentName: 'QuantEngine', symbol: 'FCHORIZON', direction: 'BUY', horizonLabel: '1_BAR' });
    expect(capturedBody.historicalReturns).toHaveLength(0);
    expect(forecast.provenance.sourceTable).toBe('prediction_outcome_horizons');
    expect(forecast.status).toBe('INSUFFICIENT_DATA');
  });

  it('caps the historical-return sample sent to Java to the most recent forecastEngineMaxSampleSize observations (real bug found this pass: an unbounded sample blew the 100ms Java bridge timeout)', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    const { tradingSafety } = await import('../config/tradingSafety');
    const cap = tradingSafety.forecastEngineMaxSampleSize;
    const totalRows = cap + 50; // deliberately more than the cap
    const baseTime = Date.now();

    const rows = Array.from({ length: totalRows }, (_, i) => ({
      id: `fc-cap-${i}`, agentName: 'CapTestAgent', symbol: 'FCCAP', prediction: 'BUY' as const,
      confidence: 0.7, reasoning: 'test', timestamp: new Date(baseTime + i * 1000).toISOString(),
    }));
    await db.insert(schema.agentPredictions).values(rows);
    await db.insert(schema.predictionOutcomes).values(
      rows.map((r, i) => ({
        predictionId: r.id, sourceTable: 'agent_predictions', symbol: 'FCCAP',
        // Distinct return per row (i) so we can prove exactly which ones survived the cap.
        actualReturn: i / 100000, actualPrice: 100, actualDirection: 'UP', outcome: 'WIN', evaluatedAt: r.timestamp,
      })),
    );

    let capturedBody: any = null;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (_url, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ schemaVersion: 1, status: 'VALID', sampleSize: capturedBody.historicalReturns.length, meanReturn: 0, medianReturn: 0, trimmedMeanReturn: 0, stdevReturn: 0, meanReturnLower: 0, meanReturnUpper: 0, probabilityOfProfit: 0.5, probabilityOfProfitLower: 0.4, probabilityOfProfitUpper: 0.6, transactionCostBps: 0, netExpectedReturn: 0 }), { status: 200 });
    });

    const forecast = await mod.buildForecast({ agentName: 'CapTestAgent', symbol: 'FCCAP', direction: 'BUY' });

    // The real payload sent to Java must never exceed the configured cap, regardless of how much
    // real history exists - this is what actually fixes the 100ms timeout.
    expect(capturedBody.historicalReturns).toHaveLength(cap);
    // Provenance must report BOTH numbers honestly - the true total evidence found, and what was
    // actually sent - never silently understating how much real history exists.
    expect(forecast.provenance.sourceRowCount).toBe(totalRows);
    expect(forecast.provenance.sampleSizeSentToModel).toBe(cap);
    // The most RECENT rows must be the ones kept (highest i values -> largest actualReturn),
    // never an arbitrary or oldest-first slice.
    const maxSent = Math.max(...capturedBody.historicalReturns);
    expect(maxSent).toBeCloseTo((totalRows - 1) / 100000, 9);
  });

  it('persists real, caller-supplied ensembleEvidence and preserves it through mostRecentForecast read-back (Part 7/9 integration)', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, status: 'VALID', sampleSize: 25, meanReturn: 0.005, medianReturn: 0.004,
      trimmedMeanReturn: 0.0045, stdevReturn: 0.01, meanReturnLower: 0.001, meanReturnUpper: 0.009,
      probabilityOfProfit: 0.58, probabilityOfProfitLower: 0.4, probabilityOfProfitUpper: 0.74,
      transactionCostBps: 0, netExpectedReturn: 0.005,
    }), { status: 200 }));

    const forecast = await mod.buildForecast({
      agentName: 'QuantEngine', strategyId: 'MOMENTUM_BREAKOUT', symbol: 'FCEVIDENCE', direction: 'BUY',
      ensembleEvidence: { strategyCount: 7, familyCount: 3, effectiveIndependentCount: 2.6 },
    });
    // Real, correlation-adjusted independence - never inflated to equal raw strategyCount.
    expect(forecast.strategyCount).toBe(7);
    expect(forecast.familyCount).toBe(3);
    expect(forecast.effectiveIndependentCount).toBe(2.6);

    const readBack = await mod.mostRecentForecast('FCEVIDENCE', 'QuantEngine', 'MOMENTUM_BREAKOUT', 'BUY');
    expect(readBack).not.toBeNull();
    expect(readBack!.strategyCount).toBe(7);
    expect(readBack!.familyCount).toBe(3);
    expect(readBack!.effectiveIndependentCount).toBe(2.6);
  });

  it('leaves strategyCount/familyCount/effectiveIndependentCount null (UNKNOWN, never fabricated) when no ensembleEvidence is supplied', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: 0, meanReturn: null, medianReturn: null,
      trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null,
      probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
      transactionCostBps: 0, netExpectedReturn: null,
    }), { status: 200 }));

    const forecast = await mod.buildForecast({ agentName: 'QuantEngine', symbol: 'FCNOEVIDENCE', direction: 'BUY' });
    expect(forecast.strategyCount).toBeNull();
    expect(forecast.familyCount).toBeNull();
    expect(forecast.effectiveIndependentCount).toBeNull();
  });

  it('coalesces concurrent buildForecast calls for the identical key into a single Java call and a single persisted row (forensic audit fix, 2026-09-14)', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    let fetchCallCount = 0;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      // Simulate real latency so the two calls below genuinely overlap in time.
      await new Promise((r) => setTimeout(r, 30));
      return new Response(JSON.stringify({
        schemaVersion: 1, status: 'VALID', sampleSize: 0, meanReturn: 0.001, medianReturn: 0.001,
        trimmedMeanReturn: 0.001, stdevReturn: 0, meanReturnLower: 0.001, meanReturnUpper: 0.001,
        probabilityOfProfit: 1, probabilityOfProfitLower: 0.9, probabilityOfProfitUpper: 1,
        transactionCostBps: 0, netExpectedReturn: 0.001,
      }), { status: 200 });
    });

    const req = { agentName: 'CoalesceTestAgent', symbol: 'FCCOALESCE', direction: 'BUY' as const };
    const [first, second] = await Promise.all([mod.buildForecast(req), mod.buildForecast(req)]);

    expect(fetchCallCount).toBe(1); // NOT 2 - the second call must not trigger a redundant Java call
    expect(first.forecastId).toBe(second.forecastId); // same coalesced result, not two separate builds

    const persisted = await db.select().from(schema.quantForecasts).where(
      (await import('drizzle-orm')).eq(schema.quantForecasts.symbol, 'FCCOALESCE'),
    );
    expect(persisted).toHaveLength(1); // exactly one row, not two near-duplicate ones

    // A THIRD call after both in-flight calls have resolved must start a genuinely new build
    // (the in-flight guard must release itself, never permanently dedupe a key).
    const third = await mod.buildForecast(req);
    expect(fetchCallCount).toBe(2);
    expect(third.forecastId).not.toBe(first.forecastId);
  });

  it('does NOT coalesce two different real keys (different symbol) - each gets its own real Java call', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    let fetchCallCount = 0;
    fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({
        schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: 0, meanReturn: null, medianReturn: null,
        trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null,
        probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
        transactionCostBps: 0, netExpectedReturn: null,
      }), { status: 200 });
    });

    await Promise.all([
      mod.buildForecast({ agentName: 'DistinctKeyAgent', symbol: 'FCDISTINCT1', direction: 'BUY' }),
      mod.buildForecast({ agentName: 'DistinctKeyAgent', symbol: 'FCDISTINCT2', direction: 'BUY' }),
    ]);
    expect(fetchCallCount).toBe(2);
  });

  it('mostRecentForecast finds the real forecast for the requested strategy even when 60+ other-strategy forecasts were built more recently under the same symbol/agent/direction/horizon (forensic audit fix, FD-3)', async () => {
    process.env.QUANT_JAVA_CORE_ENABLED = 'true';
    fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      schemaVersion: 1, status: 'INSUFFICIENT_DATA', sampleSize: 0, meanReturn: null, medianReturn: null,
      trimmedMeanReturn: null, stdevReturn: null, meanReturnLower: null, meanReturnUpper: null,
      probabilityOfProfit: null, probabilityOfProfitLower: null, probabilityOfProfitUpper: null,
      transactionCostBps: 0, netExpectedReturn: null,
    }), { status: 200 }));

    // Real forecast for the strategy we'll actually ask about, built first (oldest).
    const target = await mod.buildForecast({ agentName: 'QuantEngine', strategyId: 'RARE_STRATEGY', symbol: 'FCMANYROWS', direction: 'BUY' });

    // 60 real forecasts for a DIFFERENT strategy under the identical (symbol, agent, direction,
    // horizon) key, all built after the target - previously enough to push it out of a top-50 window.
    for (let i = 0; i < 60; i++) {
      await mod.buildForecast({ agentName: 'QuantEngine', strategyId: 'CHATTY_STRATEGY', symbol: 'FCMANYROWS', direction: 'BUY' });
    }

    const found = await mod.mostRecentForecast('FCMANYROWS', 'QuantEngine', 'RARE_STRATEGY', 'BUY');
    expect(found).not.toBeNull();
    expect(found!.forecastId).toBe(target.forecastId);
    expect(found!.strategyId).toBe('RARE_STRATEGY');
  });

  it('mostRecentForecast returns null (never fabricates) when no forecast has ever been persisted for that key', async () => {
    const result = await mod.mostRecentForecast('FCNEVER', 'QuantEngine', null, 'BUY');
    expect(result).toBeNull();
  });

  it('never fabricates probabilityOfProfit even on a legacy row where some other value was manually forced in, and never mutates the historical row on read', async () => {
    const forecast = await mod.buildForecast({ agentName: 'LegacyCost', symbol: 'FCLEGACY', direction: 'BUY' });
    sqliteDb.prepare('UPDATE quant_forecasts SET probability_of_profit=0.9 WHERE forecast_id=?').run(forecast.forecastId);
    const before = sqliteDb.prepare('SELECT * FROM quant_forecasts WHERE forecast_id=?').get(forecast.forecastId);
    const read = await mod.mostRecentForecast('FCLEGACY', 'LegacyCost', null, 'BUY');
    // probabilityOfProfit is still not computed by this module at all (a distinct, not-yet-built
    // piece) - the read path never surfaces it regardless of what a stray DB value contains.
    expect(read?.probabilityOfProfit).toBeNull();
    expect(sqliteDb.prepare('SELECT * FROM quant_forecasts WHERE forecast_id=?').get(forecast.forecastId)).toEqual(before);
  });

  it('Net-Expectancy Plumbing backward compatibility: a genuinely legacy row (written before migration 0073, cost_quality/cost_sample_size columns NULL) reads back as UNAVAILABLE, never crashes, never fabricates MEASURED', async () => {
    const forecast = await mod.buildForecast({ agentName: 'PreMigrationAgent', symbol: 'FCPREMIG', direction: 'BUY' });
    // Simulate the exact shape every real production row had before this pass: the OLD write path
    // always persisted null for these two columns (resolveTransactionCostBps() never returned a
    // real bps value), and the two new columns did not exist yet, so drizzle inserted them as NULL.
    sqliteDb.prepare('UPDATE quant_forecasts SET estimated_transaction_cost_bps=NULL, net_expected_return=NULL, cost_quality=NULL, cost_sample_size=NULL WHERE forecast_id=?').run(forecast.forecastId);
    const read = await mod.mostRecentForecast('FCPREMIG', 'PreMigrationAgent', null, 'BUY');
    expect(read).not.toBeNull();
    expect(read!.costQuality).toBe('UNAVAILABLE');
    expect(read!.netReturnAvailable).toBe(false);
    expect(read!.estimatedTransactionCostBps).toBeNull();
    expect(read!.netExpectedReturn).toBeNull();
    expect(read!.provenance.costSampleSize).toBe(0);
  });

  it('Net-Expectancy Plumbing: a forecast row with real MEASURED cost data reads back faithfully, not suppressed to null', async () => {
    const forecast = await mod.buildForecast({ agentName: 'RealCostAgent', symbol: 'FCREALCOST', direction: 'BUY' });
    // Simulate what buildForecast() itself would persist once real measured-cost evidence exists
    // (integration-tested separately in tradeEconomicAttribution.test.ts / canonicalCostModel.test.ts
    // for the cost computation itself - this test is specifically about the read path not silently
    // discarding real persisted values, the actual bug this pass fixed).
    sqliteDb.prepare("UPDATE quant_forecasts SET estimated_transaction_cost_bps=12.5, net_expected_return=0.0088, cost_quality='MEASURED', cost_sample_size=42 WHERE forecast_id=?").run(forecast.forecastId);
    const read = await mod.mostRecentForecast('FCREALCOST', 'RealCostAgent', null, 'BUY');
    expect(read).not.toBeNull();
    expect(read!.costQuality).toBe('MEASURED');
    expect(read!.netReturnAvailable).toBe(true);
    expect(read!.estimatedTransactionCostBps).toBeCloseTo(12.5, 6);
    expect(read!.netExpectedReturn).toBeCloseTo(0.0088, 6);
    expect(read!.provenance.costSampleSize).toBe(42);
  });
});
