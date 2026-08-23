import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { EVENTS } from '../core/eventNames';
import {
  isForensicCheckpointBuyLocked,
  resetForensicCheckpointBuyLockForTests,
} from '../core/forensicCheckpointBuyLock';
import { isLiveIdeaGenerationEnabled } from '../core/ideaGenerationGate';
import { tradingEngine } from '../engines/TradingEngine';
import { resetSessionRecoveryForTests } from '../core/sessionRecovery';
import { isOrganicPaperFill } from '../research/organicPaper';

describe('isOrganicPaperFill', () => {
  it('accepts FILLED PAPER and rejects REPLAY / DIAG / manual / untagged', () => {
    expect(isOrganicPaperFill({
      status: 'FILLED',
      side: 'BUY',
      symbol: 'AAPL',
      executionEnvironment: 'PAPER',
      traceId: 'live-organic-1',
    })).toBe(true);
    expect(isOrganicPaperFill({
      status: 'FILLED',
      side: 'SELL',
      symbol: 'AAPL',
      executionEnvironment: 'REPLAY',
      traceId: 'replay-1',
    })).toBe(false);
    expect(isOrganicPaperFill({
      status: 'FILLED',
      side: 'BUY',
      symbol: 'DIAG1',
      executionEnvironment: 'PAPER',
      traceId: 'x',
    })).toBe(false);
    expect(isOrganicPaperFill({
      status: 'FILLED',
      side: 'BUY',
      symbol: 'AAPL',
      reasoning: 'SOURCE: MANUAL_OVERRIDE',
      executionEnvironment: 'PAPER',
      traceId: 'manual-override-1',
    })).toBe(false);
    expect(isOrganicPaperFill({
      status: 'PENDING',
      side: 'BUY',
      symbol: 'AAPL',
      executionEnvironment: 'PAPER',
      traceId: 'x',
    })).toBe(false);
  });
});

describe('FirstFillForensicCheckpoint', () => {
  let tmpDbPath: string;
  let db: any;
  let schema: any;
  let eventBus: any;
  let checkpoint: typeof import('./FirstFillForensicCheckpoint');

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_forensic_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;
    ({ db } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    checkpoint = await import('./FirstFillForensicCheckpoint');

    await db.insert(schema.settings).values({
      budget: 10000,
      autoBotEnabled: true,
    });
  });

  afterAll(() => {
    checkpoint?.resetFirstFillForensicCheckpointForTests();
    resetForensicCheckpointBuyLockForTests();
    resetSessionRecoveryForTests();
    try { fs.unlinkSync(tmpDbPath); } catch { /* ignore */ }
  });

  beforeEach(() => {
    checkpoint.resetFirstFillForensicCheckpointForTests();
    resetForensicCheckpointBuyLockForTests();
    resetSessionRecoveryForTests();
    tradingEngine.state.enabled = true;
    tradingEngine.state.tradingState = 'TRADING_ENABLED';
  });

  async function seedPassingWorld(opts: {
    orderId: string;
    traceId: string;
    side: 'BUY' | 'SELL';
    profitLoss?: number | null;
  }) {
    const { eq } = await import('drizzle-orm');
    const now = new Date().toISOString();
    await db.insert(schema.trades).values({
      id: opts.orderId,
      symbol: 'NVDA',
      side: opts.side,
      quantity: 1,
      price: 100,
      status: 'FILLED',
      timestamp: now,
      filledAt: now,
      reasoning: 'ChiefTrader approved executionEnvironment=PAPER',
      traceId: opts.traceId,
      profitLoss: opts.profitLoss ?? null,
      executionEnvironment: 'PAPER',
    });
    await db.insert(schema.fills).values({
      orderId: opts.orderId,
      brokerFillId: `${opts.orderId}:1`,
      quantity: 1,
      price: 100,
      filledAt: now,
      cumulativeQuantity: 1,
    });
    await db.insert(schema.riskAssessments).values({
      traceId: opts.traceId,
      symbol: 'NVDA',
      side: opts.side,
      approved: true,
      maxQuantity: 1,
      createdAt: now,
    });
    await db.delete(schema.portfolio).where(eq(schema.portfolio.symbol, 'NVDA'));
    await db.insert(schema.portfolio).values({
      symbol: 'NVDA',
      quantity: opts.side === 'BUY' ? 1 : 0,
      averagePrice: 100,
      lastUpdated: now,
    });
    await db.insert(schema.reconciliationEvents).values({
      checkedAt: now,
      broker: 'test',
      matches: true,
      mismatches: '[]',
      actionTaken: 'NONE',
    });
  }

  it('PASS on first organic PAPER fill emits FORENSIC_CHECKPOINT_PASSED and does not lock BUYs', async () => {
    const orderId = `ord-pass-${Date.now()}`;
    const traceId = `trace-pass-${Date.now()}`;
    await seedPassingWorld({ orderId, traceId, side: 'BUY' });

    const disable = vi.fn(async () => ({ ok: true }));
    const passed: any[] = [];
    const failed: any[] = [];
    eventBus.on(EVENTS.FORENSIC_CHECKPOINT_PASSED, (p: any) => passed.push(p));
    eventBus.on(EVENTS.FORENSIC_CHECKPOINT_FAILED, (p: any) => failed.push(p));

    checkpoint.setFirstFillForensicDepsForTests({
      disableAutobot: disable,
      getBrokerPositions: async () => [{ symbol: 'NVDA', quantity: 1 }],
      runReconcile: async () => {},
      writeReport: () => null,
    });

    const report = await checkpoint.runFirstFillForensicCheckpoint({
      id: orderId,
      symbol: 'NVDA',
      side: 'BUY',
      quantity: 1,
      status: 'FILLED',
      traceId,
      executionEnvironment: 'PAPER',
      reasoning: 'executionEnvironment=PAPER',
    });

    expect(report?.result).toBe('PASSED');
    expect(passed.length).toBe(1);
    expect(failed.length).toBe(0);
    expect(disable).not.toHaveBeenCalled();
    expect(isForensicCheckpointBuyLocked()).toBe(false);
    expect(checkpoint.hasCompletedForensicCheckpoint()).toBe(true);

    // Second fill is a no-op
    const second = await checkpoint.runFirstFillForensicCheckpoint({
      id: 'other',
      symbol: 'AAPL',
      side: 'BUY',
      status: 'FILLED',
      executionEnvironment: 'PAPER',
      traceId: 't2',
    });
    expect(second).toBeNull();
  });

  it('FAIL disables Autobot via toggle, soft-locks new BUYs, emits FORENSIC_CHECKPOINT_FAILED', async () => {
    const orderId = `ord-fail-${Date.now()}`;
    const traceId = `trace-fail-${Date.now()}`;
    const now = new Date().toISOString();
    await db.insert(schema.trades).values({
      id: orderId,
      symbol: 'NVDA',
      side: 'SELL',
      quantity: 1,
      price: 100,
      status: 'FILLED',
      timestamp: now,
      filledAt: now,
      reasoning: 'executionEnvironment=PAPER',
      traceId,
      profitLoss: null, // intentional FAIL
      executionEnvironment: 'PAPER',
    });
    await db.insert(schema.fills).values({
      orderId,
      brokerFillId: `${orderId}:1`,
      quantity: 1,
      price: 100,
      filledAt: now,
      cumulativeQuantity: 1,
    });
    await db.insert(schema.reconciliationEvents).values({
      checkedAt: now,
      broker: 'test',
      matches: false,
      mismatches: JSON.stringify([{ symbol: 'NVDA', type: 'MISSING_REMOTELY', localQty: 1, remoteQty: 0 }]),
      actionTaken: 'TRADING_PAUSED',
    });

    const disable = vi.fn(async () => {
      tradingEngine.state.enabled = false;
      return { ok: true };
    });
    const failed: any[] = [];
    eventBus.on(EVENTS.FORENSIC_CHECKPOINT_FAILED, (p: any) => failed.push(p));

    checkpoint.setFirstFillForensicDepsForTests({
      disableAutobot: disable,
      getBrokerPositions: async () => [{ symbol: 'NVDA', quantity: 0 }],
      runReconcile: async () => {},
      writeReport: () => null,
    });

    const report = await checkpoint.runFirstFillForensicCheckpoint({
      id: orderId,
      symbol: 'NVDA',
      side: 'SELL',
      quantity: 1,
      status: 'FILLED',
      traceId,
      profitLoss: null,
      executionEnvironment: 'PAPER',
      reasoning: 'executionEnvironment=PAPER',
    });

    expect(report?.result).toBe('FAILED');
    expect(report?.failures.some((f) => f.startsWith('sell_pnl_non_null'))).toBe(true);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(isForensicCheckpointBuyLocked()).toBe(true);
    expect(failed.length).toBe(1);
    expect(tradingEngine.state.enabled).toBe(false);
    expect(isLiveIdeaGenerationEnabled()).toBe(false);
  });

  it('ignores REPLAY fills', async () => {
    checkpoint.setFirstFillForensicDepsForTests({
      disableAutobot: async () => ({ ok: true }),
      getBrokerPositions: async () => [],
      runReconcile: async () => {},
      writeReport: () => null,
    });
    const report = await checkpoint.runFirstFillForensicCheckpoint({
      id: 'replay-ord',
      symbol: 'AAPL',
      side: 'BUY',
      status: 'FILLED',
      executionEnvironment: 'REPLAY',
      traceId: 'replay-trace',
    });
    expect(report).toBeNull();
    expect(checkpoint.hasCompletedForensicCheckpoint()).toBe(false);
  });

  it('worker wires ORDER_EXECUTED and never imports placeOrder path', async () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/server/services/FirstFillForensicCheckpoint.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/\.placeOrder\(/);
    expect(src).not.toMatch(/CHIEF_APPROVED_IDEA/);
    expect(src).not.toMatch(/EMERGENCY_STOP/);
    expect(src).toMatch(/FORENSIC_CHECKPOINT_FAILED/);
    expect(src).toMatch(/tradingEngine\.toggle/);

    const orderId = `ord-wire-${Date.now()}`;
    const traceId = `trace-wire-${Date.now()}`;
    await seedPassingWorld({ orderId, traceId, side: 'BUY' });

    const passed: any[] = [];
    eventBus.on(EVENTS.FORENSIC_CHECKPOINT_PASSED, (p: any) => passed.push(p));
    checkpoint.setFirstFillForensicDepsForTests({
      disableAutobot: async () => ({ ok: true }),
      getBrokerPositions: async () => [{ symbol: 'NVDA', quantity: 1 }],
      runReconcile: async () => {},
      writeReport: () => null,
    });
    checkpoint.firstFillForensicCheckpoint.start();
    eventBus.emitOrderExecution({
      id: orderId,
      symbol: 'NVDA',
      side: 'BUY',
      quantity: 1,
      price: 100,
      status: 'FILLED',
      traceId,
      profitLoss: null,
      executionEnvironment: 'PAPER',
    });
    await vi.waitFor(() => expect(passed.length).toBe(1), { timeout: 3000 });
  });
});
