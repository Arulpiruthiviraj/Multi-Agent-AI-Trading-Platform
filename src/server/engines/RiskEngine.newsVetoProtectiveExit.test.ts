import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';
import { resetRuntimeConfigCacheForTests } from '../config/effectiveRuntimeConfig';
import {
  mintProtectiveExitSeal,
  resetProtectiveExitSealsForTests,
  PROTECTIVE_EXIT_AUTHORIZED_MINTER,
} from '../core/protectiveExitSeal';

/**
 * Regression tests: direction-aware news_veto exemption for verified protective
 * liquidations (2026-10-12, pre-market perfection mission Phase 1 item 5).
 *
 * Real integration test (isolated temp SQLite DB, no per-module mocks) through the real
 * RiskEngine: a SYNTHETIC_SEEDED high-impact news cluster (NON_ORGANIC fixture, never
 * presented as organic evidence) is inserted for one symbol, then five proposals are
 * evaluated against it:
 *  (a) protective SELL with a verified seal PASSES news_veto during the cluster;
 *  (b) discretionary SELL during the same cluster is still VETOED;
 *  (c) discretionary BUY during the same cluster is still VETOED;
 *  (d) spoofed provenance (forged seal / cross-idea seal / bare boolean flag / replayed
 *      seal / genuine seal on a BUY) is VETOED;
 *  (e) protective SELL with a verified seal and NO news cluster passes as before.
 *
 * The veto is not weakened for anything else: only (a) and (e) pass.
 */
describe('RiskEngine news_veto protective-exit exemption', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let riskEngine: any;
  let tradingEngine: any;

  const CLUSTERED_SYMBOL = 'AAPL';
  const CLEAN_SYMBOL = 'MSFT';

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_newsveto_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    await import('../core/EventBus');
    ({ riskEngine } = await import('./RiskEngine'));
    ({ tradingEngine } = await import('./TradingEngine'));
    const { marketDataWorker } = await import('../services/MarketDataWorker');
    marketDataWorker.cacheObservedQuote(CLUSTERED_SYMBOL, 150);
    marketDataWorker.cacheObservedQuote(CLEAN_SYMBOL, 300);
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';

    // Same simulated-no-Alpaca-credentials posture as RiskEngine.gates.test.ts: delete AFTER
    // all imports (EncryptionService's dotenv side effect re-populates deleted keys).
    delete process.env.ALPACA_API_KEY;
    delete process.env.ALPACA_SECRET_KEY;

    // SYNTHETIC_SEEDED / NON_ORGANIC fixture: a simulated high-impact news cluster inside
    // the 4h veto window for CLUSTERED_SYMBOL only. impactScore 0.95 -> 95 on the veto
    // scale, above the configured newsVetoMinImpactScore (80).
    const nowIso = new Date().toISOString();
    await db.insert(schema.newsClusters).values({
      id: 'SYNTHETIC_SEEDED-news-veto-protective-exit-1',
      title: 'SYNTHETIC_SEEDED certification fixture: simulated high-impact news cluster (NON_ORGANIC)',
      createdAt: nowIso,
      updatedAt: nowIso,
      impactScore: 0.95,
      symbols: JSON.stringify([CLUSTERED_SYMBOL]),
    });

    resetProtectiveExitSealsForTests();
    resetRuntimeConfigCacheForTests();
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
    resetProtectiveExitSealsForTests();
  });

  async function newsVetoGate(traceId: string) {
    const gates = await db.select().from(schema.riskGateResults).where(eq(schema.riskGateResults.traceId, traceId));
    const gate = gates.find((g: any) => g.gateName === 'news_veto');
    expect(gate).toBeDefined();
    return { gate, detail: gate.detail ? JSON.parse(gate.detail) : {} };
  }

  function mintSeal(traceId: string, symbol: string): string {
    return mintProtectiveExitSeal({ traceId, symbol, mintedBy: PROTECTIVE_EXIT_AUTHORIZED_MINTER });
  }

  it('(a) protective SELL with verified provenance PASSES news_veto during an active high-impact cluster', async () => {
    const traceId = 'news-veto-protective-a';
    const seal = mintSeal(traceId, CLUSTERED_SYMBOL);
    await riskEngine.evaluateRisk({
      traceId,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExitSeal: seal,
    });

    const { gate, detail } = await newsVetoGate(traceId);
    expect(detail.matchingClusters).toBeGreaterThan(0); // the cluster really was active
    expect(detail.protectiveExitExempt).toBe(true); // ...and the exemption is what passed the gate
    expect(gate.passed).toBe(true);
  });

  it('(b) discretionary SELL during the same cluster is still VETOED (no seal)', async () => {
    const traceId = 'news-veto-protective-b';
    await riskEngine.evaluateRisk({
      traceId,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
    });

    const { gate, detail } = await newsVetoGate(traceId);
    expect(detail.matchingClusters).toBeGreaterThan(0);
    expect(detail.protectiveExitExempt).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it('(c) discretionary BUY during the same cluster is still VETOED', async () => {
    const traceId = 'news-veto-protective-c';
    await riskEngine.evaluateRisk({
      traceId,
      symbol: CLUSTERED_SYMBOL,
      side: 'BUY',
      currentPrice: 150,
    });

    const { gate, detail } = await newsVetoGate(traceId);
    expect(detail.matchingClusters).toBeGreaterThan(0);
    expect(detail.protectiveExitExempt).toBe(false);
    expect(gate.passed).toBe(false);
  });

  it('(d) spoofed provenance is rejected: forged seal, cross-idea seal, bare boolean flag, replayed seal, and a genuine seal on a BUY are all VETOED', async () => {
    // d1: forged seal string - never minted, not in the registry.
    const traceId1 = 'news-veto-protective-d1';
    await riskEngine.evaluateRisk({
      traceId: traceId1,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExitSeal: 'forged-seal-0000-ffff',
    });
    expect((await newsVetoGate(traceId1)).gate.passed).toBe(false);

    // d2: genuine seal minted for a DIFFERENT idea (traceId binding rejects the copy).
    const traceId2 = 'news-veto-protective-d2';
    const crossIdeaSeal = mintSeal('some-other-trace-id', CLUSTERED_SYMBOL);
    await riskEngine.evaluateRisk({
      traceId: traceId2,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExitSeal: crossIdeaSeal,
    });
    expect((await newsVetoGate(traceId2)).gate.passed).toBe(false);

    // d3: bare boolean flag (the explicitly unacceptable shape) - never read, vetoed.
    const traceId3 = 'news-veto-protective-d3';
    await riskEngine.evaluateRisk({
      traceId: traceId3,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExit: true,
    } as any);
    expect((await newsVetoGate(traceId3)).gate.passed).toBe(false);

    // d4: genuine seal replayed after single-use consumption - the second use is vetoed.
    const traceId4 = 'news-veto-protective-d4';
    const realSeal = mintSeal(traceId4, CLUSTERED_SYMBOL);
    await riskEngine.evaluateRisk({
      traceId: traceId4,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExitSeal: realSeal,
    });
    expect((await newsVetoGate(traceId4)).gate.passed).toBe(true); // first (genuine) use passes
    const traceId5 = 'news-veto-protective-d5';
    await riskEngine.evaluateRisk({
      traceId: traceId5,
      symbol: CLUSTERED_SYMBOL,
      side: 'SELL',
      currentPrice: 150,
      protectiveExitSeal: realSeal, // replay of the already-consumed seal
    });
    const replayed = await newsVetoGate(traceId5);
    expect(replayed.detail.protectiveExitExempt).toBe(false);
    expect(replayed.gate.passed).toBe(false);

    // d5: genuine seal presented on a BUY proposal - the exemption is SELL-only, so even a
    // real seal cannot exempt a BUY; vetoed exactly as before.
    const traceId6 = 'news-veto-protective-d6';
    const buySeal = mintSeal(traceId6, CLUSTERED_SYMBOL);
    await riskEngine.evaluateRisk({
      traceId: traceId6,
      symbol: CLUSTERED_SYMBOL,
      side: 'BUY',
      currentPrice: 150,
      protectiveExitSeal: buySeal,
    });
    const buyAttempt = await newsVetoGate(traceId6);
    expect(buyAttempt.detail.matchingClusters).toBeGreaterThan(0);
    expect(buyAttempt.detail.protectiveExitExempt).toBe(false);
    expect(buyAttempt.gate.passed).toBe(false);
  });

  it('(e) protective SELL with verified provenance and NO news cluster passes as before (no exemption needed)', async () => {
    const traceId = 'news-veto-protective-e';
    const seal = mintSeal(traceId, CLEAN_SYMBOL);
    await riskEngine.evaluateRisk({
      traceId,
      symbol: CLEAN_SYMBOL,
      side: 'SELL',
      currentPrice: 300,
      protectiveExitSeal: seal,
    });

    const { gate, detail } = await newsVetoGate(traceId);
    expect(detail.matchingClusters).toBe(0);
    expect(detail.protectiveExitExempt).toBe(false); // nothing to be exempt from
    expect(gate.passed).toBe(true);
  });
});
